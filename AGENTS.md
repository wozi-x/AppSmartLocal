# SmartLocal – Agent Guide

This document helps AI coding assistants and developers understand the SmartLocal codebase and work effectively within it.

## Project Overview

**SmartLocal** is a Figma plugin for design localization. It bridges Figma design context and AI translation by:

1. Extracting text from selected frames with sizing metadata (`charCount`, `lines`, `boxWidthPx`, `containerWidthPx`)
2. Generating prompts for external AI tools (ChatGPT, Claude, DeepL, etc.)
3. Applying returned JSON localizations back into Figma, creating or updating locale variants
4. Optionally replacing image fills from a local folder catalog

The plugin runs entirely in Figma with no external backend. Data is handled in-plugin and copied to clipboard only when the user triggers copy actions.

## Tech Stack

- **TypeScript** – Main plugin logic (`code.ts`)
- **Figma Plugin API** – Sandboxed plugin runtime
- **HTML/CSS/JS** – UI (`ui.template.html` → `ui.html`)
- **Node.js** – Build scripts (`scripts/build_ui.js`, `scripts/local_image_server.js`)

## Key Files

| File | Purpose |
|------|---------|
| `code.ts` | Plugin main entry. Runs in Figma sandbox. Handles selection, extraction, localization apply, image replacement. |
| `ui.template.html` | UI template with `{{PROMPT}}` placeholder. Source of truth for UI. |
| `ui.html` | Generated UI (built from template + `prompt.md`). Do not edit directly. |
| `prompt.md` | Localization prompt injected into UI. Used when user copies prompt for AI. |
| `manifest.json` | Figma plugin manifest. Defines `main`, `ui`, capabilities. |
| `scripts/build_ui.js` | Injects `prompt.md` into `ui.template.html` → `ui.html`. |
| `scripts/local_image_server.js` | Local dev server for image folder selection (optional). |

## Architecture

### Sandbox Split

- **Plugin sandbox** (`code.ts`): Full Figma API access. Selection, scene graph, text/image extraction, node creation/updates.
- **UI sandbox** (`ui.html`): Limited to `figma.ui.postMessage` / `parent.postMessage`. No direct Figma API.

Communication is via `figma.ui.postMessage` (plugin → UI) and `parent.postMessage` (UI → plugin).

### Message Types

Plugin → UI examples: `selection-changed`, `prompt-copied`, `localization-result`, `image-catalog-loaded`, etc.

UI → Plugin examples: `generate-prompt`, `apply-localization`, `choose-assets-folder`, `get-storage`, `set-storage`, etc.

### Storage Keys

- `smartlocal_locales` – Target locales (comma-separated)
- `smartlocal_prompt` – User prompt override (optional)
- `smartlocal_image_source_enabled` – Whether image replacement is enabled

## Build & Development

```bash
npm install
npm run build    # build_ui.js + tsc
npm run watch    # watch mode
npm run lint     # ESLint
npm run lint:fix # ESLint with auto-fix
```

**Important:** After changing `prompt.md` or `ui.template.html`, run `npm run build` so `ui.html` is regenerated.

## Conventions

### Localization JSON Format

Input (extracted):

```json
{
  "texts": [
    { "id": "nodeId", "text": "...", "charCount": N, "lines": N, "boxWidthPx": N, "containerWidthPx": N }
  ],
  "targetLanguages": ["es", "fr", "ja"]
}
```

Output (AI response, supported shapes):

- `{ "localizations": { "<locale>": { "<id>": "translated" } } }`
- Root locale map: `{ "de-DE": { ... } }`
- Nested: `output.localizations`, `result.localizations`, `data.localizations`, `combinedOutput.localizations`
- Frame arrays: `frames[].localizations` (merged)

### Locale Variant Naming

- New locales: full text coverage required.
- Existing variants: named `<original>_<locale>` (e.g. `Card_es`, `Card_fr`). Partial updates allowed.

### Image Catalog

- Extensions: `.png`, `.jpg`, `.jpeg`, `.webp`
- Max file size: 20MB
- Max catalog entries: 5000
- Fuzzy filename matching with `MIN_MATCH_SCORE` (0.6) and `AMBIGUOUS_MARGIN` (0.04)

## Adding Features

1. **UI changes** – Edit `ui.template.html`. Add message handlers for new actions.
2. **Plugin logic** – Edit `code.ts`. Add `figma.ui.onmessage` handlers.
3. **Prompt changes** – Edit `prompt.md`. Rebuild to update `ui.html`.
4. **New storage keys** – Add constants at top of `code.ts` (e.g. `STORAGE_KEY_*`).

## Testing

- Load plugin in Figma: **Menu > Plugins > Development > Import plugin from manifest...** → select `manifest.json`.
- Use `scripts/local_image_server.js` for local image folder testing if needed.

## License

AGPL-3.0
