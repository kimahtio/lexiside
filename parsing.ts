import {
  KnowledgeSchemaError,
  type Meaning,
  type VocabularyKnowledge,
} from "./knowledge.ts";
import { finalizeVocabularyKnowledge } from "./knowledge-generation.ts";
import type {
  Collocation,
  ExampleSentence,
  Explanation,
  GrammarNotes,
  KnowledgePreview,
  OtherMeaning,
  SelectionSnapshot,
  Synonym,
} from "./types.ts";

const MAX_STRING_LENGTH = 4000;
const MAX_ARRAY_LENGTH = 40;

export class ExplanationParseError extends Error {
  readonly details: string | null;

  constructor(message: string, details: string | null = null) {
    super(message);
    this.name = "ExplanationParseError";
    this.details = details;
  }
}

export class KnowledgeParseError extends Error {
  readonly details: string | null;

  constructor(message: string, details: string | null = null) {
    super(message);
    this.name = "KnowledgeParseError";
    this.details = details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  options: { allowEmpty?: boolean } = {},
): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new ExplanationParseError(`The model response is missing the string field "${path}".`);
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_STRING_LENGTH) {
    throw new ExplanationParseError(`The field "${path}" is unexpectedly long.`);
  }
  if (!options.allowEmpty && trimmed.length === 0) {
    throw new ExplanationParseError(`The field "${path}" must not be empty.`);
  }
  return trimmed;
}

function readStringArray(
  record: Record<string, unknown>,
  key: string,
  path: string,
  options: { requireNonEmptyItem?: boolean } = {},
): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new ExplanationParseError(`The model response is missing the array field "${path}".`);
  }
  if (value.length > MAX_ARRAY_LENGTH) {
    throw new ExplanationParseError(`The field "${path}" contains too many items.`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new ExplanationParseError(`The item "${path}[${index}]" must be a string.`);
    }
    const trimmed = item.trim();
    if (trimmed.length > MAX_STRING_LENGTH) {
      throw new ExplanationParseError(`The item "${path}[${index}]" is unexpectedly long.`);
    }
    if (options.requireNonEmptyItem !== false && trimmed.length === 0) {
      throw new ExplanationParseError(`The item "${path}[${index}]" must not be empty.`);
    }
    return trimmed;
  });
}

function readArray<T>(
  record: Record<string, unknown>,
  key: string,
  path: string,
  parser: (value: unknown, itemPath: string) => T,
): T[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new ExplanationParseError(`The model response is missing the array field "${path}".`);
  }
  if (value.length > MAX_ARRAY_LENGTH) {
    throw new ExplanationParseError(`The field "${path}" contains too many items.`);
  }
  return value.map((item, index) => parser(item, `${path}[${index}]`));
}

function readObject(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ExplanationParseError(`The model response is missing the object field "${path}".`);
  }
  return value;
}

function parseOtherMeaning(value: unknown, path: string): OtherMeaning {
  const record = readObject(value, path);
  return {
    partOfSpeech: readString(record, "partOfSpeech", `${path}.partOfSpeech`, { allowEmpty: true }),
    meaning: readString(record, "meaning", `${path}.meaning`),
  };
}

function parseCollocation(value: unknown, path: string): Collocation {
  const record = readObject(value, path);
  return {
    phrase: readString(record, "phrase", `${path}.phrase`),
    meaning: readString(record, "meaning", `${path}.meaning`),
  };
}

function parseExample(value: unknown, path: string): ExampleSentence {
  const record = readObject(value, path);
  return {
    english: readString(record, "english", `${path}.english`),
    chinese: readString(record, "chinese", `${path}.chinese`),
  };
}

function parseSynonym(value: unknown, path: string): Synonym {
  const record = readObject(value, path);
  return {
    word: readString(record, "word", `${path}.word`),
    difference: readString(record, "difference", `${path}.difference`),
    usage: readString(record, "usage", `${path}.usage`),
  };
}

