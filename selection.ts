import { MarkdownView, type App } from "obsidian";
import { buildRenderedContext, normalizeEnglishSelection, sentenceOffsetsAt } from "./text.ts";
import type { SelectionSnapshot } from "./types.ts";

export const SELECTION_DEBOUNCE_MS = 150;

export const PREVIEW_TEXT_BLOCK_SELECTOR =
  "p, li, h1, h2, h3, h4, h5, h6, td, th, dt, dd, figcaption, blockquote";
const TEXT_BLOCK_SELECTOR = PREVIEW_TEXT_BLOCK_SELECTOR;
const CODE_SELECTOR = "pre, code, kbd, samp";

function firstElement(node: Node | null): HTMLElement | null {
  if (!node) {
    return null;
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    return node as HTMLElement;
  }
  return node.parentElement;
}

function findMarkdownViewForRange(app: App, range: Range): MarkdownView | null {
  const common = range.commonAncestorContainer;
  const doc = common.ownerDocument ?? common.parentElement?.ownerDocument ?? null;
  if (!doc) {
    return null;
  }

  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const view = leaf.view;
    if (!(view instanceof MarkdownView) || !view.containerEl.ownerDocument || !view.containerEl.contains(common)) {
      continue;
    }
    if (view.containerEl.isShown() === false) {
      continue;
    }
    if (doc !== view.containerEl.ownerDocument) {
      continue;
    }
    return view;
  }

  return null;
}

function isCodeSelection(node: Node): boolean {
  const element = firstElement(node);
  return element !== null && element.closest(CODE_SELECTOR) !== null;
}

function findContentBlock(node: Node, root: HTMLElement): HTMLElement | null {
  let element = firstElement(node);
  while (element && element !== root) {
    const closest = element.closest<HTMLElement>(TEXT_BLOCK_SELECTOR);
    if (closest && root.contains(closest)) {
      return closest;
    }
    element = element.parentElement;
  }
  return null;
}

function textOffsetWithin(root: HTMLElement, container: Node, offset: number): number {
  const range = root.ownerDocument.createRange();
  range.selectNodeContents(root);
  range.setEnd(container, offset);
  return range.toString().length;
}

function adjacentBlockText(block: HTMLElement, direction: "previous" | "next"): string {
  let sibling = direction === "previous" ? block.previousElementSibling : block.nextElementSibling;
  while (sibling) {
    // Avoid `instanceof HTMLElement`: a pop-out window has a different realm.
    if (sibling.nodeType === Node.ELEMENT_NODE) {
      const text = sibling.textContent?.replace(/\s+/g, " ").trim() ?? "";
      if (text) {
        return text;
      }
    }
    sibling = direction === "previous" ? sibling.previousElementSibling : sibling.nextElementSibling;
  }
  return "";
}

