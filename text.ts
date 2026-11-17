const NON_LATIN_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Thai}\p{Script=Devanagari}]/u;

const LATIN_LETTER = /\p{Script=Latin}/u;
const ALLOWED_PHRASE =
  /^(?:['’‘]?\p{Script=Latin}[\p{Script=Latin}\p{M}\p{N}'’‘\-.]*)(?:[\s\-/]+['’‘]?\p{Script=Latin}[\p{Script=Latin}\p{M}\p{N}'’‘\-.]*)*$/u;

const MAX_WORD_COUNT = 8;
const MAX_SELECTION_CHARS = 80;
const MAX_CONTEXT_CHARS = 1800;
const MAX_NEIGHBOR_SENTENCE_CHARS = 400;

export interface TextContext {
  sentence: string;
  context: string;
  previousSentence: string | null;
  nextSentence: string | null;
}

export interface ContextOptions {
  /** Strip inline Markdown formatting from the sentence and context. */
  cleanMarkdown?: boolean;
  maxContextChars?: number;
}

/** Normalize a browser/editor selection into a target word or phrase. */
export function normalizeEnglishSelection(raw: string): string | null {
  const collapsed = raw
    .normalize("NFC")
    .replace(/\uFEFF/g, "")
    .replace(/[\u200B-\u200D]/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!collapsed || collapsed.length > 240) {
    return null;
  }

  if (NON_LATIN_SCRIPT.test(collapsed)) {
    return null;
  }

  const first = collapsed.search(LATIN_LETTER);
  if (first < 0) {
    return null;
  }

  let last = collapsed.length - 1;
  while (last >= first && !LATIN_LETTER.test(collapsed.charAt(last))) {
    last -= 1;
  }
  if (last < first) {
    return null;
  }

  let target = collapsed.slice(first, last + 1).trim();
  if (!target) {
    return null;
  }

  // A trailing possessive apostrophe is not a problem; punctuation around the
  // selection has already been trimmed by finding the last Latin letter.
  target = target
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\u201C\u201D]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (target.length > MAX_SELECTION_CHARS) {
    return null;
  }

  if (!ALLOWED_PHRASE.test(target)) {
    return null;
  }

  const wordCount = target.split(/\s+/).filter(Boolean).length;
  if (wordCount < 1 || wordCount > MAX_WORD_COUNT) {
    return null;
  }

  return target;
}

