import type {
  Collocation,
  GrammarPattern,
  SentencePattern,
  VocabularyKnowledge,
  WordComparison,
} from "./knowledge.ts";

export type RelationType =
  | "synonym_of"
  | "antonym_of"
  | "derived_from"
  | "derives_to"
  | "commonly_used_with"
  | "contrasts_with"
  | "follows_pattern";

export interface SemanticRelation {
  id: string;
  source: string;
  target: string;
  type: RelationType;
  senseId?: string;
  label: string;
  note?: string;
  evidence?: string;
}

const TYPE_LABELS: Record<RelationType, string> = {
  synonym_of: "Synonym",
  antonym_of: "Antonym",
  derived_from: "Derived from",
  derives_to: "Word family",
  commonly_used_with: "Collocation",
  contrasts_with: "Contrast",
  follows_pattern: "Pattern",
};

const TYPE_PRIORITY: Record<RelationType, number> = {
  synonym_of: 0,
  antonym_of: 1,
  contrasts_with: 2,
  derives_to: 3,
  commonly_used_with: 4,
  follows_pattern: 5,
  derived_from: 6,
};

function normalizeTarget(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

function addRelation(
  relations: SemanticRelation[],
  seen: Set<string>,
  source: string,
  type: RelationType,
  target: string,
  note?: string,
  evidence?: string,
  senseId?: string,
): void {
  const normalizedTarget = normalizeTarget(target);
  if (!normalizedTarget) {
    return;
  }
  const key = `${type}\u001F${normalizedTarget.toLowerCase()}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  const relation: SemanticRelation = {
    id: key,
    source,
    target: normalizedTarget,
    type,
    label: TYPE_LABELS[type],
  };
  if (note?.trim()) {
    relation.note = note.trim();
  }
  if (evidence?.trim()) {
    relation.evidence = evidence.trim();
  }
  if (senseId) {
    relation.senseId = senseId;
  }
  relations.push(relation);
}

function addComparisons(
  relations: SemanticRelation[],
  seen: Set<string>,
  source: string,
  type: RelationType,
  items: readonly WordComparison[],
  senseId: string,
): void {
  for (const item of items) {
    addRelation(relations, seen, source, type, item.word, item.difference, item.usage, senseId);
  }
}

function addCollocations(
  relations: SemanticRelation[],
  seen: Set<string>,
  source: string,
  items: readonly Collocation[],
  senseId: string,
): void {
  for (const item of items) {
    addRelation(
      relations,
      seen,
      source,
      "commonly_used_with",
      item.phrase,
      item.meaning,
      item.example?.english,
      senseId,
    );
  }
}

function addPatterns(
  relations: SemanticRelation[],
  seen: Set<string>,
  source: string,
  items: readonly (GrammarPattern | SentencePattern)[],
  senseId: string,
): void {
  for (const item of items) {
    addRelation(
      relations,
      seen,
      source,
      "follows_pattern",
      item.pattern,
      item.note,
      item.example?.english,
      senseId,
    );
  }
}

/** Derive typed relations locally; never ask the model to generate these. */
export function deriveRelations(knowledge: VocabularyKnowledge): SemanticRelation[] {
  const relations: SemanticRelation[] = [];
  const seen = new Set<string>();
  const source = knowledge.identity.surface;
  const senseId = knowledge.context.contextualMeaningId;

  addComparisons(relations, seen, source, "synonym_of", knowledge.nuance.synonyms, senseId);
  addComparisons(relations, seen, source, "antonym_of", knowledge.nuance.antonyms, senseId);
  addComparisons(relations, seen, source, "contrasts_with", knowledge.nuance.confusables, senseId);
  for (const item of knowledge.wordFamily) {
    addRelation(
      relations,
      seen,
      source,
      "derives_to",
      item.word,
      item.chineseMeaning ?? item.partOfSpeech,
      undefined,
      senseId,
    );
  }
  addCollocations(relations, seen, source, knowledge.usage.collocations, senseId);
  addPatterns(relations, seen, source, knowledge.usage.grammarPatterns, senseId);
  addPatterns(relations, seen, source, knowledge.usage.sentencePatterns, senseId);

  return relations;
}

/**
 * Pick a balanced 4–6 relations for the map. One relation per type first,
 * then fill by priority. Fewer are returned when the data does not support
 * more; no synthetic relation is created.
 */
export function selectWordMapRelations(
  knowledge: VocabularyKnowledge,
  maxRelations = 6,
): SemanticRelation[] {
  const limit = Math.max(0, Math.min(6, maxRelations));
  if (limit === 0) {
    return [];
  }
  const all = deriveRelations(knowledge);
  const groups = new Map<RelationType, SemanticRelation[]>();
  for (const relation of all) {
    const group = groups.get(relation.type) ?? [];
    group.push(relation);
    groups.set(relation.type, group);
  }
  const types = [...groups.keys()].sort(
    (a, b) => TYPE_PRIORITY[a] - TYPE_PRIORITY[b],
  );
  const selected: SemanticRelation[] = [];
  const usedIds = new Set<string>();

  for (const type of types) {
    const first = groups.get(type)?.[0];
    if (first && selected.length < limit) {
      selected.push(first);
      usedIds.add(first.id);
    }
  }
  if (selected.length < limit) {
    for (const type of types) {
      for (const relation of groups.get(type) ?? []) {
        if (selected.length >= limit) {
          break;
        }
        if (!usedIds.has(relation.id)) {
          selected.push(relation);
          usedIds.add(relation.id);
        }
      }
    }
  }

  return selected;
}
