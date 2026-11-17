import {
  Notice,
  PluginSettingTab,
  Setting,
  requestUrl,
  type App,
  type DropdownComponent,
} from "obsidian";
import type LexiSidePlugin from "./main.ts";
import {
  OLLAMA_DEFAULT_BASE_URL,
  buildOllamaTagsUrl,
  parseOllamaModelNames,
} from "./ollama.ts";
import { DEFAULT_SETTINGS, SETTING_LIMITS } from "./storage.ts";
import type { LexiSideSettings, ModelProvider } from "./types.ts";

export class LexiSideSettingTab extends PluginSettingTab {
  private readonly plugin: LexiSidePlugin;

  constructor(app: App, plugin: LexiSidePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("lexiside-settings");
    const settings = this.plugin.getSettings();

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Contextual English explanations in your sidebar.",
    });

    new Setting(containerEl).setName("API").setHeading();

    new Setting(containerEl)
      .setName("Provider")
      .setDesc("DeepSeek API, a local Ollama server, or another OpenAI-compatible endpoint.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("deepseek", "DeepSeek")
          .addOption("ollama", "Ollama (local)")
          .addOption("custom", "Custom OpenAI-compatible")
          .setValue(settings.provider)
          .onChange((value) => {
            if (value !== "deepseek" && value !== "ollama" && value !== "custom") {
              return;
            }
            const provider = value as ModelProvider;
            const patch: Partial<LexiSideSettings> = { provider };
            if (provider === "ollama") {
              patch.baseUrl = OLLAMA_DEFAULT_BASE_URL;
            } else if (provider === "deepseek") {
              patch.baseUrl = DEFAULT_SETTINGS.baseUrl;
              patch.model = DEFAULT_SETTINGS.model;
            }
            void this.plugin.updateSettings(patch).then(() => this.display());
          });
      });

    new Setting(containerEl)
      .setName("API key")
      .setDesc(
        settings.provider === "ollama"
          ? "Optional for Ollama. Leave empty unless your local proxy requires a key."
          : "Stored locally. Never written to notes, logs, or exports.",
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "off";
        text.inputEl.spellcheck = false;
        text.setPlaceholder("sk-…").setValue(settings.apiKey);
        text.onChange((value) => {
          void this.plugin.updateSettings({ apiKey: value });
        });
      })
      .addExtraButton((button) => {
        button.setIcon("eye").setTooltip("Show/hide API key").onClick(() => {
          const settingEl = button.extraSettingsEl.closest(".setting-item");
          const input = settingEl?.querySelector<HTMLInputElement>("input");
          if (!input) {
            return;
          }
          const showing = input.type === "text";
          input.type = showing ? "password" : "text";
          button.setIcon(showing ? "eye" : "eye-off");
          button.setTooltip(showing ? "Show API key" : "Hide API key");
        });
      });

    new Setting(containerEl)
      .setName("Base URL")
      .setDesc(
        settings.provider === "ollama"
          ? "Ollama's OpenAI-compatible endpoint. Default http://127.0.0.1:11434/v1."
          : "OpenAI-compatible endpoint. /chat/completions is appended.",
      )
      .addText((text) => {
        text
          .setPlaceholder(
            settings.provider === "ollama" ? OLLAMA_DEFAULT_BASE_URL : "https://api.deepseek.com",
          )
          .setValue(settings.baseUrl)
          .onChange((value) => {
            void this.plugin.updateSettings({ baseUrl: value });
          });
      });

    if (settings.provider === "ollama") {
      const ollamaSetting = new Setting(containerEl)
        .setName("Ollama model")
        .setDesc("Installed models reported by the local server. Pull models with `ollama pull` first.");
      ollamaSetting.addDropdown((dropdown) => {
        dropdown
          .addOption(settings.model, settings.model)
          .setValue(settings.model)
          .onChange((value) => {
            if (value) {
              void this.plugin.updateSettings({ model: value });
            }
          });
        void this.loadOllamaModels(dropdown, false);
      });
      ollamaSetting.addExtraButton((button) => {
        button
          .setIcon("refresh-cw")
          .setTooltip("Refresh Ollama models")
          .onClick(() => {
            const dropdown = ollamaSetting.controlEl.querySelector<HTMLSelectElement>("select");
            if (dropdown) {
              void this.loadOllamaModels(dropdown, true);
            }
          });
      });

      new Setting(containerEl)
        .setName("Disable local reasoning")
        .setDesc(
          "Recommended for small reasoning models such as qwen3.5. Prevents thinking from consuming the output budget.",
        )
        .addToggle((toggle) => {
          toggle.setValue(settings.ollamaDisableThinking).onChange((value) => {
            void this.plugin.updateSettings({ ollamaDisableThinking: value });
          });
        });
    } else {
      new Setting(containerEl)
        .setName("Model")
        .setDesc("deepseek-flash or deepseek-v4-pro for DeepSeek; custom model IDs are supported.")
        .addText((text) => {
          text
            .setPlaceholder("deepseek-flash")
            .setValue(settings.model)
            .onChange((value) => {
              void this.plugin.updateSettings({ model: value });
            });
        });
    }

    new Setting(containerEl).setName("Generation").setHeading();

    new Setting(containerEl)
      .setName("Temperature")
      .setDesc("Lower is more consistent. Default 0.3.")
      .addSlider((slider) => {
        slider
          .setLimits(SETTING_LIMITS.temperature.min, SETTING_LIMITS.temperature.max, 0.1)
          .setValue(settings.temperature)
          .setDynamicTooltip()
          .onChange((value) => {
            void this.plugin.updateSettings({ temperature: value });
          });
      });

    new Setting(containerEl)
      .setName("Maximum tokens")
      .setDesc(`Output limit. Default 1800; range ${SETTING_LIMITS.maxTokens.min}–${SETTING_LIMITS.maxTokens.max}.`)
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = String(SETTING_LIMITS.maxTokens.min);
        text.inputEl.max = String(SETTING_LIMITS.maxTokens.max);
        text.inputEl.step = "128";
        text.setValue(String(settings.maxTokens));
        text.onChange((value) => {
          const numeric = Number(value);
          if (!Number.isFinite(numeric) || numeric < SETTING_LIMITS.maxTokens.min) {
            return;
          }
          void this.plugin.updateSettings({ maxTokens: numeric });
        });
        text.inputEl.addEventListener("blur", () => {
          text.setValue(String(this.plugin.getSettings().maxTokens));
        });
      });

    new Setting(containerEl)
      .setName("Timeout")
      .setDesc("Request timeout in seconds. Default 60; range 5–300.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = String(SETTING_LIMITS.timeoutMs.min / 1000);
        text.inputEl.max = String(SETTING_LIMITS.timeoutMs.max / 1000);
        text.inputEl.step = "5";
        text.setValue(String(Math.round(settings.timeoutMs / 1000)));
        text.onChange((value) => {
          const seconds = Number(value);
          if (!Number.isFinite(seconds) || seconds <= 0) {
            return;
          }
          void this.plugin.updateSettings({ timeoutMs: Math.round(seconds * 1000) });
        });
        text.inputEl.addEventListener("blur", () => {
          text.setValue(String(Math.round(this.plugin.getSettings().timeoutMs / 1000)));
        });
      });

    new Setting(containerEl)
      .setName("Stream responses")
      .setDesc("Show progress while generating when supported.")
      .addToggle((toggle) => {
        toggle.setValue(settings.streaming).onChange((value) => {
          void this.plugin.updateSettings({ streaming: value });
        });
      });

    if (settings.provider === "deepseek") {
      new Setting(containerEl)
        .setName("DeepSeek V4 thinking")
        .setDesc("Official DeepSeek models only. Off is faster and cheaper.")
        .addToggle((toggle) => {
          toggle.setValue(settings.thinkingEnabled).onChange((value) => {
            void this.plugin.updateSettings({ thinkingEnabled: value });
          });
        });
    }

    new Setting(containerEl).setName("Pronunciation").setHeading();

    new Setting(containerEl)
      .setName("Pronunciation source")
      .setDesc("DeepSeek TTS uses the configured API key and may bill per character. System voice is the offline fallback.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("deepseek", "DeepSeek TTS")
          .addOption("system", "System voice")
          .setValue(settings.pronunciationSource)
          .onChange((value) => {
            if (value === "deepseek" || value === "system") {
              void this.plugin.updateSettings({ pronunciationSource: value });
            }
          });
      });

    new Setting(containerEl)
      .setName("DeepSeek voice")
      .setDesc("Stella (female) or Tide (male). Language is detected automatically.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("stella", "Stella (female)")
          .addOption("tide", "Tide (male)")
          .setValue(settings.ttsVoice)
          .onChange((value) => {
            if (value === "stella" || value === "tide") {
              void this.plugin.updateSettings({ ttsVoice: value });
            }
          });
      });

    new Setting(containerEl).setName("Learning").setHeading();

    new Setting(containerEl)
      .setName("Language")
      .setDesc("English target; Simplified Chinese explanations.");

    new Setting(containerEl)
      .setName("Learner level")
      .setDesc("Adjusts English complexity.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("beginner", "Beginner")
          .addOption("intermediate", "Intermediate")
          .addOption("advanced", "Advanced")
          .setValue(settings.learnerLevel)
          .onChange((value) => {
            if (value === "beginner" || value === "intermediate" || value === "advanced") {
              void this.plugin.updateSettings({ learnerLevel: value });
            }
          });
      });

    new Setting(containerEl)
      .setName("Explanation depth")
      .setDesc("Concise, standard, or detailed wording.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("concise", "Concise")
          .addOption("standard", "Standard")
          .addOption("detailed", "Detailed")
          .setValue(settings.explanationDepth)
          .onChange((value) => {
            if (value === "concise" || value === "standard" || value === "detailed") {
              void this.plugin.updateSettings({ explanationDepth: value });
            }
          });
      });

    new Setting(containerEl).setName("Reading").setHeading();

    new Setting(containerEl)
      .setName("Auto-open side panel")
      .setDesc("Reveal the panel on new selections.")
      .addToggle((toggle) => {
        toggle.setValue(settings.autoOpenSidebar).onChange((value) => {
          void this.plugin.updateSettings({ autoOpenSidebar: value });
        });
      });

    new Setting(containerEl).setName("Anki").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Requires Anki desktop with the AnkiConnect add-on open. Cards use the selected deck and model.",
    });

    new Setting(containerEl)
      .setName("AnkiConnect URL")
      .setDesc("Local AnkiConnect endpoint. Default http://127.0.0.1:8765.")
      .addText((text) => {
        text
          .setPlaceholder("http://127.0.0.1:8765")
          .setValue(settings.ankiConnectUrl)
          .onChange((value) => {
            void this.plugin.updateSettings({ ankiConnectUrl: value });
          });
      });

    new Setting(containerEl)
      .setName("Deck")
      .setDesc("Created automatically when missing.")
      .addText((text) => {
        text
          .setPlaceholder("LexiSide")
          .setValue(settings.ankiDeck)
          .onChange((value) => {
            void this.plugin.updateSettings({ ankiDeck: value });
          });
      });

    new Setting(containerEl)
      .setName("Note type")
      .setDesc("Basic works out of the box. If missing, LexiSide tries Obsidian-basic or a two-field local model.")
      .addText((text) => {
        text
          .setPlaceholder("Basic")
          .setValue(settings.ankiModel)
          .onChange((value) => {
            void this.plugin.updateSettings({ ankiModel: value });
          });
      });

    new Setting(containerEl)
      .setName("Connection")
      .setDesc("Test AnkiConnect and optionally sync the whole saved vocabulary.")
      .addButton((button) => {
        button.setButtonText("Test").onClick(() => {
          void this.plugin.testAnkiConnect();
        });
      })
      .addButton((button) => {
        button.setButtonText("Sync all").onClick(() => {
          void this.plugin.syncAllToAnki();
        });
      });

    new Setting(containerEl).setName("Data").setHeading();

    new Setting(containerEl)
      .setName("Explanation cache")
      .setDesc(`${this.plugin.cacheSize} local entr${this.plugin.cacheSize === 1 ? "y" : "ies"}.`)
      .addButton((button) => {
        button
          .setButtonText("Clear")
          .setWarning()
          .setDisabled(this.plugin.cacheSize === 0)
          .onClick(() => {
            void this.plugin.clearCache().then(() => {
              this.display();
            });
          });
      });

    new Setting(containerEl)
      .setName("Vocabulary")
      .setDesc("Browse, edit, and export saved words.")
      .addButton((button) => {
        button.setButtonText("Open").onClick(() => {
          this.plugin.openVocabulary();
        });
      });

    new Setting(containerEl)
      .setName("Exports")
      .setDesc("Written to LexiSide Exports in the vault root.")
      .addButton((button) => {
        button.setButtonText("Export Markdown").onClick(() => {
          void this.plugin
            .exportVocabularyMarkdown(this.plugin.getVocabularyEntries())
            .catch((error: unknown) => {
              new Notice(`LexiSide: ${error instanceof Error ? error.message : "Export failed."}`);
            });
        });
      })
      .addButton((button) => {
        button.setButtonText("Export Anki CSV").onClick(() => {
          void this.plugin.exportVocabularyCsv(this.plugin.getVocabularyEntries()).catch((error: unknown) => {
            new Notice(`LexiSide: ${error instanceof Error ? error.message : "Export failed."}`);
          });
        });
      });

    containerEl.createEl("p", {
      cls: "setting-item-description lexiside-settings-note",
      text:
        "Selected context goes only to your configured API. Keys stay in plugin data and never enter notes or exports.",
    });

    const reset = new Setting(containerEl)
      .setName("Reset API settings")
      .setDesc("Clear the key and restore defaults. Vocabulary and cache remain.")
      .addButton((button) => {
        button.setButtonText("Reset").onClick(() => {
          const defaults: Partial<LexiSideSettings> = {
            provider: "deepseek",
            apiKey: "",
            baseUrl: "https://api.deepseek.com",
            model: "deepseek-flash",
            ollamaDisableThinking: true,
            temperature: 0.3,
            maxTokens: 1800,
            timeoutMs: 60_000,
            streaming: true,
            thinkingEnabled: false,
            pronunciationSource: "deepseek",
            ttsVoice: "stella",
            ankiConnectUrl: "http://127.0.0.1:8765",
            ankiDeck: "LexiSide",
            ankiModel: "Basic",
          };
          void this.plugin.updateSettings(defaults).then(() => {
            this.display();
            new Notice("LexiSide API settings restored to defaults.");
          });
        });
      });
    reset.settingEl.addClass("lexiside-danger-setting");
  }

  private async loadOllamaModels(
    target: DropdownComponent | HTMLSelectElement,
    notify: boolean,
  ): Promise<void> {
    const select = target instanceof HTMLSelectElement ? target : target.selectEl;
    const writeOptions = (models: string[], selected: string): void => {
      select.replaceChildren();
      for (const model of models) {
        const option = document.createElement("option");
        option.value = model;
        option.textContent = model;
        select.appendChild(option);
      }
      if (selected) {
        select.value = selected;
      }
    };

    try {
      const models = await this.fetchOllamaModels();
      if (models.length === 0) {
        writeOptions([], "");
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "No models found";
        select.appendChild(option);
        if (notify) {
          new Notice("LexiSide: Ollama is running, but no local models are installed.");
        }
        return;
      }
      const current = this.plugin.getSettings().model;
      const selected = models.includes(current) ? current : (models[0] ?? current);
      writeOptions(models, selected);
      if (selected !== current) {
        await this.plugin.updateSettings({ model: selected });
      }
      if (notify) {
        new Notice(`LexiSide: Loaded ${models.length} Ollama model(s).`);
      }
    } catch (error) {
      writeOptions([], "");
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "Ollama unavailable";
      select.appendChild(option);
      if (notify) {
        new Notice(
          `LexiSide: ${error instanceof Error ? error.message : "Could not reach Ollama."}`,
        );
      }
    }
  }

  private async fetchOllamaModels(): Promise<string[]> {
    const baseUrl = this.plugin.getSettings().baseUrl;
    const response = await requestUrl({
      url: buildOllamaTagsUrl(baseUrl),
      method: "GET",
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Ollama returned HTTP ${response.status}. Check that it is running.`);
    }
    let payload: unknown;
    try {
      payload = response.json;
    } catch {
      payload = JSON.parse(response.text);
    }
    const models = parseOllamaModelNames(payload);
    if (models.length === 0) {
      throw new Error("Ollama returned no installed models.");
    }
    return models;
  }
}
