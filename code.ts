// SmartLocal - Figma Localization Plugin
// Helps designers localize frames by generating AI-friendly prompts

// Storage keys for persisting user preferences
const STORAGE_KEY_LOCALES = 'smartlocal_locales';
const STORAGE_KEY_PROMPT = 'smartlocal_prompt';
const STORAGE_KEY_IMAGE_SOURCE_ENABLED = 'smartlocal_image_source_enabled';

const ALLOWED_IMAGE_EXTENSIONS = new Set<ImageCatalogExtension>(['png', 'jpg', 'jpeg', 'webp']);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_CATALOG_ENTRIES = 5000;
const BYTE_REQUEST_TIMEOUT_MS = 10000;
const IMAGE_ISSUE_CAP = 30;
const MIN_MATCH_SCORE = 0.6;
const AMBIGUOUS_MARGIN = 0.04;
const IMAGE_STOPWORDS = new Set(['img', 'image', 'screen', 'screenshot', 'copy', 'final', 'default']);
const IMAGE_DEBUG_ENABLED = true;

// Show the UI
figma.showUI(__html__, { width: 360, height: 620 });

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
    return;
  }

  figma.ui.postMessage({
    type: 'selection-changed',
    isValid: false,
    message: 'Selection is not a frame'
  });
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
}

interface ImageInfo {
  id: string;
  nodeName: string;
  fillIndex: number;
}

interface ExtractedData {
  texts: TextInfo[];
  targetLanguages: string[];
  images?: ImageInfo[];
}

interface Localizations {
  [locale: string]: {
    [nodeId: string]: string;
  };
}

type ImageSourceMode = 'folder';
type ImageCatalogExtension = 'png' | 'jpg' | 'jpeg' | 'webp';

interface ImageCatalogEntry {
  key: string;
  locale: string;
  relPath: string;
  stem: string;
  extension: ImageCatalogExtension;
  size: number;
}

interface FolderImageCatalog {
  version: 1;
  mode: ImageSourceMode;
  entries: ImageCatalogEntry[];
}

interface ImageSourceSettings {
  enabled: boolean;
  mode: ImageSourceMode | null;
  catalog: FolderImageCatalog | null;
}

interface MatchCandidateSummary {
  key: string;
  relPath: string;
  score: number;
}

type ImageIssueReason = 'no-candidate' | 'low-confidence' | 'ambiguous' | 'read-failed';

interface ImageIssue {
  locale: string;
  nodeId: string;
  nodeName: string;
  reason: ImageIssueReason;
  bestScore?: number;
  secondBestScore?: number;
  candidates?: MatchCandidateSummary[];
}

interface PendingByteRequest {
  resolve: (bytes: Uint8Array | null) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  fileKey: string;
}

interface RankedCandidate {
  entry: ImageCatalogEntry;
  score: number;
}

interface MatchDecision {
  status: 'matched' | 'no-candidate' | 'low-confidence' | 'ambiguous';
  best?: RankedCandidate;
  second?: RankedCandidate;
  topCandidates: RankedCandidate[];
}

const pendingByteRequests = new Map<string, PendingByteRequest>();

function imageDebug(message: string, payload?: unknown): void {
  if (!IMAGE_DEBUG_ENABLED) {
    return;
  }

  if (payload !== undefined) {
    console.log(`[smartlocal:image] ${message}`, payload);
    return;
  }

  console.log(`[smartlocal:image] ${message}`);
}

// Extract all text nodes from a frame recursively
function extractTextNodes(node: SceneNode, texts: TextInfo[]): void {
  if (node.type === 'TEXT') {
    const textNode = node;

    if (!textNode.visible) {
      return;
    }

    let lines = 1;
    try {
      const height = textNode.height;
      const fontSize = typeof textNode.fontSize === 'number' ? textNode.fontSize : 12;
      const lineHeight = fontSize * 1.4;
      lines = Math.max(1, Math.round(height / lineHeight));
    } catch {
      lines = 1;
    }

    texts.push({
      id: textNode.id,
      text: textNode.characters,
      charCount: textNode.characters.length,
      lines
    });
  }

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
    const fills = node.fills;
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

function parseLocaleList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(item => item.length > 0);
}

