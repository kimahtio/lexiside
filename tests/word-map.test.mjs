import test from "node:test";
import assert from "node:assert/strict";
import { deriveRelations, selectWordMapRelations } from "../relations.ts";
import {
  buildWordMapMermaid,
  buildWordMapModel,
  isProperNoun,
  wordMapMermaidBlock,
} from "../word-map.ts";
import { sampleKnowledge } from "./fixtures.mjs";

function fullKnowledge() {
  const knowledge = structuredClone(sampleKnowledge);
  knowledge.nuance.antonyms = [
    { word: "fragile", difference: "Fragile means easily damaged." },
  ];
  knowledge.nuance.confusables = [
    { word: "resistant", difference: "Resistant means opposing something." },
  ];
  knowledge.wordFamily = [
    { word: "resilience", partOfSpeech: "noun", chineseMeaning: "韧性" },
  ];
  return knowledge;
}

test("derives typed relations locally with direction and sense IDs", () => {
  const knowledge = fullKnowledge();
  const relations = deriveRelations(knowledge);
  const types = new Set(relations.map((relation) => relation.type));

  assert.ok(types.has("synonym_of"));
  assert.ok(types.has("antonym_of"));
  assert.ok(types.has("contrasts_with"));
  assert.ok(types.has("derives_to"));
  assert.ok(types.has("commonly_used_with"));
  assert.ok(types.has("follows_pattern"));
  const family = relations.find((relation) => relation.type === "derives_to");
  assert.equal(family?.source, "resilient");
  assert.equal(family?.target, "resilience");
  assert.equal(family?.senseId, knowledge.context.contextualMeaningId);
});

test("selects a balanced set of at most six relations", () => {
  const selected = selectWordMapRelations(fullKnowledge(), 6);
  assert.ok(selected.length >= 4 && selected.length <= 6);
  assert.equal(new Set(selected.map((relation) => relation.id)).size, selected.length);
});

test("builds a fixed Mermaid template with short, escaped labels", () => {
  const knowledge = fullKnowledge();
  knowledge.identity.surface = 'resilient "team" <b>now</b>';
  knowledge.nuance.synonyms[0].word = 'tough"\nnext';
  const model = buildWordMapModel(knowledge, 6);
  assert.ok(model);
  const mermaid = buildWordMapMermaid(model);
  assert.ok(mermaid);
  assert.match(mermaid, /flowchart TD/);
  assert.match(mermaid, /W\(\[/);
  assert.doesNotMatch(mermaid, /<b>/);
  assert.doesNotMatch(mermaid, /tough"\n/);
  const nodes = mermaid.split("\n").filter((line) => / n\d+\[/.test(line));
  assert.ok(nodes.length >= 1 && nodes.length <= 6);
  assert.ok(wordMapMermaidBlock(model)?.startsWith("```mermaid"));
});

test("omits the map for proper nouns", () => {
  const knowledge = fullKnowledge();
  knowledge.identity.partOfSpeech = ["proper noun"];
  assert.equal(isProperNoun(knowledge), true);
  assert.equal(buildWordMapModel(knowledge), null);

  knowledge.identity.partOfSpeech = ["proper-noun (place)"];
  assert.equal(isProperNoun(knowledge), true);
  assert.equal(buildWordMapModel(knowledge), null);
});

test("keeps the map for ordinary nouns", () => {
  const knowledge = fullKnowledge();
  knowledge.identity.partOfSpeech = ["noun"];
  assert.equal(isProperNoun(knowledge), false);
  assert.ok(buildWordMapModel(knowledge, 4));
});

test("returns no map when no relations are supported", () => {
  const knowledge = structuredClone(sampleKnowledge);
  knowledge.nuance = { synonyms: [], antonyms: [], confusables: [] };
  knowledge.usage = {
    collocations: [],
    grammarPatterns: [],
    sentencePatterns: [],
    notes: [],
  };
  knowledge.wordFamily = [];
  assert.equal(buildWordMapModel(knowledge), null);
  assert.equal(buildWordMapMermaid({ center: "word", relations: [] }), null);
});
