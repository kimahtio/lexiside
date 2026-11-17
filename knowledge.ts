/**
 * Canonical vocabulary knowledge model.
 *
 * Important versioning rule:
 * - `VocabularyKnowledge.schemaVersion` describes one knowledge record.
 * - The `data.json` envelope uses a separate storage-version field. Storage
 *   migration is intentionally not wired in yet; it belongs to Phase 4.
 */
export const KNOWLEDGE_SCHEMA_VERSION = 2;

export const KNOWLEDGE_LIMITS = {
  maxStringLength: 4_000,
  maxArrayLength: 40,
} as const;

export type ContextConfidence = "low" | "medium" | "high";
export type MeaningScope = "contextual" | "core" | "other";

export interface KnowledgeExample {
  english: string;
  chinese: string;
}

export interface Meaning {
  id: string;
  scope: MeaningScope;
  partOfSpeech: string;
  englishDefinition: string;
  /** May be empty until a translation is available. */
  chineseMeaning: string;
  examples: KnowledgeExample[];
}

export interface Collocation {
  phrase: string;
  meaning?: string;
  example?: KnowledgeExample;
}

export interface GrammarPattern {
  pattern: string;
  note?: string;
  example?: KnowledgeExample;
}

export interface SentencePattern {
  pattern: string;
  note?: string;
  example?: KnowledgeExample;
}

export interface Usage {
  collocations: Collocation[];
  grammarPatterns: GrammarPattern[];
  sentencePatterns: SentencePattern[];
  notes: string[];
}

export interface WordComparison {
  word: string;
  difference: string;
  usage?: string;
}

export interface Nuance {
  synonyms: WordComparison[];
  antonyms: WordComparison[];
  confusables: WordComparison[];
}

export interface WordFamilyItem {
  word: string;
  partOfSpeech: string;
  chineseMeaning?: string;
}

export interface WordIdentity {
  surface: string;
  /** For legacy records without a verified lemma, the surface form is used as a fallback. */
  lemma: string;
  ipa: string | null;
  partOfSpeech: string[];
  inflections: string[];
}

export interface VocabularyContext {
  sentence: string;
  previousSentence: string | null;
  nextSentence: string | null;
  contextualMeaningId: string;
  /** Optional because the model should not claim an uncalibrated probability. */
  contextConfidence?: ContextConfidence;
}

export interface VocabularyKnowledge {
  schemaVersion: typeof KNOWLEDGE_SCHEMA_VERSION;
  identity: WordIdentity;
  context: VocabularyContext;
  meanings: Meaning[];
  usage: Usage;
  nuance: Nuance;
  wordFamily: WordFamilyItem[];
  uncertainty: string[];
}

export class KnowledgeSchemaError extends Error {
  readonly path: string;

  constructor(message: string, path = "root") {
    super(`${message} (${path})`);
    this.name = "KnowledgeSchemaError";
    this.path = path;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new KnowledgeSchemaError("Expected an object.", path);
  }
  return value;
}

function readString(
  value: unknown,
  path: string,
  options: { allowEmpty?: boolean } = {},
): string {
  if (typeof value !== "string") {
    throw new KnowledgeSchemaError("Expected a string.", path);
  }
  const trimmed = value.trim();
  if (trimmed.length > KNOWLEDGE_LIMITS.maxStringLength) {
    throw new KnowledgeSchemaError("String is too long.", path);
  }
  if (!options.allowEmpty && trimmed.length === 0) {
    throw new KnowledgeSchemaError("String must not be empty.", path);
  }
  return trimmed;
}

function readOptionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const trimmed = readString(value, path, { allowEmpty: true });
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNullableString(value: unknown, path: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = readString(value, path, { allowEmpty: true });
  return trimmed.length > 0 ? trimmed : null;
}

function readEnum<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new KnowledgeSchemaError(`Expected one of: ${allowed.join(", ")}.`, path);
  }
  return value as T;
}

function readArrayField<T>(
  record: Record<string, unknown>,
  key: string,
  path: string,
  parser: (value: unknown, itemPath: string) => T,
  options: { optional?: boolean } = {},
): T[] {
  const value = record[key];
  if (value === undefined) {
    if (options.optional) {
      return [];
    }
    throw new KnowledgeSchemaError("Missing required array.", path);
  }
  if (!Array.isArray(value)) {
    throw new KnowledgeSchemaError("Expected an array.", path);
  }
  if (value.length > KNOWLEDGE_LIMITS.maxArrayLength) {
    throw new KnowledgeSchemaError("Array contains too many items.", path);
  }
  return value.map((item, index) => parser(item, `${path}[${index}]`));
}

