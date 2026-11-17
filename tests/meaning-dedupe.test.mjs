import test from "node:test";
import assert from "node:assert/strict";
import { isSemanticallyDuplicateMeaning } from "../meaning-dedupe.ts";

function meaning(englishDefinition, chineseMeaning = "") {
  return { englishDefinition, chineseMeaning };
}

test("detects the mathematician paraphrase as one sense", () => {
  const first = meaning(
    "People who study or work in mathematics, especially as experts or researchers.",
  );
  const second = meaning("A person who is an expert in mathematics.");
  assert.equal(isSemanticallyDuplicateMeaning(first, second), true);
  assert.equal(isSemanticallyDuplicateMeaning(second, first), true);
});

test("merges explanatory Chinese glosses with the same headword", () => {
  const field = meaning(
    "The abstract study of numbers, shapes, patterns and logical structures.",
    "数学（研究数量、结构、模式与逻辑的学科）",
  );
  const subject = meaning(
    "The school or university subject that deals with numbers, quantities and shapes.",
    "数学（学科科目）",
  );
  assert.equal(isSemanticallyDuplicateMeaning(field, subject), true);
});

test("does not merge parentheticals that distinguish referents", () => {
  const fruit = meaning("The round fruit of a tree.", "苹果（水果）");
  const company = meaning("A technology company.", "苹果（公司）");
  assert.equal(isSemanticallyDuplicateMeaning(fruit, company), false);
});

test("keeps genuinely different senses", () => {
  const finance = meaning("A financial institution that accepts deposits.");
  const river = meaning("The land alongside a river.");
  assert.equal(isSemanticallyDuplicateMeaning(finance, river), false);

  const books = meaning("A person who writes books.");
  const music = meaning("A person who writes music.");
  assert.equal(isSemanticallyDuplicateMeaning(books, music), false);
});
