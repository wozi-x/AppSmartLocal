// SmartLocal - Figma Localization Plugin
// Helps designers localize frames by generating AI-friendly prompts

// Storage keys for persisting user preferences
const STORAGE_KEY_LOCALES = 'smartlocal_locales';
const STORAGE_KEY_PROMPT = 'smartlocal_prompt';
const STORAGE_KEY_IMAGE_SOURCE_ENABLED = 'smartlocal_image_source_enabled';
const STORAGE_KEY_IMAGE_SOURCE_URL = 'smartlocal_image_source_url';
const STORAGE_KEY_IMAGE_SOURCE_ROOT_PATH = 'smartlocal_image_source_root_path';

// Show the UI
figma.showUI(__html__, { width: 360, height: 620 });

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

interface ImageInfo {
  id: string;
  nodeName: string;
  fillIndex: number;
}

interface ExtractedData {
  sourceFrame: string;
  texts: TextInfo[];
  targetLanguages: string[];
  images?: ImageInfo[];
}

interface Localizations {
  [locale: string]: {
    [nodeId: string]: string;
  };
}

interface ImageSourceSettings {
  enabled: boolean;
  baseUrl: string;
  rootPath: string;
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

// Extract all image nodes from a frame recursively
function extractImageNodes(node: SceneNode, images: ImageInfo[]): void {
  if (!node.visible) {
    return;
  }

  if ('fills' in node && node.fills !== figma.mixed) {
    const fills = node.fills as readonly Paint[];
    fills.forEach((paint, index) => {
      if (paint.type === 'IMAGE' && paint.visible !== false) {
        images.push({
          id: node.id,
          nodeName: node.name,
          fillIndex: index
        });
      }
    });
  }

  if ('children' in node) {
    for (const child of node.children) {
      extractImageNodes(child, images);
    }
  }
}

function isNodeWithFills(node: SceneNode): node is SceneNode & MinimalFillsMixin {
  return 'fills' in node;
}

function buildSceneNodeMapping(original: SceneNode, cloned: SceneNode, mapping: Map<string, SceneNode>): void {
  mapping.set(original.id, cloned);

  if ('children' in original && 'children' in cloned) {
    const origChildren = original.children;
    const clonedChildren = cloned.children;

    for (let i = 0; i < origChildren.length && i < clonedChildren.length; i++) {
      buildSceneNodeMapping(origChildren[i], clonedChildren[i], mapping);
    }
  }
}

function normalizeImageNodeName(nodeName: string): string {
  return nodeName.trim().replace(/\s+\d+$/, '').trim();
}

function isLikelyLocalizedScreenshotName(normalizedNodeName: string): boolean {
  const value = normalizedNodeName.trim();
  if (value.length < 8) {
    return false;
  }

  // Real screenshot keys look like "iPhone 17-user_home_iPhone_17"
  // Generic layers such as "main" / "image 3" / labels should be skipped.
  return value.includes('_') && /[-–—]/.test(value);
}

function parseLocaleList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(item => item.length > 0);
}

function normalizeImageSourceBaseUrl(value: string): string {
  let normalized = value.trim();
  if (normalized.length === 0) {
    return '';
  }

  if (/^ttp:\/\//i.test(normalized) || /^ttps:\/\//i.test(normalized)) {
    normalized = `h${normalized}`;
  }

  if (!/^https?:\/\//i.test(normalized)) {
    normalized = `http://${normalized}`;
  }

  return normalized;
}

function isLikelyHttpUrl(value: string): boolean {
  return /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(value);
}

function parseImageSourceSettings(value: unknown): ImageSourceSettings {
  if (!value || typeof value !== 'object') {
    return { enabled: false, baseUrl: '', rootPath: '' };
  }

  const settings = value as Record<string, unknown>;
  const rawBaseUrl = typeof settings.baseUrl === 'string' ? settings.baseUrl : '';
  return {
    enabled: Boolean(settings.enabled),
    baseUrl: normalizeImageSourceBaseUrl(rawBaseUrl),
    rootPath: typeof settings.rootPath === 'string' ? settings.rootPath.trim() : ''
  };
}

