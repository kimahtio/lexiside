import {
  KNOWLEDGE_SCHEMA_VERSION,
  KnowledgeSchemaError,
  validateVocabularyKnowledge,
  type ContextConfidence,
  type VocabularyKnowledge,
  type VocabularyContext,
} from "./knowledge.ts";
import type { SelectionSnapshot } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merge model-generated semantics with local context and stable local meaning
 * IDs, then validate the complete canonical record.
 */
export function finalizeVocabularyKnowledge(
  payload: unknown,
  snapshot: SelectionSnapshot,
): VocabularyKnowledge {
  if (!isRecord(payload)) {
    throw new KnowledgeSchemaError("The semantic response must be an object.", "root");
  }

  const rawMeanings = payload["meanings"];
  if (!Array.isArray(rawMeanings) || rawMeanings.length === 0) {
    throw new KnowledgeSchemaError(
      "The semantic response must contain at least one meaning.",
      "meanings",
    );
  }
  const meanings = rawMeanings.map((meaning, index) => {
    if (!isRecord(meaning)) {
      return meaning;
    }
    return { ...meaning, id: `meaning-${index + 1}` };
  });
  const contextual = meanings.find(
    (meaning) => isRecord(meaning) && meaning["scope"] === "contextual",
  );
  if (!isRecord(contextual) || typeof contextual["id"] !== "string") {
    throw new KnowledgeSchemaError(
      "At least one meaning must have scope \"contextual\".",
      "meanings",
    );
  }

  const context: VocabularyContext = {
    sentence: snapshot.sentence,
    previousSentence: snapshot.previousSentence,
    nextSentence: snapshot.nextSentence,
    contextualMeaningId: contextual["id"],
  };
  const confidence = payload["contextConfidence"];
  if (confidence !== undefined && confidence !== null) {
    context.contextConfidence = confidence as ContextConfidence;
  }

  return validateVocabularyKnowledge({
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    identity: {
      surface: snapshot.word,
      lemma: payload["lemma"],
      ipa: payload["ipa"] ?? null,
      partOfSpeech: payload["partOfSpeech"],
      inflections: payload["inflections"] ?? [],
    },
    context,
    meanings,
    usage: payload["usage"],
    nuance: payload["nuance"],
    wordFamily: payload["wordFamily"],
    uncertainty: payload["uncertainty"],
  });
}
