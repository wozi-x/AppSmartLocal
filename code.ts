// SmartLocal - Figma Localization Plugin
// Helps designers localize frames by generating AI-friendly prompts

// Show the UI
// Show the UI
figma.showUI(__html__, { width: 360, height: 480 }); // Reduced height to fit content better

// Check selection on startup (remove potential race condition, rely on ui-ready)
// checkSelection();

// Helper to check selection and notify UI
function checkSelection() {
  const selection = figma.currentPage.selection;

  if (selection.length === 0) {
    figma.ui.postMessage({
      type: 'selection-changed',
      isValid: false,
      message: 'No frame selected'
    });
    return;
  }

  if (selection.length > 1) {
    figma.ui.postMessage({
      type: 'selection-changed',
      isValid: false,
      message: 'Please select only one frame'
    });
    return;
  }

  const node = selection[0];
  if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE') {
    figma.ui.postMessage({
      type: 'selection-changed',
      isValid: true,
      nodeName: node.name
    });
  } else {
    figma.ui.postMessage({
      type: 'selection-changed',
      isValid: false,
      message: 'Selection is not a frame'
    });
  }
}

// Monitor selection changes
figma.on('selectionchange', () => {
  checkSelection();
});

// Types
interface TextInfo {
  id: string;
  text: string;
  charCount: number;
  lines: number;
  width: number;
  height: number;
}

interface ExtractedData {
  sourceFrame: string;
  texts: TextInfo[];
  targetLanguages: string[];
}

interface Localizations {
  [locale: string]: {
    [nodeId: string]: string;
  };
}

// Extract all text nodes from a frame recursively
function extractTextNodes(node: SceneNode, texts: TextInfo[]): void {
  if (node.type === 'TEXT') {
    const textNode = node as TextNode;

    // Calculate approximate line count based on text height and font size
    let lines = 1;
    try {
      // Get the height of the text box and estimate lines
      const height = textNode.height;
      const fontSize = typeof textNode.fontSize === 'number' ? textNode.fontSize : 12;
      const lineHeight = fontSize * 1.4; // Approximate line height
      lines = Math.max(1, Math.round(height / lineHeight));
    } catch {
      lines = 1;
    }

    texts.push({
      id: textNode.id,
      text: textNode.characters,
      charCount: textNode.characters.length,
      lines: lines,
      width: Math.round(textNode.width),
      height: Math.round(textNode.height)
    });
  }

  // Recursively process children
  if ('children' in node) {
    for (const child of node.children) {
      extractTextNodes(child, texts);
    }
  }
}

// Build the mapping between original node IDs and cloned TextNode references
function buildNodeMapping(original: SceneNode, cloned: SceneNode, mapping: Map<string, TextNode>): void {
  if (original.type === 'TEXT' && cloned.type === 'TEXT') {
    mapping.set(original.id, cloned);
  }

  if ('children' in original && 'children' in cloned) {
    const origChildren = original.children;
    const clonedChildren = cloned.children;

    for (let i = 0; i < origChildren.length && i < clonedChildren.length; i++) {
      buildNodeMapping(origChildren[i], clonedChildren[i], mapping);
    }
  }
}

