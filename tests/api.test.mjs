import test from "node:test";
import assert from "node:assert/strict";
import { LexiSideApiClient, LexiSideApiError, resolveChatEndpoint } from "../api.ts";
import { sampleCompletion, sampleSettings, sampleSnapshot, sseResponse } from "./fixtures.mjs";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("resolves canonical OpenAI-compatible endpoints", () => {
  assert.equal(resolveChatEndpoint("https://api.deepseek.com"), "https://api.deepseek.com/chat/completions");
  assert.equal(resolveChatEndpoint("https://api.openai.com/v1"), "https://api.openai.com/v1/chat/completions");
  assert.equal(
    resolveChatEndpoint("https://example.com/v1/chat/completions"),
    "https://example.com/v1/chat/completions",
  );
  assert.throws(() => resolveChatEndpoint("ftp://example.com"), LexiSideApiError);
  assert.throws(() => resolveChatEndpoint("https://user:pass@example.com"), LexiSideApiError);
});

test("sends a Bearer-authenticated non-streaming request and returns raw content", async () => {
  let capturedRequest = null;
  const client = new LexiSideApiClient({
    fetchImpl: async (url, init) => {
      capturedRequest = { url, init };
      return jsonResponse(sampleCompletion);
    },
  });

  const completion = await client.analyze(sampleSettings, sampleSnapshot);
  assert.equal(completion.model, "deepseek-flash");
  assert.equal(completion.finishReason, "stop");
  assert.match(completion.content, /"word":"resilient"/);
  assert.equal(capturedRequest.url, "https://api.deepseek.com/chat/completions");
  assert.equal(capturedRequest.init.headers.Authorization, "Bearer sk-test-secret");

  const body = JSON.parse(capturedRequest.init.body);
  assert.equal(body.model, "deepseek-flash");
  assert.equal(body.stream, false);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.messages.length, 2);
  assert.match(body.messages[0].content, /Mermaid, SVG, HTML/);
  assert.match(body.messages[1].content, /"learnerLevel":"intermediate"/);
  assert.match(body.messages[1].content, /"previousSentence":"The launch had gone badly\."/);
});

test("uses a prompt override for the structural repair request", async () => {
  let capturedBody = null;
  const client = new LexiSideApiClient({
    fetchImpl: async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return jsonResponse(sampleCompletion);
    },
  });

  await client.analyze(sampleSettings, sampleSnapshot, {
    promptOverride: {
      system: "Repair system prompt",
      user: "Repair user prompt",
    },
  });
  assert.equal(capturedBody.messages[0].content, "Repair system prompt");
  assert.equal(capturedBody.messages[1].content, "Repair user prompt");
});

test("honours the DeepSeek V4 thinking-mode setting", async () => {
  let capturedBody = null;
  const client = new LexiSideApiClient({
    fetchImpl: async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return jsonResponse(sampleCompletion);
    },
  });

  await client.analyze({ ...sampleSettings, thinkingEnabled: true }, sampleSnapshot);
  assert.deepEqual(capturedBody.thinking, { type: "enabled" });
});

test("streams chunk-split SSE content, progress, and partial content", async () => {
  const progress = [];
  const previews = [];
  const client = new LexiSideApiClient({
    fetchImpl: async () =>
      sseResponse(['{"word":', '"resilient",', '"phonetic":', '"/rɪˈzɪliənt/"}']),
  });

  const completion = await client.analyze(
    { ...sampleSettings, streaming: true },
    sampleSnapshot,
    {
      onProgress: (characters) => progress.push(characters),
      onContent: (content) => previews.push(content),
    },
  );

  assert.equal(completion.content, '{"word":"resilient","phonetic":"/rɪˈzɪliənt/"}');
  assert.equal(completion.finishReason, "stop");
  assert.ok(progress.length > 0);
  assert.equal(progress.at(-1), completion.content.length);
  assert.ok(previews.length > 1);
  assert.equal(previews.at(-1), completion.content);
});

