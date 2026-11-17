import { MarkdownView, Menu, Notice, Plugin, TFolder, normalizePath, requestUrl } from "obsidian";
import { AnkiConnectClient, ankiTagList, type AnkiNote } from "./anki.ts";
import { LexiSideApiClient, LexiSideApiError } from "./api.ts";
import {
  buildCacheKey,
  buildContextHash,
  CACHE_SCHEMA_VERSION,
} from "./cache.ts";
import {
  buildGenerationInput,
  profileFromSettings,
} from "./generation.ts";
import {
  applyExplanationEditsToKnowledge,
  knowledgeToLegacyExplanation,
} from "./migration.ts";
import {
  KnowledgeParseError,
  parseKnowledgeJson,
  parseKnowledgePreview,
} from "./parsing.ts";
import { buildRepairPrompt, PROMPT_VERSION } from "./prompts.ts";
import { DeepSeekTts, speakSystem } from "./pronunciation.ts";
import { LexiSideSettingTab } from "./settings.ts";
import { captureSelection, PREVIEW_TEXT_BLOCK_SELECTOR, SelectionWatcher } from "./selection.ts";
import {
  STORAGE_VERSION,
  formatKnowledgePlainText,
  LexiSideStore,
  vocabularyToAnkiCard,
  vocabularyToAnkiCsv,
  vocabularyToMarkdown,
} from "./storage.ts";
import type {
  CachedKnowledge,
  GenerationInput,
  KnowledgePreview,
  LexiSideSettings,
  LibraryHost,
  SelectionSnapshot,
  SidebarHost,
  SidebarState,
  VocabularyEntry,
  VocabularyKnowledge,
} from "./types.ts";
import { LEXISIDE_VIEW_TYPE, LexiSideView } from "./view.ts";
import { VocabularyModal } from "./modals.ts";

const EXPORT_FOLDER = "LexiSide Exports";
const SIDEBAR_OPEN_ERROR = "LexiSide could not open its sidebar.";

