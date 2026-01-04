# SmartLocal

**Effortless Figma Localization with Your Preferred AI.**

SmartLocal bridges the gap between Figma designs and AI translation. Instead of relying on rigid, built-in translation services, SmartLocal generates context-aware prompts that you can use with **any** AI tool (ChatGPT, Claude, DeepL, etc.) to get high-quality, culturally relevant translations.

![Banner Image](https://placehold.co/600x400?text=SmartLocal+Banner)

## ✨ Features

-   **🤖 AI-Agnostic**: You control the translation. Use your custom GPTs, specialized prompts, or any LLM.
-   **🎨 Perfect Style Match**: Preserves fonts, weights, colors, autolayout, and complex text styles.
-   **🚀 Batch Localization**: Generate multiple locales (e.g., `en`, `es`, `ja`, `de`) in a single pass.
-   **📏 Layout Safe**: Automatically clones and positions localized frames below the original for easy comparison.
-   **🧠 Context-Aware**: Extracts text hierarchy to help AI understand what it's translating (headings, buttons, body).

## 🛠️ How It Works

1.  **Select**: Click on any Frame, Component, or Instance in Figma.
2.  **Generate**: Open SmartLocal, enter your target languages (e.g., `es, fr`), and click **Generate Prompt**.
3.  **Translate**: Paste the generated prompt into your AI tool (ChatGPT, Claude, etc.).
4.  **Apply**: Copy the JSON response from the AI and paste it back into SmartLocal.
5.  **Done**: Watch as SmartLocal creates perfectly styled duplicates for each language!

## 📦 Installation

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
MIT
