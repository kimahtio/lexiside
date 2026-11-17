# Changelog

## 1.0.3 — 2026-11-17

- Removed the redundant "LexiSide" heading from the settings tab; Obsidian already
  shows the plugin name there, and the community review asks settings headings to
  avoid repeating it.
- Releases now include generated release notes.

## 1.0.2 — 2026-11-17

- The settings tab now uses `Setting.setHeading()` instead of a raw `h2`, as the
  Obsidian review guidelines require.
- The word map host toggles its measuring visibility through `setCssStyles`
  rather than assigning `style.visibility` directly.
- No behavior change: the only other difference is the version field.

## 1.0.1 — 2026-11-17

- Added the TypeScript sources, tests, build configuration, and documentation to
  the repository, as required by the Obsidian community directory. The published
  bundle is unchanged from 1.0.0 apart from the version field.
- Releases are now built and published by the release workflow, with GitHub build
  provenance attestations for `main.js`, `manifest.json`, and `styles.css`.

## 1.0.0 — 2026-11-17

- Added a provider selector for DeepSeek, local Ollama, and custom
  OpenAI-compatible endpoints. Ollama models are discovered from `/api/tags`,
  and a local-reasoning toggle prevents thinking models from consuming the
  entire output budget.
- Removed the Uncertainty notice card from the sidebar; the data field remains
  for backward compatibility.
- Removed unused legacy parsers, migration helpers, types, and stale CSS from
  earlier sidebar iterations.
- Added official DeepSeek TTS pronunciation (`/v1/tools/tts`) with Stella and
  Tide voices, in-memory audio caching, and automatic system-voice fallback.
- Added a Pronunciation settings section for source and voice selection.
- Removed the empty-state Open vocabulary button; the library remains available
  from the context menus and Command Palette.
- Added automatic CSS-Highlight marking of the source sentence and word in
  Reading View, plus click-to-locate from the sidebar quote.
- Added direct Anki AnkiConnect sync for the current word or all saved vocabulary,
  with deck creation, Basic/custom model field mapping, tag generation, and
  duplicate checks.
- Limited automatic selection handling to Reading View.
- Reorganized the sidebar around Meaning, Word Map, and Context; proper nouns no
  longer render a Word Map.
- Redesigned Meaning as part-of-speech groups with numbered senses, Chinese
  meanings, and per-sense examples.
- Moved the source sentence into Meaning above the part-of-speech groups. The
  contextual sense is always first; prompt v11 is organized for the current
  Meaning/map UI, permits a single sense for monosemous words, forbids hybrid
  specialized/general definitions, broad/subtype duplication, and field/subject
  splits, limits the list to genuinely distinct senses, requires one complete
  English/Chinese example per sense, and removes exact or near-duplicate
  paraphrases plus duplicate Chinese glosses, including explanatory
  parentheticals with the same headword.

## Internal pre-release 2.0 — 2026-11-15

- Added a versioned canonical vocabulary knowledge model with local meaning IDs,
  contextual/core/other senses, usage, nuance, and word family.
- Switched the AI response to canonical structured knowledge and added one
  structural repair attempt when schema validation fails.
- Added previous/next sentence input, learner level, explanation depth, and a
  language profile.
- Added stable context hashing, profile-aware cache keys, cache schema versioning,
  and surface-to-lemma cache matching.
- Upgraded `data.json` to storage v3 while preserving legacy vocabulary and cache
  records. Old entries are adapted on read and migrated lazily on edit/save.
- Added typed semantic relations derived locally from canonical data, plus a
  fixed-template Mermaid Word Map with escaped labels and a six-node limit.
- Integrated Obsidian's Pele renderer through `MarkdownRenderer`; the Word Map
  falls back to an accessible text relation list if rendering fails.
- Rebuilt the sidebar around Word Map → Context → Meaning → Usage →
  Nuance & Grammar → Word Family, with collapsible advanced sections and a
  relation details panel.
- Updated Markdown, Anki, and plain-text output with canonical extras while
  preserving the existing save, history, copy, and export flows.
- Added a best-effort pre-migration backup at
  `.obsidian/plugins/lexiside/data.backup-storage-v2.json`.

## 1.1.0 — 2026-11-15

- Started the API request and sidebar reveal concurrently instead of waiting for
  the sidebar before sending the request.
- Added progressive SSE rendering: complete, type-checked JSON fields are shown
  while the rest of the response is still generating. Final output still requires
  full schema validation.
- Reordered the output contract so examples follow the core meaning fields; the
  richer sections arrive later for a faster first paint.
- Reduced selection debounce from 220 ms to 150 ms.
- Bumped the internal prompt version to v3. Existing vocabulary and caches remain;
  old cached analyses are no longer reused.
- No data schema migration.

## 1.0.4 — 2026-11-15

- Removed the source note, AI/cache origin, analysis timestamp, and model name
  from the sidebar header for a cleaner reading layout.
- Source and timing metadata are still stored when saving a word and remain
  visible in the vocabulary History view.
- No data migration or credential changes.

## 1.0.3 — 2026-11-15

- Compacted the generated explanation contract: shorter fields, tighter array
  limits, no repeated source sentence, and output fields ordered like the UI.
- Moved the static prompt contract before the dynamic note data so providers
  with automatic prompt caching can reuse more of the request prefix.
- Bumped the internal prompt version to v2. Existing vocabulary is unchanged;
  older cached analyses remain on disk but are no longer reused.
- No data schema migration or credential changes.

## 1.0.2 — 2026-11-15

- Made sidebar body copy follow Obsidian's system text size and rebalanced the
  surrounding type scale.
- Reworked settings copy into shorter, consistent labels and descriptions.
- Simplified settings styling so notes and controls inherit Obsidian's native
  visual language.
- No data migration: existing settings, credentials, vocabulary, and cache are
  preserved.

## 1.0.1 — 2026-11-15

- Updated the DeepSeek default model from the legacy `deepseek-chat` ID to the
  current official `deepseek-flash` model.
- Added optional DeepSeek V4 thinking mode. It is disabled by default for faster,
  cheaper vocabulary lookups and is only sent to the official `api.deepseek.com`
  endpoint for `deepseek-flash` / `deepseek-v4-pro`. Custom OpenAI-compatible
  endpoints never receive the DeepSeek-specific field.
- Added a one-time v1 → v2 data migration for official DeepSeek users still on
  `deepseek-chat`. Custom endpoint model choices are left untouched. API keys,
  vocabulary, and caches are preserved.
- Updated documentation, tests, manifest, and release package.

## Early 1.0 prototype — 2026-11-15

- Initial release.