async function fetchLocalizedImageHash(
  imageBaseUrl: string,
  locale: string,
  normalizedNodeName: string,
  rootPath: string,
  cache: Map<string, string>
): Promise<string | null> {
  const queryParts = [
    `locale=${encodeURIComponent(locale)}`,
    `nodeName=${encodeURIComponent(normalizedNodeName)}`
  ];
  if (rootPath.length > 0) {
    queryParts.push(`rootPath=${encodeURIComponent(rootPath)}`);
  }
  const separator = imageBaseUrl.includes('?') ? '&' : '?';
  const requestUrl = `${imageBaseUrl}${separator}${queryParts.join('&')}`;

  const cacheKey = requestUrl;
  const cachedHash = cache.get(cacheKey);
  if (cachedHash) {
    console.log(`[image] cache-hit locale=${locale} nodeName="${normalizedNodeName}" url=${cacheKey}`);
    return cachedHash;
  }

  let response;
  try {
    console.log(`[image] fetch-start locale=${locale} nodeName="${normalizedNodeName}" url=${cacheKey}`);
    response = await fetch(cacheKey);
  } catch (err) {
    console.warn(`Image fetch failed for ${cacheKey}:`, err);
    return null;
  }

  if (!response.ok) {
    console.warn(`[image] fetch-non-ok locale=${locale} nodeName="${normalizedNodeName}" status=${response.status} url=${cacheKey}`);
    return null;
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (err) {
    console.warn(`Failed to read image bytes for ${cacheKey}:`, err);
    return null;
  }

  if (bytes.byteLength === 0) {
    console.warn(`[image] empty-bytes locale=${locale} nodeName="${normalizedNodeName}" url=${cacheKey}`);
    return null;
  }

  try {
    const hash = figma.createImage(bytes).hash;
    cache.set(cacheKey, hash);
    console.log(`[image] fetch-success locale=${locale} nodeName="${normalizedNodeName}" bytes=${bytes.byteLength}`);
    return hash;
  } catch (err) {
    console.warn(`Failed to create Figma image for ${cacheKey}:`, err);
    return null;
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
      const savedImageSourceEnabled = await figma.clientStorage.getAsync(STORAGE_KEY_IMAGE_SOURCE_ENABLED);
      const savedImageSourceUrl = await figma.clientStorage.getAsync(STORAGE_KEY_IMAGE_SOURCE_URL);
      const savedImageSourceRootPath = await figma.clientStorage.getAsync(STORAGE_KEY_IMAGE_SOURCE_ROOT_PATH);

      figma.ui.postMessage({
        type: 'load-saved-settings',
        locales: savedLocales || null,
        prompt: savedPrompt || null,
        imageSourceEnabled: Boolean(savedImageSourceEnabled),
        imageSourceUrl: typeof savedImageSourceUrl === 'string' ? savedImageSourceUrl : '',
        imageSourceRootPath: typeof savedImageSourceRootPath === 'string' ? savedImageSourceRootPath : ''
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
    const images: ImageInfo[] = [];
    extractImageNodes(selectedNode, images);

    console.log(`Total text nodes found in "${selectedNode.name}":`, texts.length);
    if (texts.length > 0) {
      console.log('Sample extracted text:', texts.slice(0, 3).map(t => t.text));
    }
    console.log(`Total image nodes found in "${selectedNode.name}":`, images.length);

    if (texts.length === 0 && images.length === 0) {
      figma.ui.postMessage({
        type: 'prompt-error',
        message: 'No visible text or image nodes found in the selected frame'
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
    if (images.length > 0) {
      extractedData.images = images;
    }

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
      imageCount: images.length,
      extractedData: extractedData
    });

    figma.notify(`📋 Prompt copied! Found ${texts.length} text nodes and ${images.length} image nodes.`);
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

    const localizations = (msg.localizations && typeof msg.localizations === 'object' && !Array.isArray(msg.localizations))
      ? msg.localizations as Localizations
      : {};
    const requestedLocales = parseLocaleList(msg.locales);
    const imageSource = parseImageSourceSettings(msg.imageSource);
    const locales = requestedLocales.length > 0 ? requestedLocales : Object.keys(localizations);
    const hasAnyTextTranslations = locales.some(locale => Object.keys(localizations[locale] || {}).length > 0);

    if (locales.length === 0) {
      figma.ui.postMessage({
        type: 'apply-error',
        message: 'No target locales provided'
      });
      return;
    }

    if (!imageSource.enabled && !hasAnyTextTranslations) {
      figma.ui.postMessage({
        type: 'apply-error',
        message: 'No localizations found in the response'
      });
      return;
    }

    if (imageSource.enabled && imageSource.baseUrl.length === 0) {
      figma.ui.postMessage({
        type: 'apply-error',
        message: 'Image source URL is required when image replacement is enabled'
      });
      return;
    }

    if (imageSource.enabled && !isLikelyHttpUrl(imageSource.baseUrl)) {
      figma.ui.postMessage({
        type: 'apply-error',
        message: 'Image source URL is invalid. Use format like http://localhost:3000/image'
      });
      return;
    }

    // Get the frame dimensions for positioning
    const originalFrame = selectedNode;
    const frameHeight = originalFrame.height;
    const spacing = 40; // Gap between frames

    let createdCount = 0;
    let imageReplacedCount = 0;
    let imageSkippedCount = 0;
    let imageFailedCount = 0;
    const imageHashCache = new Map<string, string>();
    const sourceImages: ImageInfo[] = [];
    if (imageSource.enabled) {
      extractImageNodes(originalFrame, sourceImages);
      console.log('[image] apply-config', {
        baseUrl: imageSource.baseUrl,
        rootPath: imageSource.rootPath,
        sourceImageCount: sourceImages.length
      });
      console.log('[image] source-image-sample', sourceImages.slice(0, 8).map(img => ({
        id: img.id,
        nodeName: img.nodeName,
        normalizedNodeName: normalizeImageNodeName(img.nodeName),
        fillIndex: img.fillIndex
      })));
    }

    if (imageSource.enabled && sourceImages.length === 0 && !hasAnyTextTranslations) {
      figma.ui.postMessage({
        type: 'apply-error',
        message: 'No visible image nodes found to replace'
      });
      return;
    }

    console.log('Locales received:', locales);
    console.log('Total locales to process:', locales.length);

    for (let i = 0; i < locales.length; i++) {
      const locale = locales[i];
      const translations = localizations[locale] || {};

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
        const sceneNodeMapping = new Map<string, SceneNode>();
        buildSceneNodeMapping(originalFrame, clonedFrame, sceneNodeMapping);

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

        if (imageSource.enabled && sourceImages.length > 0) {
          console.log(`[image] locale-start locale=${locale} images=${sourceImages.length}`);
          let localeReplacedCount = 0;
          let localeSkippedCount = 0;
          let localeFailedCount = 0;

          for (const imageInfo of sourceImages) {
            const targetNode = sceneNodeMapping.get(imageInfo.id);
            if (!targetNode || !isNodeWithFills(targetNode) || targetNode.fills === figma.mixed) {
              console.log(`[image] skip locale=${locale} reason=node-missing-or-no-fills id=${imageInfo.id} nodeName="${imageInfo.nodeName}"`);
              imageSkippedCount++;
              localeSkippedCount++;
              continue;
            }

            const fills = [...targetNode.fills] as Paint[];
            if (imageInfo.fillIndex < 0 || imageInfo.fillIndex >= fills.length) {
              console.log(`[image] skip locale=${locale} reason=fill-index-out-of-range id=${imageInfo.id} fillIndex=${imageInfo.fillIndex} fills=${fills.length}`);
              imageSkippedCount++;
              localeSkippedCount++;
              continue;
            }

            const targetPaint = fills[imageInfo.fillIndex];
            if (targetPaint.type !== 'IMAGE') {
              console.log(`[image] skip locale=${locale} reason=target-paint-not-image id=${imageInfo.id} fillIndex=${imageInfo.fillIndex} type=${targetPaint.type}`);
              imageSkippedCount++;
              localeSkippedCount++;
              continue;
            }

            const normalizedNodeName = normalizeImageNodeName(imageInfo.nodeName);
            if (normalizedNodeName.length === 0) {
              console.log(`[image] skip locale=${locale} reason=empty-normalized-name id=${imageInfo.id} nodeName="${imageInfo.nodeName}"`);
              imageSkippedCount++;
              localeSkippedCount++;
              continue;
            }

            if (!isLikelyLocalizedScreenshotName(normalizedNodeName)) {
              console.log(`[image] skip locale=${locale} reason=non-screenshot-node id=${imageInfo.id} normalized="${normalizedNodeName}"`);
              imageSkippedCount++;
              localeSkippedCount++;
              continue;
            }

            console.log(`[image] replace-attempt locale=${locale} id=${imageInfo.id} nodeName="${imageInfo.nodeName}" normalized="${normalizedNodeName}" fillIndex=${imageInfo.fillIndex}`);
            const imageHash = await fetchLocalizedImageHash(
              imageSource.baseUrl,
              locale,
              normalizedNodeName,
              imageSource.rootPath,
              imageHashCache
            );

            if (!imageHash) {
              console.log(`[image] skip locale=${locale} reason=hash-not-found normalized="${normalizedNodeName}"`);
              imageSkippedCount++;
              localeSkippedCount++;
              continue;
            }

            try {
              fills[imageInfo.fillIndex] = {
                ...targetPaint,
                imageHash
              };
              targetNode.fills = fills;
              imageReplacedCount++;
              localeReplacedCount++;
              console.log(`[image] replace-success locale=${locale} id=${imageInfo.id} normalized="${normalizedNodeName}"`);
            } catch (imageErr) {
              console.warn(`Image replacement failed for ${locale}/${normalizedNodeName}:`, imageErr);
              imageFailedCount++;
              localeFailedCount++;
            }
          }
          console.log(`[image] locale-summary locale=${locale} replaced=${localeReplacedCount} skipped=${localeSkippedCount} failed=${localeFailedCount}`);
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
      frameCount: createdCount,
      imageReplacedCount: imageReplacedCount,
      imageSkippedCount: imageSkippedCount,
      imageFailedCount: imageFailedCount
    });

    figma.notify(`✨ Created ${createdCount} localized frames. Images: ${imageReplacedCount} replaced, ${imageSkippedCount} skipped, ${imageFailedCount} failed.`);
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

  // Save image source settings to clientStorage
  if (msg.type === 'save-image-source') {
    const imageSource = parseImageSourceSettings(msg.imageSource);
    try {
      await figma.clientStorage.setAsync(STORAGE_KEY_IMAGE_SOURCE_ENABLED, imageSource.enabled);
      await figma.clientStorage.setAsync(STORAGE_KEY_IMAGE_SOURCE_URL, imageSource.baseUrl);
      await figma.clientStorage.setAsync(STORAGE_KEY_IMAGE_SOURCE_ROOT_PATH, imageSource.rootPath);
    } catch (err) {
      console.warn('Failed to save image source settings:', err);
    }
  }
};
