import test from "node:test";
import assert from "node:assert/strict";
import {
  KNOWLEDGE_SCHEMA_VERSION,
  KnowledgeSchemaError,
  validateVocabularyKnowledge,
} from "../knowledge.ts";
import {
  applyExplanationEditsToKnowledge,
  knowledgeToLegacyExplanation,
  legacyExplanationToKnowledge,
} from "../migration.ts";
import { sampleExplanation, sampleSnapshot } from "./fixtures.mjs";

function minimalKnowledge() {
  return {
    schemaVersion: 2,
    identity: {
      surface: "specimen",
      lemma: "specimen",
      ipa: "/ˈspesɪmən/",
      partOfSpeech: ["noun"],
      inflections: ["specimens"],
    },
    context: {
      sentence: "The specimen was examined under a microscope.",
      previousSentence: null,
      nextSentence: null,
      contextualMeaningId: "meaning-contextual",
    },
    meanings: [
      {
        id: "meaning-contextual",
        scope: "contextual",
        partOfSpeech: "noun",
        englishDefinition: "A sample used for scientific examination.",
        chineseMeaning: "标本；样本",
        examples: [],
      },
    ],
  };
}

test("legacy explanation becomes canonical v2 knowledge", () => {
  const knowledge = legacyExplanationToKnowledge(sampleExplanation, {
    sentence: sampleSnapshot.sentence,
    previousSentence: "The launch had gone badly.",
    nextSentence: "They met the next morning to plan again.",
    contextConfidence: "high",
  });

  assert.equal(knowledge.schemaVersion, KNOWLEDGE_SCHEMA_VERSION);
  assert.equal(knowledge.schemaVersion, 2);
  assert.equal(knowledge.identity.surface, "resilient");
  assert.equal(knowledge.identity.lemma, "resilient");
  assert.equal(knowledge.identity.ipa, sampleExplanation.phonetic);
  assert.deepEqual(knowledge.identity.partOfSpeech, ["adjective"]);
  assert.deepEqual(knowledge.identity.inflections, []);
  assert.equal(knowledge.context.sentence, sampleSnapshot.sentence);
  assert.equal(knowledge.context.previousSentence, "The launch had gone badly.");
  assert.equal(knowledge.context.nextSentence, "They met the next morning to plan again.");
  assert.equal(knowledge.context.contextConfidence, "high");
  assert.equal(knowledge.context.contextualMeaningId, "meaning-contextual");

  assert.equal(knowledge.meanings.length, 3);
  const contextual = knowledge.meanings.find((meaning) => meaning.scope === "contextual");
  const core = knowledge.meanings.find((meaning) => meaning.scope === "core");
  const other = knowledge.meanings.find((meaning) => meaning.scope === "other");
  assert.equal(contextual?.englishDefinition, sampleExplanation.contextualMeaning);
  assert.equal(contextual?.chineseMeaning, sampleExplanation.chineseMeaning);
  assert.equal(contextual?.examples.length, 2);
  assert.equal(core?.englishDefinition, sampleExplanation.englishDefinition);
  assert.equal(core?.chineseMeaning, "");
  assert.equal(other?.englishDefinition, sampleExplanation.otherMeanings[0].meaning);
});

