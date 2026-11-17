import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  formatExplanationPlainText,
  formatKnowledgePlainText,
  LexiSideStore,
  MAX_CACHE_ENTRIES,
  normalizeLexiSideData,
  normalizeSettings,
  vocabularyToAnkiCsv,
  vocabularyToMarkdown,
} from "../storage.ts";
import { buildCacheKey, buildContextHash } from "../cache.ts";
import { buildGenerationInput } from "../generation.ts";
import { PROMPT_VERSION } from "../prompts.ts";
import { makeCachedExplanation, makeVocabularyEntry, sampleExplanation, sampleSettings, sampleSnapshot } from "./fixtures.mjs";

test("normalizes and clamps settings", () => {
  const settings = normalizeSettings({
    apiKey: "  key  ",
    baseUrl: "",
    model: "",
    temperature: 9,
    maxTokens: 1,
    timeoutMs: 9999999,
    streaming: "yes",
    thinkingEnabled: true,
    autoOpenSidebar: false,
    targetLanguage: "fr",
    explanationLanguage: "fr",
    explanationDepth: "detailed",
    learnerLevel: "advanced",
  });

  assert.equal(settings.provider, "deepseek");
  assert.equal(settings.apiKey, "key");
  assert.equal(settings.baseUrl, DEFAULT_SETTINGS.baseUrl);
  assert.equal(settings.model, DEFAULT_SETTINGS.model);
  assert.equal(settings.ollamaDisableThinking, true);
  assert.equal(settings.temperature, 2);
  assert.equal(settings.maxTokens, 128);
  assert.equal(settings.timeoutMs, 300000);
  assert.equal(settings.streaming, DEFAULT_SETTINGS.streaming);
  assert.equal(settings.thinkingEnabled, true);
  assert.equal(settings.autoOpenSidebar, false);
  assert.equal(settings.targetLanguage, "en");
  assert.equal(settings.explanationLanguage, "zh-CN");
  assert.equal(settings.explanationDepth, "detailed");
  assert.equal(settings.learnerLevel, "advanced");
  assert.equal(settings.pronunciationSource, "deepseek");
  assert.equal(settings.ttsVoice, "stella");
  assert.equal(settings.ankiConnectUrl, "http://127.0.0.1:8765");
  assert.equal(settings.ankiDeck, "LexiSide");
  assert.equal(settings.ankiModel, "Basic");
});

test("infers and preserves the model provider", () => {
  assert.equal(normalizeSettings({}).provider, "deepseek");
  assert.equal(normalizeSettings({ baseUrl: "http://127.0.0.1:11434/v1" }).provider, "ollama");
  assert.equal(
    normalizeSettings({ provider: "ollama", baseUrl: "https://gateway.example.com/v1" }).provider,
    "ollama",
  );
  assert.equal(
    normalizeSettings({ baseUrl: "https://gateway.example.com/v1" }).provider,
    "custom",
  );
});

test("normalizes pronunciation choices", () => {
  assert.equal(normalizeSettings({ pronunciationSource: "system" }).pronunciationSource, "system");
  assert.equal(normalizeSettings({ pronunciationSource: "bad" }).pronunciationSource, "deepseek");
  assert.equal(normalizeSettings({ ttsVoice: "tide" }).ttsVoice, "tide");
  assert.equal(normalizeSettings({ ttsVoice: "bad" }).ttsVoice, "stella");
});

test("migrates the v1 deepseek-chat default once and preserves later explicit choices", () => {
  const migrated = normalizeLexiSideData({
    schemaVersion: 1,
    settings: { apiKey: "secret", model: "deepseek-chat" },
  });
  assert.equal(migrated.storageVersion, 3);
  assert.equal(migrated.settings.model, "deepseek-flash");
  assert.equal(migrated.settings.thinkingEnabled, false);
  assert.equal(migrated.settings.apiKey, "secret");

  const explicit = normalizeLexiSideData({
    schemaVersion: 2,
    settings: { model: "deepseek-chat" },
  });
  assert.equal(explicit.settings.model, "deepseek-chat");

  const customEndpoint = normalizeLexiSideData({
    schemaVersion: 1,
    settings: { model: "deepseek-chat", baseUrl: "https://gateway.example.com/v1" },
  });
  assert.equal(customEndpoint.settings.model, "deepseek-chat");
});

