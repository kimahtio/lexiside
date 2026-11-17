import { buildGenerationInput, profileFromSettings } from "./generation.ts";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompts.ts";
import type {
  ApiCompletion,
  ApiErrorKind,
  LexiSideSettings,
  PromptOverride,
  SelectionSnapshot,
} from "./types.ts";

const MAX_ERROR_DETAILS = 1200;

/** Minimal structural shape of Obsidian's public requestUrl request. */
export interface RequestUrlLikeRequest {
  url: string;
  method?: string;
  contentType?: string;
  body?: string;
  headers?: Record<string, string>;
  throw?: boolean;
}

/** Minimal structural shape of the fields LexiSide reads from requestUrl. */
export interface RequestUrlLikeResponse {
  status: number;
  text: string;
}

export type RequestUrlLike = (request: RequestUrlLikeRequest) => Promise<RequestUrlLikeResponse>;

export interface ApiClientDependencies {
  fetchImpl?: typeof fetch;
  requestUrlImpl?: RequestUrlLike | null;
}

export interface AnalyzeOptions {
  signal?: AbortSignal;
  onProgress?: (receivedCharacters: number) => void;
  onStatus?: (status: string) => void;
  /** Full accumulated JSON text received so far during SSE streaming. */
  onContent?: (content: string) => void;
  /** Optional exact prompt, used by the one-shot structural repair request. */
  promptOverride?: PromptOverride;
}

type ThinkingMode = "enabled" | "disabled";

interface ChatPayload {
  model: string;
  messages: Array<{ role: "system" | "user"; content: string }>;
  temperature: number;
  max_tokens: number;
  stream: boolean;
  response_format?: { type: "json_object" };
  thinking?: { type: ThinkingMode };
  reasoning_effort?: "none";
}

export class LexiSideApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly retryable: boolean;
  readonly details: string | null;
  readonly status: number | null;
  readonly responseBody: string | null;

  constructor(
    kind: ApiErrorKind,
    message: string,
    options: {
      retryable?: boolean;
      details?: string | null;
      status?: number | null;
      responseBody?: string | null;
    } = {},
  ) {
    super(message);
    this.name = "LexiSideApiError";
    this.kind = kind;
    this.retryable = options.retryable ?? true;
    this.details = options.details ?? null;
    this.status = options.status ?? null;
    this.responseBody = options.responseBody ?? null;
  }
}

class HttpStatusError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`HTTP ${status}`);
    this.name = "HttpStatusError";
    this.status = status;
    this.body = body;
  }
}

class LinkedAbort {
  readonly controller = new AbortController();
  timedOut = false;
  private readonly external: AbortSignal | undefined;
  private readonly onAbort: (() => void) | null;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(external: AbortSignal | undefined, timeoutMs: number) {
    this.external = external;
    this.onAbort = () => {
      this.controller.abort();
    };

    if (external) {
      if (external.aborted) {
        this.controller.abort();
      } else {
        external.addEventListener("abort", this.onAbort, { once: true });
      }
    }

    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.controller.abort();
    }, timeoutMs);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  cleanup(): void {
    clearTimeout(this.timer);
    if (this.external && this.onAbort) {
      this.external.removeEventListener("abort", this.onAbort);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redact(value: string, secret: string): string {
  if (!secret) {
    return value;
  }
  return value.split(secret).join("[redacted]");
}

function cleanErrorText(value: string, apiKey: string): string {
  return redact(value, apiKey).replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_DETAILS);
}

function parseMaybeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function extractServerMessage(body: string, apiKey: string): string {
  const parsed = parseMaybeJson(body);
  if (isRecord(parsed)) {
    const error = parsed["error"];
    if (isRecord(error) && typeof error["message"] === "string") {
      return cleanErrorText(error["message"], apiKey);
    }
    if (typeof error === "string") {
      return cleanErrorText(error, apiKey);
    }
    if (typeof parsed["message"] === "string") {
      return cleanErrorText(parsed["message"], apiKey);
    }
    if (typeof parsed["detail"] === "string") {
      return cleanErrorText(parsed["detail"], apiKey);
    }
  }

  const stripped = body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return cleanErrorText(stripped, apiKey);
}

function statusErrorKind(status: number): ApiErrorKind {
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 402) {
    return "insufficient-balance";
  }
  if (status === 404) {
    return "not-found";
  }
  if (status === 408) {
    return "timeout";
  }
  if (status === 429) {
    return "rate-limit";
  }
  if (status >= 500) {
    return "server";
  }
  return "bad-request";
}

