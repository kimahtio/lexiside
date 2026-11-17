# LexiSide selection architecture

This note records the Phase 1 API analysis and the selection strategy used by the
plugin.

## What Obsidian's public API provides (verified against `obsidian.d.ts` 1.14.4)

| Need | Public API | Result |
| --- | --- | --- |
| Selection-change event | `Workspace.on(...)` events | **Not available.** `editor-change` fires on document edits, not selection movement. |
| Editing View selected text | `Editor.getSelection()` | Available. |
| Editing View selection positions | `Editor.getCursor("from" / "to")`, `Editor.posToOffset()` | Available. |
| Editing View Markdown source | `Editor.getValue()` | Available. |
| Reading View selected text | `MarkdownPreviewView` | **No selection or source-position API.** Rendered HTML is the only source. |
| Reading View source position | `MarkdownPostProcessorContext.getSectionInfo()` | Available only inside a post-processor, not for an arbitrary browser selection. |
| Active Markdown view | `Workspace.getLeavesOfType("markdown")`, `MarkdownView` | Available. |
| Right sidebar | `Workspace.ensureSideLeaf()` / `getRightLeaf()` + `ItemView` | Available. |

There is no official way to observe a selection change. The plugin therefore uses
the web-standard `selectionchange` event as a **notification only**, and never
derives text positions from CodeMirror's private DOM or `editor.cm`.

## Editing View / Live Preview

1. A debounced `document.selectionchange` event schedules a capture.
2. The plugin locates the Markdown view whose public `containerEl` contains the
   browser selection. This supports the main window and pop-out windows, and
   avoids assuming which leaf is "active".
3. In `source` mode, the target, offsets, and full Markdown source come from the
   public `Editor` API.
4. The complete sentence and surrounding context are extracted from the source
   around those offsets. Inline Markdown is cleaned for the AI prompt and display.

No CodeMirror extension, `editor.cm`, or editor DOM class names are involved.

## Reading View

1. The same `selectionchange` event schedules a capture.
2. The browser `Selection`/`Range` identifies the selected text.
3. The selection is accepted only if its range is inside a `MarkdownView`'s
   `previewMode.containerEl` and the view is in `preview` mode.
4. The nearest semantic block element (`p`, heading, list item, table cell, etc.)
   supplies the sentence offsets. Adjacent sibling blocks supply limited extra
   context. Icons and custom sidebar UI live outside the Markdown view, so their
   selections cannot trigger a lookup.
5. The source note is obtained from the public `MarkdownView.file`.

Obsidian does not expose a mapping from a Reading View browser range back to exact
Markdown source offsets. The plugin therefore stores the **rendered sentence text**
for Reading View lookups. For Editing View lookups it stores the **source-derived
sentence** after inline-Markdown cleanup. This limitation is documented in the
README.

## Frequency, duplicates, and stale requests

- Selection events are coalesced with a 150 ms debounce.
- Selections longer than 8 words or 80 characters are ignored.
- Selections with non-Latin scripts (CJK, Cyrillic, Greek, Arabic, etc.) are ignored.
- Collapsing the selection does not clear the panel or make a request.
- An analysis cache key is built from selected text, the full sentence/context,
  the model name, and a prompt-schema version. Re-selecting the same context with
  the same model is served from cache.
- Every new query aborts the previous Fetch request via `AbortController`; late
  responses are also rejected with a monotonically increasing request id.
- The request fallback through Obsidian's `requestUrl` cannot be aborted at the
  transport layer, but its result is discarded when stale.

## Known selection limitations

- Reading View does not expose exact source offsets, and selected sentence text
  can differ slightly from Markdown source.
- Selections spanning multiple Reading View blocks are ignored.
- A selection made inside an embedded rendered note uses the outer Markdown view's
  file name.
- Mobile behavior was not tested; the plugin is desktop-first.
