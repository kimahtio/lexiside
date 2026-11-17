import test from "node:test";
import assert from "node:assert/strict";
import {
  OLLAMA_DEFAULT_BASE_URL,
  buildOllamaTagsUrl,
  parseOllamaModelNames,
} from "../ollama.ts";

test("builds the Ollama tags endpoint from common base URLs", () => {
  assert.equal(buildOllamaTagsUrl(OLLAMA_DEFAULT_BASE_URL), "http://127.0.0.1:11434/api/tags");
  assert.equal(buildOllamaTagsUrl("http://127.0.0.1:11434"), "http://127.0.0.1:11434/api/tags");
  assert.equal(buildOllamaTagsUrl("http://127.0.0.1:11434/v1/"), "http://127.0.0.1:11434/api/tags");
  assert.equal(buildOllamaTagsUrl("http://127.0.0.1:11434/api"), "http://127.0.0.1:11434/api/tags");
  assert.equal(buildOllamaTagsUrl("localhost:11434/v1"), "http://localhost:11434/api/tags");
});

test("parses, trims, de-duplicates, and sorts Ollama model names", () => {
  assert.deepEqual(
    parseOllamaModelNames({
      models: [
        { name: "qwen2.5:7b" },
        { model: "llama3.2:latest" },
        { name: " qwen2.5:7b " },
        { name: "" },
        null,
      ],
    }),
    ["llama3.2:latest", "qwen2.5:7b"],
  );
  assert.deepEqual(parseOllamaModelNames({ models: "bad" }), []);
  assert.deepEqual(parseOllamaModelNames(null), []);
});