function httpStatusMessage(status: number): string {
  switch (status) {
    case 400:
      return "The API rejected the request (HTTP 400). Check the Base URL and model, then try again.";
    case 401:
      return "Authentication failed (HTTP 401). Check your API key in LexiSide settings.";
    case 402:
      return "The API account has insufficient balance (HTTP 402).";
    case 403:
      return "The API denied access (HTTP 403). Check your API key and account permissions.";
    case 404:
      return "The API endpoint or model was not found (HTTP 404). Check the Base URL and model name.";
    case 408:
      return "The API request timed out (HTTP 408). Try again or increase the timeout.";
    case 429:
      return "The API rate limit was reached (HTTP 429). Wait a moment and try again.";
    default:
      if (status >= 500) {
        return `The API server returned an error (HTTP ${status}). Try again later.`;
      }
      return `The API request failed (HTTP ${status}).`;
  }
}

function httpError(status: number, body: string, endpoint: string, apiKey: string): LexiSideApiError {
  const serverMessage = extractServerMessage(body, apiKey);
  const detailsParts = [`HTTP ${status} from ${endpoint}`];
  if (serverMessage) {
    detailsParts.push(serverMessage);
  }
  return new LexiSideApiError(statusErrorKind(status), httpStatusMessage(status), {
    retryable: status >= 500 || status === 408 || status === 429,
    details: detailsParts.join("\n"),
    status,
    responseBody: redact(body, apiKey),
  });
}

function isUnsupportedJsonModeError(error: LexiSideApiError): boolean {
  if (error.status !== 400 && error.status !== 422) {
    return false;
  }
  const haystack = `${error.message} ${error.details ?? ""} ${error.responseBody ?? ""}`.toLowerCase();
  return (
    haystack.includes("response_format") ||
    haystack.includes("json_object") ||
    haystack.includes("json mode") ||
    haystack.includes("response format")
  );
}

function classifyNetworkError(cause: unknown, endpoint: string): LexiSideApiError {
  if (cause instanceof LexiSideApiError) {
    return cause;
  }
  const rawMessage = cause instanceof Error ? cause.message : "Unknown transport error";
  return new LexiSideApiError(
    "network",
    "Could not reach the API. Check your network, proxy, and Base URL.",
    {
      retryable: true,
      details: cleanErrorText(`${endpoint}\n${rawMessage}`, ""),
    },
  );
}

/**
 * Resolve an OpenAI-compatible base URL to its chat completions endpoint.
 * A missing scheme defaults to HTTPS. Base URLs ending in /v1 are supported.
 */
export function resolveChatEndpoint(baseUrl: string): string {
  let candidate = baseUrl.trim();
  if (!candidate) {
    throw new LexiSideApiError("configuration", "The API Base URL is empty.");
  }

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new LexiSideApiError("configuration", "The API Base URL is not a valid URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LexiSideApiError("configuration", "The API Base URL must use http:// or https://.");
  }
  if (url.username || url.password) {
    throw new LexiSideApiError("configuration", "Do not put credentials in the Base URL. Use the API key field.");
  }

  url.hash = "";
  url.search = "";
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = /\/chat\/completions$/i.test(path) ? path : `${path}/chat/completions`;
  return url.toString();
}

const DEEPSEEK_V4_MODEL_IDS = new Set(["deepseek-flash", "deepseek-v4-pro"]);

/**
 * The current DeepSeek V4 API defaults to thinking mode. LexiSide's dictionary
 * task does not need it, so send an explicit mode for the official API only.
 * Custom OpenAI-compatible endpoints never receive this DeepSeek-specific field.
 */