function parseImageSourceEnabled(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const settings = value as Record<string, unknown>;
  return Boolean(settings.enabled);
}

function parseImageCatalogExtension(value: unknown): ImageCatalogExtension | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase().replace(/^\./, '');
  if (normalized === 'png' || normalized === 'jpg' || normalized === 'jpeg' || normalized === 'webp') {
    return normalized;
  }

  return null;
}

function parseFolderImageCatalog(value: unknown): FolderImageCatalog | null {
  if (!value || typeof value !== 'object') {
    imageDebug('catalog-parse: invalid catalog payload');
    return null;
  }

  const catalogValue = value as Record<string, unknown>;
  if (catalogValue.version !== 1 || catalogValue.mode !== 'folder' || !Array.isArray(catalogValue.entries)) {
    imageDebug('catalog-parse: unsupported catalog shape', {
      version: catalogValue.version,
      mode: catalogValue.mode,
      entriesType: typeof catalogValue.entries
    });
    return null;
  }

  const entries: ImageCatalogEntry[] = [];
  const seenKeys = new Set<string>();

  for (const rawEntry of catalogValue.entries) {
    if (!rawEntry || typeof rawEntry !== 'object') {
      continue;
    }

    const entry = rawEntry as Record<string, unknown>;
    const key = typeof entry.key === 'string' ? entry.key.trim() : '';
    const locale = typeof entry.locale === 'string' ? entry.locale.trim() : '';
    const relPath = typeof entry.relPath === 'string' ? entry.relPath.trim() : '';
    const stem = typeof entry.stem === 'string' ? entry.stem.trim() : '';
    const extension = parseImageCatalogExtension(entry.extension);
    const size = typeof entry.size === 'number' && Number.isFinite(entry.size) ? Math.max(0, Math.round(entry.size)) : -1;

    if (!key || !locale || !relPath || !stem || !extension || size < 0) {
      continue;
    }

    if (seenKeys.has(key)) {
      continue;
    }

    seenKeys.add(key);
    entries.push({
      key,
      locale,
      relPath,
      stem,
      extension,
      size
    });
  }

  imageDebug('catalog-parse: parsed entries', {
    requestedEntries: catalogValue.entries.length,
    parsedEntries: entries.length
  });

  return {
    version: 1,
    mode: 'folder',
    entries
  };
}

function parseImageSourceSettings(value: unknown): ImageSourceSettings {
  if (!value || typeof value !== 'object') {
    imageDebug('image-source: missing settings object');
    return { enabled: false, mode: null, catalog: null };
  }

  const settings = value as Record<string, unknown>;
  const enabled = Boolean(settings.enabled);
  const mode = settings.mode === 'folder' ? 'folder' : null;
  const catalog = mode === 'folder' ? parseFolderImageCatalog(settings.catalog) : null;
  imageDebug('image-source: parsed settings', {
    enabled,
    mode,
    hasCatalog: Boolean(catalog),
    catalogEntries: catalog ? catalog.entries.length : 0
  });

  return {
    enabled,
    mode,
    catalog
  };
}

function normalizeImageName(value: string): string {
  return value
    .trim()
    .replace(/\s+\d+$/, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeCanonicalName(value: string): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(' ')
    .map(token => token.trim())
    .filter(token => token.length >= 2)
    .filter(token => !/^\d+$/.test(token))
    .filter(token => !IMAGE_STOPWORDS.has(token));
}

function computeTokenDiceScore(tokensA: string[], tokensB: string[]): number {
  if (tokensA.length === 0 || tokensB.length === 0) {
    return 0;
  }

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersectionCount = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersectionCount++;
    }
  }

  const denominator = setA.size + setB.size;
  if (denominator === 0) {
    return 0;
  }

  return (2 * intersectionCount) / denominator;
}

function buildBigramCounts(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  if (value.length === 0) {
    return counts;
  }

  if (value.length === 1) {
    counts.set(value, 1);
    return counts;
  }

  for (let i = 0; i < value.length - 1; i++) {
    const bigram = value.slice(i, i + 2);
    counts.set(bigram, (counts.get(bigram) || 0) + 1);
  }

  return counts;
}

