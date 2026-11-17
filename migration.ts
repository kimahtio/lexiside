import {
  KNOWLEDGE_SCHEMA_VERSION,
  validateVocabularyKnowledge,
  type ContextConfidence,
  type GrammarPattern,
  type Meaning,
  type Nuance,
  type Usage,
  type VocabularyContext,
  type VocabularyKnowledge,
  type WordComparison,
} from "./knowledge.ts";
import type { Explanation } from "./types.ts";

/**
 * Phase 1 compatibility adapters. They are deliberately not wired into the
 * existing store or sidebar yet; Phase 4 will use them for version-aware reads
 * and lazy migration.
 */

const CONTEXTUAL_MEANING_ID = "meaning-contextual";
const CORE_MEANING_ID = "meaning-core";
const LEGACY_PREPOSITION_NOTE = "Preposition pattern";

export interface LegacyKnowledgeContext {
  sentence?: string;
  previousSentence?: string | null;
  nextSentence?: string | null;
  contextConfidence?: ContextConfidence;
}

function splitBilingual(value: string): { english: string; chinese: string } {
  const separator = " — ";
  const index = value.indexOf(separator);
  if (index > 0) {
    const english = value.slice(0, index).trim();
    const chinese = value.slice(index + separator.length).trim();
    if (english) {
      return { english, chinese };
    }
  }
  return { english: value.trim(), chinese: "" };
}

function cloneExamples(explanation: Explanation): Meaning["examples"] {
  return explanation.examples.map((example) => ({ ...example }));
}

function legacyUsage(explanation: Explanation): Usage {
  const grammarPatterns: GrammarPattern[] = [
    ...explanation.grammarNotes.patterns.map((pattern) => ({ pattern })),
    ...explanation.grammarNotes.prepositions.map((pattern) => ({
      pattern,
      note: LEGACY_PREPOSITION_NOTE,
    })),
  ];
  return {
    collocations: explanation.collocations.map((item) => ({
      phrase: item.phrase,
      meaning: item.meaning,
    })),
    grammarPatterns,
    sentencePatterns: [],
    notes: [...explanation.grammarNotes.commonMistakes],
  };
}

function legacyNuance(explanation: Explanation): Nuance {
  return {
    synonyms: explanation.synonyms.map((item) => ({
      word: item.word,
      difference: item.difference,
      usage: item.usage,
    })),
    antonyms: [],
    confusables: [],
  };
}

/**
 * Build canonical v2 knowledge from the old flat `Explanation` record.
 *
 * Unknown information is represented by empty arrays or null. In particular,
 * the old record does not contain a verified lemma, inflections, antonyms,
 * confusables, or a word family, so those are not invented. For compatibility,
 * the surface form is used as the lemma fallback.
 */
export function legacyExplanationToKnowledge(
  explanation: Explanation,
  context: LegacyKnowledgeContext = {},
): VocabularyKnowledge {
  const partOfSpeech = explanation.partOfSpeech[0] ?? "";
  const meanings: Meaning[] = [
    {
      id: CONTEXTUAL_MEANING_ID,
      scope: "contextual",
      partOfSpeech,
      englishDefinition: explanation.contextualMeaning,
      chineseMeaning: explanation.chineseMeaning,
      examples: cloneExamples(explanation),
    },
    {
      id: CORE_MEANING_ID,
      scope: "core",
      partOfSpeech,
      englishDefinition: explanation.englishDefinition,
      // The old schema has one Chinese field and cannot distinguish the core
      // translation from the contextual one; do not duplicate it as a fact.
      chineseMeaning: "",
      examples: [],
    },
  ];

  explanation.otherMeanings.forEach((item, index) => {
    const bilingual = splitBilingual(item.meaning);
    meanings.push({
      id: `meaning-other-${index + 1}`,
      scope: "other",
      partOfSpeech: item.partOfSpeech || partOfSpeech,
      englishDefinition: bilingual.english,
      chineseMeaning: bilingual.chinese,
      examples: [],
    });
  });

  const canonicalContext: VocabularyContext = {
    sentence: context.sentence?.trim() ?? "",
    previousSentence: context.previousSentence?.trim() || null,
    nextSentence: context.nextSentence?.trim() || null,
    contextualMeaningId: CONTEXTUAL_MEANING_ID,
  };
  if (context.contextConfidence !== undefined) {
    canonicalContext.contextConfidence = context.contextConfidence;
  }

  const uncertainty = explanation.uncertainty.trim();
  const candidate: VocabularyKnowledge = {
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    identity: {
      surface: explanation.word,
      lemma: explanation.word,
      ipa: explanation.phonetic.trim() || null,
      partOfSpeech: [...explanation.partOfSpeech],
      inflections: [],
    },
    context: canonicalContext,
    meanings,
    usage: legacyUsage(explanation),
    nuance: legacyNuance(explanation),
    wordFamily: [],
    uncertainty: uncertainty ? [uncertainty] : [],
  };

  return validateVocabularyKnowledge(candidate);
}

function grammarPatternsForLegacy(usage: Usage): {
  patterns: string[];
  prepositions: string[];
} {
  const patterns: string[] = [];
  const prepositions: string[] = [];
  for (const pattern of usage.grammarPatterns) {
    if (pattern.note === LEGACY_PREPOSITION_NOTE) {
      prepositions.push(pattern.pattern);
    } else {
      patterns.push(pattern.pattern);
    }
  }
  patterns.push(...usage.sentencePatterns.map((pattern) => pattern.pattern));
  return { patterns, prepositions };
}