function deepSeekThinkingMode(settings: LexiSideSettings, endpoint: string): ThinkingMode | null {
  let hostname: string;
  try {
    hostname = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (hostname !== "api.deepseek.com") {
    return null;
  }
  if (!DEEPSEEK_V4_MODEL_IDS.has(settings.model.trim().toLowerCase())) {
    return null;
  }
  return settings.thinkingEnabled ? "enabled" : "disabled";
}

function buildPayload(
  settings: LexiSideSettings,
  snapshot: SelectionSnapshot,
  stream: boolean,
  includeJsonMode: boolean,
  thinkingMode: ThinkingMode | null,
  promptOverride?: PromptOverride,
): ChatPayload {
  const messages = promptOverride
    ? [
        { role: "system" as const, content: promptOverride.system },
        { role: "user" as const, content: promptOverride.user },
      ]
    : [
        { role: "system" as const, content: SYSTEM_PROMPT },
        {
          role: "user" as const,
          content: buildUserPrompt(
            buildGenerationInput(snapshot, profileFromSettings(settings)),
          ),
        },
      ];
  const payload: ChatPayload = {
    model: settings.model.trim(),
    messages,
    temperature: settings.temperature,
    max_tokens: settings.maxTokens,
    stream,
  };
  if (includeJsonMode) {
    payload.response_format = { type: "json_object" };
  }
  if (thinkingMode) {
    payload.thinking = { type: thinkingMode };
  }
  if (settings.provider === "ollama" && settings.ollamaDisableThinking) {
    payload.reasoning_effort = "none";
  }
  return payload;
}

function contentFromParts(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts: string[] = [];
  for (const part of value) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (isRecord(part) && typeof part["text"] === "string") {
      parts.push(part["text"]);
    }
  }
  return parts.length > 0 ? parts.join("") : null;
}

function findPayloadError(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const error = value["error"];
  if (typeof error === "string") {
    return error;
  }
  if (isRecord(error)) {
    if (typeof error["message"] === "string") {
      return error["message"];
    }
    return "The API returned an error object.";
  }
  return null;
}

function parseCompletionObject(value: unknown, fallbackModel: string, apiKey: string): ApiCompletion {
  if (!isRecord(value)) {
    throw new LexiSideApiError("invalid-response", "The API response was not a JSON object.", {
      details: "Expected an OpenAI-compatible chat completion object.",
    });
  }

  const payloadError = findPayloadError(value);
  if (payloadError) {
    throw new LexiSideApiError("invalid-response", "The API returned an error instead of an explanation.", {
      details: cleanErrorText(payloadError, apiKey),
    });
  }

  const choices = value["choices"];
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new LexiSideApiError("invalid-response", "The API response did not contain any choices.", {
      details: "Expected choices[0] in the OpenAI-compatible response.",
    });
  }

  const first = choices[0];
  if (!isRecord(first)) {
    throw new LexiSideApiError("invalid-response", "The API returned a malformed choice.");
  }

  const message = isRecord(first["message"]) ? first["message"] : null;
  const content =
    contentFromParts(message?.["content"]) ??
    contentFromParts(first["content"]) ??
    contentFromParts(first["text"]);
  if (content === null || content.trim().length === 0) {
    throw new LexiSideApiError("empty-response", "The AI returned an empty explanation.");
  }

  const finishReasonValue = first["finish_reason"];
  const finishReason = typeof finishReasonValue === "string" ? finishReasonValue : null;
  if (finishReason === "length") {
    throw new LexiSideApiError(
      "truncated",
      "The explanation was cut off because the model reached Maximum Tokens. Increase the limit and try again.",
      { retryable: true, details: "finish_reason: length" },
    );
  }
  if (finishReason === "content_filter") {
    throw new LexiSideApiError("invalid-response", "The API blocked the generated explanation (content filter).");
  }

  const model = typeof value["model"] === "string" && value["model"].trim() ? value["model"].trim() : fallbackModel;
  return { content, model, finishReason };
}

function parseCompletionText(text: string, fallbackModel: string, apiKey: string): ApiCompletion {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new LexiSideApiError("invalid-response", "The API returned a response that was not valid JSON.", {
      details: cleanErrorText(text, apiKey),
    });
  }
  return parseCompletionObject(parsed, fallbackModel, apiKey);
}