/** Remove common inline Markdown syntax without changing the prose itself. */
export function cleanMarkdownText(input: string): string {
  let text = input.replace(/\r\n?/g, "\n");

  text = text
    .replace(/!\[\[[^\]]*\]\]/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`{3,}[^\n]*\n([\s\S]*?)`{3,}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<\/(?:strong|em|mark|del|code|span)>/gi, "")
    .replace(/<\/?(?:strong|em|mark|del|code|span)\b[^>]*>/gi, "")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/==([^=]+)==/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*(?:[-+*]|\d+\.)\s+/gm, "")
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/\\([\\`*{}[\]()#+\-.!_>])/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  return text;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function truncateEnd(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  return `${slice.slice(0, lastSpace > maxChars * 0.6 ? lastSpace : maxChars).trim()}…`;
}

function truncateStart(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const slice = text.slice(text.length - maxChars);
  const firstSpace = slice.indexOf(" ");
  return `…${slice.slice(firstSpace >= 0 && firstSpace < maxChars * 0.4 ? firstSpace + 1 : 0).trim()}`;
}

function sentenceUnits(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [];
  }

  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
    return [...segmenter.segment(normalized)]
      .map((data) => data.segment.trim())
      .filter((sentence) => sentence.length > 0);
  }

  return (normalized.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [])
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** Pick the adjacent sentence closest to the selected sentence. */
function nearestSentence(text: string, direction: "previous" | "next"): string | null {
  const sentences = sentenceUnits(text);
  const sentence = direction === "previous" ? sentences[sentences.length - 1] : sentences[0];
  if (!sentence) {
    return null;
  }
  return direction === "previous"
    ? truncateStart(sentence, MAX_NEIGHBOR_SENTENCE_CHARS)
    : truncateEnd(sentence, MAX_NEIGHBOR_SENTENCE_CHARS);
}

interface SentenceParts {
  before: string;
  sentence: string;
  after: string;
}

/** Return the exact rendered-text range of the sentence containing a selection. */
export function sentenceOffsetsAt(text: string, from: number, to: number): { start: number; end: number } | null {
  if (!text || from < 0 || to <= from || to > text.length) {
    return null;
  }

  let start = -1;
  let end = -1;
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
    for (const data of segmenter.segment(text)) {
      const candidateStart = data.index;
      const candidateEnd = candidateStart + data.segment.length;
      if (candidateStart <= from && from < candidateEnd && to <= candidateEnd) {
        start = candidateStart;
        end = candidateEnd;
        break;
      }
    }
  }

  if (start < 0) {
    const paragraph = findParagraphBounds(text, from);
    const paragraphText = text.slice(paragraph.start, paragraph.end);
    const localFrom = from - paragraph.start;
    const localTo = to - paragraph.start;
    const boundary = /(?:[.!?](?=\s|$))|\n/g;
    let localStart = 0;
    for (const match of paragraphText.slice(0, localFrom).matchAll(boundary)) {
      localStart = (match.index ?? 0) + match[0].length;
    }
    const next = boundary.exec(paragraphText.slice(localTo));
    start = paragraph.start + localStart;
    end = next ? paragraph.start + localTo + (next.index ?? 0) + next[0].length : paragraph.end;
  }

  while (start < end && /\s/.test(text[start] ?? "")) {
    start += 1;
  }
  while (end > start && /\s/.test(text[end - 1] ?? "")) {
    end -= 1;
  }
  return start < end ? { start, end } : null;
}

function findSentenceWithSegmenter(text: string, from: number, to: number): SentenceParts | null {
  if (typeof Intl.Segmenter !== "function") {
    return null;
  }

  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  let before = "";
  let sentence: string | null = null;

  for (const data of segmenter.segment(text)) {
    const start = data.index;
    const end = data.index + data.segment.length;
    if (sentence === null) {
      if (start <= from && from < end) {
        sentence = data.segment;
        if (to > end) {
          // The selection crosses a sentence boundary. Use the first sentence:
          // the English-selection length guard makes this extremely uncommon.
          return null;
        }
      } else if (end <= from) {
        before = data.segment;
      }
      continue;
    }

    return { before, sentence, after: data.segment };
  }

  return sentence === null ? null : { before, sentence, after: "" };
}

function findParagraphBounds(text: string, from: number): { start: number; end: number } {
  const blankBefore = text.lastIndexOf("\n\n", Math.max(0, from - 1));
  const blankAfter = text.indexOf("\n\n", from);
  return {
    start: blankBefore < 0 ? 0 : blankBefore + 2,
    end: blankAfter < 0 ? text.length : blankAfter,
  };
}

function findSentenceFallback(text: string, from: number, to: number): SentenceParts | null {
  const paragraph = findParagraphBounds(text, from);
  const paragraphText = text.slice(paragraph.start, paragraph.end);
  const localFrom = clamp(from - paragraph.start, 0, paragraphText.length);
  const localTo = clamp(to - paragraph.start, localFrom, paragraphText.length);
  const beforeText = paragraphText.slice(0, localFrom);
  const afterText = paragraphText.slice(localTo);

  const boundary = /(?:[.!?](?=\s|$))|\n/g;
  let sentenceStart = 0;
  for (const match of beforeText.matchAll(boundary)) {
    const matchEnd = (match.index ?? 0) + match[0].length;
    if (matchEnd <= beforeText.length) {
      sentenceStart = matchEnd;
    }
  }

  const nextBoundary = /(?:[.!?](?=\s|$))|\n/g.exec(afterText);
  const sentenceEnd = nextBoundary
    ? localTo + (nextBoundary.index ?? 0) + nextBoundary[0].length
    : paragraphText.length;

  const sentence = paragraphText.slice(sentenceStart, sentenceEnd).trim();
  if (!sentence) {
    return null;
  }

  const before = paragraphText.slice(0, sentenceStart);
  const after = paragraphText.slice(sentenceEnd);
  return { before, sentence, after };
}

/**
 * Extract the complete sentence containing [from, to), plus one sentence of
 * context on each side. Offsets refer to `source`.
 */
export function extractTextContext(source: string, from: number, to: number, options: ContextOptions = {}): TextContext | null {
  if (!source) {
    return null;
  }

  const start = clamp(Math.min(from, to), 0, source.length);
  const end = clamp(Math.max(from, to), 0, source.length);
  if (start === end) {
    return null;
  }

  const rawParts = findSentenceWithSegmenter(source, start, end) ?? findSentenceFallback(source, start, end);
  if (!rawParts) {
    return null;
  }

  const maxContext = options.maxContextChars ?? MAX_CONTEXT_CHARS;
  const clean = options.cleanMarkdown ?? true;
  const sentenceRaw = rawParts.sentence.trim();
  if (!sentenceRaw) {
    return null;
  }

  const normalizedSentence = clean ? cleanMarkdownText(sentenceRaw) : sentenceRaw.replace(/\s+/g, " ").trim();
  if (!normalizedSentence) {
    return null;
  }

  const before = clean ? cleanMarkdownText(rawParts.before) : rawParts.before.replace(/\s+/g, " ").trim();
  const after = clean ? cleanMarkdownText(rawParts.after) : rawParts.after.replace(/\s+/g, " ").trim();

  const baseLength = normalizedSentence.length;
  const budget = Math.max(0, maxContext - baseLength);
  const beforeBudget = Math.min(before.length, Math.floor(budget / 2));
  const afterBudget = Math.min(after.length, budget - beforeBudget);

  const contextParts = [
    beforeBudget > 0 ? truncateEnd(before, beforeBudget) : "",
    normalizedSentence,
    afterBudget > 0 ? truncateStart(after, afterBudget) : "",
  ].filter((part) => part.length > 0);

  return {
    sentence: normalizedSentence,
    context: contextParts.join(" ").trim(),
    previousSentence: nearestSentence(before, "previous"),
    nextSentence: nearestSentence(after, "next"),
  };
}

/**
 * Build context around text that has already been extracted from rendered HTML.
 * Neighbour snippets are bounded; the complete selected sentence is preserved.
 */
export function buildRenderedContext(
  blockText: string,
  from: number,
  to: number,
  previousBlockText = "",
  nextBlockText = "",
): TextContext | null {
  const textContext = extractTextContext(blockText, from, to, { cleanMarkdown: false, maxContextChars: 1000 });
  if (!textContext) {
    return null;
  }

  const previous = truncateEnd(previousBlockText.replace(/\s+/g, " ").trim(), 300);
  const next = truncateStart(nextBlockText.replace(/\s+/g, " ").trim(), 300);
  const parts = [previous, textContext.sentence, next].filter((part) => part.length > 0);

  return {
    sentence: textContext.sentence,
    context: parts.join(" ").trim(),
    previousSentence:
      textContext.previousSentence ?? nearestSentence(previousBlockText, "previous"),
    nextSentence: textContext.nextSentence ?? nearestSentence(nextBlockText, "next"),
  };
}
