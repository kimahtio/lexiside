import {
  buildCacheKey,
  buildContextHash,
  CACHE_SCHEMA_VERSION,
} from "./cache.ts";
import { DEFAULT_GENERATION_PROFILE } from "./generation.ts";
import { validateVocabularyKnowledge, type VocabularyKnowledge } from "./knowledge.ts";
import {
  knowledgeToLegacyExplanation,
  legacyExplanationToKnowledge,
} from "./migration.ts";
import { buildAnalysisKey, PROMPT_VERSION } from "./prompts.ts";
import { validateExplanation } from "./parsing.ts";
import type {
  CachedExplanation,
  CachedKnowledge,
  Explanation,
  GenerationInput,
  GenerationProfile,
  LegacyVocabularyRecord,
  LexiSideData,
  LexiSideSettings,
  SelectionMode,
  StoredCacheRecord,
  StoredVocabularyRecord,
  VocabularyEntry,
  VocabularyMeta,
  VocabularyRecord,
} from "./types.ts";

export const STORAGE_VERSION = 3;
export const MAX_CACHE_ENTRIES = 500;
export const SETTING_LIMITS = {
  temperature: { min: 0, max: 2 },
  maxTokens: { min: 128, max: 32768 },
  timeoutMs: { min: 5_000, max: 300_000 },
} as const;

export const DEFAULT_SETTINGS: LexiSideSettings = {
  provider: "deepseek",
  apiKey: "",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
  ollamaDisableThinking: true,
  temperature: 0.3,
  maxTokens: 1800,
  timeoutMs: 60_000,
  streaming: true,
  thinkingEnabled: false,
  autoOpenSidebar: true,
  targetLanguage: "en",
  explanationLanguage: "zh-CN",
  explanationDepth: "standard",
  learnerLevel: "intermediate",
  pronunciationSource: "deepseek",
  ttsVoice: "stella",
  ankiConnectUrl: "http://127.0.0.1:8765",
  ankiDeck: "LexiSide",
  ankiModel: "Basic",
};

const CACHE_PROFILE_DEFAULTS = DEFAULT_GENERATION_PROFILE;

