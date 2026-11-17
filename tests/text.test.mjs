import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRenderedContext,
  cleanMarkdownText,
  extractTextContext,
  normalizeEnglishSelection,
  sentenceOffsetsAt,
} from "../text.ts";

test("normalizes a single English word and surrounding punctuation", () => {
  assert.equal(normalizeEnglishSelection("  Hello.  "), "Hello");
  assert.equal(normalizeEnglishSelection("“resilient”"), "resilient");
  assert.equal(normalizeEnglishSelection("(well-made)"), "well-made");
  assert.equal(normalizeEnglishSelection("don’t"), "don't");
  assert.equal(normalizeEnglishSelection("rock  ’n’  roll"), "rock 'n' roll");
  assert.equal(normalizeEnglishSelection("rock  ‘n’  roll"), "rock 'n' roll");
});

test("accepts useful phrases and rejects long selections", () => {
  assert.equal(normalizeEnglishSelection("take   off"), "take off");
  assert.equal(normalizeEnglishSelection("state-of-the-art"), "state-of-the-art");
  assert.equal(normalizeEnglishSelection("and/or"), "and/or");
  assert.equal(normalizeEnglishSelection("one two three four five six seven eight nine"), null);
  assert.equal(normalizeEnglishSelection("a".repeat(81)), null);
});

test("rejects non-English and non-word selections", () => {
  assert.equal(normalizeEnglishSelection("你好"), null);
  assert.equal(normalizeEnglishSelection("hello 世界"), null);
  assert.equal(normalizeEnglishSelection("Привет"), null);
  assert.equal(normalizeEnglishSelection("12345"), null);
  assert.equal(normalizeEnglishSelection("..."), null);
  assert.equal(normalizeEnglishSelection(""), null);
});

test("cleans common inline Markdown while preserving prose", () => {
  const input =
    "This is **very** [useful](https://example.com) and [[A Note|linked text]], plus `inline code` and ~~old~~ text.";
  const cleaned = cleanMarkdownText(input);
  assert.equal(cleaned, "This is very useful and linked text, plus inline code and old text.");
});

test("extracts the complete sentence and one neighbouring sentence of context", () => {
  const source =
    "Alpha opened the meeting. The team stayed resilient after the first product launch failed. Omega closed the meeting.";
  const start = source.indexOf("resilient");
  const end = start + "resilient".length;
  const context = extractTextContext(source, start, end);

  assert.ok(context);
  assert.equal(context.sentence, "The team stayed resilient after the first product launch failed.");
  assert.equal(context.previousSentence, "Alpha opened the meeting.");
  assert.equal(context.nextSentence, "Omega closed the meeting.");
  assert.match(context.context, /Alpha opened the meeting\./);
  assert.match(context.context, /Omega closed the meeting\./);
});

test("records the exact rendered sentence range for a selected word", () => {
  const block = "First resilient occurrence is here. Second resilient occurrence is the target.";
  const start = block.lastIndexOf("resilient");
  const offsets = sentenceOffsetsAt(block, start, start + "resilient".length);

  assert.deepEqual(offsets, {
    start: block.indexOf("Second"),
    end: block.length,
  });
  assert.equal(block.slice(offsets.start, offsets.end), "Second resilient occurrence is the target.");
});

test("returns null for missing neighbouring sentences", () => {
  const source = "The team stayed resilient.";
  const start = source.indexOf("resilient");
  const context = extractTextContext(source, start, start + "resilient".length);

  assert.ok(context);
  assert.equal(context.previousSentence, null);
  assert.equal(context.nextSentence, null);
});

test("rendered context uses the nearest sentences inside the block", () => {
  const block = "Alpha opens the meeting. The team stayed resilient. Omega closes the meeting.";
  const start = block.indexOf("resilient");
  const context = buildRenderedContext(
    block,
    start,
    start + "resilient".length,
    "An earlier paragraph.",
    "A later paragraph.",
  );

  assert.ok(context);
  assert.equal(context.previousSentence, "Alpha opens the meeting.");
  assert.equal(context.nextSentence, "Omega closes the meeting.");
});

test("rendered context falls back to adjacent blocks when the block has one sentence", () => {
  const block = "The team stayed resilient.";
  const start = block.indexOf("resilient");
  const context = buildRenderedContext(
    block,
    start,
    start + "resilient".length,
    "The launch had gone badly.",
    "They met the next morning to plan again.",
  );

  assert.ok(context);
  assert.equal(context.previousSentence, "The launch had gone badly.");
  assert.equal(context.nextSentence, "They met the next morning to plan again.");
});

test("cleans Markdown from the sentence while extracting context", () => {
  const source = "This **resilient** plan works. Next sentence.";
  const start = source.indexOf("resilient");
  const end = start + "resilient".length;
  const context = extractTextContext(source, start, end);

  assert.ok(context);
  assert.equal(context.sentence, "This resilient plan works.");
  assert.ok(!context.sentence.includes("**"));
});

test("returns null for a collapsed range", () => {
  const source = "The team stayed resilient.";
  const start = source.indexOf("resilient");
  assert.equal(extractTextContext(source, start, start), null);
});
