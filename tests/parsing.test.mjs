import test from "node:test";
import assert from "node:assert/strict";
import {
  ExplanationParseError,
  extractJsonObject,
  validateExplanation,
} from "../parsing.ts";
import {
  buildAnalysisKey,
  buildUserPrompt,
} from "../prompts.ts";
import {
  buildGenerationInput,
  DEFAULT_GENERATION_PROFILE,
} from "../generation.ts";
import { sampleExplanation, sampleSnapshot } from "./fixtures.mjs";

test("extracts balanced braces inside JSON strings", () => {
  const explanation = structuredClone(sampleExplanation);
  explanation.contextualMeaning = 'It may look like {"a": 1} in the sentence.';
  const raw = JSON.stringify(explanation);
  const extracted = extractJsonObject(raw);
  assert.deepEqual(JSON.parse(extracted), explanation);
});

test("rejects a schema violation instead of returning a partial explanation", () => {
  const missing = structuredClone(sampleExplanation);
  delete missing.englishDefinition;
  assert.throws(() => validateExplanation(missing), ExplanationParseError);

  const tooFewExamples = structuredClone(sampleExplanation);
  tooFewExamples.examples = [tooFewExamples.examples[0]];
  assert.throws(() => validateExplanation(tooFewExamples), ExplanationParseError);

  const wrongType = structuredClone(sampleExplanation);
  wrongType.partOfSpeech = "adjective";
  assert.throws(() => validateExplanation(wrongType), ExplanationParseError);
});

test("prompt keeps the canonical contract and a compact output budget", () => {
  const prompt = buildUserPrompt(buildGenerationInput(sampleSnapshot));
  assert.match(prompt, /Return EXACTLY ONE valid JSON object/);
  assert.match(prompt, /"meanings"/);
  assert.match(prompt, /"englishDefinition"/);
  assert.match(prompt, /"grammarPatterns"/);
  assert.match(prompt, /at least one meaning with scope "contextual"/);
  assert.match(prompt, /Collocations: 0–3/);
  assert.match(prompt, /Do not output Mermaid, SVG, HTML/);
  assert.match(prompt, /"targetLanguage":"en"/);
  assert.match(prompt, /"explanationLanguage":"zh-CN"/);
  assert.match(prompt, /"learnerLevel":"intermediate"/);
  assert.match(prompt, /"explanationDepth":"standard"/);
  assert.match(prompt, /"previousSentence":"The launch had gone badly\."/);
  assert.match(prompt, /"nextSentence":"They met the next morning to plan again\."/);
  assert.match(prompt, /The team stayed resilient/);

  // Static contract first maximizes provider-side prompt cache reuse.
  assert.ok(prompt.indexOf('"meanings"') < prompt.indexOf("<document_data>"));
  assert.ok(prompt.indexOf("<document_data>") < prompt.indexOf(sampleSnapshot.sentence));
});

test("analysis keys include model, profile, and context", () => {
  const base = buildAnalysisKey("resilient", sampleSnapshot.context, "deepseek-flash");
  const same = buildAnalysisKey("Resilient", ` ${sampleSnapshot.context} `, "DEEPSEEK-FLASH");
  const otherContext = buildAnalysisKey("resilient", "A different sentence.", "deepseek-flash");
  const otherModel = buildAnalysisKey("resilient", sampleSnapshot.context, "other-model");
  const otherLevel = buildAnalysisKey(
    "resilient",
    sampleSnapshot.context,
    "deepseek-flash",
    { ...DEFAULT_GENERATION_PROFILE, learnerLevel: "advanced" },
  );
  const otherDepth = buildAnalysisKey(
    "resilient",
    sampleSnapshot.context,
    "deepseek-flash",
    { ...DEFAULT_GENERATION_PROFILE, explanationDepth: "detailed" },
  );

  assert.equal(base, same);
  assert.notEqual(base, otherContext);
  assert.notEqual(base, otherModel);
  assert.notEqual(base, otherLevel);
  assert.notEqual(base, otherDepth);
});
