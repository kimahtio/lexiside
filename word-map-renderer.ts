import { MarkdownRenderer, type App, type Component } from "obsidian";
import { buildWordMapMermaid, wordMapMermaidBlock, type WordMapModel } from "./word-map.ts";

export interface WordMapRenderer {
  render(
    model: WordMapModel,
    container: HTMLElement,
    owner: Component,
  ): Promise<boolean>;
  clear(container: HTMLElement): void;
}

interface PeleGlobal {
  mount?: (element: HTMLElement, source: string, options?: Record<string, unknown>) => void;
}

function getPele(): PeleGlobal | null {
  if (typeof window === "undefined") {
    return null;
  }
  const candidate = (window as Window & { pele?: PeleGlobal }).pele;
  return candidate && typeof candidate.mount === "function" ? candidate : null;
}

/**
 * Renderer adapter kept independent of the knowledge model. Business code
 * passes WordMapModel; only this class knows about Pele/MarkdownRenderer.
 *
 * Pele's MarkdownRenderer path enables autoDirection and may flip TD to LR.
 * Mounting with autoDirection:false keeps the diagram TD at every sidebar width,
 * so the map does not need a fixed-width horizontal scroller.
 */
export class PeleWordMapRenderer implements WordMapRenderer {
  private readonly app: App;

  constructor(app: App) {
    this.app = app;
  }

  async render(
    model: WordMapModel,
    container: HTMLElement,
    owner: Component,
  ): Promise<boolean> {
    const source = buildWordMapMermaid(model);
    const block = wordMapMermaidBlock(model);
    if (!source || !block) {
      this.clear(container);
      return false;
    }

    container.empty();
    const host = container.createDiv({ cls: "lexiside-map-mermaid" });
    host.setCssStyles({ visibility: "hidden" });

    const mountFixed = (pele: PeleGlobal): boolean => {
      if (!pele.mount) {
        return false;
      }
      host.empty();
      pele.mount(host, source, {
        autoDirection: false,
        responsive: true,
      });
      host.querySelectorAll(".pele-zoom").forEach((control) => control.remove());
      return host.querySelector("svg.pele, .mermaid svg, svg") !== null;
    };

    try {
      const pele = getPele();
      if (pele && mountFixed(pele)) {
        return true;
      }

      // First render in a session loads Obsidian's Pele instance. After that,
      // replace the auto-directed SVG with a fixed-TD mount.
      await MarkdownRenderer.render(this.app, block, host, "", owner);
      const loaded = getPele();
      if (loaded && mountFixed(loaded)) {
        return true;
      }
      return host.querySelector("svg.pele, .mermaid svg, .block-language-mermaid svg") !== null;
    } catch {
      this.clear(container);
      return false;
    } finally {
      host.setCssStyles({ visibility: "" });
    }
  }

  clear(container: HTMLElement): void {
    container.empty();
  }
}
