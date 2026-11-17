import type { Meaning } from "./knowledge.ts";

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "who",
  "whom",
  "whose",
  "which",
  "that",
  "especially",
  "usually",
  "typically",
  "someone",
  "somebody",
  "something",
  "one",
  "of",
  "in",
  "on",
  "at",
  "to",
  "for",
  "with",
  "or",
  "and",
  "as",
  "is",
  "are",
  "be",
  "being",
  "been",
  "person",
]);

function normalizeToken(raw: string): string {
  let token = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (!token) {
    return "";
  }
  if (token === "people" || token === "persons") {
    return "person";
  }
  if (token.endsWith("ies") && token.length > 4) {
    token = `${token.slice(0, -3)}y`;
  } else if (token.endsWith("es") && token.length > 4) {
    token = token.slice(0, -2);
  } else if (token.endsWith("s") && !token.endsWith("ss")) {
    token = token.slice(0, -1);
  }
  token = token.replace(/(?:ing|ed|ly)$/, "");
  return token.length > 2 ? token : "";
}

const EXPLANATORY_GLOSS =
  /学科|科目|研究|领域|应用|理论|方法|用法|语境|含义|教育|专业|科学|数学/;

function annotatedChinese(gloss: string): { head: string; note: string } | null {
  const match = /^\s*(.+?)\s*[（(](.+)[）)]\s*$/.exec(gloss.trim());
  if (!match) {
    return null;
  }
  const head = (match[1] ?? "").replace(/[\s，,；;、/]+/g, "").trim();
  const note = (match[2] ?? "").trim();
  return head ? { head, note } : null;
}

/**
 * Catches glosses such as:
 *   数学（研究数量、结构、模式与逻辑的学科）
 *   数学（学科科目）
 * without merging genuinely different parenthetical senses such as
 *   苹果（水果） / 苹果（公司）.
 */
function hasSameExplanatoryChineseHeadword(left: Meaning, right: Meaning): boolean {
  const a = annotatedChinese(left.chineseMeaning);
  const b = annotatedChinese(right.chineseMeaning);
  if (!a || !b || a.head !== b.head) {
    return false;
  }
  return EXPLANATORY_GLOSS.test(a.note) && EXPLANATORY_GLOSS.test(b.note);
}

function contentTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z]+/)) {
    const token = normalizeToken(raw);
    if (token && !STOP_WORDS.has(token)) {
      tokens.add(token);
    }
  }
  return tokens;
}

/**
 * Conservative near-duplicate check for paraphrased dictionary senses.
 * It only merges when the shorter definition's content is almost entirely
 * contained in the longer one. This catches cases such as:
 *   "People who study or work in mathematics..." vs
 *   "A person who is an expert in mathematics."
 * while leaving genuinely different senses (bank: finance vs river) alone.
 */
export function isSemanticallyDuplicateMeaning(left: Meaning, right: Meaning): boolean {
  if (hasSameExplanatoryChineseHeadword(left, right)) {
    return true;
  }
  const leftTokens = contentTokens(left.englishDefinition);
  const rightTokens = contentTokens(right.englishDefinition);
  if (leftTokens.size < 2 || rightTokens.size < 2) {
    return false;
  }
  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      shared += 1;
    }
  }
  const coverage = shared / Math.min(leftTokens.size, rightTokens.size);
  return shared >= 2 && coverage >= 0.8;
}