// Handle messages from UI
figma.ui.onmessage = async (msg: { type: string;[key: string]: unknown }) => {

  // UI Ready - Check initial selection
  if (msg.type === 'ui-ready') {
    checkSelection();
  }

  // Generate Prompt
  if (msg.type === 'generate-prompt') {
    const selection = figma.currentPage.selection;

    if (selection.length === 0) {
      figma.ui.postMessage({
        type: 'prompt-error',
        message: 'Please select a frame first'
      });
      return;
    }

    if (selection.length > 1) {
      figma.ui.postMessage({
        type: 'prompt-error',
        message: 'Please select only one frame'
      });
      return;
    }

    const selectedNode = selection[0];
    if (selectedNode.type !== 'FRAME' && selectedNode.type !== 'COMPONENT' && selectedNode.type !== 'INSTANCE') {
      figma.ui.postMessage({
        type: 'prompt-error',
        message: 'Please select a frame, component, or instance'
      });
      return;
    }

    // Extract text nodes
    const texts: TextInfo[] = [];
    extractTextNodes(selectedNode, texts);

    if (texts.length === 0) {
      figma.ui.postMessage({
        type: 'prompt-error',
        message: 'No text found in the selected frame'
      });
      return;
    }

    const languages = msg.languages as string[];
    const promptTemplate = msg.promptTemplate as string;

    // Build extracted data
    const extractedData: ExtractedData = {
      sourceFrame: selectedNode.name,
      texts: texts,
      targetLanguages: languages
    };

    // Build the full prompt
    const fullPrompt = `${promptTemplate}

INPUT:
${JSON.stringify(extractedData, null, 2)}

OUTPUT FORMAT:
{
  "localizations": {
    "${languages[0]}": {
${texts.map(t => `      "${t.id}": "translated text for ${t.text}"`).join(',\n')}
    }
  }
}`;

    // Copy to clipboard via UI
    figma.ui.postMessage({
      type: 'copy-to-clipboard',
      text: fullPrompt
    });

    // Also send success message
    figma.ui.postMessage({
      type: 'prompt-generated',
      textCount: texts.length,
      extractedData: extractedData
    });

    figma.notify(`📋 Prompt copied! Found ${texts.length} text nodes.`);
  }

  // Apply Localization
  if (msg.type === 'apply-localization') {
    const selection = figma.currentPage.selection;

    if (selection.length === 0) {
      figma.ui.postMessage({
        type: 'apply-error',
        message: 'Please select the original frame'
      });
      return;
    }

    const selectedNode = selection[0];
    if (selectedNode.type !== 'FRAME' && selectedNode.type !== 'COMPONENT' && selectedNode.type !== 'INSTANCE') {
      figma.ui.postMessage({
        type: 'apply-error',
        message: 'Please select a frame, component, or instance'
      });
      return;
    }

    const localizations = msg.localizations as Localizations;
    const locales = Object.keys(localizations);

    if (locales.length === 0) {
      figma.ui.postMessage({
        type: 'apply-error',
        message: 'No localizations found in the response'
      });
      return;
    }

    // Get the frame dimensions for positioning
    const originalFrame = selectedNode;
    const frameHeight = originalFrame.height;
    const spacing = 40; // Gap between frames

    let createdCount = 0;

    console.log('Locales received:', locales);
    console.log('Total locales to process:', locales.length);

    for (let i = 0; i < locales.length; i++) {
      const locale = locales[i];
      const translations = localizations[locale];

      console.log(`Processing locale ${i + 1}/${locales.length}: ${locale}`);

      try {
        // Clone the frame
        const clonedFrame = originalFrame.clone();

        // Rename with locale suffix
        clonedFrame.name = `${originalFrame.name}_${locale}`;

        // Position below original (and previous clones)
        clonedFrame.y = originalFrame.y + (i + 1) * (frameHeight + spacing);

        // Build mapping between original IDs and cloned TextNode references
        const nodeMapping = new Map<string, TextNode>();
        buildNodeMapping(originalFrame, clonedFrame, nodeMapping);

        // STEP 1: Load all fonts for all text nodes BEFORE any modifications
        for (const [originalId] of Object.entries(translations)) {
          const textNode = nodeMapping.get(originalId);
          if (textNode && textNode.characters.length > 0) {
            try {
              const fontName = textNode.fontName;
              if (fontName !== figma.mixed) {
                await figma.loadFontAsync(fontName);
              } else {
                // Mixed fonts - load all unique fonts in the text
                const fontNames = textNode.getRangeAllFontNames(0, textNode.characters.length);
                for (const fn of fontNames) {
                  await figma.loadFontAsync(fn);
                }
              }
            } catch (fontErr) {
              console.warn(`Font loading error for ${originalId}:`, fontErr);
              // Continue anyway - Figma might still work
            }
          }
        }

        // STEP 2: Apply translations while preserving all text styles
        for (const [originalId, translatedText] of Object.entries(translations)) {
          const textNode = nodeMapping.get(originalId);
          if (textNode) {
            try {
              // Store ALL current styles BEFORE any modification
              const fills = [...(textNode.fills as Paint[])];
              const strokes = [...(textNode.strokes as Paint[])];
              const effects = [...(textNode.effects as Effect[])];
              const textStyleId = textNode.textStyleId;
              const fontSize = textNode.fontSize;
              const fontName = textNode.fontName;
              const textAlignHorizontal = textNode.textAlignHorizontal;
              const textAlignVertical = textNode.textAlignVertical;
              const letterSpacing = textNode.letterSpacing;
              const lineHeight = textNode.lineHeight;
              const textDecoration = textNode.textDecoration;
              const textCase = textNode.textCase;

              // Replace text content
              textNode.characters = translatedText;

              // Restore all visual styles
              textNode.fills = fills;
              textNode.strokes = strokes;
              textNode.effects = effects;

              // Restore text properties if not mixed
              if (fontSize !== figma.mixed) {
                textNode.fontSize = fontSize;
              }
              if (fontName !== figma.mixed) {
                textNode.fontName = fontName;
              }
              // textAlign properties are always strings
              textNode.textAlignHorizontal = textAlignHorizontal;
              textNode.textAlignVertical = textAlignVertical;
              if (letterSpacing !== figma.mixed) {
                textNode.letterSpacing = letterSpacing;
              }
              if (lineHeight !== figma.mixed) {
                textNode.lineHeight = lineHeight;
              }
              if (textDecoration !== figma.mixed) {
                textNode.textDecoration = textDecoration;
              }
              if (textCase !== figma.mixed) {
                textNode.textCase = textCase;
              }

              // Restore text style if it was applied
              if (typeof textStyleId === 'string' && textStyleId !== '') {
                textNode.textStyleId = textStyleId;
              }
            } catch (textErr) {
              console.warn(`Text replacement error for ${originalId}:`, textErr);
              // Continue with other text nodes
            }
          }
        }

        createdCount++;
        console.log(`Completed locale ${locale}, created count: ${createdCount}`);
      } catch (localeErr) {
        console.error(`Failed to process locale ${locale}:`, localeErr);
        // Continue with next locale
      }
    }

    figma.ui.postMessage({
      type: 'apply-success',
      frameCount: createdCount
    });

    figma.notify(`✨ Created ${createdCount} localized frames!`);
  }

  // Handle clipboard copy request from UI
  if (msg.type === 'copy-complete') {
    // Clipboard copy handled in UI
  }
};