test("omits Authorization and DeepSeek-specific fields for keyless custom endpoints", async () => {
  let headers;
  let body;
  const client = new LexiSideApiClient({
    fetchImpl: async (_url, init) => {
      headers = init.headers;
      body = JSON.parse(init.body);
      return jsonResponse(sampleCompletion);
    },
  });

  await client.analyze(
    {
      ...sampleSettings,
      provider: "ollama",
      apiKey: "",
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    sampleSnapshot,
  );
  assert.equal(headers.Authorization, undefined);
  assert.equal(body.thinking, undefined);
  assert.equal(body.reasoning_effort, "none");

  await client.analyze(
    {
      ...sampleSettings,
      provider: "ollama",
      apiKey: "must-not-leak",
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    sampleSnapshot,
  );
  assert.equal(headers.Authorization, undefined);
});

test("maps an authentication failure without exposing the key", async () => {
  const key = "sk-test-secret";
  const client = new LexiSideApiClient({
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { message: `Incorrect key ${key}` } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
  });

  await assert.rejects(
    () => client.analyze({ ...sampleSettings, apiKey: key }, sampleSnapshot),
    (error) => {
      assert.ok(error instanceof LexiSideApiError);
      assert.equal(error.kind, "auth");
      assert.doesNotMatch(error.message, /sk-test-secret/);
      assert.doesNotMatch(error.details ?? "", /sk-test-secret/);
      return true;
    },
  );
});

test("falls back to requestUrl on a Fetch/CORS failure", async () => {
  let fallbackRequest = null;
  const client = new LexiSideApiClient({
    fetchImpl: async () => {
      throw new TypeError("Failed to fetch");
    },
    requestUrlImpl: async (request) => {
      fallbackRequest = request;
      return { status: 200, text: JSON.stringify(sampleCompletion) };
    },
  });

  const completion = await client.analyze(sampleSettings, sampleSnapshot);
  assert.equal(completion.content, JSON.stringify(sampleDefinition()));
  assert.ok(fallbackRequest);
  const body = JSON.parse(fallbackRequest.body);
  assert.equal(body.stream, false);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(fallbackRequest.headers.Authorization, "Bearer sk-test-secret");
});

function sampleDefinition() {
  return JSON.parse(sampleCompletion.choices[0].message.content);
}

test("retries without response_format when an endpoint rejects JSON mode", async () => {
  const requests = [];
  const client = new LexiSideApiClient({
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      if (requests.length === 1) {
        return jsonResponse({ error: { message: "response_format json_object is not supported" } }, 400);
      }
      return jsonResponse(sampleCompletion);
    },
  });

  const completion = await client.analyze(sampleSettings, sampleSnapshot);
  assert.equal(completion.finishReason, "stop");
  assert.equal(requests.length, 2);
  assert.ok(requests[0].response_format);
  assert.equal(requests[1].response_format, undefined);
});

test("rejects malformed OpenAI-compatible responses", async () => {
  const client = new LexiSideApiClient({
    fetchImpl: async () => jsonResponse({ choices: [] }),
  });
  await assert.rejects(() => client.analyze(sampleSettings, sampleSnapshot), (error) => {
    assert.ok(error instanceof LexiSideApiError);
    assert.equal(error.kind, "invalid-response");
    return true;
  });
});

test("times out a stalled request", async () => {
  const client = new LexiSideApiClient({
    fetchImpl: async (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal;
        if (signal.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }),
  });

  await assert.rejects(
    () => client.analyze({ ...sampleSettings, timeoutMs: 20 }, sampleSnapshot),
    (error) => {
      assert.ok(error instanceof LexiSideApiError);
      assert.equal(error.kind, "timeout");
      return true;
    },
  );
});

test("cancels an in-flight request", async () => {
  const controller = new AbortController();
  const client = new LexiSideApiClient({
    fetchImpl: async (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal;
        if (signal.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }),
  });

  const request = client.analyze(sampleSettings, sampleSnapshot, { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);

  await assert.rejects(request, (error) => {
    assert.ok(error instanceof LexiSideApiError);
    assert.equal(error.kind, "aborted");
    return true;
  });
});