test("drops malformed persisted vocabulary and cache entries", () => {
  const data = normalizeLexiSideData({
    settings: { apiKey: "secret" },
    vocabulary: [makeVocabularyEntry(), { garbage: true }],
    cache: [makeCachedExplanation(), { key: "broken" }],
  });

  assert.equal(data.settings.apiKey, "secret");
  assert.equal(data.storageVersion, 3);
  assert.equal(data.vocabulary.length, 1);
  assert.equal(data.cache.length, 1);
});

test("keeps legacy vocabulary and cache records without rewriting them", () => {
  const legacyEntry = {
    ...makeVocabularyEntry(),
    previousSentence: null,
    nextSentence: null,
  };
  delete legacyEntry.knowledge;
  const legacyCache = {
    key: "legacy-cache",
    word: sampleExplanation.word,
    context: "",
    sourceSentence: "",
    model: sampleSettings.model,
    explanation: sampleExplanation,
    createdAt: "2026-11-15T01:00:00.000Z",
  };
  const data = normalizeLexiSideData({
    schemaVersion: 2,
    settings: sampleSettings,
    vocabulary: [legacyEntry],
    cache: [legacyCache],
  });

  assert.equal(data.storageVersion, 3);
  assert.equal(data.vocabulary[0].knowledge, undefined);
  assert.equal(data.cache[0].knowledge, undefined);

  const store = LexiSideStore.load(data, async () => undefined);
  assert.equal(store.findVocabularyById(legacyEntry.id)?.word, "resilient");
  assert.equal(store.getCached("legacy-cache"), null);
  assert.equal(store.cacheSize, 1);
});

test("stores, finds, updates, and deletes vocabulary entries", async () => {
  const savedSnapshots = [];
  const store = LexiSideStore.load(
    { settings: sampleSettings },
    async (data) => {
      savedSnapshots.push(structuredClone(data));
    },
  );

  const entry = makeVocabularyEntry();
  store.upsertVocabularyEntry(entry);
  assert.equal(store.findVocabularyByKey(entry.key)?.word, "resilient");
  assert.equal(store.findVocabularyById(entry.id)?.id, entry.id);

  const knowledge = structuredClone(entry.knowledge);
  const contextual = knowledge.meanings.find((meaning) => meaning.scope === "contextual");
  contextual.chineseMeaning = "更新后的中文释义";
  const updated = {
    ...entry,
    knowledge,
    chineseMeaning: "更新后的中文释义",
    updatedAt: "2026-11-16T00:00:00.000Z",
  };
  store.updateVocabularyEntry(updated);
  assert.equal(store.findVocabularyById(entry.id)?.chineseMeaning, "更新后的中文释义");

  await store.persist();
  assert.equal(savedSnapshots.length, 1);
  assert.equal(savedSnapshots[0].storageVersion, 3);
  assert.equal(savedSnapshots[0].vocabulary[0].knowledge.identity.surface, "resilient");
  assert.equal(
    savedSnapshots[0].vocabulary[0].knowledge.meanings[0].chineseMeaning,
    "更新后的中文释义",
  );

  assert.equal(store.deleteVocabularyEntry(entry.id), true);
  assert.equal(store.findVocabularyById(entry.id), null);
});

test("caches explanations by key and clears the cache", () => {
  const store = LexiSideStore.load({ settings: sampleSettings }, async () => undefined);
  const cached = makeCachedExplanation("key-a");
  store.putCached(cached);
  assert.equal(store.getCached("key-a")?.word, "resilient");
  assert.equal(store.cacheSize, 1);
  assert.equal(store.clearCache(), 1);
  assert.equal(store.getCached("key-a"), null);
});