function captureReading(view: MarkdownView, range: Range, file: NonNullable<MarkdownView["file"]>): SelectionSnapshot | null {
  if (view.getMode() !== "preview") {
    return null;
  }

  const previewRoot = view.previewMode.containerEl;
  if (!previewRoot.contains(range.commonAncestorContainer)) {
    return null;
  }

  const raw = range.toString();
  const word = normalizeEnglishSelection(raw);
  if (!word) {
    return null;
  }

  if (isCodeSelection(range.startContainer) || isCodeSelection(range.endContainer)) {
    return null;
  }

  const startBlock = findContentBlock(range.startContainer, previewRoot);
  const endBlock = findContentBlock(range.endContainer, previewRoot);
  if (!startBlock || !endBlock || startBlock !== endBlock) {
    return null;
  }

  const blockText = startBlock.textContent ?? "";
  if (!blockText.trim()) {
    return null;
  }

  const start = textOffsetWithin(startBlock, range.startContainer, range.startOffset);
  const end = textOffsetWithin(startBlock, range.endContainer, range.endOffset);
  if (end <= start) {
    return null;
  }

  const context = buildRenderedContext(
    blockText,
    start,
    end,
    adjacentBlockText(startBlock, "previous"),
    adjacentBlockText(startBlock, "next"),
  );
  if (!context) {
    return null;
  }
  const sentenceOffsets = sentenceOffsetsAt(blockText, start, end);

  const doc = previewRoot.ownerDocument;
  const prefix = doc.createRange();
  prefix.selectNodeContents(previewRoot);
  prefix.setEnd(range.startContainer, range.startOffset);
  const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wordOccurrence = Array.from(
    prefix.toString().matchAll(new RegExp(`\\b${escapedWord}\\b`, "gi")),
  ).length;
  const sourceBlockIndex = Array.from(
    previewRoot.querySelectorAll(TEXT_BLOCK_SELECTOR),
  ).indexOf(startBlock);
  const lineElement =
    startBlock.matches("[data-line]") ? startBlock : startBlock.closest("[data-line]");
  const lineValue = Number.parseInt(lineElement?.getAttribute("data-line") ?? "", 10);

  return {
    word,
    wordOccurrence,
    sourceBlockIndex: sourceBlockIndex >= 0 ? sourceBlockIndex : undefined,
    sourceLine: Number.isFinite(lineValue) ? lineValue : undefined,
    sourceBlockText: blockText,
    sourceBlockStart: start,
    sourceBlockEnd: end,
    sourceSentenceStart: sentenceOffsets?.start,
    sourceSentenceEnd: sentenceOffsets?.end,
    sourceScroll: view.previewMode.getScroll(),
    sentence: context.sentence,
    context: context.context,
    previousSentence: context.previousSentence,
    nextSentence: context.nextSentence,
    sourceNote: file.basename,
    sourcePath: file.path,
    mode: "reading",
  };
}

/**
 * Read the current selection using public APIs and generic semantic HTML only.
 * The browser selection is never used to infer CodeMirror positions.
 */
export function captureSelection(app: App, doc: Document): SelectionSnapshot | null {
  const selection = doc.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }

  const directWord = normalizeEnglishSelection(selection.toString());
  if (!directWord) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (range.collapsed) {
    return null;
  }

  const view = findMarkdownViewForRange(app, range);
  if (!view || !view.file) {
    return null;
  }

  // LexiSide only consumes selections in Reading View. Editing/Live Preview
  // selections must never open the sidebar or issue an API request.
  if (view.getMode() !== "preview") {
    return null;
  }

  return captureReading(view, range, view.file);
}

/**
 * Debounces DOM selection events and captures at most one snapshot per pause.
 * It never uses editor internals: captureSelection only uses public APIs.
 */
export class SelectionWatcher {
  private timer: number | null = null;
  private timerWindow: Window | null = null;
  private readonly app: App;
  private readonly onSelection: (snapshot: SelectionSnapshot) => void;
  private readonly debounceMs: number;
  private disposed = false;

  constructor(app: App, onSelection: (snapshot: SelectionSnapshot) => void, debounceMs = SELECTION_DEBOUNCE_MS) {
    this.app = app;
    this.onSelection = onSelection;
    this.debounceMs = debounceMs;
  }

  schedule(doc: Document): void {
    if (this.disposed) {
      return;
    }

    this.clearTimer();
    const win = doc.defaultView;
    if (!win) {
      return;
    }

    this.timerWindow = win;
    this.timer = win.setTimeout(() => {
      this.timer = null;
      this.timerWindow = null;
      if (this.disposed) {
        return;
      }
      try {
        const snapshot = captureSelection(this.app, doc);
        if (snapshot) {
          this.onSelection(snapshot);
        }
      } catch {
        // A document may disappear while the debounce timer is pending. The
        // next selection event will recover normally.
      }
    }, this.debounceMs);
  }

  destroy(): void {
    this.disposed = true;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.timerWindow?.clearTimeout(this.timer);
      this.timer = null;
      this.timerWindow = null;
    }
  }
}