function computeBigramDiceScore(valueA: string, valueB: string): number {
  if (!valueA || !valueB) {
    return 0;
  }

  const countsA = buildBigramCounts(valueA);
  const countsB = buildBigramCounts(valueB);

  let totalA = 0;
  for (const count of countsA.values()) {
    totalA += count;
  }

  let totalB = 0;
  for (const count of countsB.values()) {
    totalB += count;
  }

  if (totalA === 0 || totalB === 0) {
    return 0;
  }

  let intersection = 0;
  for (const [bigram, countA] of countsA.entries()) {
    const countB = countsB.get(bigram) || 0;
    intersection += Math.min(countA, countB);
  }

  return (2 * intersection) / (totalA + totalB);
}

function scoreImageNameMatch(nodeName: string, filenameStem: string): number {
  const canonicalNodeName = normalizeImageName(nodeName);
  const canonicalFilenameStem = normalizeImageName(filenameStem);

  if (!canonicalNodeName || !canonicalFilenameStem) {
    return 0;
  }

  if (canonicalNodeName === canonicalFilenameStem) {
    return 1;
  }

  const tokenDice = computeTokenDiceScore(
    tokenizeCanonicalName(canonicalNodeName),
    tokenizeCanonicalName(canonicalFilenameStem)
  );
  const charBigramDice = computeBigramDiceScore(canonicalNodeName, canonicalFilenameStem);
  const containsBoost =
    canonicalNodeName.includes(canonicalFilenameStem) || canonicalFilenameStem.includes(canonicalNodeName)
      ? 0.08
      : 0;

  return Math.min(1, (0.55 * tokenDice) + (0.45 * charBigramDice) + containsBoost);
}

function rankImageCandidates(nodeName: string, candidates: ImageCatalogEntry[]): RankedCandidate[] {
  return candidates
    .map(entry => ({
      entry,
      score: scoreImageNameMatch(nodeName, entry.stem)
    }))
    .sort((a, b) => b.score - a.score);
}

function decideImageCandidate(nodeName: string, candidates: ImageCatalogEntry[]): MatchDecision {
  if (candidates.length === 0) {
    return {
      status: 'no-candidate',
      topCandidates: []
    };
  }

  const rankedCandidates = rankImageCandidates(nodeName, candidates);
  const best = rankedCandidates[0];
  const second = rankedCandidates[1];

  if (!best) {
    return {
      status: 'no-candidate',
      topCandidates: []
    };
  }

  if (best.score < MIN_MATCH_SCORE) {
    return {
      status: 'low-confidence',
      best,
      second,
      topCandidates: rankedCandidates.slice(0, 3)
    };
  }

  if (second && (best.score - second.score) < AMBIGUOUS_MARGIN) {
    return {
      status: 'ambiguous',
      best,
      second,
      topCandidates: rankedCandidates.slice(0, 3)
    };
  }

  return {
    status: 'matched',
    best,
    second,
    topCandidates: rankedCandidates.slice(0, 3)
  };
}

function summarizeCandidates(candidates: RankedCandidate[]): MatchCandidateSummary[] {
  return candidates.map(candidate => ({
    key: candidate.entry.key,
    relPath: candidate.entry.relPath,
    score: Number(candidate.score.toFixed(3))
  }));
}

function addImageIssue(imageIssues: ImageIssue[], issue: ImageIssue): void {
  if (imageIssues.length < IMAGE_ISSUE_CAP) {
    imageIssues.push(issue);
  }
}

function parseUint8Array(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (Array.isArray(value)) {
    const numbers = value.filter((item): item is number => typeof item === 'number');
    if (numbers.length !== value.length) {
      return null;
    }

    return Uint8Array.from(numbers);
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const rawLength = record.length;
    if (typeof rawLength === 'number' && Number.isInteger(rawLength) && rawLength >= 0) {
      const bytes = new Uint8Array(rawLength);
      for (let i = 0; i < rawLength; i++) {
        const item = record[String(i)];
        if (typeof item !== 'number') {
          return null;
        }
        bytes[i] = item;
      }
      return bytes;
    }
  }

  return null;
}