test("finds canonical cache entries by context key and surface-to-lemma alias", () => {
  const store = LexiSideStore.load({ settings: sampleSettings }, async () => undefined);
  const input = buildGenerationInput(sampleSnapshot);
  const key = buildCacheKey(input, sampleSettings, PROMPT_VERSION);
  const cached = {
    ...makeCachedExplanation(key),
    word: "resilient",
    lemma: "resilient",
    contextHash: buildContextHash(input),
    profile: {
      targetLanguage: sampleSettings.targetLanguage,
      explanationLanguage: sampleSettings.explanationLanguage,
      explanationDepth: sampleSettings.explanationDepth,
      learnerLevel: sampleSettings.learnerLevel,
    },
    promptVersion: PROMPT_VERSION,
  };
  store.putCached(cached);
  assert.equal(store.findCachedForInput(input, sampleSettings, PROMPT_VERSION)?.key, key);

  const aliasInput = { ...input, selectedText: "run" };
  const alias = {
    ...makeCachedExplanation("alias-key"),
    word: "running",
    lemma: "run",
    contextHash: buildContextHash(aliasInput),
    profile: cached.profile,
    promptVersion: PROMPT_VERSION,
  };
  store.putCached(alias);
  assert.equal(
    store.findCachedForInput(aliasInput, sampleSettings, PROMPT_VERSION)?.key,
    "alias-key",
  );
});

test("cache is capped", () => {
  const store = LexiSideStore.load({ settings: sampleSettings }, async () => undefined);
  for (let index = 0; index < MAX_CACHE_ENTRIES + 20; index += 1) {
    store.putCached(makeCachedExplanation(`key-${index}`));
  }
  assert.equal(store.cacheSize, MAX_CACHE_ENTRIES);
});

test("markdown export contains sections and never includes credentials", () => {
  const entry = makeVocabularyEntry();
  const markdown = vocabularyToMarkdown([entry]);

  assert.match(markdown, /# LexiSide Vocabulary/);
  assert.match(markdown, /## resilient/);
  assert.match(markdown, /### Contextual Meaning/);
  assert.match(markdown, /### Grammar & Usage/);
  assert.doesNotMatch(markdown, /sk-test-secret/);
});

test("Anki export is headerless CSV with three HTML-aware fields", () => {
  const entry = makeVocabularyEntry({
    contextualMeaning: 'He said "go", then <b>waited</b>.\nNext line.',
  });
  const csv = vocabularyToAnkiCsv([entry]);

  assert.ok(csv.startsWith('"<b>resilient</b>'));
  assert.match(csv, /lexiside resilient"\r\n$/);
  assert.match(csv, /&quot;go&quot;/);
  assert.match(csv, /&lt;b&gt;waited&lt;\/b&gt;/);
  assert.match(csv, /\.<br>Next line\./);
  assert.match(csv, /adjective: A material/);
  assert.doesNotMatch(csv, /adjective:A material/);
  assert.doesNotMatch(csv, /sk-test-secret/);
  assert.equal(csv.split('","').length > 2, true);
  assert.equal(csv.split("\r\n").filter(Boolean).length, 1);
});

test("canonical extras appear in copy and exports without credentials", () => {
  const entry = makeVocabularyEntry();
  entry.knowledge.nuance.antonyms = [
    { word: "fragile", difference: "Fragile means easily damaged." },
  ];
  entry.knowledge.wordFamily = [
    { word: "resilience", partOfSpeech: "noun", chineseMeaning: "韧性" },
  ];
  entry.knowledge.usage.sentencePatterns = [{ pattern: "remain resilient" }];

  const text = formatKnowledgePlainText(entry.knowledge, {
    sentence: "The team stayed resilient.",
  });
  assert.match(text, /Antonyms:/);
  assert.match(text, /Word family:/);
  assert.match(text, /remain resilient/);

  const markdown = vocabularyToMarkdown([entry]);
  assert.match(markdown, /### Word Family/);
  assert.match(markdown, /### Antonyms/);
  assert.match(markdown, /remain resilient/);

  const csv = vocabularyToAnkiCsv([entry]);
  assert.match(csv, /Word family/);
  assert.match(csv, /Antonyms/);
  assert.doesNotMatch(csv, /sk-test-secret/);
});

test("plain-text copy contains the explanation and source sentence", () => {
  const text = formatExplanationPlainText(sampleExplanation, {
    sentence: "The team stayed resilient.",
    sourceNote: "Retro",
  });
  assert.match(text, /resilient \/rɪˈzɪliənt\//);
  assert.match(text, /Contextual meaning:/);
  assert.match(text, /Original sentence: The team stayed resilient\./);
  assert.match(text, /Chinese meaning:/);
  assert.match(text, /有韧性的/);
});