function parseGrammarNotes(value: unknown): GrammarNotes {
  const record = readObject(value, "grammarNotes");
  return {
    patterns: readStringArray(record, "patterns", "grammarNotes.patterns", { requireNonEmptyItem: false }),
    prepositions: readStringArray(record, "prepositions", "grammarNotes.prepositions", {
      requireNonEmptyItem: false,
    }),
    commonMistakes: readStringArray(record, "commonMistakes", "grammarNotes.commonMistakes", {
      requireNonEmptyItem: false,
    }),
  };
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

/** Scan for the first complete JSON object, tolerating minor prose around it. */
export function extractJsonObject(raw: string): string {
  const candidate = stripCodeFence(raw);
  const start = candidate.indexOf("{");
  if (start < 0) {
    throw new ExplanationParseError("The model response did not contain a JSON object.");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < candidate.length; index += 1) {
    const character = candidate.charAt(index);
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return candidate.slice(start, index + 1);
      }
      if (depth < 0) {
        break;
      }
    }
  }

  throw new ExplanationParseError("The model response contained incomplete JSON.");
}

/** Validate unknown JSON against the exact explanation contract. */
export function validateExplanation(value: unknown): Explanation {
  const record = readObject(value, "root");
  const partOfSpeech = readStringArray(record, "partOfSpeech", "partOfSpeech");
  if (partOfSpeech.length === 0) {
    throw new ExplanationParseError("The field \"partOfSpeech\" must contain at least one tag.");
  }

  const examples = readArray(record, "examples", "examples", parseExample);
  if (examples.length < 2) {
    throw new ExplanationParseError("The model response must contain at least two example sentences.");
  }

  return {
    word: readString(record, "word", "word"),
    phonetic: readString(record, "phonetic", "phonetic", { allowEmpty: true }),
    partOfSpeech,
    contextualMeaning: readString(record, "contextualMeaning", "contextualMeaning"),
    englishDefinition: readString(record, "englishDefinition", "englishDefinition"),
    chineseMeaning: readString(record, "chineseMeaning", "chineseMeaning"),
    otherMeanings: readArray(record, "otherMeanings", "otherMeanings", parseOtherMeaning),
    collocations: readArray(record, "collocations", "collocations", parseCollocation),
    examples,
    synonyms: readArray(record, "synonyms", "synonyms", parseSynonym),
    grammarNotes: parseGrammarNotes(record["grammarNotes"]),
    uncertainty: readString(record, "uncertainty", "uncertainty", { allowEmpty: true }),
  };
}



function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/.test(text.charAt(index))) {
    index += 1;
  }
  return index;
}

function findStringEnd(text: string, start: number): number {
  if (text.charAt(start) !== '"') {
    return -1;
  }
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      return index;
    }
  }
  return -1;
}

/** Find the exclusive end of a top-level JSON value, or -1 while incomplete. */
function findValueEnd(text: string, start: number): number {
  if (start >= text.length) {
    return -1;
  }

  const first = text.charAt(start);
  if (first === '"') {
    const stringEnd = findStringEnd(text, start);
    return stringEnd < 0 ? -1 : stringEnd + 1;
  }

  if (first === "{" || first === "[") {
    const stack: string[] = [first];
    let inString = false;
    let escaped = false;

    for (let index = start + 1; index < text.length; index += 1) {
      const character = text.charAt(index);
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }

      if (character === '"') {
        inString = true;
        continue;
      }

      if (character === "{" || character === "[") {
        stack.push(character);
        continue;
      }

      if (character === "}" || character === "]") {
        const opening = stack.pop();
        if (
          opening === undefined ||
          (opening === "{" && character !== "}") ||
          (opening === "[" && character !== "]")
        ) {
          return -1;
        }
        if (stack.length === 0) {
          return index + 1;
        }
      }
    }
    return -1;
  }

  // Primitive top-level values are not used by the explanation schema, but
  // handling them keeps the scanner generic.
  let index = start;
  while (index < text.length && !",}]".includes(text.charAt(index))) {
    index += 1;
  }
  return index < text.length ? index : -1;
}

/**
 * Extract complete top-level fields from a still-streaming JSON object.
 * Incomplete keys, strings, arrays, and objects are omitted; malformed values
 * are skipped rather than guessed.
 */