type SaveData = (data: LexiSideData) => Promise<void>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, numeric));
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readChoice<T extends string>(value: unknown, fallback: T, choices: readonly T[]): T {
  return typeof value === "string" && (choices as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function inferProvider(baseUrl: string): LexiSideSettings["provider"] {
  try {
    const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl) ? baseUrl : `http://${baseUrl}`;
    const url = new URL(raw);
    if (url.hostname.toLowerCase() === "api.deepseek.com") {
      return "deepseek";
    }
    if (url.port === "11434" || /(^|\.)ollama(\.|$)/i.test(url.hostname)) {
      return "ollama";
    }
  } catch {
    // Fall through to custom for malformed or empty URLs.
  }
  return "custom";
}

export function normalizeSettings(raw: unknown): LexiSideSettings {
  const record = isRecord(raw) ? raw : {};
  const baseUrl = readString(record["baseUrl"], DEFAULT_SETTINGS.baseUrl) || DEFAULT_SETTINGS.baseUrl;
  const provider = readChoice(record["provider"], inferProvider(baseUrl), [
    "deepseek",
    "ollama",
    "custom",
  ] as const);
  return {
    provider,
    apiKey: readString(record["apiKey"]),
    baseUrl,
    model: readString(record["model"], DEFAULT_SETTINGS.model) || DEFAULT_SETTINGS.model,
    ollamaDisableThinking: readBoolean(
      record["ollamaDisableThinking"],
      DEFAULT_SETTINGS.ollamaDisableThinking,
    ),
    temperature: clampNumber(
      record["temperature"],
      DEFAULT_SETTINGS.temperature,
      SETTING_LIMITS.temperature.min,
      SETTING_LIMITS.temperature.max,
    ),
    maxTokens: Math.round(
      clampNumber(record["maxTokens"], DEFAULT_SETTINGS.maxTokens, SETTING_LIMITS.maxTokens.min, SETTING_LIMITS.maxTokens.max),
    ),
    timeoutMs: Math.round(
      clampNumber(
        record["timeoutMs"],
        DEFAULT_SETTINGS.timeoutMs,
        SETTING_LIMITS.timeoutMs.min,
        SETTING_LIMITS.timeoutMs.max,
      ),
    ),
    streaming: readBoolean(record["streaming"], DEFAULT_SETTINGS.streaming),
    thinkingEnabled: readBoolean(record["thinkingEnabled"], DEFAULT_SETTINGS.thinkingEnabled),
    autoOpenSidebar: readBoolean(record["autoOpenSidebar"], DEFAULT_SETTINGS.autoOpenSidebar),
    targetLanguage: readChoice(record["targetLanguage"], DEFAULT_SETTINGS.targetLanguage, ["en"] as const),
    explanationLanguage: readChoice(record["explanationLanguage"], DEFAULT_SETTINGS.explanationLanguage, [
      "zh-CN",
    ] as const),
    explanationDepth: readChoice(record["explanationDepth"], DEFAULT_SETTINGS.explanationDepth, [
      "concise",
      "standard",
      "detailed",
    ] as const),
    learnerLevel: readChoice(record["learnerLevel"], DEFAULT_SETTINGS.learnerLevel, [
      "beginner",
      "intermediate",
      "advanced",
    ] as const),
    pronunciationSource: readChoice(record["pronunciationSource"], DEFAULT_SETTINGS.pronunciationSource, [
      "deepseek",
      "system",
    ] as const),
    ttsVoice: readChoice(record["ttsVoice"], DEFAULT_SETTINGS.ttsVoice, ["stella", "tide"] as const),
    ankiConnectUrl:
      readString(record["ankiConnectUrl"], DEFAULT_SETTINGS.ankiConnectUrl) ||
      DEFAULT_SETTINGS.ankiConnectUrl,
    ankiDeck: readString(record["ankiDeck"], DEFAULT_SETTINGS.ankiDeck) || DEFAULT_SETTINGS.ankiDeck,
    ankiModel: readString(record["ankiModel"], DEFAULT_SETTINGS.ankiModel) || DEFAULT_SETTINGS.ankiModel,
  };
}

function readMode(value: unknown): SelectionMode {
  return value === "reading" ? "reading" : "editing";
}

function readDate(value: unknown, fallback: string): string {
  const date = readString(value);
  return date.length > 0 ? date : fallback;
}

function readProfile(value: unknown): GenerationProfile {
  const record = isRecord(value) ? value : {};
  return {
    targetLanguage: readChoice(
      record["targetLanguage"],
      CACHE_PROFILE_DEFAULTS.targetLanguage,
      ["en"] as const,
    ),
    explanationLanguage: readChoice(
      record["explanationLanguage"],
      CACHE_PROFILE_DEFAULTS.explanationLanguage,
      ["zh-CN"] as const,
    ),
    explanationDepth: readChoice(
      record["explanationDepth"],
      CACHE_PROFILE_DEFAULTS.explanationDepth,
      ["concise", "standard", "detailed"] as const,
    ),
    learnerLevel: readChoice(
      record["learnerLevel"],
      CACHE_PROFILE_DEFAULTS.learnerLevel,
      ["beginner", "intermediate", "advanced"] as const,
    ),
  };
}

function readNeighbour(
  value: unknown,
  fallback: string | null,
): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  return fallback;
}

function parseVocabularyMeta(
  value: Record<string, unknown>,
  surface: string,
  fallbackSentence: string,
  fallbackPrevious: string | null,
  fallbackNext: string | null,
  now: string,
): VocabularyMeta | null {
  const id = readString(value["id"]);
  if (!id) {
    return null;
  }
  const model = readString(value["model"], DEFAULT_SETTINGS.model) || DEFAULT_SETTINGS.model;
  const sourceSentence = readString(value["sourceSentence"], fallbackSentence);
  const context = readString(value["context"], sourceSentence || fallbackSentence);
  const createdAt = readDate(value["createdAt"], now);
  const savedAt = readDate(value["savedAt"], createdAt);
  const updatedAt = readDate(value["updatedAt"], savedAt);
  return {
    id,
    key:
      readString(value["key"]) ||
      buildAnalysisKey(
        surface,
        context || sourceSentence,
        model,
        DEFAULT_GENERATION_PROFILE,
        PROMPT_VERSION,
      ),
    context,
    sourceSentence,
    previousSentence: readNeighbour(value["previousSentence"], fallbackPrevious),
    nextSentence: readNeighbour(value["nextSentence"], fallbackNext),
    sourceNote: readString(value["sourceNote"], "Unknown note"),
    sourcePath: readString(value["sourcePath"]),
    mode: readMode(value["mode"]),
    model,
    createdAt,
    savedAt,
    updatedAt,
  };
}

function isOfficialDeepSeekBaseUrl(baseUrl: string): boolean {
  try {
    const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl.trim()) ? baseUrl.trim() : `https://${baseUrl.trim()}`;
    return new URL(normalized).hostname.toLowerCase() === "api.deepseek.com";
  } catch {
    return false;
  }
}

