export const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Turn an OpenAI-compatible Ollama base URL into its native tags endpoint.
 * Accepts both http://host:11434 and http://host:11434/v1.
 */
export function buildOllamaTagsUrl(baseUrl: string): string {
  const raw = baseUrl.trim() || OLLAMA_DEFAULT_BASE_URL;
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  const url = new URL(withProtocol);
  const path = url.pathname.replace(/\/+$/, "");
  const root = path.replace(/\/v1$/i, "").replace(/\/api$/i, "");
  url.pathname = `${root}/api/tags`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** Read model names from Ollama's GET /api/tags response. */
export function parseOllamaModelNames(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value["models"])) {
    return [];
  }
  const names = new Set<string>();
  for (const model of value["models"]) {
    if (!isRecord(model)) {
      continue;
    }
    const name = model["name"] ?? model["model"];
    if (typeof name === "string" && name.trim()) {
      names.add(name.trim());
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}
