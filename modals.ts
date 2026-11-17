import { App, Modal, Notice, Setting, setIcon } from "obsidian";
import type {
  Collocation,
  ExampleSentence,
  GrammarNotes,
  LibraryHost,
  OtherMeaning,
  Synonym,
  VocabularyEntry,
} from "./types.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Unexpected error.";
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

function splitLines(value: string): string[] {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parsePipeList(value: string): string[][] {
  return splitLines(value).map((line) => line.split("|").map((part) => part.trim()));
}

function joinOtherMeanings(items: readonly OtherMeaning[]): string {
  return items.map((item) => `${item.partOfSpeech} | ${item.meaning}`).join("\n");
}

function joinCollocations(items: readonly Collocation[]): string {
  return items.map((item) => `${item.phrase} | ${item.meaning}`).join("\n");
}

function joinExamples(items: readonly ExampleSentence[]): string {
  return items.map((item) => `${item.english} | ${item.chinese}`).join("\n");
}

function joinSynonyms(items: readonly Synonym[]): string {
  return items.map((item) => `${item.word} | ${item.difference} | ${item.usage}`).join("\n");
}

function parseOtherMeanings(value: string): OtherMeaning[] {
  return parsePipeList(value).map((parts) => {
    if (parts.length < 2) {
      return { partOfSpeech: "", meaning: parts[0] ?? "" };
    }
    return {
      partOfSpeech: parts[0] ?? "",
      meaning: parts.slice(1).join(" | ").trim(),
    };
  });
}

function parseCollocations(value: string): Collocation[] {
  return parsePipeList(value).map((parts) => ({
    phrase: parts[0] ?? "",
    meaning: parts.slice(1).join(" | ").trim(),
  }));
}

function parseExamples(value: string): ExampleSentence[] {
  return parsePipeList(value).map((parts) => ({
    english: parts[0] ?? "",
    chinese: parts.slice(1).join(" | ").trim(),
  }));
}

function parseSynonyms(value: string): Synonym[] {
  return parsePipeList(value).map((parts) => ({
    word: parts[0] ?? "",
    difference: parts.length >= 3 ? (parts[1] ?? "") : parts.slice(1).join(" | ").trim(),
    usage: parts.length >= 3 ? parts.slice(2).join(" | ").trim() : "",
  }));
}

export class VocabularyModal extends Modal {
  private readonly host: LibraryHost;
  private query = "";
  private listEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;

  constructor(app: App, host: LibraryHost) {
    super(app);
    this.host = host;
  }

  onOpen(): void {
    this.modalEl.addClass("lexiside-library-modal");
    this.titleEl.setText("LexiSide Vocabulary");

    const content = this.contentEl;
    content.empty();
    content.addClass("lexiside-library-content");

    const searchRow = content.createDiv({ cls: "lexiside-library-search" });
    const searchIcon = searchRow.createDiv({ cls: "lexiside-library-search-icon" });
    setIcon(searchIcon, "search");
    const search = searchRow.createEl("input", {
      cls: "lexiside-library-search-input",
      attr: {
        type: "search",
        placeholder: "Search words, meanings, or source notes…",
        "aria-label": "Search vocabulary",
      },
    });
    search.addEventListener("input", () => {
      this.query = search.value;
      this.renderList();
    });

    this.countEl = content.createEl("p", { cls: "lexiside-library-count" });
    this.listEl = content.createDiv({ cls: "lexiside-library-list" });

    const footer = content.createDiv({ cls: "lexiside-library-footer" });
    const exportMarkdown = footer.createEl("button", { cls: "lexiside-button" });
    setIcon(exportMarkdown, "file-text");
    exportMarkdown.appendText(" Export all as Markdown");
    exportMarkdown.addEventListener("click", () => {
      void this.runExport(exportMarkdown, "markdown");
    });

    const exportCsv = footer.createEl("button", { cls: "lexiside-button" });
    setIcon(exportCsv, "table");
    exportCsv.appendText(" Export all as Anki CSV");
    exportCsv.addEventListener("click", () => {
      void this.runExport(exportCsv, "csv");
    });

    const close = footer.createEl("button", { cls: "lexiside-button lexiside-button-secondary" });
    close.appendText("Close");
    close.addEventListener("click", () => {
      this.close();
    });

    this.renderList();
    search.focus();
  }

  onClose(): void {
    this.contentEl.empty();
    this.listEl = null;
    this.countEl = null;
  }

  private getEntries(): VocabularyEntry[] {
    return this.host
      .getVocabularyEntries()
      .slice()
      .sort((left, right) => right.savedAt.localeCompare(left.savedAt));
  }

  private filterEntries(entries: readonly VocabularyEntry[]): VocabularyEntry[] {
    const query = this.query.trim().toLowerCase();
    if (!query) {
      return entries.slice();
    }
    return entries.filter((entry) => {
      const haystack = [
        entry.word,
        entry.phonetic,
        entry.partOfSpeech.join(" "),
        entry.contextualMeaning,
        entry.englishDefinition,
        entry.chineseMeaning,
        entry.sourceNote,
        entry.sourceSentence,
        entry.context,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }

  private renderList(): void {
    if (!this.listEl || !this.countEl) {
      return;
    }

    const all = this.getEntries();
    const entries = this.filterEntries(all);
    this.listEl.empty();
    this.countEl.setText(
      this.query.trim() ? `${entries.length} of ${all.length} saved words` : `${all.length} saved word${all.length === 1 ? "" : "s"}`,
    );

    if (all.length === 0) {
      const empty = this.listEl.createDiv({ cls: "lexiside-library-empty" });
      const icon = empty.createDiv({ cls: "lexiside-library-empty-icon" });
      setIcon(icon, "star");
      empty.createEl("p", { text: "Your vocabulary is empty." });
      empty.createEl("p", {
        cls: "lexiside-muted",
        text: "Select a word in a note, then click the star in the LexiSide panel to save it.",
      });
      return;
    }

    if (entries.length === 0) {
      const empty = this.listEl.createDiv({ cls: "lexiside-library-empty" });
      empty.createEl("p", { text: "No saved words match this search." });
      return;
    }

    for (const entry of entries) {
      this.renderEntry(entry);
    }
  }

  private renderEntry(entry: VocabularyEntry): void {
    if (!this.listEl) {
      return;
    }

    const card = this.listEl.createDiv({ cls: "lexiside-library-entry" });
    const heading = card.createDiv({ cls: "lexiside-library-entry-heading" });
    const titleWrap = heading.createDiv({ cls: "lexiside-library-entry-title" });
    titleWrap.createEl("h3", { text: entry.word });
    if (entry.phonetic) {
      titleWrap.createEl("span", { cls: "lexiside-library-ipa", text: entry.phonetic });
    }
    if (entry.partOfSpeech.length > 0) {
      const tags = titleWrap.createDiv({ cls: "lexiside-pos-tags" });
      for (const tag of entry.partOfSpeech) {
        tags.createEl("span", { cls: "lexiside-pos-tag", text: tag });
      }
    }

    const actions = heading.createDiv({ cls: "lexiside-library-entry-actions" });
    const open = actions.createEl("button", { cls: "lexiside-button lexiside-button-small" });
    setIcon(open, "panel-right");
    open.appendText(" Open");
    open.addEventListener("click", () => {
      this.host.openVocabularyEntry(entry);
      this.close();
    });

    const edit = actions.createEl("button", { cls: "lexiside-icon-button", attr: { "aria-label": "Edit explanation" } });
    setIcon(edit, "pencil");
    edit.addEventListener("click", () => {
      new EditEntryModal(this.app, this.host, entry, () => {
        this.renderList();
      }).open();
    });

    const remove = actions.createEl("button", {
      cls: "lexiside-icon-button is-danger",
      attr: { "aria-label": "Delete vocabulary entry", title: "Delete entry" },
    });
    setIcon(remove, "trash-2");
    remove.addEventListener("click", () => {
      new ConfirmModal(this.app, {
        title: "Delete saved word?",
        message: `Remove “${entry.word}” and its saved explanation from LexiSide? This cannot be undone.`,
        confirmText: "Delete",
        danger: true,
        onConfirm: async () => {
          await this.host.deleteVocabularyEntry(entry.id);
          this.renderList();
          new Notice("Vocabulary entry deleted.");
        },
      }).open();
    });

    card.createEl("p", { cls: "lexiside-library-snippet", text: entry.contextualMeaning });

    const meta = card.createDiv({ cls: "lexiside-library-meta" });
    meta.createEl("span", { text: `Source · ${entry.sourceNote || "Unknown note"}` });
    meta.createEl("span", { text: `Saved · ${formatTimestamp(entry.savedAt)}` });
  }

  private async runExport(button: HTMLButtonElement, format: "markdown" | "csv"): Promise<void> {
    if (button.disabled) {
      return;
    }
    const entries = this.getEntries();
    if (entries.length === 0) {
      new Notice("There are no saved words to export.");
      return;
    }

    button.disabled = true;
    try {
      if (format === "markdown") {
        await this.host.exportVocabularyMarkdown(entries);
      } else {
        await this.host.exportVocabularyCsv(entries);
      }
    } catch (error) {
      new Notice(`LexiSide export failed: ${errorMessage(error)}`);
    } finally {
      if (button.isConnected) {
        button.disabled = false;
      }
    }
  }
}

interface ConfirmOptions {
  title: string;
  message: string;
  confirmText: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
}

class ConfirmModal extends Modal {
  private readonly options: ConfirmOptions;

  constructor(app: App, options: ConfirmOptions) {
    super(app);
    this.options = options;
  }

  onOpen(): void {
    this.modalEl.addClass("lexiside-confirm-modal");
    this.titleEl.setText(this.options.title);
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: this.options.message });

    const actions = this.contentEl.createDiv({ cls: "lexiside-modal-actions" });
    const cancel = actions.createEl("button", { cls: "lexiside-button lexiside-button-secondary" });
    cancel.appendText("Cancel");
    cancel.addEventListener("click", () => {
      this.close();
    });

    const confirm = actions.createEl("button", {
      cls: this.options.danger ? "lexiside-button lexiside-button-danger" : "lexiside-button lexiside-button-primary",
    });
    confirm.appendText(this.options.confirmText);
    confirm.addEventListener("click", () => {
      if (confirm.disabled) {
        return;
      }
      confirm.disabled = true;
      void this.options
        .onConfirm()
        .then(() => {
          this.close();
        })
        .catch((error: unknown) => {
          confirm.disabled = false;
          new Notice(`LexiSide: ${errorMessage(error)}`);
        });
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class EditEntryModal extends Modal {
  private readonly host: LibraryHost;
  private readonly entry: VocabularyEntry;
  private readonly onSaved: () => void;
  private inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
  private errorEl: HTMLElement | null = null;
  private saveButton: HTMLButtonElement | null = null;

  constructor(app: App, host: LibraryHost, entry: VocabularyEntry, onSaved: () => void) {
    super(app);
    this.host = host;
    this.entry = entry;
    this.onSaved = onSaved;
  }

  onOpen(): void {
    this.modalEl.addClass("lexiside-edit-modal");
    this.titleEl.setText(`Edit explanation · ${this.entry.word}`);
    this.contentEl.empty();

    const intro = this.contentEl.createDiv({ cls: "lexiside-edit-intro" });
    intro.createEl("p", {
      text: "Edit the saved explanation. Each line in a list field represents one item; the separator is a vertical bar ( | ).",
    });

    this.addSection("Pronunciation & context");
    this.addInput("phonetic", "IPA", "For example: /rɪˈzɪliənt/", this.entry.phonetic, false);
    this.addInput(
      "partOfSpeech",
      "Part of speech",
      "Comma-separated, for example: adjective, noun",
      this.entry.partOfSpeech.join(", "),
      false,
    );
    this.addInput("sourceSentence", "Original sentence", "The sentence shown in the panel.", this.entry.sourceSentence, true, 3);
    this.addInput("contextualMeaning", "Contextual meaning", "Required. Explain the word in this context.", this.entry.contextualMeaning, true, 4);
    this.addInput("englishDefinition", "English definition", "Required. Keep it learner-friendly.", this.entry.englishDefinition, true, 3);
    this.addInput("chineseMeaning", "Chinese meaning", "Required. Simplified Chinese.", this.entry.chineseMeaning, true, 3);
    this.addInput(
      "otherMeanings",
      "Other common meanings",
      "One per line: part of speech | meaning",
      joinOtherMeanings(this.entry.otherMeanings),
      true,
      4,
    );

    this.addSection("Examples, collocations & synonyms");
    this.addInput(
      "examples",
      "Example sentences",
      "One per line: English sentence | Chinese translation. At least two.",
      joinExamples(this.entry.examples),
      true,
      5,
    );
    this.addInput(
      "collocations",
      "Collocations",
      "One per line: phrase | meaning",
      joinCollocations(this.entry.collocations),
      true,
      4,
    );
    this.addInput(
      "synonyms",
      "Synonyms & differences",
      "One per line: synonym | difference | usage advice",
      joinSynonyms(this.entry.synonyms),
      true,
      4,
    );

    this.addSection("Grammar & certainty");
    this.addInput(
      "grammarPatterns",
      "Grammar patterns",
      "One pattern per line.",
      this.entry.grammarNotes.patterns.join("\n"),
      true,
      3,
    );
    this.addInput(
      "grammarPrepositions",
      "Preposition patterns",
      "One per line.",
      this.entry.grammarNotes.prepositions.join("\n"),
      true,
      3,
    );
    this.addInput(
      "grammarMistakes",
      "Common mistakes",
      "One per line.",
      this.entry.grammarNotes.commonMistakes.join("\n"),
      true,
      3,
    );
    this.addInput("uncertainty", "Uncertainty note", "Optional. Leave empty if none.", this.entry.uncertainty, true, 2);

    const source = this.contentEl.createDiv({ cls: "lexiside-edit-source" });
    source.createEl("span", { text: "Source note" });
    source.createEl("strong", { text: this.entry.sourceNote || "Unknown note" });
    source.createEl("span", { cls: "lexiside-muted", text: this.entry.sourcePath });

    this.errorEl = this.contentEl.createDiv({ cls: "lexiside-edit-error", attr: { role: "alert" } });
    this.errorEl.hide();

    const actions = this.contentEl.createDiv({ cls: "lexiside-modal-actions" });
    const cancel = actions.createEl("button", { cls: "lexiside-button lexiside-button-secondary" });
    cancel.appendText("Cancel");
    cancel.addEventListener("click", () => {
      this.close();
    });

    this.saveButton = actions.createEl("button", { cls: "lexiside-button lexiside-button-primary" });
    this.saveButton.appendText("Save changes");
    this.saveButton.addEventListener("click", () => {
      void this.save();
    });
  }

  onClose(): void {
    this.contentEl.empty();
    this.inputs.clear();
  }

  private addSection(title: string): void {
    this.contentEl.createEl("h3", { cls: "lexiside-edit-section-title", text: title });
  }

  private addInput(
    key: string,
    name: string,
    description: string,
    value: string,
    multiline: boolean,
    rows = 3,
  ): void {
    const setting = new Setting(this.contentEl).setName(name).setDesc(description);
    setting.settingEl.addClass("lexiside-edit-field");

    if (multiline) {
      setting.addTextArea((text) => {
        text.setValue(value);
        text.inputEl.rows = rows;
        text.inputEl.addClass("lexiside-edit-textarea");
        this.inputs.set(key, text.inputEl);
      });
    } else {
      setting.addText((text) => {
        text.setValue(value);
        this.inputs.set(key, text.inputEl);
      });
    }
  }

  private value(key: string): string {
    return this.inputs.get(key)?.value ?? "";
  }

  private showError(message: string): void {
    if (!this.errorEl) {
      return;
    }
    this.errorEl.setText(message);
    this.errorEl.show();
    this.errorEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  private async save(): Promise<void> {
    if (!this.saveButton || this.saveButton.disabled) {
      return;
    }

    const contextualMeaning = this.value("contextualMeaning").trim();
    const englishDefinition = this.value("englishDefinition").trim();
    const chineseMeaning = this.value("chineseMeaning").trim();
    const partOfSpeech = this.value("partOfSpeech")
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
    const examples = parseExamples(this.value("examples")).filter(
      (example) => example.english.length > 0 || example.chinese.length > 0,
    );

    if (!contextualMeaning || !englishDefinition || !chineseMeaning) {
      this.showError("Contextual meaning, English definition, and Chinese meaning are required.");
      return;
    }
    if (partOfSpeech.length === 0) {
      this.showError("Add at least one part of speech tag.");
      return;
    }
    if (examples.some((example) => !example.english.trim() || !example.chinese.trim())) {
      this.showError("Every example needs an English sentence and a Chinese translation.");
      return;
    }

    const grammarNotes: GrammarNotes = {
      patterns: splitLines(this.value("grammarPatterns")),
      prepositions: splitLines(this.value("grammarPrepositions")),
      commonMistakes: splitLines(this.value("grammarMistakes")),
    };

    const updated: VocabularyEntry = {
      ...this.entry,
      phonetic: this.value("phonetic").trim(),
      partOfSpeech,
      sourceSentence: this.value("sourceSentence").trim(),
      contextualMeaning,
      englishDefinition,
      chineseMeaning,
      otherMeanings: parseOtherMeanings(this.value("otherMeanings")),
      examples,
      collocations: parseCollocations(this.value("collocations")),
      synonyms: parseSynonyms(this.value("synonyms")),
      grammarNotes,
      uncertainty: this.value("uncertainty").trim(),
      updatedAt: new Date().toISOString(),
    };

    this.saveButton.disabled = true;
    this.errorEl?.hide();
    try {
      await this.host.updateVocabularyEntry(updated);
      this.onSaved();
      this.close();
      new Notice("Vocabulary entry updated.");
    } catch (error) {
      this.saveButton.disabled = false;
      this.showError(errorMessage(error));
    }
  }
}