function parseCanonicalVocabularyRecord(
  value: unknown,
  now: string,
): VocabularyRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  let knowledge;
  try {
    knowledge = validateVocabularyKnowledge(value["knowledge"]);
  } catch {
    return null;
  }
  const meta = parseVocabularyMeta(
    value,
    knowledge.identity.surface,
    knowledge.context.sentence,
    knowledge.context.previousSentence,
    knowledge.context.nextSentence,
    now,
  );
  if (!meta) {
    return null;
  }
  return { ...meta, knowledge };
}

function parseLegacyVocabularyRecord(
  value: unknown,
  now: string,
): LegacyVocabularyRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  let explanation: Explanation;
  try {
    explanation = validateExplanation(value);
  } catch {
    return null;
  }
  const fallbackContext = readString(value["context"], explanation.contextualMeaning);
  const meta = parseVocabularyMeta(
    value,
    explanation.word,
    fallbackContext,
    null,
    null,
    now,
  );
  if (!meta) {
    return null;
  }
  return { ...meta, ...explanation };
}

function parseStoredVocabularyRecord(
  value: unknown,
  now: string,
): StoredVocabularyRecord | null {
  if (isRecord(value) && isRecord(value["knowledge"])) {
    return parseCanonicalVocabularyRecord(value, now);
  }
  return parseLegacyVocabularyRecord(value, now);
}

function isCanonicalVocabularyRecord(
  record: StoredVocabularyRecord,
): record is VocabularyRecord {
  return "knowledge" in record && isRecord(record.knowledge);
}

function legacyExplanation(record: LegacyVocabularyRecord): Explanation {
  return {
    word: record.word,
    phonetic: record.phonetic,
    partOfSpeech: [...record.partOfSpeech],
    contextualMeaning: record.contextualMeaning,
    englishDefinition: record.englishDefinition,
    chineseMeaning: record.chineseMeaning,
    otherMeanings: record.otherMeanings.map((item) => ({ ...item })),
    collocations: record.collocations.map((item) => ({ ...item })),
    examples: record.examples.map((item) => ({ ...item })),
    synonyms: record.synonyms.map((item) => ({ ...item })),
    grammarNotes: {
      patterns: [...record.grammarNotes.patterns],
      prepositions: [...record.grammarNotes.prepositions],
      commonMistakes: [...record.grammarNotes.commonMistakes],
    },
    uncertainty: record.uncertainty,
  };
}

function toVocabularyEntry(record: StoredVocabularyRecord): VocabularyEntry {
  if (isCanonicalVocabularyRecord(record)) {
    return {
      ...knowledgeToLegacyExplanation(record.knowledge),
      id: record.id,
      key: record.key,
      context: record.context,
      sourceSentence: record.sourceSentence,
      previousSentence: record.previousSentence,
      nextSentence: record.nextSentence,
      sourceNote: record.sourceNote,
      sourcePath: record.sourcePath,
      mode: record.mode,
      model: record.model,
      createdAt: record.createdAt,
      savedAt: record.savedAt,
      updatedAt: record.updatedAt,
      knowledge: record.knowledge,
    };
  }
  const explanation = legacyExplanation(record);
  const knowledge = legacyExplanationToKnowledge(explanation, {
    sentence: record.sourceSentence || record.context,
    previousSentence: record.previousSentence,
    nextSentence: record.nextSentence,
  });
  return {
    ...explanation,
    id: record.id,
    key: record.key,
    context: record.context,
    sourceSentence: record.sourceSentence,
    previousSentence: record.previousSentence,
    nextSentence: record.nextSentence,
    sourceNote: record.sourceNote,
    sourcePath: record.sourcePath,
    mode: record.mode,
    model: record.model,
    createdAt: record.createdAt,
    savedAt: record.savedAt,
    updatedAt: record.updatedAt,
    knowledge,
  };
}

function vocabularyRecordFromView(entry: VocabularyEntry): VocabularyRecord {
  return {
    id: entry.id,
    key: entry.key,
    context: entry.context,
    sourceSentence: entry.sourceSentence,
    previousSentence: entry.previousSentence,
    nextSentence: entry.nextSentence,
    sourceNote: entry.sourceNote,
    sourcePath: entry.sourcePath,
    mode: entry.mode,
    model: entry.model,
    createdAt: entry.createdAt,
    savedAt: entry.savedAt,
    updatedAt: entry.updatedAt,
    knowledge: entry.knowledge,
  };
}

