# SmartLocal

**Effortless Figma Localization with Your Preferred AI.**

SmartLocal bridges the gap between Figma designs and AI translation. Instead of relying on rigid, built-in translation services, SmartLocal generates context-aware prompts that you can use with **any** AI tool (ChatGPT, Claude, DeepL, etc.) to get high-quality, culturally relevant translations.

[**👉 Try it on Figma Community**](https://www.figma.com/community/plugin/1589498837344174364/smartlocal)

## ✨ Features

-   **🤖 AI-Agnostic**: Use any LLM (ChatGPT, Claude, etc.) with generated prompts.
-   **🎨 Perfect Style Preservation**: Maintains fonts, colors, and auto-layout.
-   **🚀 Batch Localization**: Generate multiple languages in one pass.
-   **📏 Non-Destructive**: Clones and positions localized frames below originals.
-   **🧠 Context-Aware**: Extracts text hierarchy for better translations.

## 🛠️ How It Works

1.  **Select**: Click on any Frame, Component, or Instance in Figma.
2.  **Generate**: Open SmartLocal, enter your target languages (e.g., `es, fr`), and click **Generate Prompt**.
3.  **Translate**: Paste the generated prompt into your AI tool (ChatGPT, Claude, etc.).
4.  **Apply**: Copy the JSON response from the AI and paste it back into SmartLocal.
5.  **Done**: Watch as SmartLocal creates perfectly styled duplicates for each language!

## 📦 Installation

### 🚀 From Figma Community (Recommended)

Install SmartLocal directly from the [Figma Community](https://www.figma.com/community/plugin/1589498837344174364/smartlocal).

### 🛠️ For Developers (Manual)

1.  Download this repository.
2.  Open Figma Desktop App.
3.  Go to **Menu > Plugins > Development > Import plugin from manifest...**.
4.  Select `manifest.json` from the `AppSmartLocal` folder.

## 💻 Usage

### Generating Translations
1.  Select a frame with text.
2.  Run **SmartLocal**.
3.  In the "Target Languages" input, type codes like `es` (Spanish), `fr` (French), `jp` (Japanese).
4.  Hit **Generate & Copy Prompt**.
5.  Go to ChatGPT/Claude and paste.

### Applying Translations
1.  Copy the JSON code block returned by the AI.
2.  Paste it into the plugin's text area.
3.  Ensure the **original frame** is still selected.
4.  Click **Apply Localization**.

*Tip: If the AI adds extra text before/after the JSON, just copy strictly the `{ ... }` JSON part.*

### Applying Localized Images (Optional)
1.  In the plugin, enable **Enable localized image replacement**.
2.  Click **Choose Assets Folder** and select a local folder containing locale subfolders.
3.  Click **Apply Localization**.

Expected screenshots folder structure:
```text
<root>/
  en-US/
    iPhone 17-mystudy_cardstack_iPhone_17.png
    ...
  zh-Hans/
    iPhone 17-mystudy_cardstack_iPhone_17.png
    ...
```

Matching behavior:
- SmartLocal auto-matches node names to filenames using fuzzy scoring.
- Exact or near matches are applied automatically.
- If no confident match exists, SmartLocal skips and reports the mismatch.
- If multiple candidates are too close, SmartLocal marks as ambiguous and skips.

Supported image formats and limits:
- Extensions: `.png`, `.jpg`, `.jpeg`, `.webp`
- Max size: `20MB` per file
- Catalog limit: `5000` files
- Apply flow continues even when some image matches are skipped/failed.

## ⚙️ Development

```bash
# Install dependencies
npm install

# Build the plugin
npm run build

# Watch mode for development
npm run watch
```

## 🔒 Privacy & Security
SmartLocal runs entirely locally in your Figma instance. It does not send your design data to any third-party server. Text is only exported to your clipboard when you explicitly click "Generate".

## 📄 License
AGPL-3.0