function readStringArrayField(
  record: Record<string, unknown>,
  key: string,
  path: string,
  options: { optional?: boolean; dropEmpty?: boolean } = {},
): string[] {
  const values = readArrayField(
    record,
    key,
    path,
    (item, itemPath) => readString(item, itemPath, { allowEmpty: options.dropEmpty !== false }),
    { optional: options.optional },
  );
  return options.dropEmpty === false ? values : values.filter((item) => item.length > 0);
}

function readOptionalRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }
  return readRecord(value, path);
}

function readExample(value: unknown, path: string): KnowledgeExample {
  const record = readRecord(value, path);
  return {
    english: readString(record["english"], `${path}.english`),
    chinese: readOptionalString(record["chinese"], `${path}.chinese`) ?? "",
  };
}

function readExamplesField(
  record: Record<string, unknown>,
  key: string,
  path: string,
): KnowledgeExample[] {
  return readArrayField(record, key, path, readExample, { optional: true });
}

function readMeaning(value: unknown, path: string): Meaning {
  const record = readRecord(value, path);
  const englishDefinition = readString(record["englishDefinition"], `${path}.englishDefinition`);
  return {
    id: readString(record["id"], `${path}.id`),
    scope: readEnum(record["scope"], `${path}.scope`, ["contextual", "core", "other"] as const),
    partOfSpeech: readString(record["partOfSpeech"], `${path}.partOfSpeech`, { allowEmpty: true }),
    englishDefinition,
    chineseMeaning:
      readOptionalString(record["chineseMeaning"], `${path}.chineseMeaning`) ?? "",
    examples: readExamplesField(record, "examples", `${path}.examples`),
  };
}

function readCollocation(value: unknown, path: string): Collocation {
  const record = readRecord(value, path);
  const collocation: Collocation = {
    phrase: readString(record["phrase"], `${path}.phrase`),
  };
  const meaning = readOptionalString(record["meaning"], `${path}.meaning`);
  if (meaning !== undefined) {
    collocation.meaning = meaning;
  }
  const example = record["example"];
  if (example !== undefined && example !== null) {
    collocation.example = readExample(example, `${path}.example`);
  }
  return collocation;
}

function readGrammarPattern(value: unknown, path: string): GrammarPattern {
  const record = readRecord(value, path);
  const pattern: GrammarPattern = {
    pattern: readString(record["pattern"], `${path}.pattern`),
  };
  const note = readOptionalString(record["note"], `${path}.note`);
  if (note !== undefined) {
    pattern.note = note;
  }
  const example = record["example"];
  if (example !== undefined && example !== null) {
    pattern.example = readExample(example, `${path}.example`);
  }
  return pattern;
}

function readSentencePattern(value: unknown, path: string): SentencePattern {
  const record = readRecord(value, path);
  const pattern: SentencePattern = {
    pattern: readString(record["pattern"], `${path}.pattern`),
  };
  const note = readOptionalString(record["note"], `${path}.note`);
  if (note !== undefined) {
    pattern.note = note;
  }
  const example = record["example"];
  if (example !== undefined && example !== null) {
    pattern.example = readExample(example, `${path}.example`);
  }
  return pattern;
}

function readWordComparison(value: unknown, path: string): WordComparison {
  const record = readRecord(value, path);
  const comparison: WordComparison = {
    word: readString(record["word"], `${path}.word`),
    difference: readString(record["difference"], `${path}.difference`),
  };
  const usage = readOptionalString(record["usage"], `${path}.usage`);
  if (usage !== undefined) {
    comparison.usage = usage;
  }
  return comparison;
}

function readWordFamilyItem(value: unknown, path: string): WordFamilyItem {
  const record = readRecord(value, path);
  const item: WordFamilyItem = {
    word: readString(record["word"], `${path}.word`),
    partOfSpeech: readString(record["partOfSpeech"], `${path}.partOfSpeech`),
  };
  const chinese = readOptionalString(record["chineseMeaning"], `${path}.chineseMeaning`);
  if (chinese !== undefined) {
    item.chineseMeaning = chinese;
  }
  return item;
}

function readIdentity(value: unknown): WordIdentity {
  const record = readRecord(value, "identity");
  const partOfSpeech = readStringArrayField(record, "partOfSpeech", "identity.partOfSpeech", {
    optional: false,
    dropEmpty: true,
  });
  if (partOfSpeech.length === 0) {
    throw new KnowledgeSchemaError(
      "Identity must contain at least one part of speech.",
      "identity.partOfSpeech",
    );
  }
  return {
    surface: readString(record["surface"], "identity.surface"),
    lemma: readString(record["lemma"], "identity.lemma"),
    ipa: readNullableString(record["ipa"], "identity.ipa"),
    partOfSpeech,
    inflections: readStringArrayField(record, "inflections", "identity.inflections", {
      optional: true,
      dropEmpty: true,
    }),
  };
}

