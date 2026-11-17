import type {
  ContextConfidence,
  Meaning,
  Nuance,
  Usage,
  VocabularyKnowledge,
  WordFamilyItem,
} from "./knowledge.ts";

export type { VocabularyKnowledge } from "./knowledge.ts";

export type SelectionMode = "editing" | "reading";
export type TargetLanguage = "en";
export type ExplanationLanguage = "zh-CN";
export type ExplanationDepth = "concise" | "standard" | "detailed";
export type LearnerLevel = "beginner" | "intermediate" | "advanced";

export interface GenerationProfile {
  targetLanguage: TargetLanguage;
  explanationLanguage: ExplanationLanguage;
  explanationDepth: ExplanationDepth;
  learnerLevel: LearnerLevel;
}

/** Normalized input sent to the prompt/API; document text remains untrusted data. */
export interface GenerationInput extends GenerationProfile {
  selectedText: string;
  sentence: string;
  previousSentence: string | null;
  nextSentence: string | null;
  sourceNote: string;
}

/** A captured English selection plus the context sent to the model. */
export interface SelectionSnapshot {
  /** The selected word or phrase, trimmed and normalized. */
  word: string;
  /** Zero-based occurrence of the selected word in the reading-view text. */
  wordOccurrence?: number;
  /** Reading-view content-block index for exact source positioning. */
  sourceBlockIndex?: number;
  /** Source line reported by the Reading View block, when available. */
  sourceLine?: number;
  /** Text fingerprint of the source block to reject shifted indices. */
  sourceBlockText?: string;
  /** Character offset of the selected word inside that block. */
  sourceBlockStart?: number;
  sourceBlockEnd?: number;
  /** Character range of the selected sentence inside that rendered block. */
  sourceSentenceStart?: number;
  sourceSentenceEnd?: number;
  /** Reading-view scroll position when the word was selected. */
  sourceScroll?: number;
  /** The complete sentence containing the selection. */
  sentence: string;
  /** The sentence plus a limited amount of surrounding context. */
  context: string;
  /** The nearest complete previous sentence, if one is available. */
  previousSentence: string | null;
  /** The nearest complete next sentence, if one is available. */
  nextSentence: string | null;
  /** Display name of the source note, without extension. */
  sourceNote: string;
  /** Vault-relative path of the source note. */
  sourcePath: string;
  mode: SelectionMode;
}

export interface OtherMeaning {
  partOfSpeech: string;
  meaning: string;
}

export interface Collocation {
  phrase: string;
  meaning: string;
}

export interface ExampleSentence {
  english: string;
  chinese: string;
}

export interface Synonym {
  word: string;
  difference: string;
  usage: string;
}

export interface GrammarNotes {
  patterns: string[];
  prepositions: string[];
  commonMistakes: string[];
}

/**
 * Strict response contract expected from the model. All fields are required;
 * `uncertainty` is an empty string when the model is confident.
 */
export interface Explanation {
  word: string;
  phonetic: string;
  partOfSpeech: string[];
  contextualMeaning: string;
  englishDefinition: string;
  chineseMeaning: string;
  otherMeanings: OtherMeaning[];
  collocations: Collocation[];
  examples: ExampleSentence[];
  synonyms: Synonym[];
  grammarNotes: GrammarNotes;
  uncertainty: string;
}

export interface VocabularyMeta {
  id: string;
  key: string;
  context: string;
  sourceSentence: string;
  previousSentence: string | null;
  nextSentence: string | null;
  sourceNote: string;
  sourcePath: string;
  mode: SelectionMode;
  model: string;
  /** Time the explanation was originally produced. */
  createdAt: string;
  /** Time the entry was added to the vocabulary. */
  savedAt: string;
  /** Time the saved entry was last edited. */
  updatedAt: string;
}

/** Canonical stored vocabulary record. */
export interface VocabularyRecord extends VocabularyMeta {
  knowledge: VocabularyKnowledge;
}

/** Pre-migration flat record kept in the data file until it is edited. */
export interface LegacyVocabularyRecord extends VocabularyMeta, Explanation {}

export type StoredVocabularyRecord = VocabularyRecord | LegacyVocabularyRecord;

/**
 * UI/library view of a vocabulary entry. Flat fields are derived from
 * `knowledge` for compatibility with the existing history editor and exports.
 * This shape is never persisted.
 */
export interface VocabularyEntry extends Explanation, VocabularyMeta {
  knowledge: VocabularyKnowledge;
}

