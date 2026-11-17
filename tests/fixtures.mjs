export const sampleExplanation = {
  word: "resilient",
  phonetic: "/rɪˈzɪliənt/",
  partOfSpeech: ["adjective"],
  contextualMeaning: "In this sentence, resilient means able to recover quickly after a setback.",
  englishDefinition: "Able to recover quickly after something difficult or damaging happens.",
  chineseMeaning: "有韧性的；能迅速恢复的；适应力强的",
  otherMeanings: [
    {
      partOfSpeech: "adjective",
      meaning: "A material that is resilient can return to its original shape after being pressed or bent.",
    },
  ],
  collocations: [
    { phrase: "a resilient economy", meaning: "an economy that recovers well from shocks" },
    { phrase: "become more resilient", meaning: "develop the ability to recover from difficulties" },
  ],
  examples: [
    {
      english: "The team stayed resilient after the first product launch failed.",
      chinese: "首次产品发布失败后，团队依然保持韧性。",
    },
    {
      english: "Children are often more resilient than adults expect.",
      chinese: "孩子们往往比成年人想象的更有适应力。",
    },
  ],
  synonyms: [
    {
      word: "tough",
      difference: "Tough emphasizes the ability to endure pressure; resilient emphasizes recovery after a setback.",
      usage: "Use resilient when recovery and adaptation are central.",
    },
    {
      word: "adaptable",
      difference: "Adaptable focuses on changing to fit new conditions; resilient focuses on bouncing back.",
      usage: "Use adaptable for people or systems that adjust easily.",
    },
  ],
  grammarNotes: {
    patterns: ["be resilient to + noun", "remain resilient in the face of + noun"],
    prepositions: ["resilient to change", "resilient under pressure"],
    commonMistakes: ["Do not say “resilient against difficulties”; “resilient in the face of difficulties” is more natural."],
  },
  uncertainty: "",
};

import { legacyExplanationToKnowledge } from "../migration.ts";

export const sampleSnapshot = {
  word: "resilient",
  sentence: "The team stayed resilient after the first product launch failed.",
  context:
    "The launch had gone badly. The team stayed resilient after the first product launch failed. They met the next morning to plan again.",
  previousSentence: "The launch had gone badly.",
  nextSentence: "They met the next morning to plan again.",
  sourceNote: "Product Retrospective",
  sourcePath: "01_Projects/Product Retrospective.md",
  mode: "reading",
};

export const sampleKnowledge = legacyExplanationToKnowledge(sampleExplanation, {
  sentence: sampleSnapshot.sentence,
  previousSentence: sampleSnapshot.previousSentence,
  nextSentence: sampleSnapshot.nextSentence,
});

export const sampleSettings = {
  provider: "deepseek",
  apiKey: "sk-test-secret",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
  ollamaDisableThinking: true,
  temperature: 0.3,
  maxTokens: 1800,
  timeoutMs: 60000,
  streaming: false,
  thinkingEnabled: false,
  autoOpenSidebar: true,
  targetLanguage: "en",
  explanationLanguage: "zh-CN",
  explanationDepth: "standard",
  learnerLevel: "intermediate",
};

export const sampleCompletion = {
  id: "chatcmpl-test",
  object: "chat.completion",
  created: 1780000000,
  model: "deepseek-flash",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: JSON.stringify(sampleExplanation),
      },
      finish_reason: "stop",
    },
  ],
};

export function makeCachedExplanation(key = "test-cache-key") {
  return {
    cacheSchemaVersion: 2,
    key,
    word: sampleExplanation.word,
    lemma: sampleKnowledge.identity.lemma,
    context: sampleSnapshot.context,
    contextHash: "test-context-hash",
    sourceSentence: sampleSnapshot.sentence,
    previousSentence: sampleSnapshot.previousSentence,
    nextSentence: sampleSnapshot.nextSentence,
    model: sampleSettings.model,
    profile: {
      targetLanguage: sampleSettings.targetLanguage,
      explanationLanguage: sampleSettings.explanationLanguage,
      explanationDepth: sampleSettings.explanationDepth,
      learnerLevel: sampleSettings.learnerLevel,
    },
    promptVersion: "lexiside-context-v12",
    knowledge: structuredClone(sampleKnowledge),
    createdAt: "2026-11-15T01:00:00.000Z",
  };
}


export function makeVocabularyEntry(overrides = {}) {
  return {
    ...sampleExplanation,
    id: "entry-test-1",
    key: "test-cache-key",
    context: sampleSnapshot.context,
    sourceSentence: sampleSnapshot.sentence,
    previousSentence: sampleSnapshot.previousSentence,
    nextSentence: sampleSnapshot.nextSentence,
    sourceNote: sampleSnapshot.sourceNote,
    sourcePath: sampleSnapshot.sourcePath,
    mode: sampleSnapshot.mode,
    model: sampleSettings.model,
    createdAt: "2026-11-15T01:00:00.000Z",
    savedAt: "2026-11-15T01:02:00.000Z",
    updatedAt: "2026-11-15T01:02:00.000Z",
    knowledge: structuredClone(sampleKnowledge),
    ...overrides,
  };
}

export function sseResponse(tokens, finishReason = "stop") {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const events = tokens.map((token) =>
        JSON.stringify({
          choices: [{ index: 0, delta: { content: token }, finish_reason: null }],
        }),
      );
      events.push(
        JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }),
        "[DONE]",
      );

      for (const event of events) {
        const bytes = encoder.encode(`data: ${event}\n\n`);
        const cut = Math.max(1, Math.floor(bytes.length / 2));
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}