function readContext(value: unknown): VocabularyContext {
  const record = readRecord(value, "context");
  const context: VocabularyContext = {
    sentence: readString(record["sentence"], "context.sentence", { allowEmpty: true }),
    previousSentence: readNullableString(record["previousSentence"], "context.previousSentence"),
    nextSentence: readNullableString(record["nextSentence"], "context.nextSentence"),
    contextualMeaningId: readString(
      record["contextualMeaningId"],
      "context.contextualMeaningId",
    ),
  };
  const confidence = record["contextConfidence"];
  if (confidence !== undefined && confidence !== null) {
    context.contextConfidence = readEnum(confidence, "context.contextConfidence", [
      "low",
      "medium",
      "high",
    ] as const);
  }
  return context;
}

function readUsage(value: unknown): Usage {
  const record = readOptionalRecord(value, "usage");
  return {
    collocations: readArrayField(record, "collocations", "usage.collocations", readCollocation, {
      optional: true,
    }),
    grammarPatterns: readArrayField(
      record,
      "grammarPatterns",
      "usage.grammarPatterns",
      readGrammarPattern,
      { optional: true },
    ),
    sentencePatterns: readArrayField(
      record,
      "sentencePatterns",
      "usage.sentencePatterns",
      readSentencePattern,
      { optional: true },
    ),
    notes: readStringArrayField(record, "notes", "usage.notes", {
      optional: true,
      dropEmpty: true,
    }),
  };
}

function readNuance(value: unknown): Nuance {
  const record = readOptionalRecord(value, "nuance");
  return {
    synonyms: readArrayField(record, "synonyms", "nuance.synonyms", readWordComparison, {
      optional: true,
    }),
    antonyms: readArrayField(record, "antonyms", "nuance.antonyms", readWordComparison, {
      optional: true,
    }),
    confusables: readArrayField(
      record,
      "confusables",
      "nuance.confusables",
      readWordComparison,
      { optional: true },
    ),
  };
}

/** Validate and normalize an unknown value as canonical vocabulary knowledge. */
export function validateVocabularyKnowledge(value: unknown): VocabularyKnowledge {
  const record = readRecord(value, "root");
  const version = record["schemaVersion"];
  if (version === undefined) {
    throw new KnowledgeSchemaError("Missing vocabulary schema version.", "schemaVersion");
  }
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new KnowledgeSchemaError("Vocabulary schema version must be an integer.", "schemaVersion");
  }
  if (version !== KNOWLEDGE_SCHEMA_VERSION) {
    throw new KnowledgeSchemaError(
      `Unsupported vocabulary schema version ${version}.`,
      "schemaVersion",
    );
  }

  const meanings = readArrayField(record, "meanings", "meanings", readMeaning, {
    optional: false,
  });
  if (meanings.length === 0) {
    throw new KnowledgeSchemaError("At least one meaning is required.", "meanings");
  }
  const meaningIds = new Set<string>();
  for (const meaning of meanings) {
    if (meaningIds.has(meaning.id)) {
      throw new KnowledgeSchemaError(`Duplicate meaning id "${meaning.id}".`, "meanings");
    }
    meaningIds.add(meaning.id);
  }

  const context = readContext(record["context"]);
  const contextualMeaning = meanings.find(
    (meaning) => meaning.id === context.contextualMeaningId,
  );
  if (!contextualMeaning) {
    throw new KnowledgeSchemaError(
      "contextualMeaningId must reference an existing meaning.",
      "context.contextualMeaningId",
    );
  }
  if (contextualMeaning.scope !== "contextual") {
    throw new KnowledgeSchemaError(
      "contextualMeaningId must reference a contextual meaning.",
      "context.contextualMeaningId",
    );
  }

  return {
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    identity: readIdentity(record["identity"]),
    context,
    meanings,
    usage: readUsage(record["usage"]),
    nuance: readNuance(record["nuance"]),
    wordFamily: readArrayField(record, "wordFamily", "wordFamily", readWordFamilyItem, {
      optional: true,
    }),
    uncertainty: readStringArrayField(record, "uncertainty", "uncertainty", {
      optional: true,
      dropEmpty: true,
    }),
  };
}