function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `lexiside-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function storedStorageVersion(value: unknown): number {
  if (typeof value !== "object" || value === null) {
    return 0;
  }
  const record = value as Record<string, unknown>;
  const version = record["storageVersion"] ?? record["schemaVersion"];
  return typeof version === "number" && Number.isFinite(version) ? version : 0;
}

function localFileTimestamp(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    " ",
    pad(date.getHours()),
    "-",
    pad(date.getMinutes()),
    "-",
    pad(date.getSeconds()),
  ].join("");
}

export default class LexiSidePlugin extends Plugin implements SidebarHost, LibraryHost {
  private store!: LexiSideStore;
  private apiClient!: LexiSideApiClient;
  private ttsClient!: DeepSeekTts;
  private ttsFallbackNoticed = false;
  private selectionWatcher!: SelectionWatcher;
  private sidebarState: SidebarState = { kind: "empty" };
  private activeController: AbortController | null = null;
  private requestEpoch = 0;
  private lastSelectionKey: string | null = null;
  private watchedDocuments = new Set<Document>();
  private settingsSaveTimer: number | null = null;

  getSettings(): Readonly<LexiSideSettings> {
    return this.store.settings;
  }

  get cacheSize(): number {
    return this.store.cacheSize;
  }

  async onload(): Promise<void> {
    const stored = await this.loadData();
    const previousStorageVersion = storedStorageVersion(stored);
    if (stored !== null && stored !== undefined && previousStorageVersion > 0 && previousStorageVersion < STORAGE_VERSION) {
      await this.backupStoredData();
    }
    this.store = LexiSideStore.load(stored, async (data) => {
      await this.saveData(data);
    });
    this.apiClient = new LexiSideApiClient({ requestUrlImpl: requestUrl });
    this.ttsClient = new DeepSeekTts(async (options) => {
      const response = await requestUrl({
        url: options.url,
        method: "POST",
        headers: options.headers,
        body: options.body,
        throw: false,
      });
      return {
        status: response.status,
        headers: response.headers,
        arrayBuffer: response.arrayBuffer,
        text: response.text,
      };
    });

    // Storage is upgraded lazily on the next settings/vocabulary/cache write.
    // Loading alone must not rewrite historical data.

    this.registerView(LEXISIDE_VIEW_TYPE, (leaf) => new LexiSideView(leaf, this));

    this.addRibbonIcon("book-open", "Open LexiSide", () => {
      void this.openSidebarFromCommand();
    });

    this.addCommand({
      id: "open-sidebar",
      name: "Open sidebar",
      callback: () => {
        void this.openSidebarFromCommand();
      },
    });

    this.addCommand({
      id: "explain-selection",
      name: "Explain selection now",
      callback: () => {
        this.explainCurrentSelection();
      },
    });

    this.addCommand({
      id: "open-vocabulary",
      name: "Open vocabulary library",
      callback: () => {
        this.openVocabulary();
      },
    });

    this.addCommand({
      id: "save-current",
      name: "Save current explanation to vocabulary",
      callback: () => {
        void this.saveCurrent().catch((error: unknown) => {
          new Notice(`LexiSide: ${error instanceof Error ? error.message : "Could not save the explanation."}`);
        });
      },
    });

    this.addCommand({
      id: "copy-current",
      name: "Copy current explanation",
      callback: () => {
        void this.copyCurrent().then(
          () => new Notice("Explanation copied."),
          (error: unknown) => {
            new Notice(`LexiSide: ${error instanceof Error ? error.message : "Could not copy the explanation."}`);
          },
        );
      },
    });

    this.addCommand({
      id: "regenerate-current",
      name: "Regenerate current explanation",
      callback: () => {
        void this.regenerateCurrent().catch((error: unknown) => {
          new Notice(`LexiSide: ${error instanceof Error ? error.message : "Could not regenerate the explanation."}`);
        });
      },
    });

    this.addCommand({
      id: "clear-cache",
      name: "Clear explanation cache",
      callback: () => {
        void this.clearCache();
      },
    });

    this.addCommand({
      id: "anki-test",
      name: "Anki: test AnkiConnect connection",
      callback: () => {
        void this.testAnkiConnect();
      },
    });

    this.addCommand({
      id: "anki-sync-current",
      name: "Anki: sync current word",
      callback: () => {
        void this.syncCurrentToAnki();
      },
    });

    this.addCommand({
      id: "anki-sync-all",
      name: "Anki: sync all saved words",
      callback: () => {
        void this.syncAllToAnki();
      },
    });

    this.addSettingTab(new LexiSideSettingTab(this.app, this));

    this.selectionWatcher = new SelectionWatcher(this.app, (snapshot) => {
      void this.handleSelection(snapshot).catch((error: unknown) => {
        new Notice(`LexiSide: ${error instanceof Error ? error.message : "Unexpected error while analyzing the selection."}`);
      });
    });

    this.watchDocument(this.app.workspace.containerEl.ownerDocument);
    this.app.workspace.iterateAllLeaves((leaf) => {
      const doc = leaf.view?.containerEl?.ownerDocument;
      if (doc) {
        this.watchDocument(doc);
      }
    });

    this.registerEvent(
      this.app.workspace.on("window-open", (_workspaceWindow, win) => {
        this.watchDocument(win.document);
      }),
    );
  }

  onunload(): void {
    this.clearSourceHighlight();
    this.ttsClient?.destroy();
    this.selectionWatcher?.destroy();
    this.activeController?.abort();
    this.activeController = null;
    this.requestEpoch += 1;
    this.watchedDocuments.clear();
    if (this.settingsSaveTimer !== null) {
      window.clearTimeout(this.settingsSaveTimer);
      this.settingsSaveTimer = null;
      void this.store.persist().catch(() => undefined);
    }
  }

  /** Best-effort raw backup before the storage envelope is upgraded. */
  private async backupStoredData(): Promise<void> {
    try {
      const dir = this.manifest.dir;
      if (!dir) {
        return;
      }
      const dataPath = normalizePath(`${dir}/data.json`);
      const backupPath = normalizePath(`${dir}/data.backup-storage-v2.json`);
      if (await this.app.vault.adapter.exists(backupPath)) {
        return;
      }
      const raw = await this.app.vault.adapter.read(dataPath);
      await this.app.vault.adapter.write(backupPath, raw);
    } catch {
      // A backup failure must not block loading; installation also snapshots data.
    }
  }

  private watchDocument(doc: Document): void {
    if (!doc || this.watchedDocuments.has(doc)) {
      return;
    }
    this.watchedDocuments.add(doc);
    this.registerDomEvent(doc, "selectionchange", () => {
      this.selectionWatcher?.schedule(doc);
    });
    this.registerDomEvent(doc, "contextmenu", (event) => {
      this.showSelectionContextMenu(event as MouseEvent, doc);
    });
  }

  private showSelectionContextMenu(event: MouseEvent, doc: Document): void {
    const snapshot = captureSelection(this.app, doc);
    if (!snapshot) {
      return;
    }
    const key = this.keyForSnapshot(snapshot);
    const current = this.currentResult();
    const same = current !== null && current.key === key;
    const saved = same && this.store.findVocabularyByKey(key) !== null;
    const menu = new Menu();

    menu.addItem((item) => {
      item
        .setTitle(saved ? "Remove from LexiSide" : "Add to LexiSide")
        .setIcon(saved ? "star-off" : "star")
        .onClick(() => {
          void (async () => {
            try {
              if (saved) {
                await this.toggleCurrentSaved();
              } else {
                await this.addSelectionToLexiSide(snapshot);
              }
            } catch (error) {
              new Notice(`LexiSide: ${error instanceof Error ? error.message : "Could not save the selection."}`);
            }
          })();
        });
    });

    menu.addItem((item) => {
      item
        .setTitle("Regenerate explanation")
        .setIcon("refresh-cw")
        .onClick(() => {
          void (async () => {
            try {
              if (this.currentResult()?.key === key) {
                await this.regenerateCurrent();
              } else {
                await this.handleSelection(snapshot, true);
              }
            } catch (error) {
              new Notice(
                `LexiSide: ${error instanceof Error ? error.message : "Could not regenerate the explanation."}`,
              );
            }
          })();
        });
    });

    menu.addSeparator();
    menu.addItem((item) => {
      item
        .setTitle("Open LexiSide library")
        .setIcon("library")
        .onClick(() => this.openVocabulary());
    });

    menu.showAtMouseEvent(event);
    event.preventDefault();
    event.stopPropagation();
  }

  async revealSource(snapshot: SelectionSnapshot): Promise<void> {
    let target = this.findSourceView(snapshot);
    if (!target) {
      try {
        await this.app.workspace.openLinkText(snapshot.sourcePath, "", false);
      } catch {
        new Notice("LexiSide: Could not open the source note.");
        return;
      }
      target = this.findSourceView(snapshot);
    }
    if (!target) {
      new Notice("LexiSide: Could not find the source note.");
      return;
    }
    if (target.getMode() !== "preview") {
      new Notice("LexiSide: Switch the source note to Reading View to locate the sentence.");
      return;
    }

    this.app.workspace.revealLeaf(target.leaf);
    // Always restore the scroll captured with the selection before locating.
    // If an identical paragraph is mounted elsewhere, looking first can
    // produce a valid-looking range in the wrong place and prevent recovery.
    const locateExact = (): { sentence: Range | null; word: Range | null } | null =>
      this.findLocatorRanges(target.previewMode.containerEl, snapshot);

    let restoredScroll = false;
    if (snapshot.sourceScroll !== undefined) {
      // The block may not be mounted while the note is scrolled elsewhere.
      // Virtualized Reading View can take several frames to mount a distant
      // section, especially after switching leaves.
      target.previewMode.applyScroll(snapshot.sourceScroll);
      restoredScroll = true;
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }

    let ranges = locateExact() ?? { sentence: null, word: null };
    let anchor = ranges.sentence ?? ranges.word;
    if (!anchor && restoredScroll) {
      for (let attempt = 0; attempt < 11 && !anchor; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 50));
        ranges = locateExact() ?? { sentence: null, word: null };
        anchor = ranges.sentence ?? ranges.word;
      }
    }
    const hasExactLocator =
      snapshot.sourceBlockStart !== undefined && snapshot.sourceBlockEnd !== undefined;
    if (!anchor && !hasExactLocator) {
      // Only legacy entries without a captured character range may use text
      // matching. New entries fail visibly rather than navigating to a
      // same-spelled word at the wrong source location.
      ranges = this.findTextRanges(
        target.previewMode.containerEl,
        snapshot.sentence,
        snapshot.word,
      );
      anchor = ranges.sentence ?? ranges.word;
    }
    if (!anchor) {
      new Notice("LexiSide: Could not locate the source sentence in the note.");
      return;
    }

    const block =
      (anchor.startContainer.nodeType === Node.TEXT_NODE
        ? anchor.startContainer.parentElement
        : (anchor.startContainer as Element)
      )?.closest("p, li, blockquote, h1, h2, h3, h4, h5, h6, td, th, dd") ??
      target.previewMode.containerEl;
    if (!restoredScroll) {
      block.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    if (!this.applySourceHighlights(ranges)) {
      this.flashSourceBlock(block);
    }
    this.clearNativeSelection(target);
  }

  autoHighlightSource(snapshot: SelectionSnapshot): void {
    this.clearSourceHighlight();
    const target = this.findSourceView(snapshot);
    if (!target || target.getMode() !== "preview") {
      return;
    }
    const ranges =
      this.findLocatorRanges(target.previewMode.containerEl, snapshot) ??
      this.findTextRanges(
        target.previewMode.containerEl,
        snapshot.sentence,
        snapshot.word,
      );
    this.applySourceHighlights(ranges);
    this.clearNativeSelection(target);
  }

  private clearNativeSelection(view: MarkdownView): void {
    const selection = view.containerEl.ownerDocument.getSelection();
    if (!selection || selection.isCollapsed) {
      return;
    }
    const anchor = selection.anchorNode;
    if (anchor && view.containerEl.contains(anchor)) {
      selection.removeAllRanges();
    }
  }

  clearSourceHighlight(): void {
    const registry = (CSS as unknown as {
      highlights?: { delete(name: string): void };
    }).highlights;
    registry?.delete("lexiside-source-sentence");
    registry?.delete("lexiside-source-word");
  }

  private findSourceView(snapshot: SelectionSnapshot): MarkdownView | null {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === snapshot.sourcePath) {
        return view;
      }
    }
    return null;
  }

  private findLocatorRanges(
    root: HTMLElement,
    snapshot: SelectionSnapshot,
  ): { sentence: Range | null; word: Range | null } | null {
    if (
      snapshot.sourceBlockIndex === undefined ||
      snapshot.sourceBlockStart === undefined ||
      snapshot.sourceBlockEnd === undefined
    ) {
      return null;
    }
    const blocks = Array.from(
      root.querySelectorAll<HTMLElement>(PREVIEW_TEXT_BLOCK_SELECTOR),
    );
    const candidates: HTMLElement[] = [];
    if (snapshot.sourceLine !== undefined) {
      for (const element of Array.from(root.querySelectorAll<HTMLElement>("[data-line]"))) {
        if (Number.parseInt(element.getAttribute("data-line") ?? "", 10) !== snapshot.sourceLine) {
          continue;
        }
        if (element.matches(PREVIEW_TEXT_BLOCK_SELECTOR)) {
          candidates.push(element);
        }
        for (const child of Array.from(
          element.querySelectorAll<HTMLElement>(PREVIEW_TEXT_BLOCK_SELECTOR),
        )) {
          candidates.push(child);
        }
      }
    }
    if (snapshot.sourceBlockIndex !== undefined) {
      const indexed = blocks[snapshot.sourceBlockIndex];
      if (indexed) {
        candidates.push(indexed);
      }
    }

    const normalize = (value: string): string =>
      value.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
    const expectedBlock = snapshot.sourceBlockText ? normalize(snapshot.sourceBlockText) : null;
    // Block indexes are local to the currently mounted part of Obsidian's
    // virtualized Reading View. The text fingerprint remains stable, so scan
    // mounted blocks as well instead of assuming that index is global.
    if (expectedBlock) {
      for (const block of blocks) {
        if (normalize(block.textContent ?? "") === expectedBlock) {
          candidates.push(block);
        }
      }
    }
    const seen = new Set<HTMLElement>();
    for (const block of candidates) {
      if (seen.has(block)) {
        continue;
      }
      seen.add(block);
      if (expectedBlock && normalize(block.textContent ?? "") !== expectedBlock) {
        continue;
      }
      const length = (block.textContent ?? "").length;
      if (
        snapshot.sourceBlockStart < 0 ||
        snapshot.sourceBlockEnd <= snapshot.sourceBlockStart ||
        snapshot.sourceBlockEnd > length
      ) {
        continue;
      }
      const word = this.rangeFromTextOffsets(
        block,
        snapshot.sourceBlockStart,
        snapshot.sourceBlockEnd,
      );
      if (!word || normalize(word.toString()) !== normalize(snapshot.word)) {
        continue;
      }
      const sentence =
        snapshot.sourceSentenceStart !== undefined && snapshot.sourceSentenceEnd !== undefined
          ? this.rangeFromTextOffsets(block, snapshot.sourceSentenceStart, snapshot.sourceSentenceEnd)
          : this.findTextRanges(block, snapshot.sentence, snapshot.word).sentence;
      if (!sentence) {
        continue;
      }
      return { sentence, word };
    }
    return null;
  }

  private rangeFromTextOffsets(root: HTMLElement, start: number, end: number): Range | null {
    const doc = root.ownerDocument;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let startPoint: { node: Text; offset: number } | null = null;
    let endPoint: { node: Text; offset: number } | null = null;
    let current: Node | null = walker.nextNode();
    while (current) {
      const text = current as Text;
      const next = offset + (text.nodeValue?.length ?? 0);
      if (!startPoint && start >= offset && start <= next) {
        startPoint = { node: text, offset: start - offset };
      }
      if (!endPoint && end >= offset && end <= next) {
        endPoint = { node: text, offset: end - offset };
      }
      if (startPoint && endPoint) {
        break;
      }
      offset = next;
      current = walker.nextNode();
    }
    if (!startPoint || !endPoint) {
      return null;
    }
    const range = doc.createRange();
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, endPoint.offset);
    return range;
  }

  private findTextRanges(
    root: HTMLElement,
    sentence: string,
    word: string,
  ): { sentence: Range | null; word: Range | null } {
    const empty = { sentence: null, word: null };
    const doc = root.ownerDocument;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || parent.closest("script, style, .lexiside-word-map")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const normalize = (value: string): string =>
      value
        .replace(/\u00a0/g, " ")
        .replace(/[’‘]/g, "'")
        .replace(/[“”]/g, '"');
    const segments: Array<{ node: Text; start: number; end: number }> = [];
    let full = "";
    let current: Node | null = walker.nextNode();
    while (current) {
      const text = normalize(current.nodeValue ?? "");
      segments.push({ node: current as Text, start: full.length, end: full.length + text.length });
      full += text;
      current = walker.nextNode();
    }

    const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const normalizedSentence = normalize(sentence);
    const normalizedWord = normalize(word);
    const sentenceWords = normalizedSentence.trim().split(/\s+/).filter(Boolean).map(escape);
    const wordWords = normalizedWord.trim().split(/\s+/).filter(Boolean).map(escape);
    const sentenceMatches: RegExpExecArray[] = [];
    if (sentenceWords.length > 0) {
      const sentencePattern = new RegExp(sentenceWords.join("\\s+"), "gi");
      let candidate: RegExpExecArray | null;
      while ((candidate = sentencePattern.exec(full))) {
        sentenceMatches.push(candidate);
      }
    }
    const wordMatches: RegExpExecArray[] = [];
    if (wordWords.length > 0) {
      const collect = (pattern: RegExp): void => {
        let candidate: RegExpExecArray | null;
        while ((candidate = pattern.exec(full))) {
          wordMatches.push(candidate);
        }
      };
      collect(new RegExp(`\\b${wordWords.join("\\s+")}\\b`, "gi"));
      if (wordMatches.length === 0) {
        // Apostrophes, punctuation, or symbols can defeat word boundaries.
        collect(new RegExp(wordWords.join("\\s+"), "gi"));
      }
    }

    const within = (wordMatch: RegExpExecArray | null, sentenceMatch: RegExpExecArray | null): boolean =>
      Boolean(
        wordMatch &&
          sentenceMatch &&
          wordMatch.index >= sentenceMatch.index &&
          wordMatch.index < sentenceMatch.index + sentenceMatch[0].length,
      );
    const firstSentence = sentenceMatches[0] ?? null;
    // A full-document word occurrence is not stable in a virtualized Reading
    // View. Only fall back when the sentence itself is unique in the mounted
    // DOM, then choose the word inside that sentence.
    const sentenceMatch = sentenceMatches.length === 1 ? firstSentence : null;
    const wordMatch = sentenceMatch
      ? wordMatches.find((candidate) => within(candidate, sentenceMatch)) ?? null
      : null;

    const locate = (offset: number): { node: Text; offset: number } | null => {
      for (const segment of segments) {
        if (offset >= segment.start && offset <= segment.end) {
          return { node: segment.node, offset: Math.max(0, offset - segment.start) };
        }
      }
      return null;
    };
    const makeRange = (match: RegExpExecArray | null): Range | null => {
      if (!match) {
        return null;
      }
      const start = locate(match.index);
      const end = locate(match.index + match[0].length);
      if (!start || !end) {
        return null;
      }
      const range = doc.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      return range;
    };

    const ranges = {
      sentence: makeRange(sentenceMatch),
      word: makeRange(wordMatch),
    };
    return ranges.sentence || ranges.word ? ranges : empty;
  }

  private applySourceHighlights(ranges: { sentence: Range | null; word: Range | null }): boolean {
    this.clearSourceHighlight();
    const registry = (CSS as unknown as {
      highlights?: { set(name: string, value: unknown): void; delete(name: string): void };
    }).highlights;
    const HighlightCtor = (window as Window & { Highlight?: new (...ranges: Range[]) => unknown })
      .Highlight;
    if (!registry || !HighlightCtor || (!ranges.sentence && !ranges.word)) {
      return false;
    }

    // Paint the sentence around the word, not underneath it. Overlapping
    // highlights can otherwise hide the stronger word color.
    if (ranges.sentence && ranges.word) {
      const containsWord =
        ranges.sentence.compareBoundaryPoints(Range.START_TO_START, ranges.word) <= 0 &&
        ranges.sentence.compareBoundaryPoints(Range.END_TO_END, ranges.word) >= 0;
      if (containsWord) {
        const before = ranges.sentence.cloneRange();
        before.setEnd(ranges.word.startContainer, ranges.word.startOffset);
        const after = ranges.sentence.cloneRange();
        after.setStart(ranges.word.endContainer, ranges.word.endOffset);
        const pieces = [before, after].filter((range) => !range.collapsed);
        if (pieces.length > 0) {
          registry.set("lexiside-source-sentence", new HighlightCtor(...pieces));
        }
        registry.set("lexiside-source-word", new HighlightCtor(ranges.word));
        return true;
      }
    }

    if (ranges.sentence) {
      registry.set("lexiside-source-sentence", new HighlightCtor(ranges.sentence));
    }
    if (ranges.word) {
      registry.set("lexiside-source-word", new HighlightCtor(ranges.word));
    }
    return true;
  }

  private flashSourceBlock(block: Element): void {
    block.addClass("lexiside-source-flash");
    window.setTimeout(() => block.removeClass("lexiside-source-flash"), 1800);
  }

  private async addSelectionToLexiSide(snapshot: SelectionSnapshot): Promise<void> {
    const key = this.keyForSnapshot(snapshot);
    if (!this.currentResult() || this.currentResult()?.key !== key) {
      await this.handleSelection(snapshot, true);
    }
    const resultKey = this.currentResult()?.key ?? key;
    if (this.store.findVocabularyByKey(resultKey)) {
      new Notice("LexiSide: This selection is already in the vocabulary.");
      return;
    }
    await this.saveCurrent();
  }

  private explainCurrentSelection(): void {
    const doc = typeof activeDocument === "undefined" ? document : activeDocument;
    const snapshot = captureSelection(this.app, doc);
    if (!snapshot) {
      new Notice("Select an English word or phrase in a Markdown note first.");
      return;
    }
    void this.handleSelection(snapshot, true).catch((error: unknown) => {
      new Notice(`LexiSide: ${error instanceof Error ? error.message : "Unexpected error while analyzing the selection."}`);
    });
  }

  private async openSidebarFromCommand(): Promise<void> {
    try {
      const view = await this.ensureSidebar(true);
      if (!view) {
        new Notice(SIDEBAR_OPEN_ERROR);
      }
    } catch (error) {
      new Notice(`${SIDEBAR_OPEN_ERROR} ${error instanceof Error ? error.message : ""}`.trim());
    }
  }

  private getSidebarViews(): LexiSideView[] {
    return this.app.workspace
      .getLeavesOfType(LEXISIDE_VIEW_TYPE)
      .map((leaf) => leaf.view)
      .filter((view): view is LexiSideView => view instanceof LexiSideView);
  }

  private async ensureSidebar(reveal: boolean): Promise<LexiSideView | null> {
    let leaves = this.app.workspace.getLeavesOfType(LEXISIDE_VIEW_TYPE);
    let leaf = leaves[0];

    if (!leaf && !reveal) {
      return null;
    }

    if (!leaf) {
      leaf = await this.app.workspace.ensureSideLeaf(LEXISIDE_VIEW_TYPE, "right", {
        active: false,
        reveal: true,
        split: false,
      });
    } else {
      await leaf.loadIfDeferred();
      if (reveal && leaf.view.containerEl.isShown() === false) {
        await this.app.workspace.ensureSideLeaf(LEXISIDE_VIEW_TYPE, "right", {
          active: false,
          reveal: true,
          split: false,
        });
      }
    }

    leaves = this.app.workspace.getLeavesOfType(LEXISIDE_VIEW_TYPE);
    leaf = leaves[0] ?? leaf;
    if (!leaf) {
      return null;
    }
    await leaf.loadIfDeferred();

    if (!(leaf.view instanceof LexiSideView)) {
      await leaf.setViewState({ type: LEXISIDE_VIEW_TYPE, active: false });
      await leaf.loadIfDeferred();
    }

    const view = leaf.view;
    if (!(view instanceof LexiSideView)) {
      return null;
    }
    view.renderState();
    return view;
  }

  private setSidebarState(state: SidebarState): void {
    this.sidebarState = state;
    for (const view of this.getSidebarViews()) {
      view.renderState();
    }
  }

  private updateLoadingStatus(status: string): void {
    if (this.sidebarState.kind !== "loading") {
      return;
    }
    this.sidebarState = { ...this.sidebarState, status };
    for (const view of this.getSidebarViews()) {
      view.updateLoadingStatus(status);
    }
  }

  private updateStreamingPreview(preview: KnowledgePreview): void {
    if (this.sidebarState.kind !== "loading" || Object.keys(preview).length === 0) {
      return;
    }
    this.sidebarState = { ...this.sidebarState, preview };
    for (const view of this.getSidebarViews()) {
      view.renderState();
    }
  }

  private cancelActiveRequest(): void {
    this.activeController?.abort();
    this.activeController = null;
  }

  private isCurrentRequest(epoch: number, controller: AbortController): boolean {
    return epoch === this.requestEpoch && this.activeController === controller && !controller.signal.aborted;
  }

  private inputForSnapshot(snapshot: SelectionSnapshot): GenerationInput {
    return buildGenerationInput(snapshot, profileFromSettings(this.store.settings));
  }

  private keyForSnapshot(snapshot: SelectionSnapshot): string {
    return buildCacheKey(this.inputForSnapshot(snapshot), this.store.settings, PROMPT_VERSION);
  }

  private async handleSelection(snapshot: SelectionSnapshot, forceReveal = false): Promise<void> {
    const key = this.keyForSnapshot(snapshot);
    const reveal = forceReveal || this.store.settings.autoOpenSidebar;

    if (this.lastSelectionKey === key && this.sidebarState.kind !== "empty") {
      const currentSnapshot =
        this.sidebarState.kind === "result" || this.sidebarState.kind === "loading" || this.sidebarState.kind === "error"
          ? this.sidebarState.snapshot
          : null;
      // Keep the displayed source note in sync when the same context appears in
      // a different note. The cached analysis itself does not need a new request.
      if (currentSnapshot?.sourcePath === snapshot.sourcePath) {
        this.lastSelectionKey = key;
        await this.openSidebarSafely(reveal);
        return;
      }
    }

    await this.runQuery(snapshot, key, reveal, true);
  }

  private async openSidebarSafely(reveal: boolean): Promise<void> {
    try {
      await this.ensureSidebar(reveal);
    } catch {
      new Notice(SIDEBAR_OPEN_ERROR);
    }
  }

  private async runQuery(
    snapshot: SelectionSnapshot,
    key: string,
    reveal: boolean,
    useCache: boolean,
  ): Promise<void> {
    this.cancelActiveRequest();
    const epoch = ++this.requestEpoch;
    this.lastSelectionKey = key;

    if (useCache) {
      const input = this.inputForSnapshot(snapshot);
      const cached = this.store.findCachedForInput(input, this.store.settings, PROMPT_VERSION);
      if (cached) {
        this.lastSelectionKey = cached.key;
        this.setSidebarState({
          kind: "result",
          snapshot,
          knowledge: cached.knowledge,
          explanation: knowledgeToLegacyExplanation(cached.knowledge),
          meta: {
            origin: "cache",
            model: cached.model,
            queriedAt: cached.createdAt,
          },
          key: cached.key,
        });
        await this.openSidebarSafely(reveal);
        return;
      }
    }

    this.setSidebarState({
      kind: "loading",
      snapshot,
      status: "Preparing request…",
      startedAt: new Date().toISOString(),
    });

    if (epoch !== this.requestEpoch) {
      return;
    }

    // Start the network request and reveal the sidebar concurrently. Previously
    // the request waited for the sidebar leaf to be created and revealed.
    await Promise.all([this.openSidebarSafely(reveal), this.startAnalysis(snapshot, key, epoch)]);
  }

  private async startAnalysis(snapshot: SelectionSnapshot, key: string, epoch: number): Promise<void> {
    if (epoch !== this.requestEpoch) {
      return;
    }

    this.cancelActiveRequest();
    const controller = new AbortController();
    this.activeController = controller;
    const settings = this.store.settings;
    const apiKey = settings.apiKey;
    const input = this.inputForSnapshot(snapshot);
    let lastProgressUpdate = 0;
    let lastPreviewUpdate = 0;
    let lastPreviewSignature = "";

    try {
      let completion = await this.apiClient.analyze(settings, snapshot, {
        signal: controller.signal,
        onStatus: (status) => {
          if (this.isCurrentRequest(epoch, controller)) {
            this.updateLoadingStatus(status);
          }
        },
        onProgress: (characters) => {
          if (!this.isCurrentRequest(epoch, controller)) {
            return;
          }
          const now = Date.now();
          if (now - lastProgressUpdate > 250) {
            lastProgressUpdate = now;
            this.updateLoadingStatus(`Receiving structured response · ${characters.toLocaleString()} characters`);
          }
        },
        onContent: (raw) => {
          if (!this.isCurrentRequest(epoch, controller)) {
            return;
          }
          const now = Date.now();
          if (now - lastPreviewUpdate < 80) {
            return;
          }
          lastPreviewUpdate = now;

          try {
            const preview = parseKnowledgePreview(raw, snapshot);
            const signature = JSON.stringify(preview);
            if (signature === lastPreviewSignature || signature === "{}") {
              return;
            }
            lastPreviewSignature = signature;
            this.updateStreamingPreview(preview);
          } catch {
            // A malformed partial field is ignored until the full response is
            // parsed and validated.
          }
        },
      });

      if (!this.isCurrentRequest(epoch, controller)) {
        return;
      }

      let knowledge: VocabularyKnowledge;
      try {
        knowledge = parseKnowledgeJson(completion.content, snapshot);
      } catch (parseError) {
        if (!(parseError instanceof KnowledgeParseError)) {
          throw parseError;
        }
        if (!this.isCurrentRequest(epoch, controller)) {
          return;
        }
        this.updateLoadingStatus("Repairing the structured response…");
        const repaired = await this.apiClient.analyze(settings, snapshot, {
          signal: controller.signal,
          promptOverride: buildRepairPrompt(
            input,
            completion.content,
            parseError.details ?? parseError.message,
          ),
          onStatus: (status) => {
            if (this.isCurrentRequest(epoch, controller)) {
              this.updateLoadingStatus(status);
            }
          },
        });
        if (!this.isCurrentRequest(epoch, controller)) {
          return;
        }
        try {
          knowledge = parseKnowledgeJson(repaired.content, snapshot);
        } catch (repairError) {
          if (repairError instanceof KnowledgeParseError) {
            throw new KnowledgeParseError(
              "The AI response still does not match the vocabulary schema after one repair attempt.",
              repairError.details ?? repairError.message,
            );
          }
          throw repairError;
        }
        completion = repaired;
      }

      const explanation = knowledgeToLegacyExplanation(knowledge);
      const createdAt = new Date().toISOString();
      const cached: CachedKnowledge = {
        cacheSchemaVersion: CACHE_SCHEMA_VERSION,
        key,
        word: snapshot.word,
        lemma: knowledge.identity.lemma,
        context: snapshot.context,
        contextHash: buildContextHash(input),
        sourceSentence: snapshot.sentence,
        previousSentence: snapshot.previousSentence,
        nextSentence: snapshot.nextSentence,
        model: completion.model || settings.model,
        profile: profileFromSettings(settings),
        promptVersion: PROMPT_VERSION,
        knowledge,
        createdAt,
      };

      if (!this.isCurrentRequest(epoch, controller)) {
        return;
      }

      this.store.putCached(cached);
      this.setSidebarState({
        kind: "result",
        snapshot,
        knowledge,
        explanation,
        meta: {
          origin: "ai",
          model: cached.model,
          queriedAt: createdAt,
        },
        key,
      });

      try {
        await this.store.persist();
      } catch {
        new Notice("LexiSide: The explanation loaded, but the local cache could not be saved.");
      }
    } catch (error) {
      if (!this.isCurrentRequest(epoch, controller)) {
        return;
      }
      if (error instanceof LexiSideApiError && error.kind === "aborted") {
        return;
      }
      const message =
        error instanceof LexiSideApiError
          ? error.message
          : error instanceof KnowledgeParseError
            ? "The AI returned JSON that does not match the LexiSide schema after one repair attempt. Try again."
            : "An unexpected error occurred while analyzing the selection.";
      const rawDetails =
        error instanceof LexiSideApiError
          ? error.details
          : error instanceof KnowledgeParseError
            ? (error.details ?? error.message)
            : error instanceof Error
              ? error.message
              : null;
      const details = rawDetails ? this.redactSecret(rawDetails, apiKey) : null;

      this.setSidebarState({
        kind: "error",
        snapshot,
        message,
        details,
        retryable: true,
      });

      if (!this.getSidebarViews().some((view) => view.containerEl.isShown())) {
        new Notice(`LexiSide: ${message}`);
      }
    } finally {
      if (this.activeController === controller) {
        this.activeController = null;
      }
    }
  }

  private redactSecret(value: string, secret: string): string {
    return secret ? value.split(secret).join("[redacted]") : value;
  }

  private async requery(snapshot: SelectionSnapshot, reveal: boolean): Promise<void> {
    await this.runQuery(snapshot, this.keyForSnapshot(snapshot), reveal, false);
  }

  private currentResult(): Extract<SidebarState, { kind: "result" }> | null {
    return this.sidebarState.kind === "result" ? this.sidebarState : null;
  }

  // SidebarHost

  getSidebarState(): SidebarState {
    return this.sidebarState;
  }

  isCurrentSaved(): boolean {
    const result = this.currentResult();
    return result ? this.store.findVocabularyByKey(result.key) !== null : false;
  }

  async toggleCurrentSaved(): Promise<void> {
    const result = this.currentResult();
    if (!result) {
      return;
    }
    const existing = this.store.findVocabularyByKey(result.key);
    if (!existing) {
      await this.saveCurrent();
      return;
    }

    this.store.deleteVocabularyEntry(existing.id);
    try {
      await this.store.persist();
    } catch (error) {
      this.store.upsertVocabularyEntry(existing);
      throw error;
    }
    new Notice("Removed from vocabulary.");
  }

  async saveCurrent(): Promise<void> {
    const result = this.currentResult();
    if (!result) {
      throw new Error("There is no explanation to save yet.");
    }
    if (this.store.findVocabularyByKey(result.key)) {
      return;
    }

    const now = new Date().toISOString();
    const entry: VocabularyEntry = {
      ...result.explanation,
      id: makeId(),
      key: result.key,
      context: result.snapshot.context,
      sourceSentence: result.snapshot.sentence,
      previousSentence: result.snapshot.previousSentence,
      nextSentence: result.snapshot.nextSentence,
      sourceNote: result.snapshot.sourceNote,
      sourcePath: result.snapshot.sourcePath,
      mode: result.snapshot.mode,
      model: result.meta.model,
      createdAt: result.meta.queriedAt,
      savedAt: now,
      updatedAt: now,
      knowledge: result.knowledge,
    };

    this.store.upsertVocabularyEntry(entry);
    try {
      await this.store.persist();
    } catch (error) {
      this.store.deleteVocabularyByKey(entry.key);
      throw error;
    }
    new Notice(`Saved “${entry.word}” to LexiSide vocabulary.`);
  }

  async copyCurrent(): Promise<void> {
    const result = this.currentResult();
    if (!result) {
      throw new Error("There is no explanation to copy yet.");
    }
    const text = formatKnowledgePlainText(result.knowledge, {
      sentence: result.snapshot.sentence,
      sourceNote: result.snapshot.sourceNote,
    });
    const win = this.app.workspace.containerEl.ownerDocument.defaultView;
    const clipboard = win?.navigator.clipboard ?? globalThis.navigator?.clipboard;
    if (!clipboard) {
      throw new Error("Clipboard access is not available in this environment.");
    }
    await clipboard.writeText(text);
  }

  async regenerateCurrent(): Promise<void> {
    const result = this.currentResult();
    if (!result) {
      return;
    }
    await this.requery(result.snapshot, true);
  }

  async retryCurrent(): Promise<void> {
    const state = this.sidebarState;
    if (state.kind !== "error" || !state.snapshot) {
      return;
    }
    await this.requery(state.snapshot, true);
  }

  async speakWord(word: string, button: HTMLButtonElement): Promise<void> {
    const settings = this.store.settings;
    if (settings.pronunciationSource === "deepseek") {
      try {
        await this.ttsClient.play(word, settings, button);
        return;
      } catch {
        if (!this.ttsFallbackNoticed) {
          this.ttsFallbackNoticed = true;
          new Notice("LexiSide: DeepSeek TTS unavailable; using the system voice.");
        }
      }
    }
    try {
      speakSystem(word, button);
    } catch (error) {
      new Notice(`LexiSide: ${error instanceof Error ? error.message : "Pronunciation is unavailable."}`);
    }
  }

  openVocabulary(): void {
    new VocabularyModal(this.app, this).open();
  }

  // LibraryHost

  getVocabularyEntries(): readonly VocabularyEntry[] {
    return this.store.vocabularyEntries;
  }

  async deleteVocabularyEntry(id: string): Promise<void> {
    const existing = this.store.findVocabularyById(id);
    if (!existing) {
      throw new Error("That vocabulary entry no longer exists.");
    }
    this.store.deleteVocabularyEntry(id);
    try {
      await this.store.persist();
    } catch (error) {
      this.store.upsertVocabularyEntry(existing);
      throw error;
    }
  }

  async updateVocabularyEntry(entry: VocabularyEntry): Promise<void> {
    const existing = this.store.findVocabularyById(entry.id);
    if (!existing) {
      throw new Error("That vocabulary entry no longer exists.");
    }
    const knowledge = applyExplanationEditsToKnowledge(existing.knowledge, entry);
    const flat = knowledgeToLegacyExplanation(knowledge);
    const updated: VocabularyEntry = {
      ...entry,
      ...flat,
      knowledge,
      savedAt: existing.savedAt,
      updatedAt: new Date().toISOString(),
    };
    this.store.updateVocabularyEntry(updated);
    try {
      await this.store.persist();
    } catch (error) {
      this.store.updateVocabularyEntry(existing);
      throw error;
    }

    const state = this.sidebarState;
    if (state.kind === "result" && state.key === updated.key) {
      this.setSidebarState({
        ...state,
        knowledge,
        explanation: flat,
        snapshot: {
          ...state.snapshot,
          word: knowledge.identity.surface,
          sentence: updated.sourceSentence || state.snapshot.sentence,
          context: updated.context || state.snapshot.context,
          previousSentence: updated.previousSentence,
          nextSentence: updated.nextSentence,
          sourceNote: updated.sourceNote || state.snapshot.sourceNote,
          sourcePath: updated.sourcePath || state.snapshot.sourcePath,
        },
      });
    } else {
      }
  }

  openVocabularyEntry(entry: VocabularyEntry): void {
    this.cancelActiveRequest();
    this.requestEpoch += 1;
    const snapshot: SelectionSnapshot = {
      word: entry.word,
      sentence: entry.sourceSentence || entry.contextualMeaning,
      context: entry.context || entry.sourceSentence || entry.contextualMeaning,
      previousSentence: entry.previousSentence,
      nextSentence: entry.nextSentence,
      sourceNote: entry.sourceNote,
      sourcePath: entry.sourcePath,
      mode: entry.mode,
    };
    const currentKey = this.keyForSnapshot(snapshot);
    this.lastSelectionKey = currentKey === entry.key ? entry.key : null;
    this.setSidebarState({
      kind: "result",
      snapshot,
      knowledge: entry.knowledge,
      explanation: knowledgeToLegacyExplanation(entry.knowledge),
      meta: {
        origin: "library",
        model: entry.model,
        queriedAt: entry.createdAt,
      },
      key: entry.key,
    });
    void this.openSidebarSafely(true);
  }

  async exportVocabularyMarkdown(entries: readonly VocabularyEntry[]): Promise<void> {
    if (entries.length === 0) {
      throw new Error("There are no saved words to export.");
    }
    await this.writeExport("LexiSide Vocabulary", "md", vocabularyToMarkdown(entries));
  }

  async exportVocabularyCsv(entries: readonly VocabularyEntry[]): Promise<void> {
    if (entries.length === 0) {
      throw new Error("There are no saved words to export.");
    }
    await this.writeExport("LexiSide Anki", "csv", vocabularyToAnkiCsv(entries));
  }

  async testAnkiConnect(): Promise<void> {
    try {
      const version = await this.ankiClient().version();
      new Notice(`AnkiConnect version ${version} is reachable.`);
    } catch (error) {
      new Notice(`LexiSide: ${error instanceof Error ? error.message : "AnkiConnect test failed."}`);
    }
  }

  async syncAllToAnki(): Promise<void> {
    await this.syncToAnki(this.getVocabularyEntries());
  }

  async syncCurrentToAnki(): Promise<void> {
    const result = this.currentResult();
    if (!result) {
      new Notice("LexiSide: There is no current word to sync.");
      return;
    }
    if (!this.store.findVocabularyByKey(result.key)) {
      await this.saveCurrent();
    }
    const entry = this.store.findVocabularyByKey(result.key);
    if (!entry) {
      new Notice("LexiSide: The current word could not be saved for Anki sync.");
      return;
    }
    await this.syncToAnki([entry]);
  }

  private ankiClient(): AnkiConnectClient {
    return new AnkiConnectClient(this.store.settings.ankiConnectUrl, async (options) => {
      const response = await requestUrl({
        url: options.url,
        method: "POST",
        headers: options.headers,
        body: options.body,
        throw: false,
      });
      return { status: response.status, text: response.text };
    });
  }

  private async syncToAnki(entries: readonly VocabularyEntry[]): Promise<void> {
    if (entries.length === 0) {
      new Notice("LexiSide: There are no saved words to sync.");
      return;
    }
    try {
      const settings = this.store.settings;
      const client = this.ankiClient();
      await client.ensureDeck(settings.ankiDeck);

      const models = await client.modelNames();
      let modelName = settings.ankiModel;
      let modelFields: string[] | null = null;
      if (models.includes(modelName)) {
        modelFields = await client.modelFieldNames(modelName);
      }
      if (!modelFields || modelFields.length < 2) {
        const candidates = [
          settings.ankiModel,
          "Obsidian-basic",
          "Basic",
          "问答题",
          "问答题（附翻转卡片）",
        ];
        for (const candidate of Array.from(new Set(candidates))) {
          if (!models.includes(candidate)) {
            continue;
          }
          if (!modelFields || modelFields.length < 2) {
            try {
              const fields = await client.modelFieldNames(candidate);
              if (fields.length >= 2) {
                modelName = candidate;
                modelFields = fields;
              }
            } catch {
              // Try the next compatible model.
            }
          }
        }
      }
      if (!modelFields || modelFields.length < 2) {
        throw new Error(`No compatible Anki model found. Available: ${models.join(", ")}`);
      }
      const frontField = modelFields.find((field) => /^front$/i.test(field)) ?? modelFields[0];
      const backField = modelFields.find((field) => /^back$/i.test(field)) ?? modelFields[1];
      if (!frontField || !backField || frontField === backField) {
        throw new Error(`Anki model "${modelName}" needs two usable fields.`);
      }

      const notes: AnkiNote[] = entries.map((entry) => {
        const card = vocabularyToAnkiCard(entry);
        return {
          deckName: settings.ankiDeck,
          modelName,
          fields: {
            [frontField]: card.front,
            [backField]: card.back,
          },
          tags: ankiTagList(card.tags),
          options: { allowDuplicate: false, duplicateScope: "deck" },
        };
      });

      const canAdd = await client.canAddNotes(notes);
      const addable = notes.filter((_note, index) => canAdd[index]);
      if (addable.length === 0) {
        new Notice(`LexiSide: All ${notes.length} card(s) already exist in Anki.`);
        return;
      }
      const results = await client.addNotes(addable);
      const added = results.filter((result) => typeof result === "number").length;
      const duplicates = notes.length - addable.length;
      const failed = addable.length - added;
      new Notice(
        `LexiSide: Added ${added} card(s) to Anki (${modelName})` +
          (duplicates > 0 ? `; skipped ${duplicates} duplicate(s)` : "") +
          (failed > 0 ? `; ${failed} failed` : "") +
          ".",
      );
    } catch (error) {
      new Notice(`LexiSide: ${error instanceof Error ? error.message : "Anki sync failed."}`);
    }
  }

  async updateSettings(patch: Partial<LexiSideSettings>): Promise<void> {
    this.store.updateSettings(patch);
    if (this.settingsSaveTimer !== null) {
      window.clearTimeout(this.settingsSaveTimer);
    }
    this.settingsSaveTimer = window.setTimeout(() => {
      this.settingsSaveTimer = null;
      void this.store.persist().catch(() => {
        new Notice("LexiSide: Could not save plugin settings.");
      });
    }, 400);
  }

  async clearCache(): Promise<void> {
    const count = this.store.clearCache();
    try {
      await this.store.persist();
    } catch {
      new Notice("LexiSide: Cache was cleared in memory but could not be saved.");
      return;
    }
    new Notice(`LexiSide: Cleared ${count} cached explanation${count === 1 ? "" : "s"}.`);
  }

  private async ensureExportFolder(): Promise<void> {
    const path = normalizePath(EXPORT_FOLDER);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) {
      return;
    }
    if (existing) {
      throw new Error(`“${EXPORT_FOLDER}” exists but is not a folder.`);
    }
    await this.app.vault.createFolder(path);
  }

  private async writeExport(baseName: string, extension: "md" | "csv", content: string): Promise<void> {
    await this.ensureExportFolder();
    const normalizedBase = baseName.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-").trim() || "LexiSide Export";
    const stamp = localFileTimestamp();
    let suffix = 1;
    let path = normalizePath(`${EXPORT_FOLDER}/${normalizedBase} ${stamp}.${extension}`);
    while (this.app.vault.getAbstractFileByPath(path)) {
      suffix += 1;
      path = normalizePath(`${EXPORT_FOLDER}/${normalizedBase} ${stamp} (${suffix}).${extension}`);
    }
    const file = await this.app.vault.create(path, content);
    new Notice(`LexiSide exported to “${file.path}”.`);
  }
}