function parseCachedKnowledge(value: unknown, now: string): CachedKnowledge | null {
  if (!isRecord(value) || !isRecord(value["knowledge"])) {
    return null;
  }
  let knowledge;
  try {
    knowledge = validateVocabularyKnowledge(value["knowledge"]);
  } catch {
    return null;
  }
  const key = readString(value["key"]);
  if (!key) {
    return null;
  }
  const profile = readProfile(value["profile"]);
  const word = readString(value["word"], knowledge.identity.surface);
  const context = readString(value["context"], knowledge.context.sentence);
  const previousSentence = readNeighbour(
    value["previousSentence"],
    knowledge.context.previousSentence,
  );
  const nextSentence = readNeighbour(value["nextSentence"], knowledge.context.nextSentence);
  const contextHash =
    readString(value["contextHash"]) ||
    buildContextHash({
      selectedText: word,
      sentence: knowledge.context.sentence,
      previousSentence,
      nextSentence,
      targetLanguage: profile.targetLanguage,
      explanationLanguage: profile.explanationLanguage,
      explanationDepth: profile.explanationDepth,
      learnerLevel: profile.learnerLevel,
      sourceNote: "",
    });
  return {
    cacheSchemaVersion: CACHE_SCHEMA_VERSION,
    key,
    word,
    lemma: readString(value["lemma"], knowledge.identity.lemma),
    context,
    contextHash,
    sourceSentence: readString(value["sourceSentence"], knowledge.context.sentence),
    previousSentence,
    nextSentence,
    model: readString(value["model"], DEFAULT_SETTINGS.model),
    profile,
    promptVersion: readString(value["promptVersion"], PROMPT_VERSION),
    knowledge,
    createdAt: readDate(value["createdAt"], now),
  };
}

function parseLegacyCachedExplanation(
  value: unknown,
  now: string,
): CachedExplanation | null {
  if (!isRecord(value)) {
    return null;
  }
  const key = readString(value["key"]);
  if (!key) {
    return null;
  }
  let explanation: Explanation;
  try {
    explanation = validateExplanation(value["explanation"]);
  } catch {
    return null;
  }
  return {
    key,
    word: readString(value["word"], explanation.word),
    context: readString(value["context"]),
    sourceSentence: readString(value["sourceSentence"]),
    model: readString(value["model"], DEFAULT_SETTINGS.model),
    explanation,
    createdAt: readDate(value["createdAt"], now),
  };
}

function isCachedKnowledge(record: StoredCacheRecord): record is CachedKnowledge {
  return "knowledge" in record && "contextHash" in record;
}

