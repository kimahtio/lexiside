import type {
  GenerationInput,
  GenerationProfile,
  LexiSideSettings,
  SelectionSnapshot,
} from "./types.ts";

export const DEFAULT_GENERATION_PROFILE: GenerationProfile = {
  targetLanguage: "en",
  explanationLanguage: "zh-CN",
  explanationDepth: "standard",
  learnerLevel: "intermediate",
};

export function profileFromSettings(
  settings: Pick<
    LexiSideSettings,
    "targetLanguage" | "explanationLanguage" | "explanationDepth" | "learnerLevel"
  >,
): GenerationProfile {
  return {
    targetLanguage: settings.targetLanguage,
    explanationLanguage: settings.explanationLanguage,
    explanationDepth: settings.explanationDepth,
    learnerLevel: settings.learnerLevel,
  };
}

export function buildGenerationInput(
  snapshot: SelectionSnapshot,
  profile: GenerationProfile = DEFAULT_GENERATION_PROFILE,
): GenerationInput {
  return {
    selectedText: snapshot.word,
    sentence: snapshot.sentence,
    previousSentence: snapshot.previousSentence,
    nextSentence: snapshot.nextSentence,
    sourceNote: snapshot.sourceNote,
    ...profile,
  };
}
