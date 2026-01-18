// SmartLocal - Figma Localization Plugin
// Helps designers localize frames by generating AI-friendly prompts

// Storage keys for persisting user preferences
const STORAGE_KEY_LOCALES = 'smartlocal_locales';
const STORAGE_KEY_PROMPT = 'smartlocal_prompt';

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
  // console.log(`Processing node: ${node.name} (${node.type})`);

  if (node.type === 'TEXT') {
    const textNode = node as TextNode;
    // console.log(`  -> Found TEXT node: "${textNode.characters}" (ID: ${textNode.id}) visible: ${textNode.visible}`);

    // Skip invisible nodes
    if (!textNode.visible) {
      console.log(`  -> Skipping invisible node: ${textNode.name}`);
      return;
    }

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

  // UI Ready - Load saved settings and check initial selection
  if (msg.type === 'ui-ready') {
    // Load saved settings from clientStorage
    try {
      const savedLocales = await figma.clientStorage.getAsync(STORAGE_KEY_LOCALES);
      const savedPrompt = await figma.clientStorage.getAsync(STORAGE_KEY_PROMPT);

      figma.ui.postMessage({
        type: 'load-saved-settings',
        locales: savedLocales || null,
        prompt: savedPrompt || null
      });
    } catch (err) {
      console.warn('Failed to load saved settings:', err);
    }

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

    console.log(`Total text nodes found in "${selectedNode.name}":`, texts.length);
    if (texts.length > 0) {
      console.log('Sample extracted text:', texts.slice(0, 3).map(t => t.text));
    }

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
              // Get all segments to find the "Dominant Style"
              // (The style used by the majority of the characters)
              const segments = textNode.getStyledTextSegments([
                'fontName',
                'fontSize',
                'fills',
                'lineHeight',
                'letterSpacing',
                'textDecoration',
                'textCase'
              ]);

              // Guard against empty text nodes
              if (segments.length === 0) {
                textNode.characters = translatedText;
                continue; // Skip to next text node
              }

              let dominantSegment = segments[0];
              let maxLen = 0;

              for (const seg of segments) {
                const len = seg.end - seg.start;
                if (len > maxLen) {
                  maxLen = len;
                  dominantSegment = seg;
                }
              }

              // Ensure the dominant font is loaded before we try to apply it
              // (We pre-loaded fonts earlier, but this is a safety double-check for the specific one we want to set)
              const dominantFontName = dominantSegment.fontName;
              if (dominantFontName && (dominantFontName as any) !== figma.mixed) {
                await figma.loadFontAsync(dominantFontName);
              }

              // Replace text content
              // Figma will initially apply the style of index 0
              textNode.characters = translatedText;

              // Force apply the Dominant Style to the whole string
              // This fixes issues where index 0 was a bullet point/icon with a different style
              if ((dominantSegment.fontSize as any) !== figma.mixed) textNode.fontSize = dominantSegment.fontSize;
              if ((dominantSegment.fontName as any) !== figma.mixed) textNode.fontName = dominantSegment.fontName;
              if ((dominantSegment.fills as any) !== figma.mixed) textNode.fills = dominantSegment.fills;
              if ((dominantSegment.lineHeight as any) !== figma.mixed) textNode.lineHeight = dominantSegment.lineHeight;
              if ((dominantSegment.letterSpacing as any) !== figma.mixed) textNode.letterSpacing = dominantSegment.letterSpacing;
              if ((dominantSegment.textDecoration as any) !== figma.mixed) textNode.textDecoration = dominantSegment.textDecoration;
              if ((dominantSegment.textCase as any) !== figma.mixed) textNode.textCase = dominantSegment.textCase;

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

  // Save locales to clientStorage
  if (msg.type === 'save-locales') {
    try {
      await figma.clientStorage.setAsync(STORAGE_KEY_LOCALES, msg.locales as string);
    } catch (err) {
      console.warn('Failed to save locales:', err);
    }
  }

  // Save prompt to clientStorage
  if (msg.type === 'save-prompt') {
    try {
      await figma.clientStorage.setAsync(STORAGE_KEY_PROMPT, msg.prompt as string);
    } catch (err) {
      console.warn('Failed to save prompt:', err);
    }
  }
};