test("legacy adapter preserves existing knowledge without inventing relations", () => {
  const source = structuredClone(sampleExplanation);
  source.otherMeanings = [
    {
      partOfSpeech: "adjective",
      meaning: "Able to bend and return to shape — 有弹性的",
    },
  ];
  source.uncertainty = "The technical sense is possible but not certain.";

  const knowledge = legacyExplanationToKnowledge(source, {
    sentence: sampleSnapshot.sentence,
  });
  const other = knowledge.meanings.find((meaning) => meaning.scope === "other");

  assert.equal(other?.englishDefinition, "Able to bend and return to shape");
  assert.equal(other?.chineseMeaning, "有弹性的");
  assert.equal(knowledge.usage.collocations.length, 2);
  assert.ok(
    knowledge.usage.grammarPatterns.some(
      (pattern) => pattern.pattern === "be resilient to + noun",
    ),
  );
  assert.ok(
    knowledge.usage.grammarPatterns.some(
      (pattern) =>
        pattern.pattern === "resilient to change" &&
        pattern.note === "Preposition pattern",
    ),
  );
  assert.deepEqual(knowledge.usage.notes, sampleExplanation.grammarNotes.commonMistakes);
  assert.equal(knowledge.nuance.synonyms.length, 2);
  assert.deepEqual(knowledge.nuance.antonyms, []);
  assert.deepEqual(knowledge.nuance.confusables, []);
  assert.deepEqual(knowledge.wordFamily, []);
  assert.deepEqual(knowledge.uncertainty, [source.uncertainty]);
});

test("legacy adapter does not mutate the source explanation", () => {
  const before = structuredClone(sampleExplanation);
  legacyExplanationToKnowledge(sampleExplanation, {
    sentence: sampleSnapshot.sentence,
  });
  assert.deepEqual(sampleExplanation, before);
});

test("legacy round-trip preserves the old flat explanation", () => {
  const knowledge = legacyExplanationToKnowledge(sampleExplanation, {
    sentence: sampleSnapshot.sentence,
  });
  const restored = knowledgeToLegacyExplanation(knowledge);
  assert.deepEqual(restored, sampleExplanation);
});

test("missing optional canonical sections normalize to empty values", () => {
  const knowledge = validateVocabularyKnowledge(minimalKnowledge());

  assert.deepEqual(knowledge.usage, {
    collocations: [],
    grammarPatterns: [],
    sentencePatterns: [],
    notes: [],
  });
  assert.deepEqual(knowledge.nuance, {
    synonyms: [],
    antonyms: [],
    confusables: [],
  });
  assert.deepEqual(knowledge.wordFamily, []);
  assert.deepEqual(knowledge.uncertainty, []);
  assert.equal(knowledge.context.contextConfidence, undefined);
  assert.equal(knowledge.meanings[0].examples.length, 0);
});

test("canonical knowledge without a core meaning falls back to contextual", () => {
  const explanation = knowledgeToLegacyExplanation(minimalKnowledge());
  assert.equal(explanation.word, "specimen");
  assert.equal(explanation.englishDefinition, "A sample used for scientific examination.");
  assert.equal(explanation.contextualMeaning, "A sample used for scientific examination.");
  assert.equal(explanation.chineseMeaning, "标本；样本");
});

test("canonical validation does not mutate its input", () => {
  const source = minimalKnowledge();
  const before = structuredClone(source);
  validateVocabularyKnowledge(source);
  assert.deepEqual(source, before);
});

test("rejects missing or unsupported knowledge schema versions", () => {
  const missing = structuredClone(minimalKnowledge());
  delete missing.schemaVersion;
  assert.throws(
    () => validateVocabularyKnowledge(missing),
    (error) => error instanceof KnowledgeSchemaError && /schemaVersion/.test(error.message),
  );

  const unsupported = { ...minimalKnowledge(), schemaVersion: 3 };
  assert.throws(
    () => validateVocabularyKnowledge(unsupported),
    (error) => error instanceof KnowledgeSchemaError && /Unsupported.*3/.test(error.message),
  );
});

test("rejects duplicate meaning ids", () => {
  const source = structuredClone(minimalKnowledge());
  source.meanings.push({
    ...structuredClone(source.meanings[0]),
    scope: "core",
  });
  assert.throws(
    () => validateVocabularyKnowledge(source),
    (error) => error instanceof KnowledgeSchemaError && /Duplicate meaning id/.test(error.message),
  );
});

