export interface AnkiRequestOptions {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

export interface AnkiResponse {
  status: number;
  text: string;
}

export type AnkiRequest = (options: AnkiRequestOptions) => Promise<AnkiResponse>;

export interface AnkiNote {
  deckName: string;
  modelName: string;
  fields: Record<string, string>;
  tags: string[];
  options: {
    allowDuplicate: boolean;
    duplicateScope: "deck";
  };
}

interface AnkiEnvelope<T> {
  result: T | null;
  error: string | null;
}

/** Minimal AnkiConnect v6 client. It only talks to the configured local URL. */
export class AnkiConnectClient {
  private readonly baseUrl: string;
  private readonly request: AnkiRequest;

  constructor(baseUrl: string, request: AnkiRequest) {
    this.baseUrl = (baseUrl.trim() || "http://127.0.0.1:8765").replace(/\/+$/, "");
    this.request = request;
  }

  async version(): Promise<number> {
    return this.invoke<number>("version");
  }

  async deckNames(): Promise<string[]> {
    return this.invoke<string[]>("deckNames");
  }

  async modelNames(): Promise<string[]> {
    return this.invoke<string[]>("modelNames");
  }

  async modelFieldNames(modelName: string): Promise<string[]> {
    return this.invoke<string[]>("modelFieldNames", { modelName });
  }

  async ensureDeck(deckName: string): Promise<void> {
    const decks = await this.deckNames();
    if (!decks.includes(deckName)) {
      await this.invoke<number>("createDeck", { deck: deckName });
    }
  }

  async canAddNotes(notes: readonly AnkiNote[]): Promise<boolean[]> {
    if (notes.length === 0) {
      return [];
    }
    return this.invoke<boolean[]>("canAddNotes", { notes });
  }

  async addNotes(notes: readonly AnkiNote[]): Promise<Array<number | null>> {
    if (notes.length === 0) {
      return [];
    }
    return this.invoke<Array<number | null>>("addNotes", { notes });
  }

  private async invoke<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    let response: AnkiResponse;
    try {
      response = await this.request({
        url: this.baseUrl,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, version: 6, params }),
      });
    } catch {
      throw new Error(
        "Could not reach AnkiConnect. Is Anki open and the AnkiConnect add-on installed?",
      );
    }

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`AnkiConnect returned HTTP ${response.status}.`);
    }

    let envelope: AnkiEnvelope<T>;
    try {
      envelope = JSON.parse(response.text) as AnkiEnvelope<T>;
    } catch {
      throw new Error("AnkiConnect returned an invalid response.");
    }
    if (envelope.error) {
      throw new Error(`AnkiConnect: ${envelope.error}`);
    }
    return envelope.result as T;
  }
}

/** Split an Anki tag string into valid, non-empty tags. */
export function ankiTagList(tags: string): string[] {
  return Array.from(
    new Set(
      tags
        .split(/\s+/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  );
}
