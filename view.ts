import { Component, ItemView, Menu, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import type { Meaning, VocabularyKnowledge } from "./knowledge.ts";
import type { SemanticRelation } from "./relations.ts";
import type {
  KnowledgePreview,
  SelectionSnapshot,
  SidebarHost,
  SidebarState,
} from "./types.ts";
import { isSemanticallyDuplicateMeaning } from "./meaning-dedupe.ts";
import { buildWordMapModel } from "./word-map.ts";
import { PeleWordMapRenderer } from "./word-map-renderer.ts";

export const LEXISIDE_VIEW_TYPE = "lexiside-sidebar";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Unexpected error.";
}

function asPhonetic(phonetic: string | null): string {
  if (!phonetic) {
    return "";
  }
  const trimmed = phonetic.trim();
  if (!trimmed) {
    return "";
  }
  if ((trimmed.startsWith("/") && trimmed.endsWith("/")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return trimmed;
  }
  return `/${trimmed}/`;
}

function appendHighlightedText(parent: HTMLElement, text: string, target: string): void {
  const normalizedTarget = target.trim();
  if (!normalizedTarget) {
    parent.appendText(text);
    return;
  }
  const index = text.toLowerCase().indexOf(normalizedTarget.toLowerCase());
  if (index < 0) {
    parent.appendText(text);
    return;
  }
  parent.appendText(text.slice(0, index));
  parent.createEl("strong", {
    cls: "lexiside-context-target",
    text: text.slice(index, index + normalizedTarget.length),
  });
  parent.appendText(text.slice(index + normalizedTarget.length));
}

export class LexiSideView extends ItemView {
  private readonly host: SidebarHost;
  private readonly mapRenderer: PeleWordMapRenderer;
  private loadingStatusEl: HTMLElement | null = null;
  private renderedStateKey: string | null = null;
  private mapOwner: Component | null = null;
  private mapRenderToken = 0;

  constructor(leaf: WorkspaceLeaf, host: SidebarHost) {
    super(leaf);
    this.host = host;
    this.mapRenderer = new PeleWordMapRenderer(this.app);
    this.navigation = false;
  }

  getViewType(): string {
    return LEXISIDE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "LexiSide";
  }

  getIcon(): string {
    return "book-open";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("lexiside-view");
    this.registerDomEvent(this.containerEl, "contextmenu", (event) => {
      this.showContextMenu(event);
    });
    this.renderState();
  }

  async onClose(): Promise<void> {
    this.loadingStatusEl = null;
    this.host.clearSourceHighlight();
    this.disposeMap();
  }

  renderState(): void {
    const state = this.host.getSidebarState();
    const previousScrollTop = this.contentEl.scrollTop;
    const previousStateKey = this.renderedStateKey;
    const nextStateKey = this.stateKey(state);

    this.loadingStatusEl = null;
    this.disposeMap();
    if (state.kind !== "result") {
      this.host.clearSourceHighlight();
    }
    this.contentEl.empty();

    if (state.kind === "empty") {
      this.renderEmpty();
    } else if (state.kind === "loading") {
      this.renderLoading(state);
    } else if (state.kind === "error") {
      this.renderError(state);
    } else {
      this.renderResult(state);
    }

    this.contentEl.scrollTop =
      nextStateKey !== null && nextStateKey === previousStateKey ? previousScrollTop : 0;
    this.renderedStateKey = nextStateKey;
  }

  private stateKey(state: SidebarState): string | null {
    if (state.kind === "empty" || state.snapshot === null) {
      return null;
    }
    const snapshot = state.snapshot;
    const baseKey = [snapshot.sourcePath, snapshot.word, snapshot.sentence, snapshot.context].join("\u001F");
    return state.kind === "error" ? `${baseKey}\u001Ferror` : baseKey;
  }

  updateLoadingStatus(status: string): void {
    if (!this.loadingStatusEl) {
      return;
    }
    this.loadingStatusEl.setText(status);
  }

  private showContextMenu(event: MouseEvent): void {
    const state = this.host.getSidebarState();
    const menu = new Menu();
    if (state.kind === "result") {
      const saved = this.host.isCurrentSaved();
      menu.addItem((item) => {
        item
          .setTitle(saved ? "Remove from LexiSide" : "Add to LexiSide")
          .setIcon(saved ? "star-off" : "star")
          .onClick(() => {
            void this.host.toggleCurrentSaved().catch((error: unknown) => {
              new Notice(`LexiSide: ${errorMessage(error)}`);
            });
          });
      });
      menu.addItem((item) => {
        item
          .setTitle("Regenerate explanation")
          .setIcon("refresh-cw")
          .onClick(() => {
            void this.host.regenerateCurrent().catch((error: unknown) => {
              new Notice(`LexiSide: ${errorMessage(error)}`);
            });
          });
      });
      menu.addSeparator();
    }
    menu.addItem((item) => {
      item
        .setTitle("Open LexiSide library")
        .setIcon("library")
        .onClick(() => this.host.openVocabulary());
    });
    menu.showAtMouseEvent(event);
    event.preventDefault();
    event.stopPropagation();
  }

  private disposeMap(): void {
    this.mapRenderToken += 1;
    if (this.mapOwner) {
      try {
        this.mapOwner.unload();
      } catch {
        // The view may already be detaching.
      }
      this.mapOwner = null;
    }
  }

  private renderEmpty(): void {
    const empty = this.contentEl.createDiv({ cls: "lexiside-empty" });
    const icon = empty.createDiv({ cls: "lexiside-empty-icon" });
    setIcon(icon, "book-open");

    empty.createEl("h1", { cls: "lexiside-empty-title", text: "LexiSide" });
    empty.createEl("p", {
      cls: "lexiside-empty-subtitle",
      text: "A contextual English knowledge explorer for your reading.",
    });
    empty.createEl("p", {
      cls: "lexiside-empty-instruction",
      text: "Select an English word or phrase in Reading View.",
    });
    empty.createEl("p", {
      cls: "lexiside-empty-hint",
      text: "The original sentence and nearby sentences are used together for context.",
    });
  }

  private renderLoading(state: Extract<SidebarState, { kind: "loading" }>): void {
    if (state.preview && this.hasPreviewContent(state.preview)) {
      this.renderPreview(state);
      return;
    }

    const wrapper = this.contentEl.createDiv({ cls: "lexiside-state" });
    this.renderHeader(wrapper, state.snapshot.word, "");
    const status = wrapper.createDiv({ cls: "lexiside-loading", attr: { "aria-live": "polite" } });
    const spinner = status.createDiv({ cls: "lexiside-spinner", attr: { "aria-hidden": "true" } });
    spinner.createDiv({ cls: "lexiside-spinner-ring" });
    const textWrap = status.createDiv({ cls: "lexiside-loading-copy" });
    textWrap.createEl("p", { cls: "lexiside-loading-title", text: "Analyzing in context" });
    this.loadingStatusEl = textWrap.createEl("p", { cls: "lexiside-loading-status", text: state.status });
    status.createDiv({ cls: "lexiside-loading-bar", attr: { "aria-hidden": "true" } }).createDiv({
      cls: "lexiside-loading-bar-fill",
    });

    const skeleton = wrapper.createDiv({ cls: "lexiside-skeleton", attr: { "aria-hidden": "true" } });
    for (let index = 0; index < 3; index += 1) {
      const section = skeleton.createDiv({ cls: "lexiside-skeleton-section" });
      section.createDiv({ cls: "lexiside-skeleton-label" });
      section.createDiv({ cls: "lexiside-skeleton-line" });
      section.createDiv({ cls: "lexiside-skeleton-line short" });
    }
  }

  private hasPreviewContent(preview: KnowledgePreview): boolean {
    return Boolean(
      preview.lemma ||
        (preview.partOfSpeech && preview.partOfSpeech.length > 0) ||
        (preview.meanings && preview.meanings.length > 0),
    );
  }

  private renderPreview(state: Extract<SidebarState, { kind: "loading" }>): void {
    const preview = state.preview;
    if (!preview) {
      return;
    }
    const wrapper = this.contentEl.createDiv({ cls: "lexiside-state lexiside-result" });
    this.renderHeader(
      wrapper,
      preview.lemma ?? state.snapshot.word,
      asPhonetic(preview.ipa ?? ""),
    );

    const live = wrapper.createDiv({ cls: "lexiside-streaming-status", attr: { "aria-live": "polite" } });
    live.createDiv({ cls: "lexiside-streaming-dot", attr: { "aria-hidden": "true" } });
    const text = live.createDiv({ cls: "lexiside-streaming-status-text" });
    text.createEl("span", { text: "Generating" });
    this.loadingStatusEl = text.createEl("span", {
      cls: "lexiside-loading-status-inline",
      text: state.status,
    });

    const body = wrapper.createDiv({ cls: "lexiside-body" });
    const meanings = preview.meanings ?? [];
    if (meanings.length > 0) {
      this.renderMeaningSection(
        body,
        meanings,
        false,
        preview.partOfSpeech ?? [],
        state.snapshot,
      );
    }
  }

  private renderError(state: Extract<SidebarState, { kind: "error" }>): void {
    const wrapper = this.contentEl.createDiv({ cls: "lexiside-state" });
    if (state.snapshot) {
      this.renderHeader(wrapper, state.snapshot.word, "");
    } else {
      wrapper.createEl("h1", { cls: "lexiside-word", text: "LexiSide" });
    }

    const card = wrapper.createDiv({ cls: "lexiside-error", attr: { role: "alert" } });
    const icon = card.createDiv({ cls: "lexiside-error-icon" });
    setIcon(icon, "alert-triangle");
    const copy = card.createDiv({ cls: "lexiside-error-copy" });
    copy.createEl("p", { cls: "lexiside-error-title", text: "Couldn't load the explanation" });
    copy.createEl("p", { cls: "lexiside-error-message", text: state.message });
    if (state.details) {
      const details = card.createEl("details", { cls: "lexiside-error-details" });
      details.createEl("summary", { text: "Technical details" });
      details.createEl("pre", { cls: "lexiside-error-pre", text: state.details });
    }

    const actions = wrapper.createDiv({ cls: "lexiside-error-actions" });
    if (state.snapshot) {
      const retry = actions.createEl("button", { cls: "lexiside-button lexiside-button-primary" });
      setIcon(retry, "refresh-cw");
      retry.appendText(" Try again");
      retry.addEventListener("click", () => {
        void this.host.retryCurrent().catch((error: unknown) => {
          new Notice(`LexiSide: ${errorMessage(error)}`);
        });
      });
    }
    const library = actions.createEl("button", { cls: "lexiside-button lexiside-button-secondary" });
    setIcon(library, "library");
    library.appendText(" Vocabulary");
    library.addEventListener("click", () => {
      this.host.openVocabulary();
    });

    const help = wrapper.createDiv({ cls: "lexiside-hint-card" });
    help.createEl("p", {
      text: "Check the API key, model, and Base URL in LexiSide settings. The source note and selection stay local.",
    });
  }

  private renderResult(state: Extract<SidebarState, { kind: "result" }>): void {
    const knowledge = state.knowledge;
    const wrapper = this.contentEl.createDiv({ cls: "lexiside-state lexiside-result" });
    this.renderHeader(
      wrapper,
      knowledge.identity.surface,
      asPhonetic(knowledge.identity.ipa),
      true,
    );

    const body = wrapper.createDiv({ cls: "lexiside-body" });
    this.renderMeaningAndMap(body, knowledge, state.snapshot);
    this.host.autoHighlightSource(state.snapshot);
  }

  private renderMeaningAndMap(
    parent: HTMLElement,
    knowledge: VocabularyKnowledge,
    snapshot: SelectionSnapshot,
  ): void {
    const model = buildWordMapModel(knowledge, 4);
    if (!model) {
      this.renderMeaningSection(
        parent,
        knowledge.meanings,
        true,
        knowledge.identity.partOfSpeech,
        snapshot,
      );
      return;
    }

    const section = this.createSection(parent, "Meaning");
    const host = section.createDiv({ cls: "lexiside-word-map" });
    const details = section.createDiv({ cls: "lexiside-map-detail" });
    this.resetMapDetail(details);

    // Screen-reader alternative for the SVG labels; it is not visible.
    const srList = section.createEl("ul", { cls: "lexiside-sr-only" });
    for (const relation of model.relations) {
      srList.createEl("li", {
        text: `${relation.label}: ${relation.target}${relation.note ? ` — ${relation.note}` : ""}`,
      });
    }

    let selectedRelationId: string | null = null;
    let meaningSelected = false;
    let lastClickedNode: Element | null = null;

    const clearNodeSelection = (): void => {
      host.querySelectorAll(".pele-node.is-selected").forEach((node) => {
        node.classList.remove("is-selected");
      });
      section.querySelectorAll(".lexiside-map-relation.is-selected").forEach((button) => {
        button.classList.remove("is-selected");
      });
    };
    const clearSelection = (): void => {
      selectedRelationId = null;
      meaningSelected = false;
      this.resetMapDetail(details);
      clearNodeSelection();
    };
    const highlightNode = (node: Element | null, button: HTMLButtonElement | null): void => {
      clearNodeSelection();
      node?.classList.add("is-selected");
      button?.classList.add("is-selected");
    };
    const showMeaning = (node: Element | null): void => {
      selectedRelationId = null;
      meaningSelected = true;
      details.empty();
      if (
        !this.renderMeaningContent(
          details,
          knowledge.meanings,
          true,
          knowledge.identity.partOfSpeech,
          snapshot,
        )
      ) {
        clearSelection();
        return;
      }
      details.show();
      if (node) {
        highlightNode(node, null);
      }
    };
    const toggleMeaning = (node: Element): void => {
      if (meaningSelected) {
        clearSelection();
        return;
      }
      showMeaning(node);
    };
    const toggleRelation = (
      relation: SemanticRelation,
      node: Element | null,
      button: HTMLButtonElement | null,
    ): void => {
      if (selectedRelationId === relation.id) {
        clearSelection();
        return;
      }
      meaningSelected = false;
      selectedRelationId = relation.id;
      details.show();
      this.showRelation(details, relation);
      highlightNode(node, button);
    };

    // The original word is selected by default: its Meaning is visible below
    // the map immediately. Clicking the center node still collapses it.
    showMeaning(null);

    const owner = new Component();
    owner.load();
    this.mapOwner = owner;
    const token = ++this.mapRenderToken;
    let fallbackShown = false;
    const showFallback = (): void => {
      if (fallbackShown || token !== this.mapRenderToken) {
        return;
      }
      fallbackShown = true;
      host.addClass("is-fallback");
      this.renderRelationFallback(section, model.relations, (relation, button) => {
        toggleRelation(relation, null, button);
      });
    };

    void this.mapRenderer
      .render(model, host, owner)
      .then((rendered) => {
        if (token !== this.mapRenderToken) {
          return;
        }
        if (!rendered) {
          showFallback();
          return;
        }
        host.querySelectorAll(".pele-zoom").forEach((control) => control.remove());
        if (meaningSelected) {
          const center = model.center
            .replace(/^["'“”]+|["'“”]+$/g, "")
            .trim()
            .toLowerCase();
          const centerNode = Array.from(host.querySelectorAll(".pele-node")).find((node) => {
            const dataId = node.getAttribute("data-id") ?? "";
            const text = (node.textContent ?? "")
              .replace(/^["'“”]+|["'“”]+$/g, "")
              .trim()
              .toLowerCase();
            return /(?:^|[-_.:])W(?:$|[-_.:])/.test(dataId) || text === center;
          });
          centerNode?.classList.add("is-selected");
        }
        host.addEventListener(
          "dblclick",
          (event) => {
            event.preventDefault();
            event.stopPropagation();
          },
          true,
        );
        host.addEventListener(
          "click",
          (event) => {
            const svg = host.querySelector("svg");
            const nodes = svg ? Array.from(svg.querySelectorAll(".pele-node")) : [];
            const target = event.target;
            const pathNode =
              target && typeof (target as Element).closest === "function"
                ? (target as Element).closest(".pele-node")
                : null;
            const containing = nodes
              .map((node) => ({ node, rect: node.getBoundingClientRect() }))
              .filter(
                ({ rect }) =>
                  event.clientX >= rect.left &&
                  event.clientX <= rect.right &&
                  event.clientY >= rect.top &&
                  event.clientY <= rect.bottom,
              )
              .sort((left, right) => {
                return (
                  left.rect.width * left.rect.height -
                  right.rect.width * right.rect.height
                );
              });
            const node = pathNode ?? containing[0]?.node ?? null;
            if (!node) {
              return;
            }
            const text = (node.textContent ?? "")
              .replace(/^["'“”]+|["'“”]+$/g, "")
              .trim()
              .toLowerCase();
            const center = model.center
              .replace(/^["'“”]+|["'“”]+$/g, "")
              .trim()
              .toLowerCase();
            const dataId = node.getAttribute("data-id") ?? "";
            const isCenterById = /(?:^|[-_.:])W(?:$|[-_.:])/.test(dataId);
            if (isCenterById || text === center) {
              if (event.detail > 1 && node === lastClickedNode) {
                return;
              }
              lastClickedNode = node;
              event.preventDefault();
              event.stopPropagation();
              toggleMeaning(node);
              return;
            }

            // Pele exposes the Mermaid node ID ("n1", "n2", ...). Use it for an
            // exact node→relation mapping instead of fuzzy label matching, which
            // can resolve to the previously selected relation and collapse it.
            const idMatch = /(?:^|[-_.:])n(\d+)(?:$|[-_.:])/.exec(dataId);
            const byId =
              idMatch && Number(idMatch[1]) >= 1
                ? model.relations[Number(idMatch[1]) - 1]
                : undefined;
            const exact = model.relations.find(
              (candidate) => candidate.target.toLowerCase() === text,
            );
            const fuzzy = model.relations
              .filter(
                (candidate) =>
                  text.includes(candidate.target.toLowerCase()) ||
                  candidate.target.toLowerCase().includes(text),
              )
              .sort((left, right) => right.target.length - left.target.length);
            const relation = byId ?? exact ?? fuzzy[0];
            if (!relation) {
              // Only the center node and relation targets are rendered. An
              // unmatched node is therefore the original word, even if Pele
              // decorated its label with quotes or line breaks.
              if (event.detail > 1 && node === lastClickedNode) {
                return;
              }
              lastClickedNode = node;
              event.preventDefault();
              event.stopPropagation();
              toggleMeaning(node);
              return;
            }
            if (event.detail > 1 && node === lastClickedNode) {
              return;
            }
            lastClickedNode = node;
            event.preventDefault();
            event.stopPropagation();
            toggleRelation(relation, node, null);
          },
          true,
        );
      })
      .catch(showFallback);
  }

  private resetMapDetail(container: HTMLElement): void {
    container.empty();
    container.hide();
  }

  private renderRelationFallback(
    parent: HTMLElement,
    relations: readonly SemanticRelation[],
    onSelect: (relation: SemanticRelation, button: HTMLButtonElement) => void,
  ): void {
    const fallback = parent.createDiv({ cls: "lexiside-map-fallback" });
    const list = fallback.createEl("ul", { cls: "lexiside-list lexiside-map-relations" });
    for (const relation of relations) {
      const item = list.createEl("li");
      const button = item.createEl("button", {
        cls: "lexiside-map-relation",
        attr: { type: "button" },
      });
      button.createEl("span", { cls: "lexiside-map-relation-type", text: relation.label });
      button.createEl("span", { cls: "lexiside-map-relation-target", text: relation.target });
      button.addEventListener("click", () => onSelect(relation, button));
    }
  }

  private showRelation(container: HTMLElement, relation: SemanticRelation): void {
    container.empty();
    const meta = container.createDiv({ cls: "lexiside-meaning-meta" });
    meta.createEl("span", {
      cls: "lexiside-confidence is-high lexiside-meaning-pos",
      text: relation.label,
    });
    const branchList = container.createEl("ul", { cls: "lexiside-branch-list" });
    const branch = branchList.createEl("li", { cls: "lexiside-branch-item" });
    const definition = branch.createEl("p", {
      cls: "lexiside-prose lexiside-meaning-definition",
    });
    definition.createEl("strong", { text: relation.target });
    if (relation.note) {
      branch.createEl("p", { cls: "lexiside-prose", text: relation.note });
    }
    if (relation.evidence) {
      const examples = branch.createDiv({ cls: "lexiside-meaning-examples" });
      const block = examples.createDiv({ cls: "lexiside-meaning-example" });
      block.createEl("p", { cls: "lexiside-example-english", text: relation.evidence });
    }
  }

  private renderMeaningSection(
    parent: HTMLElement,
    meanings: readonly Meaning[],
    full: boolean,
    partOfSpeech: readonly string[],
    snapshot?: SelectionSnapshot,
  ): void {
    const section = this.createSection(parent, "Meaning");
    if (!this.renderMeaningContent(section, meanings, full, partOfSpeech, snapshot)) {
      section.remove();
    }
  }

  private renderMeaningContent(
    parent: HTMLElement,
    meanings: readonly Meaning[],
    full: boolean,
    partOfSpeech: readonly string[],
    snapshot?: SelectionSnapshot,
  ): boolean {
    const ordered = [
      meanings.find((meaning) => meaning.scope === "contextual"),
      meanings.find((meaning) => meaning.scope === "core"),
      ...meanings.filter((meaning) => meaning.scope === "other"),
    ].filter((meaning): meaning is Meaning => Boolean(meaning));

    if (ordered.length === 0) {
      return false;
    }

    if (snapshot) {
      const sourceSnapshot = snapshot;
      const quote = parent.createEl("blockquote", {
        cls: "lexiside-context-quote is-clickable",
        attr: {
          role: "button",
          tabindex: "0",
          title: "Show in source note",
        },
      });
      appendHighlightedText(quote, sourceSnapshot.sentence, sourceSnapshot.word);
      const reveal = (): void => {
        void this.host.revealSource(sourceSnapshot);
      };
      quote.addEventListener("click", reveal);
      quote.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          reveal();
        }
      });
    }

    const completeExample = (sense: Meaning): Meaning["examples"][number] | undefined =>
      sense.examples.find((example) => example.english.trim() && example.chinese.trim());

    const fallbackPos = partOfSpeech.map((pos) => pos.trim()).find(Boolean) || "Meaning";
    const groups = new Map<string, { pos: string; senses: Meaning[] }>();
    const seenDefinitions = new Set<string>();
    const seenChinese = new Set<string>();
    const usable: Meaning[] = [];
    for (const sense of ordered) {
      if (usable.length >= 3) {
        break;
      }
      // A non-contextual sense without a complete example would break the
      // uniform block structure and is usually a minor sense: omit it.
      if (sense.scope !== "contextual" && !completeExample(sense)) {
        continue;
      }
      const definitionKey = sense.englishDefinition
        .normalize("NFC")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      if (seenDefinitions.has(definitionKey)) {
        continue;
      }
      const chineseKey = sense.chineseMeaning
        .normalize("NFC")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      if (chineseKey && seenChinese.has(chineseKey)) {
        continue;
      }
      if (usable.some((existing) => isSemanticallyDuplicateMeaning(existing, sense))) {
        continue;
      }
      seenDefinitions.add(definitionKey);
      if (chineseKey) {
        seenChinese.add(chineseKey);
      }
      usable.push(sense);
    }

    for (const sense of usable) {
      const pos = sense.partOfSpeech.trim() || fallbackPos;
      let group = groups.get(pos);
      if (!group) {
        group = { pos, senses: [] };
        groups.set(pos, group);
      }
      group.senses.push(sense);
    }

    const allGroups = Array.from(groups.values()).filter((group) => group.senses.length > 0);
    if (allGroups.length === 0) {
      return false;
    }

    const visibleGroups = full ? allGroups : allGroups.slice(0, 1);
    for (const group of visibleGroups) {
      const groupEl = parent.createDiv({ cls: "lexiside-meaning-group" });
      const meta = groupEl.createDiv({ cls: "lexiside-meaning-meta" });
      meta.createEl("span", {
        cls: "lexiside-confidence is-high lexiside-meaning-pos",
        text: group.pos,
      });

      const list = groupEl.createEl("ol", { cls: "lexiside-meaning-list" });
      const senses = full ? group.senses : group.senses.slice(0, 1);
      for (const sense of senses) {
        const item = list.createEl("li", { cls: "lexiside-meaning-item" });
        item.createEl("p", {
          cls: "lexiside-prose lexiside-meaning-definition",
          text: sense.englishDefinition,
        });
        if (sense.chineseMeaning) {
          item.createEl("p", {
            cls: "lexiside-prose lexiside-chinese",
            text: sense.chineseMeaning,
          });
        }
        const example = completeExample(sense);
        if (full && example) {
          const examples = item.createDiv({ cls: "lexiside-meaning-examples" });
          const block = examples.createDiv({ cls: "lexiside-meaning-example" });
          block.createEl("p", { cls: "lexiside-example-english", text: example.english });
          block.createEl("p", { cls: "lexiside-example-chinese", text: example.chinese });
        }
      }
    }
    return true;
  }

  private createSection(parent: HTMLElement, title: string): HTMLElement {
    const section = parent.createEl("section", { cls: "lexiside-section" });
    const heading = section.createDiv({ cls: "lexiside-section-heading" });
    heading.createEl("h2", { cls: "lexiside-section-title", text: title });
    return section.createDiv({ cls: "lexiside-section-content" });
  }

  private renderHeader(
    parent: HTMLElement,
    word: string,
    ipa: string,
    showActions = false,
  ): void {
    const header = parent.createEl("header", { cls: "lexiside-header" });
    const top = header.createDiv({ cls: "lexiside-word-row" });
    const wordBlock = top.createDiv({ cls: "lexiside-word-block" });
    const title = wordBlock.createEl("h1", { cls: "lexiside-word", text: word });
    if (word.length > 24) {
      title.classList.add("is-long");
    }
    const pronunciation = wordBlock.createDiv({ cls: "lexiside-pronunciation" });
    if (ipa) {
      pronunciation.createEl("span", { cls: "lexiside-ipa", text: ipa });
    } else if (showActions) {
      pronunciation.createEl("span", { cls: "lexiside-ipa is-muted", text: "IPA unavailable" });
    }

    if (showActions) {
      const speak = pronunciation.createEl("button", {
        cls: "lexiside-icon-button lexiside-speak-button",
        attr: {
          type: "button",
          "aria-label": "Play pronunciation",
          title: "Play pronunciation with system voice",
        },
      });
      setIcon(speak, "volume-2");
      speak.addEventListener("click", () => {
        void this.host.speakWord(word, speak);
      });
    }

  }

}