export function extractCompletedTopLevelFields(raw: string): Record<string, unknown> {
  const objectStart = raw.indexOf("{");
  if (objectStart < 0) {
    return {};
  }

  const fields: Record<string, unknown> = {};
  let index = objectStart + 1;

  while (index < raw.length) {
    index = skipWhitespace(raw, index);
    if (index >= raw.length) {
      break;
    }

    const character = raw.charAt(index);
    if (character === "}") {
      break;
    }
    if (character === ",") {
      index += 1;
      continue;
    }
    if (character !== '"') {
      break;
    }

    const keyEnd = findStringEnd(raw, index);
    if (keyEnd < 0) {
      break;
    }

    let key: string;
    try {
      const parsedKey = JSON.parse(raw.slice(index, keyEnd + 1)) as unknown;
      if (typeof parsedKey !== "string") {
        break;
      }
      key = parsedKey;
    } catch {
      break;
    }

    index = skipWhitespace(raw, keyEnd + 1);
    if (raw.charAt(index) !== ":") {
      break;
    }
    index = skipWhitespace(raw, index + 1);

    const valueEnd = findValueEnd(raw, index);
    if (valueEnd < 0) {
      break;
    }

    try {
      fields[key] = JSON.parse(raw.slice(index, valueEnd)) as unknown;
    } catch {
      break;
    }
    index = valueEnd;
  }

  return fields;
}



/** Parse and finalize the canonical semantic response. */
export function parseKnowledgeJson(
  raw: string,
  snapshot: SelectionSnapshot,
): VocabularyKnowledge {
  let json: string;
  try {
    json = extractJsonObject(raw);
  } catch (error) {
    throw new KnowledgeParseError(
      "The model response did not contain a complete JSON object.",
      error instanceof ExplanationParseError ? error.details : null,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new KnowledgeParseError(
      "The model response was not valid JSON.",
      `Malformed JSON object (${json.length} characters).`,
    );
  }

  try {
    return finalizeVocabularyKnowledge(parsed, snapshot);
  } catch (error) {
    if (error instanceof KnowledgeSchemaError) {
      throw new KnowledgeParseError(
        "The model response did not match the vocabulary schema.",
        error.message,
      );
    }
    throw error;
  }
}

function readPreviewString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readPreviewStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/**
 * Build a safe progressive preview from complete top-level canonical fields.
 * Missing or incomplete fields are omitted; final schema validation is still
 * mandatory before the result becomes official.
 */
export function parseKnowledgePreview(
  raw: string,
  snapshot: SelectionSnapshot,
): KnowledgePreview {
  const fields = extractCompletedTopLevelFields(raw);
  const preview: KnowledgePreview = {};

  const lemma = readPreviewString(fields["lemma"]);
  if (lemma) {
    preview.lemma = lemma;
  }
  if (fields["ipa"] === null) {
    preview.ipa = null;
  } else if (typeof fields["ipa"] === "string") {
    preview.ipa = fields["ipa"].trim() || null;
  }
  const partOfSpeech = readPreviewStringArray(fields["partOfSpeech"]);
  if (partOfSpeech) {
    preview.partOfSpeech = partOfSpeech;
  }

  const meanings = fields["meanings"];
  if (Array.isArray(meanings) && meanings.length > 0) {
    try {
      const probe = finalizeVocabularyKnowledge(
        {
          lemma: preview.lemma ?? snapshot.word,
          ipa: preview.ipa,
          partOfSpeech: preview.partOfSpeech ?? ["unknown"],
          contextConfidence: fields["contextConfidence"],
          meanings,
          usage: fields["usage"],
          nuance: fields["nuance"],
          wordFamily: fields["wordFamily"],
          uncertainty: fields["uncertainty"],
        },
        snapshot,
      );
      preview.meanings = probe.meanings as Meaning[];
      preview.usage = probe.usage;
      preview.nuance = probe.nuance;
      preview.wordFamily = probe.wordFamily;
      preview.uncertainty = probe.uncertainty;
      if (probe.context.contextConfidence) {
        preview.contextConfidence = probe.context.contextConfidence;
      }
    } catch {
      // The meanings array is incomplete or invalid; publish only identity.
    }
  }

  return preview;
}