function extractStreamDelta(
  value: unknown,
  onText: (text: string) => void,
): string | null {
  if (!isRecord(value)) {
    throw new LexiSideApiError("invalid-response", "A streaming event was not a JSON object.");
  }
  const payloadError = findPayloadError(value);
  if (payloadError) {
    throw new LexiSideApiError("invalid-response", "The streaming API reported an error.", {
      details: payloadError,
    });
  }

  const choices = value["choices"];
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const first = choices[0];
  if (!isRecord(first)) {
    return null;
  }

  const delta = first["delta"];
  const deltaText = isRecord(delta)
    ? contentFromParts(delta["content"]) ?? (typeof delta["text"] === "string" ? delta["text"] : null)
    : null;
  if (deltaText) {
    onText(deltaText);
  }

  const finishValue = first["finish_reason"];
  return typeof finishValue === "string" ? finishValue : null;
}

function isSseResponse(contentType: string): boolean {
  return contentType.toLowerCase().includes("text/event-stream");
}

function createAbortRace<T>(promise: Promise<T>, linked: LinkedAbort): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (linked.signal.aborted) {
      reject(new Error("Request aborted"));
      return;
    }

    const onAbort = (): void => {
      reject(new Error("Request aborted"));
    };

    linked.signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        linked.signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        linked.signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export class LexiSideApiClient {
  private readonly fetchImpl: typeof fetch | null;
  private readonly requestUrlImpl: RequestUrlLike | null;

  constructor(dependencies: ApiClientDependencies = {}) {
    this.fetchImpl =
      dependencies.fetchImpl ??
      (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null);
    this.requestUrlImpl = dependencies.requestUrlImpl ?? null;
  }

  async analyze(settings: LexiSideSettings, snapshot: SelectionSnapshot, options: AnalyzeOptions = {}): Promise<ApiCompletion> {
    if (!settings.model.trim()) {
      throw new LexiSideApiError("configuration", "The model name is empty. Set it in LexiSide settings.");
    }

    const endpoint = resolveChatEndpoint(settings.baseUrl);
    const thinkingMode = deepSeekThinkingMode(settings, endpoint);
    let includeJsonMode = true;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.withFetch(settings, snapshot, endpoint, includeJsonMode, thinkingMode, options);
      } catch (cause) {
        const error = cause instanceof LexiSideApiError ? cause : classifyNetworkError(cause, endpoint);
        if (error.kind === "aborted" || error.kind === "timeout") {
          throw error;
        }

        if (error.kind === "network" && this.requestUrlImpl) {
          this.emitStatus(options, "Fetch was blocked; retrying through Obsidian's requestUrl transport…");
          try {
            return await this.withRequestUrl(settings, snapshot, endpoint, includeJsonMode, thinkingMode, options);
          } catch (fallbackCause) {
            const fallbackError =
              fallbackCause instanceof LexiSideApiError
                ? fallbackCause
                : classifyNetworkError(fallbackCause, endpoint);

            if (fallbackError.kind === "aborted" || fallbackError.kind === "timeout") {
              throw fallbackError;
            }

            if (isUnsupportedJsonModeError(fallbackError) && includeJsonMode) {
              includeJsonMode = false;
              continue;
            }

            if (fallbackError.kind === "network") {
              throw new LexiSideApiError(
                "network",
                "Could not reach the API with either Obsidian transport. Check the Base URL, network, proxy, or CORS settings.",
                {
                  retryable: true,
                  details: [error.details, fallbackError.details].filter(Boolean).join("\n\n"),
                },
              );
            }

            throw fallbackError;
          }
        }

        if (isUnsupportedJsonModeError(error) && includeJsonMode) {
          includeJsonMode = false;
          continue;
        }

        throw error;
      }
    }

    throw new LexiSideApiError("invalid-response", "The request could not be completed after retrying without JSON mode.");
  }

  private emitStatus(options: AnalyzeOptions, status: string): void {
    try {
      options.onStatus?.(status);
    } catch {
      // UI callbacks must never break a network request.
    }
  }

  private emitProgress(options: AnalyzeOptions, receivedCharacters: number): void {
    try {
      options.onProgress?.(receivedCharacters);
    } catch {
      // UI callbacks must never break a network request.
    }
  }

  private emitContent(options: AnalyzeOptions, content: string): void {
    try {
      options.onContent?.(content);
    } catch {
      // UI callbacks must never break a network request.
    }
  }

  private abortError(linked: LinkedAbort, timeoutMs: number): LexiSideApiError {
    if (linked.timedOut) {
      const seconds = Math.round(timeoutMs / 1000);
      return new LexiSideApiError("timeout", `The request timed out after ${seconds} seconds.`, {
        retryable: true,
        details: "Increase Timeout in LexiSide settings or try again.",
      });
    }
    return new LexiSideApiError("aborted", "The request was cancelled.", { retryable: false });
  }

  private authHeaders(settings: LexiSideSettings, accept: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: accept,
    };
    // Ollama is local and normally unauthenticated; never forward a
    // DeepSeek/custom key to it just because it was left in settings.
    const key = settings.provider === "ollama" ? "" : settings.apiKey.trim();
    if (key) {
      headers["Authorization"] = `Bearer ${key}`;
    }
    return headers;
  }

  private async withFetch(
    settings: LexiSideSettings,
    snapshot: SelectionSnapshot,
    endpoint: string,
    includeJsonMode: boolean,
    thinkingMode: ThinkingMode | null,
    options: AnalyzeOptions,
  ): Promise<ApiCompletion> {
    if (!this.fetchImpl) {
      throw new LexiSideApiError("network", "The Fetch API is not available in this environment.");
    }

    const linked = new LinkedAbort(options.signal, settings.timeoutMs);
    const payload = buildPayload(
      settings,
      snapshot,
      settings.streaming,
      includeJsonMode,
      thinkingMode,
      options.promptOverride,
    );

    try {
      this.emitStatus(options, settings.streaming ? "Connecting to the AI and generating…" : "Generating the explanation…");
      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: this.authHeaders(settings, settings.streaming ? "text/event-stream" : "application/json"),
        body: JSON.stringify(payload),
        signal: linked.signal,
      });

      if (!response.ok) {
        let body = "";
        try {
          body = await response.text();
        } catch {
          body = "";
        }
        throw new HttpStatusError(response.status, body);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (settings.streaming && isSseResponse(contentType)) {
        return await this.readSse(response, settings.model, settings.apiKey, options);
      }

      const text = await response.text();
      if (settings.streaming && text.trimStart().startsWith("data:")) {
        return this.parseSseText(text, settings.model, settings.apiKey);
      }
      return parseCompletionText(text, settings.model, settings.apiKey);
    } catch (cause) {
      if (linked.signal.aborted) {
        throw this.abortError(linked, settings.timeoutMs);
      }
      if (cause instanceof HttpStatusError) {
        throw httpError(cause.status, cause.body, endpoint, settings.apiKey);
      }
      if (cause instanceof LexiSideApiError) {
        throw cause;
      }
      throw classifyNetworkError(cause, endpoint);
    } finally {
      linked.cleanup();
    }
  }

  private async withRequestUrl(
    settings: LexiSideSettings,
    snapshot: SelectionSnapshot,
    endpoint: string,
    includeJsonMode: boolean,
    thinkingMode: ThinkingMode | null,
    options: AnalyzeOptions,
  ): Promise<ApiCompletion> {
    if (!this.requestUrlImpl) {
      throw new LexiSideApiError("network", "Obsidian requestUrl is not available for the fallback transport.");
    }

    const linked = new LinkedAbort(options.signal, settings.timeoutMs);
    const payload = buildPayload(
      settings,
      snapshot,
      false,
      includeJsonMode,
      thinkingMode,
      options.promptOverride,
    );

    try {
      this.emitStatus(options, "Using Obsidian's CORS-safe transport…");
      const response = await createAbortRace(
        this.requestUrlImpl({
          url: endpoint,
          method: "POST",
          contentType: "application/json",
          body: JSON.stringify(payload),
          headers: this.authHeaders(settings, "application/json"),
          throw: false,
        }),
        linked,
      );

      if (linked.signal.aborted) {
        throw this.abortError(linked, settings.timeoutMs);
      }
      if (response.status < 200 || response.status >= 300) {
        throw httpError(response.status, response.text, endpoint, settings.apiKey);
      }
      return parseCompletionText(response.text, settings.model, settings.apiKey);
    } catch (cause) {
      if (linked.signal.aborted) {
        throw this.abortError(linked, settings.timeoutMs);
      }
      if (cause instanceof LexiSideApiError) {
        throw cause;
      }
      throw classifyNetworkError(cause, endpoint);
    } finally {
      linked.cleanup();
    }
  }

  private parseSseText(text: string, fallbackModel: string, apiKey: string): ApiCompletion {
    let content = "";
    let finishReason: string | null = null;
    let sawDone = false;

    const consumeLine = (rawLine: string): void => {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line.startsWith("data:")) {
        return;
      }
      const data = line.slice(5).trimStart();
      if (!data) {
        return;
      }
      if (data === "[DONE]") {
        sawDone = true;
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data) as unknown;
      } catch {
        throw new LexiSideApiError("invalid-response", "A streaming data event was not valid JSON.", {
          details: cleanErrorText(data, apiKey),
        });
      }
      const reason = extractStreamDelta(parsed, (delta) => {
        content += delta;
      });
      if (reason) {
        finishReason = reason;
      }
    };

    for (const line of text.split("\n")) {
      consumeLine(line);
      if (sawDone) {
        break;
      }
    }

    return this.finishStream(content, finishReason, fallbackModel);
  }

  private async readSse(
    response: Response,
    fallbackModel: string,
    apiKey: string,
    options: AnalyzeOptions,
  ): Promise<ApiCompletion> {
    if (!response.body) {
      throw new LexiSideApiError("empty-response", "The streaming response had no body.");
    }

    this.emitStatus(options, "Streaming the structured explanation…");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let finishReason: string | null = null;
    let sawDone = false;
    let lastProgress = 0;
    let lastEmittedContentLength = -1;

    const emitContentIfChanged = (): void => {
      if (content.length !== lastEmittedContentLength) {
        lastEmittedContentLength = content.length;
        this.emitContent(options, content);
      }
    };

    const consumeLine = (rawLine: string): void => {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line.startsWith("data:")) {
        return;
      }
      const data = line.slice(5).trimStart();
      if (!data) {
        return;
      }
      if (data === "[DONE]") {
        sawDone = true;
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data) as unknown;
      } catch {
        throw new LexiSideApiError("invalid-response", "A streaming data event was not valid JSON.", {
          details: cleanErrorText(data, apiKey),
        });
      }
      const reason = extractStreamDelta(parsed, (delta) => {
        content += delta;
      });
      if (reason) {
        finishReason = reason;
      }
    };

    try {
      while (!sawDone) {
        const { value, done } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          break;
        }
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          consumeLine(line);
          emitContentIfChanged();
          if (sawDone) {
            break;
          }
          newlineIndex = buffer.indexOf("\n");
        }

        if (content.length - lastProgress >= 100) {
          lastProgress = content.length;
          this.emitProgress(options, content.length);
        }
      }

      if (!sawDone && buffer.trim()) {
        consumeLine(buffer);
        emitContentIfChanged();
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // The stream may already be closed or aborted.
      }
      reader.releaseLock();
    }

    emitContentIfChanged();
    this.emitProgress(options, content.length);
    return this.finishStream(content, finishReason, fallbackModel);
  }

  private finishStream(content: string, finishReason: string | null, fallbackModel: string): ApiCompletion {
    if (!content.trim()) {
      throw new LexiSideApiError("empty-response", "The AI returned an empty explanation.");
    }
    if (finishReason === "length") {
      throw new LexiSideApiError(
        "truncated",
        "The explanation was cut off because the model reached Maximum Tokens. Increase the limit and try again.",
        { retryable: true, details: "finish_reason: length" },
      );
    }
    if (finishReason === "content_filter") {
      throw new LexiSideApiError("invalid-response", "The API blocked the generated explanation (content filter).");
    }
    return {
      content,
      model: fallbackModel,
      finishReason,
    };
  }
}