function normalizeKeyText(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

function profilesMatch(
  profile: GenerationProfile,
  input: Pick<
    GenerationInput,
    "targetLanguage" | "explanationLanguage" | "explanationDepth" | "learnerLevel"
  >,
): boolean {
  return (
    profile.targetLanguage === input.targetLanguage &&
    profile.explanationLanguage === input.explanationLanguage &&
    profile.explanationDepth === input.explanationDepth &&
    profile.learnerLevel === input.learnerLevel
  );
}

/** Normalize persisted data defensively; malformed entries are dropped. */
export function normalizeLexiSideData(raw: unknown, now = new Date().toISOString()): LexiSideData {
  const record = isRecord(raw) ? raw : {};
  const previousStorageVersion =
    typeof record["storageVersion"] === "number" && Number.isFinite(record["storageVersion"])
      ? record["storageVersion"]
      : typeof record["schemaVersion"] === "number" && Number.isFinite(record["schemaVersion"])
        ? record["schemaVersion"]
        : 0;
  const settings = normalizeSettings(record["settings"]);

  // v2 moved the DeepSeek default from the legacy deepseek-chat alias to the
  // current official model ID. Only the old schema is migrated; a user who
  // explicitly chooses deepseek-chat after upgrading keeps that choice.
  if (
    previousStorageVersion > 0 &&
    previousStorageVersion < 2 &&
    settings.model.toLowerCase() === "deepseek-chat" &&
    isOfficialDeepSeekBaseUrl(settings.baseUrl)
  ) {
    settings.model = DEFAULT_SETTINGS.model;
  }

  const seenVocabularyIds = new Set<string>();
  const vocabulary = Array.isArray(record["vocabulary"])
    ? record["vocabulary"]
        .map((entry) => parseStoredVocabularyRecord(entry, now))
        .filter((entry): entry is StoredVocabularyRecord => {
          if (!entry || seenVocabularyIds.has(entry.id)) {
            return false;
          }
          seenVocabularyIds.add(entry.id);
          return true;
        })
    : [];

  const seenCacheKeys = new Set<string>();
  const cache = Array.isArray(record["cache"])
    ? record["cache"]
        .map((entry) => {
          if (isRecord(entry) && isRecord(entry["knowledge"])) {
            return parseCachedKnowledge(entry, now);
          }
          return parseLegacyCachedExplanation(entry, now);
        })
        .filter((entry): entry is StoredCacheRecord => {
          if (!entry || seenCacheKeys.has(entry.key)) {
            return false;
          }
          seenCacheKeys.add(entry.key);
          return true;
        })
        .slice(0, MAX_CACHE_ENTRIES)
    : [];

  return {
    storageVersion: STORAGE_VERSION,
    settings,
    vocabulary,
    cache,
  };
}

export class LexiSideStore {
  private data: LexiSideData;
  private readonly saveData: SaveData;
  private saveChain: Promise<void> = Promise.resolve();

  private constructor(data: LexiSideData, saveData: SaveData) {
    this.data = data;
    this.saveData = saveData;
  }

  static load(raw: unknown, saveData: SaveData): LexiSideStore {
    return new LexiSideStore(normalizeLexiSideData(raw), saveData);
  }

  get settings(): Readonly<LexiSideSettings> {
    return this.data.settings;
  }

  get vocabularyEntries(): readonly VocabularyEntry[] {
    return this.data.vocabulary.map(toVocabularyEntry);
  }

  get cacheSize(): number {
    return this.data.cache.length;
  }

  updateSettings(patch: Partial<LexiSideSettings>): Readonly<LexiSideSettings> {
    this.data.settings = normalizeSettings({ ...this.data.settings, ...patch });
    return this.data.settings;
  }

  updateApiKey(apiKey: string): void {
    this.data.settings.apiKey = apiKey.trim();
  }

  getCached(key: string): CachedKnowledge | null {
    const entry = this.data.cache.find((item) => item.key === key);
    return entry && isCachedKnowledge(entry) ? entry : null;
  }

  findCachedForInput(
    input: GenerationInput,
    settings: Pick<LexiSideSettings, "baseUrl" | "model">,
    promptVersion = PROMPT_VERSION,
  ): CachedKnowledge | null {
    const key = buildCacheKey(input, settings, promptVersion);
    const exact = this.getCached(key);
    if (exact) {
      return exact;
    }

    // Secondary lookup accepts a known surface→lemma alias without requiring a
    // local lemmatizer before the first request.
    const contextHash = buildContextHash(input);
    const selected = normalizeKeyText(input.selectedText);
    const model = normalizeKeyText(settings.model);
    return (
      this.data.cache.find((entry): entry is CachedKnowledge => {
        if (!isCachedKnowledge(entry)) {
          return false;
        }
        return (
          entry.contextHash === contextHash &&
          normalizeKeyText(entry.model) === model &&
          entry.promptVersion === promptVersion &&
          profilesMatch(entry.profile, input) &&
          (normalizeKeyText(entry.word) === selected || normalizeKeyText(entry.lemma) === selected)
        );
      }) ?? null
    );
  }

  putCached(entry: CachedKnowledge): void {
    this.data.cache = [entry, ...this.data.cache.filter((item) => item.key !== entry.key)].slice(0, MAX_CACHE_ENTRIES);
  }

  clearCache(): number {
    const count = this.data.cache.length;
    this.data.cache = [];
    return count;
  }

  findVocabularyByKey(key: string): VocabularyEntry | null {
    const entry = this.data.vocabulary.find((item) => item.key === key);
    return entry ? toVocabularyEntry(entry) : null;
  }

  findVocabularyById(id: string): VocabularyEntry | null {
    const entry = this.data.vocabulary.find((item) => item.id === id);
    return entry ? toVocabularyEntry(entry) : null;
  }

  upsertVocabularyEntry(entry: VocabularyEntry): void {
    const existingIndex = this.data.vocabulary.findIndex((item) => item.key === entry.key || item.id === entry.id);
    const canonical = vocabularyRecordFromView(entry);
    if (existingIndex >= 0) {
      const existing = this.data.vocabulary[existingIndex];
      canonical.id = existing?.id ?? entry.id;
      canonical.savedAt = existing?.savedAt ?? entry.savedAt;
      this.data.vocabulary[existingIndex] = canonical;
      return;
    }
    this.data.vocabulary = [canonical, ...this.data.vocabulary];
  }

  updateVocabularyEntry(entry: VocabularyEntry): void {
    const index = this.data.vocabulary.findIndex((item) => item.id === entry.id);
    if (index < 0) {
      throw new Error("That vocabulary entry no longer exists.");
    }
    const existing = this.data.vocabulary[index];
    const canonical = vocabularyRecordFromView(entry);
    canonical.savedAt = existing?.savedAt ?? entry.savedAt;
    this.data.vocabulary[index] = canonical;
  }

  deleteVocabularyEntry(id: string): boolean {
    const before = this.data.vocabulary.length;
    this.data.vocabulary = this.data.vocabulary.filter((entry) => entry.id !== id);
    return this.data.vocabulary.length !== before;
  }

  deleteVocabularyByKey(key: string): boolean {
    const before = this.data.vocabulary.length;
    this.data.vocabulary = this.data.vocabulary.filter((entry) => entry.key !== key);
    return this.data.vocabulary.length !== before;
  }

  /** Serialize saves so rapid settings/cache writes cannot overwrite each other. */
  persist(): Promise<void> {
    const snapshot = structuredClone(this.data);
    this.saveChain = this.saveChain.catch(() => undefined).then(() => this.saveData(snapshot));
    return this.saveChain;
  }
}

function normalizeMultiline(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

function markdownInline(value: string): string {
  return normalizeMultiline(value).replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function bulletList(items: readonly string[]): string {
  return items.map((item) => `- ${markdownInline(item)}`).join("\n");
}

export function formatExplanationPlainText(
  explanation: Explanation,
  context: { sentence?: string; sourceNote?: string } = {},
): string {
  const lines: string[] = [];
  const head = `${explanation.word}${explanation.phonetic ? ` ${explanation.phonetic}` : ""}`;
  lines.push(head, "");

  if (explanation.partOfSpeech.length > 0) {
    lines.push(`Part of speech: ${explanation.partOfSpeech.join(", ")}`);
  }
  if (context.sourceNote) {
    lines.push(`Source: ${context.sourceNote}`);
  }
  if (context.sentence) {
    lines.push(`Original sentence: ${normalizeMultiline(context.sentence)}`);
  }
  lines.push("", "Contextual meaning:", normalizeMultiline(explanation.contextualMeaning));
  lines.push("", "English definition:", normalizeMultiline(explanation.englishDefinition));
  lines.push("", "Chinese meaning:", normalizeMultiline(explanation.chineseMeaning));

  if (explanation.otherMeanings.length > 0) {
    lines.push("", "Other common meanings:");
    for (const item of explanation.otherMeanings) {
      lines.push(`- ${item.partOfSpeech ? `${item.partOfSpeech}: ` : ""}${normalizeMultiline(item.meaning)}`);
    }
  }

  lines.push("", "Examples:");
  explanation.examples.forEach((example, index) => {
    lines.push(`${index + 1}. ${normalizeMultiline(example.english)}`);
    lines.push(`   ${normalizeMultiline(example.chinese)}`);
  });

  if (explanation.collocations.length > 0) {
    lines.push("", "Collocations:");
    for (const item of explanation.collocations) {
      lines.push(`- ${normalizeMultiline(item.phrase)}: ${normalizeMultiline(item.meaning)}`);
    }
  }

  if (explanation.synonyms.length > 0) {
    lines.push("", "Synonyms and differences:");
    for (const item of explanation.synonyms) {
      lines.push(`- ${normalizeMultiline(item.word)}: ${normalizeMultiline(item.difference)}`);
      if (item.usage) {
        lines.push(`  Usage: ${normalizeMultiline(item.usage)}`);
      }
    }
  }

  const grammar: string[] = [];
  if (explanation.grammarNotes.patterns.length > 0) {
    grammar.push("Patterns:", bulletList(explanation.grammarNotes.patterns));
  }
  if (explanation.grammarNotes.prepositions.length > 0) {
    grammar.push("Preposition patterns:", bulletList(explanation.grammarNotes.prepositions));
  }
  if (explanation.grammarNotes.commonMistakes.length > 0) {
    grammar.push("Common mistakes:", bulletList(explanation.grammarNotes.commonMistakes));
  }
  if (grammar.length > 0) {
    lines.push("", "Grammar and usage:", ...grammar);
  }

  if (explanation.uncertainty) {
    lines.push("", `Uncertainty: ${normalizeMultiline(explanation.uncertainty)}`);
  }

  return lines.join("\n").trim();
}

function knowledgeExtrasPlainText(knowledge: VocabularyKnowledge): string[] {
  const lines: string[] = [];
  if (knowledge.nuance.antonyms.length > 0) {
    lines.push("", "Antonyms:");
    for (const item of knowledge.nuance.antonyms) {
      lines.push(`- ${item.word}: ${item.difference}`);
    }
  }
  if (knowledge.nuance.confusables.length > 0) {
    lines.push("", "Confusables:");
    for (const item of knowledge.nuance.confusables) {
      lines.push(`- ${item.word}: ${item.difference}`);
    }
  }
  if (knowledge.wordFamily.length > 0) {
    lines.push("", "Word family:");
    for (const item of knowledge.wordFamily) {
      lines.push(
        `- ${item.word} (${item.partOfSpeech})${item.chineseMeaning ? ` — ${item.chineseMeaning}` : ""}`,
      );
    }
  }
  return lines;
}

export function formatKnowledgePlainText(
  knowledge: VocabularyKnowledge,
  context: { sentence?: string; sourceNote?: string } = {},
): string {
  const base = formatExplanationPlainText(knowledgeToLegacyExplanation(knowledge), context);
  return [base, ...knowledgeExtrasPlainText(knowledge)].join("\n").trim();
}

function knowledgeExtrasMarkdown(knowledge: VocabularyKnowledge): string[] {
  const parts: string[] = [];
  for (const [title, items] of [
    ["Antonyms", knowledge.nuance.antonyms],
    ["Confusables", knowledge.nuance.confusables],
  ] as const) {
    if (items.length > 0) {
      parts.push(`### ${title}`, "");
      for (const item of items) {
        parts.push(`- **${markdownInline(item.word)}** — ${markdownInline(item.difference)}`);
      }
      parts.push("");
    }
  }
  if (knowledge.wordFamily.length > 0) {
    parts.push("### Word Family", "");
    for (const item of knowledge.wordFamily) {
      parts.push(
        `- **${markdownInline(item.word)}** — ${markdownInline(item.partOfSpeech)}${
          item.chineseMeaning ? ` — ${markdownInline(item.chineseMeaning)}` : ""
        }`,
      );
    }
    parts.push("");
  }
  return parts;
}

function knowledgeExtrasHtml(knowledge: VocabularyKnowledge): string[] {
  const parts: string[] = [];
  if (knowledge.nuance.antonyms.length > 0) {
    parts.push(
      `<b>Antonyms</b><br>${knowledge.nuance.antonyms
        .map((item) => `${escapeHtml(item.word)}: ${escapeHtml(item.difference)}`)
        .join("<br>")}`,
    );
  }
  if (knowledge.nuance.confusables.length > 0) {
    parts.push(
      `<b>Confusables</b><br>${knowledge.nuance.confusables
        .map((item) => `${escapeHtml(item.word)}: ${escapeHtml(item.difference)}`)
        .join("<br>")}`,
    );
  }
  if (knowledge.wordFamily.length > 0) {
    parts.push(
      `<b>Word family</b><br>${knowledge.wordFamily
        .map(
          (item) =>
            `${escapeHtml(item.word)} (${escapeHtml(item.partOfSpeech)})${
              item.chineseMeaning ? ` — ${escapeHtml(item.chineseMeaning)}` : ""
            }`,
        )
        .join("<br>")}`,
    );
  }
  return parts;
}

function markdownExamples(entries: readonly VocabularyEntry[]): string {
  const parts: string[] = [
    "# LexiSide Vocabulary",
    "",
    `Exported: ${new Date().toISOString()}`,
    `Entries: ${entries.length}`,
    "",
  ];

  for (const entry of entries) {
    parts.push(`## ${entry.word}`);
    const facts: string[] = [];
    if (entry.phonetic) {
      facts.push(`- **IPA:** ${markdownInline(entry.phonetic)}`);
    }
    if (entry.partOfSpeech.length > 0) {
      facts.push(`- **Part of speech:** ${entry.partOfSpeech.map(markdownInline).join(", ")}`);
    }
    facts.push(`- **Source:** ${entry.sourceNote || "Unknown note"}`);
    if (entry.sourcePath) {
      facts.push(`- **Path:** \`${entry.sourcePath.replace(/`/g, "'")}\``);
    }
    facts.push(`- **Saved:** ${entry.savedAt}`);
    facts.push(`- **Model:** ${entry.model}`);
    parts.push(facts.join("\n"), "");

    if (entry.sourceSentence) {
      parts.push("> " + entry.sourceSentence.replace(/\n/g, "\n> "), "");
    }

    parts.push("### Contextual Meaning", markdownInline(entry.contextualMeaning), "");
    parts.push("### English Definition", markdownInline(entry.englishDefinition), "");
    parts.push("### Chinese Meaning", markdownInline(entry.chineseMeaning), "");

    if (entry.otherMeanings.length > 0) {
      parts.push("### Other Meanings", "");
      for (const meaning of entry.otherMeanings) {
        parts.push(`- **${markdownInline(meaning.partOfSpeech || "meaning")}:** ${markdownInline(meaning.meaning)}`);
      }
      parts.push("");
    }

    parts.push("### Examples", "");
    for (const example of entry.examples) {
      parts.push(`- ${markdownInline(example.english)}`, `  - ${markdownInline(example.chinese)}`);
    }
    parts.push("");

    if (entry.collocations.length > 0) {
      parts.push("### Collocations", "");
      for (const item of entry.collocations) {
        parts.push(`- **${markdownInline(item.phrase)}** — ${markdownInline(item.meaning)}`);
      }
      parts.push("");
    }

    if (entry.synonyms.length > 0) {
      parts.push("### Synonyms & Differences", "");
      for (const item of entry.synonyms) {
        parts.push(`- **${markdownInline(item.word)}** — ${markdownInline(item.difference)}`);
        if (item.usage) {
          parts.push(`  - Usage: ${markdownInline(item.usage)}`);
        }
      }
      parts.push("");
    }

    const grammar: string[] = [];
    if (entry.grammarNotes.patterns.length > 0) {
      grammar.push("**Patterns**", bulletList(entry.grammarNotes.patterns), "");
    }
    if (entry.grammarNotes.prepositions.length > 0) {
      grammar.push("**Preposition patterns**", bulletList(entry.grammarNotes.prepositions), "");
    }
    if (entry.grammarNotes.commonMistakes.length > 0) {
      grammar.push("**Common mistakes**", bulletList(entry.grammarNotes.commonMistakes), "");
    }
    if (grammar.length > 0) {
      parts.push("### Grammar & Usage", "", ...grammar);
    }

    if (entry.uncertainty) {
      parts.push(`> **Uncertainty:** ${markdownInline(entry.uncertainty)}`, "");
    }

    parts.push(...knowledgeExtrasMarkdown(entry.knowledge));
    parts.push("---", "");
  }

  return parts.join("\n").trimEnd() + "\n";
}

export function vocabularyToMarkdown(entries: readonly VocabularyEntry[]): string {
  return markdownExamples(entries);
}

function escapeHtml(value: string): string {
  return normalizeMultiline(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\n/g, "<br>");
}

function ankiBackHtml(entry: VocabularyEntry): string {
  const parts: string[] = [];
  if (entry.partOfSpeech.length > 0) {
    parts.push(`<i>${escapeHtml(entry.partOfSpeech.join(", "))}</i>`);
  }
  if (entry.sourceSentence) {
    parts.push(`<blockquote>${escapeHtml(entry.sourceSentence)}</blockquote>`);
  }
  parts.push(`<b>In this context</b><br>${escapeHtml(entry.contextualMeaning)}`);
  parts.push(`<b>English definition</b><br>${escapeHtml(entry.englishDefinition)}`);
  parts.push(`<b>Chinese</b><br>${escapeHtml(entry.chineseMeaning)}`);

  if (entry.otherMeanings.length > 0) {
    parts.push(
      `<b>Other meanings</b><br>${entry.otherMeanings
        .map((item) => escapeHtml(`${item.partOfSpeech ? `${item.partOfSpeech}: ` : ""}${item.meaning}`))
        .join("<br>")}`,
    );
  }

  parts.push(
    `<b>Examples</b><br>${entry.examples
      .map(
        (example, index) =>
          `${index + 1}. ${escapeHtml(example.english)}<br><span>${escapeHtml(example.chinese)}</span>`,
      )
      .join("<br>")}`,
  );

  if (entry.collocations.length > 0) {
    parts.push(
      `<b>Collocations</b><br>${entry.collocations
        .map((item) => `${escapeHtml(item.phrase)}: ${escapeHtml(item.meaning)}`)
        .join("<br>")}`,
    );
  }

  if (entry.synonyms.length > 0) {
    parts.push(
      `<b>Synonyms</b><br>${entry.synonyms
        .map((item) => `${escapeHtml(item.word)}: ${escapeHtml(item.difference)}`)
        .join("<br>")}`,
    );
  }

  parts.push(...knowledgeExtrasHtml(entry.knowledge));

  if (entry.sourceNote) {
    parts.push(`<small>Source: ${escapeHtml(entry.sourceNote)}</small>`);
  }

  return parts.join("<br><br>");
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export interface AnkiCard {
  front: string;
  back: string;
  tags: string;
}

/** Shared Anki representation for CSV export and AnkiConnect sync. */
export function vocabularyToAnkiCard(entry: VocabularyEntry): AnkiCard {
  const front = `<b>${escapeHtml(entry.word)}</b>${entry.phonetic ? `<br><i>${escapeHtml(entry.phonetic)}</i>` : ""}`;
  const tags = `lexiside ${entry.word
    .toLowerCase()
    .replace(/[^\p{Script=Latin}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "word"}`;
  return { front, back: ankiBackHtml(entry), tags };
}

/**
 * Three CSV columns (Front, Back, Tags), no header row. The back column contains
 * HTML for Anki. Import with "Allow HTML in fields" enabled.
 */
export function vocabularyToAnkiCsv(entries: readonly VocabularyEntry[]): string {
  return entries
    .map((entry) => {
      const card = vocabularyToAnkiCard(entry);
      return [csvCell(card.front), csvCell(card.back), csvCell(card.tags)].join(",");
    })
    .join("\r\n")
    .concat(entries.length > 0 ? "\r\n" : "");
}
