import test from "node:test";
import assert from "node:assert/strict";
import { KnowledgeParseError, parseKnowledgeJson, parseKnowledgePreview } from "../parsing.ts";
import { buildGenerationInput } from "../generation.ts";
import { buildRepairPrompt } from "../prompts.ts";
import { sampleKnowledge, sampleSnapshot } from "./fixtures.mjs";

function payloadFromKnowledge(knowledge) {
  return {
    lemma: knowledge.identity.lemma,
    ipa: knowledge.identity.ipa,
    partOfSpeech: knowledge.identity.partOfSpeech,
    inflections: knowledge.identity.inflections,
    contextConfidence: knowledge.context.contextConfidence,
    meanings: knowledge.meanings.map(({ id, ...meaning }) => meaning),
    usage: knowledge.usage,
    nuance: knowledge.nuance,
    wordFamily: knowledge.wordFamily,
    uncertainty: knowledge.uncertainty,
  };
}

test("parses a canonical generation payload and finalizes local IDs/context", () => {
  const payload = payloadFromKnowledge(sampleKnowledge);
  const knowledge = parseKnowledgeJson(JSON.stringify(payload), sampleSnapshot);

  assert.equal(knowledge.schemaVersion, 2);
  assert.equal(knowledge.identity.surface, "resilient");
  assert.equal(knowledge.context.sentence, sampleSnapshot.sentence);
  assert.equal(knowledge.context.previousSentence, sampleSnapshot.previousSentence);
  assert.equal(knowledge.context.nextSentence, sampleSnapshot.nextSentence);
  assert.ok(knowledge.meanings.some((meaning) => meaning.id === "meaning-1"));
  assert.ok(
    knowledge.meanings.some(
      (meaning) => meaning.id === knowledge.context.contextualMeaningId && meaning.scope === "contextual",
    ),
  );
});

test("reports schema failure details for the repair request", () => {
  const invalid = payloadFromKnowledge(sampleKnowledge);
  invalid.meanings[0].englishDefinition = "";
  assert.throws(
    () => parseKnowledgeJson(JSON.stringify(invalid), sampleSnapshot),
    (error) =>
      error instanceof KnowledgeParseError &&
      /schema/.test(error.message) &&
      /englishDefinition/.test(error.details ?? ""),
  );
});

test("previews completed canonical fields without accepting a partial schema", () => {
  const payload = payloadFromKnowledge(sampleKnowledge);
  const partial = JSON.stringify({
    lemma: payload.lemma,
    ipa: payload.ipa,
    partOfSpeech: payload.partOfSpeech,
    meanings: payload.meanings,
  });
  const preview = parseKnowledgePreview(partial, sampleSnapshot);

  assert.equal(preview.lemma, "resilient");
  assert.deepEqual(preview.partOfSpeech, ["adjective"]);
  assert.equal(preview.meanings?.length, sampleKnowledge.meanings.length);
  assert.deepEqual(preview.usage, {
    collocations: [],
    grammarPatterns: [],
    sentencePatterns: [],
    notes: [],
  });
});

test("preview ignores incomplete meanings", () => {
  const preview = parseKnowledgePreview(
    '{"lemma":"resilient","partOfSpeech":["adjective"],"meanings":[{"scope":"contextual"',
    sampleSnapshot,
  );
  assert.equal(preview.lemma, "resilient");
  assert.equal(preview.meanings, undefined);
});

test("repair prompt preserves context and forbids adding knowledge", () => {
  const input = buildGenerationInput(sampleSnapshot);
  const override = buildRepairPrompt(input, '{"invalid":true}', "Missing contextual scope.");
  assert.equal(override.system.length > 0, true);
  assert.match(override.user, /Do not add new facts/);
  assert.match(override.user, /Missing contextual scope/);
  assert.match(override.user, /The team stayed resilient/);
  assert.match(override.user, /<previous_response>/);
});
