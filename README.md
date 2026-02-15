# SmartLocal

**Effortless Figma localization with your preferred AI.**

SmartLocal bridges Figma design context and AI translation quality. It generates structured prompts from your selected design and applies returned JSON back into localized variants while preserving visual style.

[**Try it on Figma Community**](https://www.figma.com/community/plugin/1589498837344174364/smartlocal)

## Features

- **AI-agnostic workflow**: Use ChatGPT, Claude, DeepL, or any LLM that can return JSON.
- **Width-aware prompt generation**: Exports `charCount`, `lines`, `boxWidthPx`, and `containerWidthPx` for better UI fit.
- **Text-style preservation**: Keeps dominant text styling (font, size, fills, spacing, case, decoration) when replacing content.
- **Create + update modes**: Creates new localized variants and updates existing `<originalName>_<locale>` variants in place.
- **Flexible JSON parsing**: Accepts multiple response shapes, including nested outputs and merged frame-level localizations.
- **Optional localized image replacement**: Replaces image fills from a local folder catalog using fuzzy matching.
- **Bulk archive utility**: Exports all top-level frame text content on the page as one archive JSON payload.
- **Local-first**: Runs in Figma, with local storage for UI settings and no external SmartLocal backend.

## How It Works

1. Select a **Frame**, **Component**, or **Instance**.
2. Enter target locales (for example: `es, fr, ja`).
3. Use one of these extraction paths:
   - **Generate & Copy Prompt** for the selected node.
   - **Extract All Frames Content** to archive all top-level frames on the current page.
4. Paste the generated JSON input into your AI tool and get localization JSON back.
5. Paste AI JSON into SmartLocal and click **Apply Localization**.
6. SmartLocal creates or updates localized variants and optionally swaps locale-specific images.

## Installation

### From Figma Community (Recommended)

Install SmartLocal directly from [Figma Community](https://www.figma.com/community/plugin/1589498837344174364/smartlocal).

### For Developers (Manual)

1. Download this repository.
2. Open the Figma desktop app.
3. Go to **Menu > Plugins > Development > Import plugin from manifest...**
4. Select `manifest.json` from this project folder.

## Usage

### 1) Generate Prompt (Selected Node)

1. Select one frame/component/instance containing text.
2. Click **Generate & Copy Prompt**.
3. Paste into your AI tool.

The generated input includes text IDs plus sizing metadata so translations can better match layout constraints.

### 2) Extract All Frames Content (Page Utility)

Use **Extract All Frames Content** to copy archive JSON for every top-level frame on the current page. The archive includes:

- Per-frame text input payloads
- A combined page-level input payload
- Frame path metadata and counts

This is useful for page-wide localization pipelines.

### 3) Apply Localization JSON

Paste AI JSON and click **Apply Localization**.

Supported response patterns include:

- `{ "localizations": { ... } }`
- Locale map at root (for example `{ "de-DE": { ... } }`)
- Nested containers like `output.localizations`, `result.localizations`, `data.localizations`, or `combinedOutput.localizations`
- Frame arrays where each item contains localizations (`frames[].localizations`, etc.), which are merged

Important behavior:

- For **new locales**, full text coverage is required (missing IDs are rejected).
- For **existing localized variants**, partial updates are allowed.
- Existing localized siblings named like `<original>_<locale>` are updated instead of duplicated.
- Success status reports both `created` and `updated` counts.

### 4) Optional Image Replacement

1. Enable **Enable localized image replacement**.
2. Click **Choose Assets Folder**.
3. Provide locale-based folders like:

```text
<root>/
  en-US/
    home_hero.png
  zh-Hans/
    home_hero.png
```

SmartLocal image replacement rules:

- Supported extensions: `.png`, `.jpg`, `.jpeg`, `.webp`
- Max size: `20MB` per file
- Catalog limit: `5000` files
- Fuzzy filename matching with confidence/ambiguity checks
- Mismatches can be exported via **Copy Image Mismatch Report**

## Recent Changes

- Prompt generation is now **width-aware** and focused on text-localization payloads.
- Localization apply flow now distinguishes **created vs updated** locale variants.
- Added **Extract All Frames Content** utility for page-level archive export.
- Apply parser now handles more AI response structures and merges frame-level outputs.
- New-locale guardrails enforce full JSON coverage before first-time creation.
- Improved style consistency by applying dominant source text styling after replacement.
- Image localization flow improved with stricter limits, fuzzy matching, and clearer mismatch reporting.

## Development

```bash
npm install
npm run build
npm run watch
```

## Privacy & Security

SmartLocal runs locally in your Figma session. It does not require a SmartLocal server for translation. Prompt/response data is handled in-plugin and copied to clipboard only when you trigger copy actions.

## License

AGPL-3.0