/** Canonical cache record. */
export interface CachedKnowledge {
  cacheSchemaVersion: number;
  key: string;
  word: string;
  lemma: string;
  context: string;
  contextHash: string;
  sourceSentence: string;
  previousSentence: string | null;
  nextSentence: string | null;
  model: string;
  profile: GenerationProfile;
  promptVersion: string;
  knowledge: VocabularyKnowledge;
  createdAt: string;
}

/** Pre-migration cache record retained without being used for new lookups. */
export interface CachedExplanation {
  key: string;
  word: string;
  context: string;
  sourceSentence: string;
  model: string;
  explanation: Explanation;
  createdAt: string;
}

export type StoredCacheRecord = CachedKnowledge | CachedExplanation;

export type PronunciationSource = "deepseek" | "system";
export type TtsVoice = "stella" | "tide";
export type ModelProvider = "deepseek" | "ollama" | "custom";

export interface LexiSideSettings {
  provider: ModelProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Ollama only: stop reasoning models from spending the output budget on thoughts. */
  ollamaDisableThinking: boolean;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  streaming: boolean;
  /** DeepSeek V4 only: send an explicit thinking-mode flag to the official API. */
  thinkingEnabled: boolean;
  autoOpenSidebar: boolean;
  targetLanguage: TargetLanguage;
  explanationLanguage: ExplanationLanguage;
  explanationDepth: ExplanationDepth;
  learnerLevel: LearnerLevel;
  pronunciationSource: PronunciationSource;
  ttsVoice: TtsVoice;
  ankiConnectUrl: string;
  ankiDeck: string;
  ankiModel: string;
}

export interface LexiSideData {
  /** Whole-file storage version. Distinct from knowledge.schemaVersion. */
  storageVersion: number;
  settings: LexiSideSettings;
  vocabulary: StoredVocabularyRecord[];
  cache: StoredCacheRecord[];
}

/** Safe partial canonical data for progressive rendering. */
export interface KnowledgePreview {
  lemma?: string;
  ipa?: string | null;
  partOfSpeech?: string[];
  contextConfidence?: ContextConfidence;
  meanings?: Meaning[];
  usage?: Usage;
  nuance?: Nuance;
  wordFamily?: WordFamilyItem[];
  uncertainty?: string[];
}

export type ResultOrigin = "ai" | "cache" | "library";

export interface ResultMeta {
  origin: ResultOrigin;
  model: string;
  queriedAt: string;
}

export type SidebarState =
  | { kind: "empty" }
  | {
      kind: "loading";
      snapshot: SelectionSnapshot;
      status: string;
      startedAt: string;
      preview?: KnowledgePreview;
    }
  | {
      kind: "error";
      snapshot: SelectionSnapshot | null;
      message: string;
      details: string | null;
      retryable: boolean;
    }
  | {
      kind: "result";
      snapshot: SelectionSnapshot;
      knowledge: VocabularyKnowledge;
      /** Flat projection retained for compatibility actions and fallback UI. */
      explanation: Explanation;
      meta: ResultMeta;
      key: string;
    };

/** Operations the sidebar view needs from the plugin controller. */
export interface SidebarHost {
  getSidebarState(): SidebarState;
  isCurrentSaved(): boolean;
  toggleCurrentSaved(): Promise<void>;
  saveCurrent(): Promise<void>;
  copyCurrent(): Promise<void>;
  regenerateCurrent(): Promise<void>;
  retryCurrent(): Promise<void>;
  openVocabulary(): void;
  speakWord(word: string, button: HTMLButtonElement): Promise<void>;
  revealSource(snapshot: SelectionSnapshot): Promise<void>;
  autoHighlightSource(snapshot: SelectionSnapshot): void;
  clearSourceHighlight(): void;
}

/** Operations the vocabulary modal needs from the plugin controller. */
export interface LibraryHost {
  getVocabularyEntries(): readonly VocabularyEntry[];
  deleteVocabularyEntry(id: string): Promise<void>;
  updateVocabularyEntry(entry: VocabularyEntry): Promise<void>;
  exportVocabularyMarkdown(entries: readonly VocabularyEntry[]): Promise<void>;
  exportVocabularyCsv(entries: readonly VocabularyEntry[]): Promise<void>;
  openVocabularyEntry(entry: VocabularyEntry): void;
}

export interface ApiCompletion {
  content: string;
  model: string;
  finishReason: string | null;
}

export interface PromptOverride {
  system: string;
  user: string;
}

export type ApiErrorKind =
  | "configuration"
  | "network"
  | "timeout"
  | "aborted"
  | "auth"
  | "rate-limit"
  | "insufficient-balance"
  | "not-found"
  | "bad-request"
  | "server"
  | "empty-response"
  | "truncated"
  | "invalid-response";