/**
 * Convert canonical knowledge into the existing flat explanation shape so the
 * current UI can continue to render both old and new records during migration.
 * This is only a view adapter; it is not a persistence format.
 */
/**
 * Apply edits made through the legacy flat editor to canonical knowledge while
 * preserving fields the editor does not expose (antonyms, confusables, word
 * family, sentence patterns, confidence, and context neighbours).
 */
export function applyExplanationEditsToKnowledge(
  knowledge: VocabularyKnowledge,
  edited: Explanation & { sourceSentence?: string },
): VocabularyKnowledge {
  const next = structuredClone(knowledge);
  const oldSurface = next.identity.surface;
  next.identity.surface = edited.word;
  if (!next.identity.lemma || next.identity.lemma === oldSurface) {
    next.identity.lemma = edited.word;
  }
  next.identity.ipa = edited.phonetic.trim() || null;
  next.identity.partOfSpeech = [...edited.partOfSpeech];
  next.context.sentence = edited.sourceSentence || next.context.sentence;

  const contextual = next.meanings.find(
    (meaning) => meaning.id === next.context.contextualMeaningId,
  );
  if (!contextual) {
    throw new Error("Canonical knowledge has no contextual meaning.");
  }
  contextual.partOfSpeech = edited.partOfSpeech[0] ?? contextual.partOfSpeech;
  contextual.englishDefinition = edited.contextualMeaning;
  contextual.chineseMeaning = edited.chineseMeaning;
  contextual.examples = edited.examples.map((example) => ({ ...example }));

  const core = next.meanings.find((meaning) => meaning.scope === "core");
  if (core) {
    core.partOfSpeech = edited.partOfSpeech[0] ?? core.partOfSpeech;
    core.englishDefinition = edited.englishDefinition;
  } else if (edited.englishDefinition !== edited.contextualMeaning) {
    next.meanings.push({
      id: "meaning-core",
      scope: "core",
      partOfSpeech: edited.partOfSpeech[0] ?? "",
      englishDefinition: edited.englishDefinition,
      chineseMeaning: "",
      examples: [],
    });
  }

  next.meanings = next.meanings.filter((meaning) => meaning.scope !== "other");
  const usedIds = new Set(next.meanings.map((meaning) => meaning.id));
  edited.otherMeanings.forEach((item, index) => {
    const bilingual = splitBilingual(item.meaning);
    let id = `meaning-other-${index + 1}`;
    while (usedIds.has(id)) {
      id = `${id}-edited`;
    }
    usedIds.add(id);
    next.meanings.push({
      id,
      scope: "other",
      partOfSpeech: item.partOfSpeech || edited.partOfSpeech[0] || "",
      englishDefinition: bilingual.english,
      chineseMeaning: bilingual.chinese,
      examples: [],
    });
  });

  next.usage.collocations = edited.collocations.map((item) => ({
    phrase: item.phrase,
    meaning: item.meaning,
  }));
  next.usage.grammarPatterns = [
    ...edited.grammarNotes.patterns.map((pattern) => ({ pattern })),
    ...edited.grammarNotes.prepositions.map((pattern) => ({
      pattern,
      note: LEGACY_PREPOSITION_NOTE,
    })),
  ];
  next.usage.notes = [...edited.grammarNotes.commonMistakes];
  next.nuance.synonyms = edited.synonyms.map((item) => ({
    word: item.word,
    difference: item.difference,
    usage: item.usage,
  }));
  next.uncertainty = edited.uncertainty.trim() ? [edited.uncertainty.trim()] : [];

  return validateVocabularyKnowledge(next);
}

export function knowledgeToLegacyExplanation(
  knowledge: VocabularyKnowledge,
): Explanation {
  const normalized = validateVocabularyKnowledge(knowledge);
  const contextual =
    normalized.meanings.find((meaning) => meaning.id === normalized.context.contextualMeaningId) ??
    normalized.meanings.find((meaning) => meaning.scope === "contextual");
  if (!contextual) {
    throw new Error("Canonical knowledge has no contextual meaning.");
  }
  const core = normalized.meanings.find((meaning) => meaning.scope === "core") ?? contextual;
  const otherMeanings = normalized.meanings
    .filter((meaning) => meaning.scope === "other")
    .map((meaning) => ({
      partOfSpeech: meaning.partOfSpeech,
      meaning: meaning.chineseMeaning
        ? `${meaning.englishDefinition} — ${meaning.chineseMeaning}`
        : meaning.englishDefinition,
    }));
  const examples =
    contextual.examples.length > 0 ? contextual.examples : core.examples;
  const grammar = grammarPatternsForLegacy(normalized.usage);
  const synonyms: WordComparison[] = normalized.nuance.synonyms;

  return {
    word: normalized.identity.surface,
    phonetic: normalized.identity.ipa ?? "",
    partOfSpeech: [...normalized.identity.partOfSpeech],
    contextualMeaning: contextual.englishDefinition,
    englishDefinition: core.englishDefinition,
    chineseMeaning: contextual.chineseMeaning || core.chineseMeaning,
    otherMeanings,
    collocations: normalized.usage.collocations.map((item) => ({
      phrase: item.phrase,
      meaning: item.meaning ?? "",
    })),
    examples: examples.map((example) => ({ ...example })),
    synonyms: synonyms.map((item) => ({
      word: item.word,
      difference: item.difference,
      usage: item.usage ?? "",
    })),
    grammarNotes: {
      patterns: grammar.patterns,
      prepositions: grammar.prepositions,
      commonMistakes: [...normalized.usage.notes],
    },
    uncertainty: normalized.uncertainty.join(" "),
  };
}