function createByteRequestId(): string {
  return `${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

function handleImageBytesResponse(msg: Record<string, unknown>): void {
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
  if (!requestId) {
    imageDebug('bytes-response: missing requestId');
    return;
  }

  const pendingRequest = pendingByteRequests.get(requestId);
  if (!pendingRequest) {
    imageDebug('bytes-response: no pending request', { requestId });
    return;
  }

  pendingByteRequests.delete(requestId);
  clearTimeout(pendingRequest.timeoutId);

  const ok = Boolean(msg.ok);
  if (!ok) {
    imageDebug('bytes-response: failed', {
      requestId,
      fileKey: pendingRequest.fileKey,
      error: typeof msg.error === 'string' ? msg.error : 'unknown'
    });
    pendingRequest.resolve(null);
    return;
  }

  const bytes = parseUint8Array(msg.bytes);
  if (!bytes || bytes.byteLength === 0) {
    imageDebug('bytes-response: empty-bytes', {
      requestId,
      fileKey: pendingRequest.fileKey
    });
    pendingRequest.resolve(null);
    return;
  }

  imageDebug('bytes-response: ok', {
    requestId,
    fileKey: pendingRequest.fileKey,
    byteLength: bytes.byteLength
  });

  pendingRequest.resolve(bytes);
}

function requestImageBytesFromUi(fileKey: string): Promise<Uint8Array | null> {
  const requestId = createByteRequestId();
  imageDebug('bytes-request: send', { requestId, fileKey });

  return new Promise(resolve => {
    const timeoutId = setTimeout(() => {
      pendingByteRequests.delete(requestId);
      imageDebug('bytes-request: timeout', { requestId, fileKey, timeoutMs: BYTE_REQUEST_TIMEOUT_MS });
      resolve(null);
    }, BYTE_REQUEST_TIMEOUT_MS);

    pendingByteRequests.set(requestId, {
      resolve,
      timeoutId,
      fileKey
    });

    figma.ui.postMessage({
      type: 'request-image-bytes',
      requestId,
      fileKey
    });
  });
}

function getLocaleCatalog(catalog: FolderImageCatalog): Map<string, ImageCatalogEntry[]> {
  const byLocale = new Map<string, ImageCatalogEntry[]>();

  for (const entry of catalog.entries) {
    if (!ALLOWED_IMAGE_EXTENSIONS.has(entry.extension)) {
      continue;
    }

    if (entry.size > MAX_IMAGE_BYTES) {
      continue;
    }

    const localeEntries = byLocale.get(entry.locale) || [];
    localeEntries.push(entry);
    byLocale.set(entry.locale, localeEntries);
  }

  imageDebug('catalog-index: built', {
    totalEntries: catalog.entries.length,
    localeCount: byLocale.size,
    locales: Array.from(byLocale.keys()).slice(0, 20)
  });

  return byLocale;
}

function getLanguageBase(locale: string): string {
  const normalized = locale.trim().toLowerCase();
  if (!normalized) {
    return '';
  }

  const [base] = normalized.split('-');
  return base || normalized;
}

function getCandidatesForLocale(
  localeCatalog: Map<string, ImageCatalogEntry[]>,
  locale: string
): ImageCatalogEntry[] {
  const exact = localeCatalog.get(locale);
  if (exact && exact.length > 0) {
    imageDebug('locale-candidates: exact', { locale, candidateCount: exact.length });
    return exact;
  }

  const normalizedLocale = locale.trim().toLowerCase();
  if (!normalizedLocale) {
    return [];
  }

  for (const [catalogLocale, entries] of localeCatalog.entries()) {
    if (catalogLocale.trim().toLowerCase() === normalizedLocale) {
      imageDebug('locale-candidates: case-insensitive exact', {
        locale,
        matchedLocale: catalogLocale,
        candidateCount: entries.length
      });
      return entries;
    }
  }

  const localeBase = getLanguageBase(locale);
  const fallback: ImageCatalogEntry[] = [];
  for (const [catalogLocale, entries] of localeCatalog.entries()) {
    if (getLanguageBase(catalogLocale) === localeBase) {
      fallback.push(...entries);
    }
  }

  imageDebug('locale-candidates: language-base fallback', {
    locale,
    localeBase,
    candidateCount: fallback.length
  });

  return fallback;
}

// Handle messages from UI
figma.ui.onmessage = async (msg: { type: string;[key: string]: unknown }) => {
  if (msg.type === 'image-bytes-response') {
    handleImageBytesResponse(msg as Record<string, unknown>);
    return;
  }

  // UI Ready - Load saved settings and check initial selection
  if (msg.type === 'ui-ready') {
    try {
      const savedLocales = await figma.clientStorage.getAsync(STORAGE_KEY_LOCALES);
      const savedPrompt = await figma.clientStorage.getAsync(STORAGE_KEY_PROMPT);
      const savedImageSourceEnabled = await figma.clientStorage.getAsync(STORAGE_KEY_IMAGE_SOURCE_ENABLED);

      figma.ui.postMessage({
        type: 'load-saved-settings',
        locales: savedLocales || null,
        prompt: savedPrompt || null,
        imageSourceEnabled: Boolean(savedImageSourceEnabled)
      });
    } catch (err) {
      console.warn('Failed to load saved settings:', err);
    }

    checkSelection();
    return;
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

    const texts: TextInfo[] = [];
    extractTextNodes(selectedNode, texts);
    const images: ImageInfo[] = [];
    extractImageNodes(selectedNode, images);

    if (texts.length === 0 && images.length === 0) {
      figma.ui.postMessage({
        type: 'prompt-error',
        message: 'No visible text or image nodes found in the selected frame'
      });
      return;
    }

    const languages = msg.languages as string[];
    const promptTemplate = msg.promptTemplate as string;

    const extractedData: ExtractedData = {
      texts,
      targetLanguages: languages
    };
    if (images.length > 0) {
      extractedData.images = images;
    }

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

    figma.ui.postMessage({
      type: 'copy-to-clipboard',
      text: fullPrompt
    });

    figma.ui.postMessage({
      type: 'prompt-generated',
      textCount: texts.length,
      imageCount: images.length,
      extractedData
    });

    figma.notify(`📋 Prompt copied! Found ${texts.length} text nodes and ${images.length} image nodes.`);
    return;
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
    imageDebug('apply-start', {
      locales,
      imageSourceEnabled: imageSource.enabled,
      hasAnyTextTranslations
    });

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

    if (imageSource.enabled && (imageSource.mode !== 'folder' || !imageSource.catalog)) {
      figma.ui.postMessage({
        type: 'apply-error',
        message: 'Choose a localized assets folder before applying image replacement'
      });
      return;
    }

    if (imageSource.enabled && imageSource.catalog && imageSource.catalog.entries.length > MAX_CATALOG_ENTRIES) {
      figma.ui.postMessage({
        type: 'apply-error',
        message: `Image catalog exceeds limit (${MAX_CATALOG_ENTRIES}). Reduce files and try again.`
      });
      return;
    }

    const originalFrame = selectedNode;
    const frameHeight = originalFrame.height;
    const spacing = 40;

    let createdCount = 0;
    let imageReplacedCount = 0;
    let imageSkippedCount = 0;
    let imageAmbiguousCount = 0;
    let imageFailedCount = 0;
    const imageIssues: ImageIssue[] = [];

    const imageHashCache = new Map<string, string>();
    const sourceImages: ImageInfo[] = [];
    const localeCatalog = imageSource.catalog ? getLocaleCatalog(imageSource.catalog) : new Map<string, ImageCatalogEntry[]>();

    if (imageSource.enabled) {
      extractImageNodes(originalFrame, sourceImages);
      imageDebug('apply-source-images', {
        sourceImageCount: sourceImages.length,
        sample: sourceImages.slice(0, 6)
      });
    }

    if (imageSource.enabled && sourceImages.length === 0 && !hasAnyTextTranslations) {
      figma.ui.postMessage({
        type: 'apply-error',
        message: 'No visible image nodes found to replace'
      });
      return;
    }

    for (let i = 0; i < locales.length; i++) {
      const locale = locales[i];
      const translations = localizations[locale] || {};
      imageDebug('locale-start', {
        locale,
        localeIndex: i + 1,
        totalLocales: locales.length,
        translationCount: Object.keys(translations).length
      });

      try {
        const clonedFrame = originalFrame.clone();
        clonedFrame.name = `${originalFrame.name}_${locale}`;
        clonedFrame.y = originalFrame.y + (i + 1) * (frameHeight + spacing);

        const nodeMapping = new Map<string, TextNode>();
        buildNodeMapping(originalFrame, clonedFrame, nodeMapping);
        const sceneNodeMapping = new Map<string, SceneNode>();
        buildSceneNodeMapping(originalFrame, clonedFrame, sceneNodeMapping);

        // Load fonts for all translated text nodes first.
        for (const [originalId] of Object.entries(translations)) {
          const textNode = nodeMapping.get(originalId);
          if (!textNode || textNode.characters.length === 0) {
            continue;
          }

          try {
            const fontName = textNode.fontName;
            if (fontName !== figma.mixed) {
              await figma.loadFontAsync(fontName);
            } else {
              const fontNames = textNode.getRangeAllFontNames(0, textNode.characters.length);
              for (const fn of fontNames) {
                await figma.loadFontAsync(fn);
              }
            }
          } catch (fontErr) {
            console.warn(`Font loading error for ${originalId}:`, fontErr);
          }
        }

        for (const [originalId, translatedText] of Object.entries(translations)) {
          const textNode = nodeMapping.get(originalId);
          if (!textNode) {
            continue;
          }

          try {
            const segments = textNode.getStyledTextSegments([
              'fontName',
              'fontSize',
              'fills',
              'lineHeight',
              'letterSpacing',
              'textDecoration',
              'textCase'
            ]);

            if (segments.length === 0) {
              textNode.characters = translatedText;
              continue;
            }

            let dominantSegment = segments[0];
            let maxLen = 0;
            for (const segment of segments) {
              const len = segment.end - segment.start;
              if (len > maxLen) {
                maxLen = len;
                dominantSegment = segment;
              }
            }

            await figma.loadFontAsync(dominantSegment.fontName);

            textNode.characters = translatedText;

            textNode.fontSize = dominantSegment.fontSize;
            textNode.fontName = dominantSegment.fontName;
            textNode.fills = dominantSegment.fills;
            textNode.lineHeight = dominantSegment.lineHeight;
            textNode.letterSpacing = dominantSegment.letterSpacing;
            textNode.textDecoration = dominantSegment.textDecoration;
            textNode.textCase = dominantSegment.textCase;
          } catch (textErr) {
            console.warn(`Text replacement error for ${originalId}:`, textErr);
          }
        }

        if (imageSource.enabled && sourceImages.length > 0) {
          const localeCandidates = getCandidatesForLocale(localeCatalog, locale);
          imageDebug('locale-candidate-pool', {
            locale,
            candidateCount: localeCandidates.length
          });

          for (const imageInfo of sourceImages) {
            imageDebug('node-eval-start', {
              locale,
              nodeId: imageInfo.id,
              nodeName: imageInfo.nodeName,
              fillIndex: imageInfo.fillIndex
            });
            const targetNode = sceneNodeMapping.get(imageInfo.id);
            if (!targetNode || !isNodeWithFills(targetNode) || targetNode.fills === figma.mixed) {
              imageSkippedCount++;
              imageDebug('node-skip:no-target-or-fills', {
                locale,
                nodeId: imageInfo.id,
                nodeName: imageInfo.nodeName
              });
              addImageIssue(imageIssues, {
                locale,
                nodeId: imageInfo.id,
                nodeName: imageInfo.nodeName,
                reason: 'no-candidate'
              });
              continue;
            }

            const fills = [...targetNode.fills] as Paint[];
            if (imageInfo.fillIndex < 0 || imageInfo.fillIndex >= fills.length) {
              imageSkippedCount++;
              imageDebug('node-skip:fill-index-out-of-range', {
                locale,
                nodeId: imageInfo.id,
                fillIndex: imageInfo.fillIndex,
                fillCount: fills.length
              });
              addImageIssue(imageIssues, {
                locale,
                nodeId: imageInfo.id,
                nodeName: imageInfo.nodeName,
                reason: 'no-candidate'
              });
              continue;
            }

            const targetPaint = fills[imageInfo.fillIndex];
            if (targetPaint.type !== 'IMAGE') {
              imageSkippedCount++;
              imageDebug('node-skip:paint-not-image', {
                locale,
                nodeId: imageInfo.id,
                paintType: targetPaint.type
              });
              addImageIssue(imageIssues, {
                locale,
                nodeId: imageInfo.id,
                nodeName: imageInfo.nodeName,
                reason: 'no-candidate'
              });
              continue;
            }

            const normalizedNodeName = normalizeImageName(imageInfo.nodeName);
            const matchDecision = decideImageCandidate(normalizedNodeName, localeCandidates);
            imageDebug('node-match-decision', {
              locale,
              nodeId: imageInfo.id,
              nodeName: imageInfo.nodeName,
              normalizedNodeName,
              status: matchDecision.status,
              bestScore: matchDecision.best ? Number(matchDecision.best.score.toFixed(3)) : null,
              secondScore: matchDecision.second ? Number(matchDecision.second.score.toFixed(3)) : null,
              topCandidates: summarizeCandidates(matchDecision.topCandidates)
            });

            if (matchDecision.status === 'no-candidate') {
              imageSkippedCount++;
              addImageIssue(imageIssues, {
                locale,
                nodeId: imageInfo.id,
                nodeName: imageInfo.nodeName,
                reason: 'no-candidate'
              });
              continue;
            }

            if (matchDecision.status === 'low-confidence') {
              imageSkippedCount++;
              addImageIssue(imageIssues, {
                locale,
                nodeId: imageInfo.id,
                nodeName: imageInfo.nodeName,
                reason: 'low-confidence',
                bestScore: matchDecision.best ? Number(matchDecision.best.score.toFixed(3)) : undefined,
                secondBestScore: matchDecision.second ? Number(matchDecision.second.score.toFixed(3)) : undefined,
                candidates: summarizeCandidates(matchDecision.topCandidates)
              });
              continue;
            }

            if (matchDecision.status === 'ambiguous') {
              imageSkippedCount++;
              imageAmbiguousCount++;
              addImageIssue(imageIssues, {
                locale,
                nodeId: imageInfo.id,
                nodeName: imageInfo.nodeName,
                reason: 'ambiguous',
                bestScore: matchDecision.best ? Number(matchDecision.best.score.toFixed(3)) : undefined,
                secondBestScore: matchDecision.second ? Number(matchDecision.second.score.toFixed(3)) : undefined,
                candidates: summarizeCandidates(matchDecision.topCandidates)
              });
              continue;
            }

            const matchedEntry = matchDecision.best?.entry;
            if (!matchedEntry) {
              imageSkippedCount++;
              addImageIssue(imageIssues, {
                locale,
                nodeId: imageInfo.id,
                nodeName: imageInfo.nodeName,
                reason: 'no-candidate'
              });
              continue;
            }

            let imageHash = imageHashCache.get(matchedEntry.key);
            const matchedBestScore = matchDecision.best ? Number(matchDecision.best.score.toFixed(3)) : undefined;
            if (!imageHash) {
              imageDebug('node-match:selected', {
                locale,
                nodeId: imageInfo.id,
                fileKey: matchedEntry.key,
                relPath: matchedEntry.relPath,
                score: matchedBestScore
              });
              const bytes = await requestImageBytesFromUi(matchedEntry.key);
              if (!bytes || bytes.byteLength === 0) {
                imageFailedCount++;
                imageDebug('node-fail:bytes-missing', {
                  locale,
                  nodeId: imageInfo.id,
                  fileKey: matchedEntry.key
                });
                addImageIssue(imageIssues, {
                  locale,
                  nodeId: imageInfo.id,
                  nodeName: imageInfo.nodeName,
                  reason: 'read-failed',
                  bestScore: matchedBestScore,
                  secondBestScore: matchDecision.second ? Number(matchDecision.second.score.toFixed(3)) : undefined,
                  candidates: summarizeCandidates(matchDecision.topCandidates)
                });
                continue;
              }

              try {
                imageHash = figma.createImage(bytes).hash;
                imageHashCache.set(matchedEntry.key, imageHash);
                imageDebug('image-cache:set', {
                  fileKey: matchedEntry.key,
                  hash: imageHash
                });
              } catch (imageErr) {
                console.warn(`Failed to create image for file key ${matchedEntry.key}:`, imageErr);
                imageFailedCount++;
                addImageIssue(imageIssues, {
                  locale,
                  nodeId: imageInfo.id,
                  nodeName: imageInfo.nodeName,
                  reason: 'read-failed',
                  bestScore: matchedBestScore,
                  secondBestScore: matchDecision.second ? Number(matchDecision.second.score.toFixed(3)) : undefined,
                  candidates: summarizeCandidates(matchDecision.topCandidates)
                });
                continue;
              }
            }

            try {
              fills[imageInfo.fillIndex] = {
                ...targetPaint,
                imageHash
              };
              targetNode.fills = fills;
              imageReplacedCount++;
              imageDebug('node-replace:success', {
                locale,
                nodeId: imageInfo.id,
                nodeName: imageInfo.nodeName,
                fileKey: matchedEntry.key
              });
            } catch (imageErr) {
              console.warn(`Image replacement failed for ${locale}/${imageInfo.nodeName}:`, imageErr);
              imageFailedCount++;
              addImageIssue(imageIssues, {
                locale,
                nodeId: imageInfo.id,
                nodeName: imageInfo.nodeName,
                reason: 'read-failed',
                bestScore: matchedBestScore,
                secondBestScore: matchDecision.second ? Number(matchDecision.second.score.toFixed(3)) : undefined,
                candidates: summarizeCandidates(matchDecision.topCandidates)
              });
            }
          }
        }

        createdCount++;
        imageDebug('locale-complete', {
          locale,
          createdCountSoFar: createdCount,
          replaced: imageReplacedCount,
          skipped: imageSkippedCount,
          ambiguous: imageAmbiguousCount,
          failed: imageFailedCount
        });
      } catch (localeErr) {
        console.error(`Failed to process locale ${locale}:`, localeErr);
      }
    }

    imageDebug('apply-complete', {
      frameCount: createdCount,
      imageReplacedCount,
      imageSkippedCount,
      imageAmbiguousCount,
      imageFailedCount,
      issueCount: imageIssues.length
    });

    figma.ui.postMessage({
      type: 'apply-success',
      frameCount: createdCount,
      imageReplacedCount,
      imageSkippedCount,
      imageAmbiguousCount,
      imageFailedCount,
      imageIssues
    });

    figma.notify(
      `✨ Created ${createdCount} localized frames. Images: ${imageReplacedCount} replaced, ${imageSkippedCount} skipped, ${imageAmbiguousCount} ambiguous, ${imageFailedCount} failed.`
    );
    return;
  }

  // Save locales to clientStorage
  if (msg.type === 'save-locales') {
    try {
      await figma.clientStorage.setAsync(STORAGE_KEY_LOCALES, msg.locales as string);
    } catch (err) {
      console.warn('Failed to save locales:', err);
    }
    return;
  }

  // Save prompt to clientStorage
  if (msg.type === 'save-prompt') {
    try {
      await figma.clientStorage.setAsync(STORAGE_KEY_PROMPT, msg.prompt as string);
    } catch (err) {
      console.warn('Failed to save prompt:', err);
    }
    return;
  }

  // Save image source enabled state to clientStorage
  if (msg.type === 'save-image-source') {
    try {
      const enabled = parseImageSourceEnabled(msg.imageSource);
      await figma.clientStorage.setAsync(STORAGE_KEY_IMAGE_SOURCE_ENABLED, enabled);
    } catch (err) {
      console.warn('Failed to save image source settings:', err);
    }
  }
};
