import type { LexiSideSettings, TtsVoice } from "./types.ts";

export interface TtsRequestOptions {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

export interface TtsResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  text?: string;
}

export type TtsRequest = (options: TtsRequestOptions) => Promise<TtsResponse>;

/** Build the official DeepSeek TTS endpoint from a Base URL. */
export function buildDeepSeekTtsUrl(baseUrl: string): string {
  let normalized = baseUrl.trim() || "https://api.deepseek.com";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
    normalized = `https://${normalized}`;
  }
  normalized = normalized.replace(/\/+$/, "").replace(/\/v1$/i, "");
  return `${normalized}/v1/tools/tts`;
}

export function buildTtsPayload(text: string, voice: TtsVoice): string {
  return JSON.stringify({
    text: text.trim(),
    voice_id: voice,
    format: "wav",
    filter_markdown: false,
  });
}

function headerValue(headers: Record<string, string>, name: string): string | null {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found ? found[1] : null;
}

/**
 * DeepSeek TTS client. Audio is kept as object URLs in memory only; it is never
 * written into data.json. Repeated words are reused for the current session.
 */
export class DeepSeekTts {
  private readonly request: TtsRequest;
  private readonly cache = new Map<string, string>();
  private audio: HTMLAudioElement | null = null;
  private activeButton: HTMLButtonElement | null = null;

  constructor(request: TtsRequest) {
    this.request = request;
  }

  async play(
    text: string,
    settings: Pick<LexiSideSettings, "apiKey" | "baseUrl" | "ttsVoice">,
    button: HTMLButtonElement,
  ): Promise<void> {
    const word = text.trim();
    if (!word) {
      throw new Error("There is no text to pronounce.");
    }
    if (!settings.apiKey.trim()) {
      throw new Error("The DeepSeek API key is not configured.");
    }

    const key = `${settings.ttsVoice}\u001F${word.toLowerCase()}`;
    let audioUrl = this.cache.get(key);
    if (!audioUrl) {
      const response = await this.request({
        url: buildDeepSeekTtsUrl(settings.baseUrl),
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: buildTtsPayload(word, settings.ttsVoice),
      });

      if (response.status < 200 || response.status >= 300) {
        throw new Error(ttsErrorMessage(response.status));
      }
      if (!response.arrayBuffer || response.arrayBuffer.byteLength === 0) {
        throw new Error("DeepSeek TTS returned no audio.");
      }

      const contentType = headerValue(response.headers, "content-type") ?? "audio/wav";
      const blob = new Blob([response.arrayBuffer], { type: contentType });
      audioUrl = URL.createObjectURL(blob);
      this.cache.set(key, audioUrl);
      while (this.cache.size > 24) {
        const oldest = this.cache.entries().next().value as [string, string] | undefined;
        if (!oldest) {
          break;
        }
        URL.revokeObjectURL(oldest[1]);
        this.cache.delete(oldest[0]);
      }
    }

    await this.playUrl(audioUrl, button);
  }

  destroy(): void {
    if (this.audio) {
      this.audio.pause();
      this.audio = null;
    }
    this.activeButton?.removeClass("is-speaking");
    this.activeButton = null;
    for (const url of this.cache.values()) {
      URL.revokeObjectURL(url);
    }
    this.cache.clear();
  }

  private async playUrl(url: string, button: HTMLButtonElement): Promise<void> {
    if (this.audio) {
      this.audio.pause();
      this.audio = null;
    }
    this.activeButton?.removeClass("is-speaking");

    const audio = new Audio(url);
    this.audio = audio;
    this.activeButton = button;
    button.addClass("is-speaking");
    try {
      await new Promise<void>((resolve, reject) => {
        audio.onended = () => resolve();
        audio.onerror = () => reject(new Error("DeepSeek audio playback failed."));
        void audio.play().catch(reject);
      });
    } finally {
      if (this.audio === audio) {
        this.audio = null;
      }
      if (this.activeButton === button) {
        this.activeButton = null;
      }
      button.removeClass("is-speaking");
    }
  }
}

function ttsErrorMessage(status: number): string {
  if (status === 400) {
    return "DeepSeek TTS rejected the text.";
  }
  if (status === 429) {
    return "DeepSeek TTS is busy (rate limit).";
  }
  if (status === 503 || status === 504) {
    return "DeepSeek TTS is temporarily unavailable.";
  }
  return `DeepSeek TTS failed (${status}).`;
}

/** System voice fallback, used when DeepSeek TTS is disabled or unavailable. */
export function speakSystem(text: string, button: HTMLButtonElement): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    throw new Error("System speech synthesis is not available.");
  }
  const synth = window.speechSynthesis;
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-US";
  utterance.rate = 0.95;
  button.addClass("is-speaking");
  utterance.onend = () => button.removeClass("is-speaking");
  utterance.onerror = () => button.removeClass("is-speaking");
  synth.speak(utterance);
}
