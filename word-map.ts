import type { VocabularyKnowledge } from "./knowledge.ts";
import {
  selectWordMapRelations,
  type SemanticRelation,
} from "./relations.ts";

export interface WordMapModel {
  center: string;
  relations: SemanticRelation[];
}

const MAX_LABEL_CHARS = 48;

function escapeLabel(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/["`\\[\]{}|<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LABEL_CHARS);
}

/**
 * Fixed Mermaid template. The model never authors Mermaid, and user text is
 * aggressively reduced to quoted plain labels before it enters the source.
 */
export function buildWordMapMermaid(model: WordMapModel): string | null {
  if (model.relations.length === 0) {
    return null;
  }
  const center = escapeLabel(model.center) || "word";
  const lines = [
    "flowchart TD",
    `  W(["${center}"])`,
  ];
  model.relations.forEach((relation, index) => {
    const target = escapeLabel(relation.target) || relation.label;
    const edgeLabel = escapeLabel(relation.label) || "related";
    lines.push(`  W ---|"${edgeLabel}"| n${index + 1}["${target}"]`);
  });
  return lines.join("\n");
}

export function isProperNoun(knowledge: VocabularyKnowledge): boolean {
  return knowledge.identity.partOfSpeech.some((pos) =>
    /proper[-\s]*(?:noun|name)/i.test(pos),
  );
}

export function buildWordMapModel(
  knowledge: VocabularyKnowledge,
  maxRelations = 6,
): WordMapModel | null {
  // Proper names do not have a useful lexical relation map. Person, place,
  // organization, and brand names are therefore shown without a Word Map.
  if (isProperNoun(knowledge)) {
    return null;
  }
  const relations = selectWordMapRelations(knowledge, maxRelations);
  if (relations.length === 0) {
    return null;
  }
  return {
    center: knowledge.identity.surface,
    relations,
  };
}

export function wordMapMermaidBlock(model: WordMapModel): string | null {
  const mermaid = buildWordMapMermaid(model);
  return mermaid ? ["```mermaid", mermaid, "```"].join("\n") : null;
}
