import { KNOWLEDGE_SCHEMA_VERSION } from "./knowledge.ts";
import type { GenerationInput, GenerationProfile, LexiSideSettings } from "./types.ts";

export const CACHE_SCHEMA_VERSION = 2;

function normalize(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Stable, dependency-free 53-bit hash; a second seed reduces collisions. */
function cyrb53(value: string, seed: number): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/** Hash exactly the context fields sent to the model. */
export function buildContextHash(input: GenerationInput): string {
  const context = JSON.stringify([
    normalize(input.sentence),
    input.previousSentence ? normalize(input.previousSentence) : "",
    input.nextSentence ? normalize(input.nextSentence) : "",
  ]);
  return `${cyrb53(context, 0)}${cyrb53(context, 1)}`;
}

export function cacheProviderKey(baseUrl: string): string {
  try {
    const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl.trim())
      ? baseUrl.trim()
      : `https://${baseUrl.trim()}`;
    const url = new URL(normalized);
    return normalize(`${url.hostname}${url.pathname.replace(/\/+$/, "")}`);
  } catch {
    return normalize(baseUrl);
  }
}

/**
 * The key includes the surface form. The store records the model's lemma and
 * can match known surface→lemma aliases without requiring a local lemmatizer.
 */
export function buildCacheKey(
  input: GenerationInput,
  settings: Pick<LexiSideSettings, "baseUrl" | "model">,
  promptVersion: string,
): string {
  const profile: GenerationProfile = {
    targetLanguage: input.targetLanguage,
    explanationLanguage: input.explanationLanguage,
    explanationDepth: input.explanationDepth,
    learnerLevel: input.learnerLevel,
  };
  return [
    `cache-v${CACHE_SCHEMA_VERSION}`,
    `knowledge-v${KNOWLEDGE_SCHEMA_VERSION}`,
    promptVersion,
    cacheProviderKey(settings.baseUrl),
    normalize(settings.model),
    profile.targetLanguage,
    profile.explanationLanguage,
    profile.explanationDepth,
    profile.learnerLevel,
    normalize(input.selectedText),
    buildContextHash(input),
  ].join("\u001F");
}
