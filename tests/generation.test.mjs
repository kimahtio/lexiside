import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGenerationInput,
  DEFAULT_GENERATION_PROFILE,
  profileFromSettings,
} from "../generation.ts";
import { sampleSettings, sampleSnapshot } from "./fixtures.mjs";

test("default generation profile matches the specified Phase 2 defaults", () => {
  assert.deepEqual(DEFAULT_GENERATION_PROFILE, {
    targetLanguage: "en",
    explanationLanguage: "zh-CN",
    explanationDepth: "standard",
    learnerLevel: "intermediate",
  });
});

test("builds generation input from the snapshot and profile", () => {
  const profile = {
    ...DEFAULT_GENERATION_PROFILE,
    explanationDepth: "detailed",
    learnerLevel: "advanced",
  };
  const input = buildGenerationInput(sampleSnapshot, profile);

  assert.equal(input.selectedText, "resilient");
  assert.equal(input.sentence, sampleSnapshot.sentence);
  assert.equal(input.previousSentence, sampleSnapshot.previousSentence);
  assert.equal(input.nextSentence, sampleSnapshot.nextSentence);
  assert.equal(input.sourceNote, sampleSnapshot.sourceNote);
  assert.equal(input.targetLanguage, "en");
  assert.equal(input.explanationLanguage, "zh-CN");
  assert.equal(input.explanationDepth, "detailed");
  assert.equal(input.learnerLevel, "advanced");
});

test("reads the profile from normalized settings", () => {
  const profile = profileFromSettings(sampleSettings);
  assert.deepEqual(profile, {
    targetLanguage: "en",
    explanationLanguage: "zh-CN",
    explanationDepth: "standard",
    learnerLevel: "intermediate",
  });
});

test("preserves missing neighbour sentences as null input", () => {
  const input = buildGenerationInput({
    ...sampleSnapshot,
    previousSentence: null,
    nextSentence: null,
  });
  assert.equal(input.previousSentence, null);
  assert.equal(input.nextSentence, null);
});

