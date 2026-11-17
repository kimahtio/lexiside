import test from "node:test";
import assert from "node:assert/strict";
import { AnkiConnectClient, ankiTagList } from "../anki.ts";

function fakeRequest(handler) {
  const calls = [];
  const request = async (options) => {
    calls.push(JSON.parse(options.body));
    return handler(calls[calls.length - 1]);
  };
  return { request, calls };
}

function ok(result) {
  return { status: 200, text: JSON.stringify({ result, error: null }) };
}

test("calls AnkiConnect with version 6 and parses results", async () => {
  const { request, calls } = fakeRequest(() => ok(6));
  const client = new AnkiConnectClient("http://127.0.0.1:8765/", request);
  assert.equal(await client.version(), 6);
  assert.deepEqual(calls, [{ action: "version", version: 6, params: {} }]);
});

test("surfaces AnkiConnect errors", async () => {
  const { request } = fakeRequest(() => ({
    status: 200,
    text: JSON.stringify({ result: null, error: "model was not found" }),
  }));
  const client = new AnkiConnectClient("http://127.0.0.1:8765", request);
  await assert.rejects(() => client.version(), /model was not found/);
});

test("creates a missing deck", async () => {
  const { request, calls } = fakeRequest((body) => {
    if (body.action === "deckNames") {
      return ok(["Default"]);
    }
    return ok(1);
  });
  const client = new AnkiConnectClient("http://127.0.0.1:8765", request);
  await client.ensureDeck("LexiSide");
  assert.deepEqual(calls.map((call) => call.action), ["deckNames", "createDeck"]);
});

test("normalizes Anki tags", () => {
  assert.deepEqual(ankiTagList(" lexiside  history\nlexiside "), ["lexiside", "history"]);
});