test("rejects an invalid contextual meaning reference", () => {
  const missing = structuredClone(minimalKnowledge());
  missing.context.contextualMeaningId = "missing-meaning";
  assert.throws(
    () => validateVocabularyKnowledge(missing),
    (error) =>
      error instanceof KnowledgeSchemaError && /contextualMeaningId/.test(error.message),
  );

  const coreOnly = structuredClone(minimalKnowledge());
  coreOnly.meanings.push({
    id: "meaning-core",
    scope: "core",
    partOfSpeech: "noun",
    englishDefinition: "A general sense.",
    chineseMeaning: "一般含义",
    examples: [],
  });
  coreOnly.context.contextualMeaningId = "meaning-core";
  assert.throws(
    () => validateVocabularyKnowledge(coreOnly),
    (error) =>
      error instanceof KnowledgeSchemaError && /contextual meaning/.test(error.message),
  );
});

test("validates confidence, usage shapes, and required definitions", () => {
  const badConfidence = structuredClone(minimalKnowledge());
  badConfidence.context.contextConfidence = "certain";
  assert.throws(
    () => validateVocabularyKnowledge(badConfidence),
    (error) => error instanceof KnowledgeSchemaError && /contextConfidence/.test(error.message),
  );

  const badUsage = structuredClone(minimalKnowledge());
  badUsage.usage = { collocations: [{ meaning: "missing phrase" }] };
  assert.throws(
    () => validateVocabularyKnowledge(badUsage),
    (error) => error instanceof KnowledgeSchemaError && /collocations\[0\]\.phrase/.test(error.message),
  );

  const badDefinition = structuredClone(minimalKnowledge());
  badDefinition.meanings[0].englishDefinition = "";
  assert.throws(
    () => validateVocabularyKnowledge(badDefinition),
    (error) =>
      error instanceof KnowledgeSchemaError && /englishDefinition/.test(error.message),
  );
});

test("legacy editor changes update canonical fields and preserve advanced data", () => {
  const knowledge = structuredClone(legacyExplanationToKnowledge(sampleExplanation, {
    sentence: sampleSnapshot.sentence,
    previousSentence: "Previous context.",
    nextSentence: "Next context.",
  }));
  knowledge.nuance.antonyms = [
    { word: "fragile", difference: "Fragile means easily damaged." },
  ];
  knowledge.nuance.confusables = [
    { word: "resistant", difference: "Resistant means opposing something." },
  ];
  knowledge.wordFamily = [
    { word: "resilience", partOfSpeech: "noun", chineseMeaning: "韧性" },
  ];
  knowledge.usage.sentencePatterns = [{ pattern: "remain resilient" }];

  const edited = {
    ...structuredClone(sampleExplanation),
    word: "resilient",
    chineseMeaning: "编辑后的中文",
    examples: [],
    otherMeanings: [],
    collocations: [],
    synonyms: [],
    uncertainty: "Edited uncertainty.",
    sourceSentence: "Edited source sentence.",
    grammarNotes: { patterns: [], prepositions: [], commonMistakes: [] },
  };
  const updated = applyExplanationEditsToKnowledge(knowledge, edited);

  assert.equal(updated.meanings.find((m) => m.scope === "contextual").chineseMeaning, "编辑后的中文");
  assert.equal(updated.meanings.find((m) => m.scope === "contextual").examples.length, 0);
  assert.equal(updated.usage.collocations.length, 0);
  assert.equal(updated.nuance.synonyms.length, 0);
  assert.equal(updated.nuance.antonyms[0].word, "fragile");
  assert.equal(updated.nuance.confusables[0].word, "resistant");
  assert.equal(updated.wordFamily[0].word, "resilience");
  assert.equal(updated.usage.sentencePatterns[0].pattern, "remain resilient");
  assert.equal(updated.context.previousSentence, "Previous context.");
  assert.equal(updated.context.sentence, "Edited source sentence.");
  assert.deepEqual(updated.uncertainty, ["Edited uncertainty."]);
});

test("invalid canonical payloads are rejected", () => {
  const invalid = { ...minimalKnowledge(), schemaVersion: 3 };
  assert.throws(
    () => validateVocabularyKnowledge(invalid),
    (error) => error instanceof KnowledgeSchemaError,
  );
});
