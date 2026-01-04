# SmartLocal

A Figma plugin for localizing UI designs with AI assistance.

## How It Works

1. **Select a frame** with text content in Figma
2. **Generate prompt** - Plugin extracts all text and creates an AI-ready prompt
3. **Copy to AI** - Paste the prompt to your favorite AI language model
4. **Get translations** - AI returns JSON with localized text
5. **Apply** - Plugin creates duplicated frames with translated text

## Installation

1. Open Figma Desktop
2. Go to **Plugins → Development → Import plugin from manifest**
3. Select the `manifest.json` file from this directory

## Development

```bash
# Install dependencies
npm install

# Build once
npm run build

# Watch for changes
npm run watch
```

## Usage

1. Select a frame containing text elements
2. Enter target languages (e.g., `es, fr, ja, zh`)
3. Click **Generate & Copy Prompt**
4. Paste the prompt into an AI like ChatGPT or Claude
5. Copy the JSON response
6. Paste it into the plugin's response area
7. Click **Apply Localization**

The plugin will create new frames below the original, named with locale suffixes (e.g., `MyFrame_es`, `MyFrame_fr`).
