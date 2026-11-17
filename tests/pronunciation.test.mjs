import test from "node:test";
import assert from "node:assert/strict";
import { buildDeepSeekTtsUrl, buildTtsPayload } from "../pronunciation.ts";

test("builds the official DeepSeek TTS endpoint from the base URL", () => {
  assert.equal(
    buildDeepSeekTtsUrl("https://api.deepseek.com"),
    "https://api.deepseek.com/v1/tools/tts",
  );
  assert.equal(
    buildDeepSeekTtsUrl("https://api.deepseek.com/v1/"),
    "https://api.deepseek.com/v1/tools/tts",
  );
  assert.equal(
    buildDeepSeekTtsUrl("api.deepseek.com"),
    "https://api.deepseek.com/v1/tools/tts",
  );
});

test("builds a DeepSeek TTS WAV payload", () => {
  const payload = JSON.parse(buildTtsPayload("  history  ", "tide"));
  assert.deepEqual(payload, {
    text: "history",
    voice_id: "tide",
    format: "wav",
    filter_markdown: false,
  });
});
