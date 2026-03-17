// SmartLocal - Figma Localization Plugin
// Helps designers localize frames by generating AI-friendly prompts

// Storage keys for persisting user preferences
const STORAGE_KEY_LOCALES = 'smartlocal_locales';
const STORAGE_KEY_PROMPT = 'smartlocal_prompt';
const STORAGE_KEY_IMAGE_SOURCE_ENABLED = 'smartlocal_image_source_enabled';
const PLUGIN_DATA_SOURCE_NODE_ID = 'smartlocal_source_node_id';
const PLUGIN_DATA_SOURCE_FRAME_ID = 'smartlocal_source_frame_id';
const PLUGIN_DATA_LOCALE = 'smartlocal_locale';

const ALLOWED_IMAGE_EXTENSIONS = new Set<ImageCatalogExtension>(['png', 'jpg', 'jpeg', 'webp']);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_CATALOG_ENTRIES = 5000;
const BYTE_REQUEST_TIMEOUT_MS = 10000;
const IMAGE_ISSUE_CAP = 30;
const MIN_MATCH_SCORE = 0.6;
const AMBIGUOUS_MARGIN = 0.04;
const IMAGE_STOPWORDS = new Set(['img', 'image', 'screen', 'screenshot', 'copy', 'final', 'default']);
/** Set to true for development debugging. Disable in production to reduce console noise. */
const IMAGE_DEBUG_ENABLED = false;
const APPLY_YIELD_INTERVAL = 25;
const TEXT_APPLY_YIELD_INTERVAL = 50;

// Show the UI
figma.showUI(__html__, { width: 360, height: 620 });

// This avoids traversing hidden instance subtrees during node queries.
const pluginApiWithSkipInvisible = figma as PluginAPI & { skipInvisibleInstanceChildren?: boolean };
if (typeof pluginApiWithSkipInvisible.skipInvisibleInstanceChildren === 'boolean') {
  pluginApiWithSkipInvisible.skipInvisibleInstanceChildren = true;
}

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
      nodeName: node.name,
      selectionId: node.id
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
  boxWidthPx: number;
  containerWidthPx: number;
}

interface ImageInfo {
  id: string;
  nodeName: string;
  normalizedNodeName: string;
  fillIndex: number;
}

interface ExtractedData {
  texts: TextInfo[];
  targetLanguages: string[];
}

interface ArchivedFrameContent {
  frameId: string;
  frameName: string;
  framePath: string;
  textCount: number;
  input: ExtractedData;
}

interface ArchiveExportData {
  generatedAt: string;
  page: {
    id: string;
    name: string;
  };
  targetLanguages: string[];
  frameCount: number;
  totalTextCount: number;
  combinedInput: ExtractedData;
  frames: ArchivedFrameContent[];
}

interface Localizations {
  [locale: string]: {
    [nodeId: string]: string;
  };
}

type LocalizableContainerNode = FrameNode | ComponentNode | InstanceNode;

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

type Severity = 'error' | 'warning';
type LocaleMode = 'create' | 'update';
type ApplyOutcomeStatus = 'success' | 'partial' | 'failed';
type VariantResolutionMode = 'tagged';

interface MessageIssue {
  code: string;
  message: string;
  severity: Severity;
}

interface LocalePlan {
  locale: string;
  mode: LocaleMode;
  existingNode: LocalizableContainerNode | null;
  translations: Record<string, string>;
  translationCount: number;
  missingTextIds: string[];
  unknownTextIds: string[];
  canApply: boolean;
  issues: MessageIssue[];
  willApplyImages: boolean;
}

interface LocaleValidationSummary {
  locale: string;
  mode: LocaleMode;
  translationCount: number;
  missingTextIds: string[];
  unknownTextIds: string[];
  canApply: boolean;
  issues: MessageIssue[];
  willApplyImages: boolean;
}

interface ValidationSummary {
  sourceTextCount: number;
  sourceImageCount: number;
  localeCount: number;
  responseLocaleCount: number;
  creatableCount: number;
  updatableCount: number;
  blockedCount: number;
  warningCount: number;
  imageSourceEnabled: boolean;
}

interface ValidationResultPayload {
  selectionName: string;
  requestedLocales: string[];
  responseLocales: string[];
  canApply: boolean;
  partialIssues: boolean;
  summary: ValidationSummary;
  locales: LocaleValidationSummary[];
}

interface VariantResolution {
  mode: VariantResolutionMode;
  nodeMapping: Map<string, TextNode>;
  sceneNodeMapping: Map<string, SceneNode>;
}

interface LocaleApplyOutcome {
  locale: string;
  mode: LocaleMode;
  status: ApplyOutcomeStatus;
  textAppliedCount: number;
  textFailedCount: number;
  imageReplacedCount: number;
  imageSkippedCount: number;
  imageAmbiguousCount: number;
  imageFailedCount: number;
  issues: MessageIssue[];
}

interface ApplyResultPayload {
  status: 'success' | 'partial';
  partialSuccess: boolean;
  createdCount: number;
  updatedCount: number;
  imageReplacedCount: number;
  imageSkippedCount: number;
  imageAmbiguousCount: number;
  imageFailedCount: number;
  localeOutcomes: LocaleApplyOutcome[];
  imageIssues: ImageIssue[];
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

interface BigramProfile {
  counts: Map<string, number>;
  total: number;
}

interface CanonicalNameProfile {
  canonical: string;
  tokens: Set<string>;
  bigrams: BigramProfile;
}

interface PreparedImageCatalogEntry {
  entry: ImageCatalogEntry;
  profile: CanonicalNameProfile;
  stableIndex: number;
}

interface MatchDecision {
  status: 'matched' | 'no-candidate' | 'low-confidence' | 'ambiguous';
  best?: RankedCandidate;
  second?: RankedCandidate;
  topCandidates: RankedCandidate[];
}

const pendingByteRequests = new Map<string, PendingByteRequest>();
const loadedFonts = new Set<string>();
let applyInFlight = false;

function getFontKey(fontName: FontName): string {
  return `${fontName.family}::${fontName.style}`;
}

async function loadFontOnce(fontName: FontName): Promise<void> {
  const key = getFontKey(fontName);
  if (loadedFonts.has(key)) {
    return;
  }
  await figma.loadFontAsync(fontName);
  loadedFonts.add(key);
}

async function yieldToMainThread(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

async function yieldIfNeeded(counter: number, everyN: number): Promise<void> {
  if (counter > 0 && counter % everyN === 0) {
    await yieldToMainThread();
  }
}

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

function hasWidth(node: BaseNode | null): node is BaseNode & { width: number } {
  return Boolean(node && 'width' in node && typeof (node as { width?: unknown }).width === 'number');
}

function getRoundedWidthPx(node: BaseNode | null): number | null {
  if (!hasWidth(node)) {
    return null;
  }

  const rounded = Math.round(node.width);
  if (!Number.isFinite(rounded)) {
    return null;
  }

  return Math.max(1, rounded);
}

function getContainerWidthPx(textNode: TextNode): number {
  let parent: BaseNode | null = textNode.parent;

  while (parent) {
    const width = getRoundedWidthPx(parent);
    if (width !== null) {
      return width;
    }
    parent = parent.parent;
  }

  return getRoundedWidthPx(textNode) ?? 1;
}

/**
 * Recursively extracts visible text nodes from a frame/component, including
 * charCount, lines, boxWidthPx, and containerWidthPx for AI localization context.
 */
function extractTextNodes(node: SceneNode, texts: TextInfo[]): void {
  const textNodes = 'findAllWithCriteria' in node
    ? node.findAllWithCriteria({ types: ['TEXT'] })
    : (node.type === 'TEXT' ? [node] : []);

  for (const textNode of textNodes) {
    if (!textNode.visible) {
      continue;
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
      lines,
      boxWidthPx: getRoundedWidthPx(textNode) ?? 1,
      containerWidthPx: getContainerWidthPx(textNode)
    });
  }
}

/**
 * Recursively extracts image fill nodes from a frame for optional localized image replacement.
 */
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
          normalizedNodeName: normalizeImageName(node.name),
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

function trySetNodePluginData(node: SceneNode, key: string, value: string): void {
  try {
    node.setPluginData(key, value);
  } catch (err) {
    console.warn(`Failed to set plugin data ${key} on node ${node.id}:`, err);
  }
}

function setLocalizedNodeMetadata(
  original: SceneNode,
  target: SceneNode,
  locale: string,
  sourceFrameId: string,
  isRoot: boolean
): void {
  trySetNodePluginData(target, PLUGIN_DATA_SOURCE_NODE_ID, original.id);

  if (isRoot) {
    trySetNodePluginData(target, PLUGIN_DATA_SOURCE_FRAME_ID, sourceFrameId);
    trySetNodePluginData(target, PLUGIN_DATA_LOCALE, locale);
  }

  if ('children' in original && 'children' in target) {
    const origChildren = original.children;
    const targetChildren = target.children;

    for (let i = 0; i < origChildren.length && i < targetChildren.length; i++) {
      setLocalizedNodeMetadata(origChildren[i], targetChildren[i], locale, sourceFrameId, false);
    }
  }
}

function hasStoredVariantMetadata(node: LocalizableContainerNode, originalFrameId: string, locale: string): boolean {
  return node.getPluginData(PLUGIN_DATA_SOURCE_FRAME_ID) === originalFrameId
    && node.getPluginData(PLUGIN_DATA_LOCALE) === locale;
}

function hasTaggedDescendants(node: SceneNode): boolean {
  if (node.getPluginData(PLUGIN_DATA_SOURCE_NODE_ID)) {
    return true;
  }

  if ('children' in node) {
    for (const child of node.children) {
      if (hasTaggedDescendants(child)) {
        return true;
      }
    }
  }

  return false;
}

function _hasExactLegacyTreeMatch(original: SceneNode, candidate: SceneNode, allowRootNameMismatch = false): boolean {
  if (original.type !== candidate.type) {
    return false;
  }

  if (!allowRootNameMismatch && original.type !== 'TEXT' && original.name !== candidate.name) {
    return false;
  }

  if ('children' in original !== 'children' in candidate) {
    return false;
  }

  if ('children' in original && 'children' in candidate) {
    if (original.children.length !== candidate.children.length) {
      return false;
    }

    for (let i = 0; i < original.children.length; i++) {
      if (!_hasExactLegacyTreeMatch(original.children[i], candidate.children[i], false)) {
        return false;
      }
    }
  }

  return true;
}

function buildTaggedTextNodeMapping(node: SceneNode, mapping: Map<string, TextNode>, duplicates: Set<string>): void {
  const sourceNodeId = node.getPluginData(PLUGIN_DATA_SOURCE_NODE_ID);
  if (sourceNodeId && node.type === 'TEXT') {
    if (mapping.has(sourceNodeId)) {
      duplicates.add(sourceNodeId);
    } else {
      mapping.set(sourceNodeId, node);
    }
  }

  if ('children' in node) {
    for (const child of node.children) {
      buildTaggedTextNodeMapping(child, mapping, duplicates);
    }
  }
}

function buildTaggedSceneNodeMapping(node: SceneNode, mapping: Map<string, SceneNode>, duplicates: Set<string>): void {
  const sourceNodeId = node.getPluginData(PLUGIN_DATA_SOURCE_NODE_ID);
  if (sourceNodeId) {
    if (mapping.has(sourceNodeId)) {
      duplicates.add(sourceNodeId);
    } else {
      mapping.set(sourceNodeId, node);
    }
  }

  if ('children' in node) {
    for (const child of node.children) {
      buildTaggedSceneNodeMapping(child, mapping, duplicates);
    }
  }
}

function resolveVariantMappings(
  originalFrame: LocalizableContainerNode,
  targetFrame: LocalizableContainerNode,
  locale: string
): { ok: true; resolution: VariantResolution } | { ok: false; message: string } {
  const hasMetadata = hasStoredVariantMetadata(targetFrame, originalFrame.id, locale) || hasTaggedDescendants(targetFrame);

  if (!hasMetadata) {
    return {
      ok: false,
      message: `Existing ${locale} variant is not tagged with SmartLocal metadata and cannot be updated safely. Recreate or migrate it manually.`
    };
  }

  const nodeMapping = new Map<string, TextNode>();
  const sceneNodeMapping = new Map<string, SceneNode>();
  const duplicates = new Set<string>();

  buildTaggedTextNodeMapping(targetFrame, nodeMapping, duplicates);
  buildTaggedSceneNodeMapping(targetFrame, sceneNodeMapping, duplicates);

  if (duplicates.size > 0) {
    return {
      ok: false,
      message: `Existing ${locale} variant has duplicate SmartLocal metadata and cannot be updated safely. Recreate the variant.`
    };
  }

  return {
    ok: true,
    resolution: {
      mode: 'tagged',
      nodeMapping,
      sceneNodeMapping
    }
  };
}

function isLocalizableContainerNode(node: SceneNode): node is LocalizableContainerNode {
  return node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE';
}

/** Validates current selection and returns the node if valid. Use for generate-prompt and apply-localization. */
function getValidatedSelection(): { valid: true; node: LocalizableContainerNode } | { valid: false; message: string } {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    return { valid: false, message: 'Please select a frame first' };
  }
  if (selection.length > 1) {
    return { valid: false, message: 'Please select only one frame' };
  }
  const node = selection[0];
  if (!isLocalizableContainerNode(node)) {
    return { valid: false, message: 'Please select a frame, component, or instance' };
  }
  return { valid: true, node };
}

function getFramePath(frame: FrameNode): string {
  const segments: string[] = [];
  let current: BaseNode | null = frame;

  while (current && current.type !== 'PAGE') {
    if ('name' in current && typeof current.name === 'string') {
      segments.push(current.name);
    }
    current = current.parent;
  }

  return segments.reverse().join(' / ');
}

function hasFrameAncestor(frame: FrameNode): boolean {
  let parent: BaseNode | null = frame.parent;

  while (parent && parent.type !== 'PAGE') {
    if (parent.type === 'FRAME') {
      return true;
    }
    parent = parent.parent;
  }

  return false;
}

function getArchiveFrames(page: PageNode): FrameNode[] {
  const allFrames = page.findAllWithCriteria({ types: ['FRAME'] });
  const rootFrames = allFrames.filter(frame => !hasFrameAncestor(frame));

  rootFrames.sort((a, b) => {
    if (a.y !== b.y) {
      return a.y - b.y;
    }
    return a.x - b.x;
  });

  return rootFrames;
}

function findExistingLocalizedNode(originalNode: LocalizableContainerNode, locale: string): LocalizableContainerNode | null {
  const parent = originalNode.parent;
  if (!parent || !('children' in parent)) {
    return null;
  }

  const expectedName = `${originalNode.name}_${locale}`;
  const siblings = parent.children.filter(
    (child): child is LocalizableContainerNode => child.id !== originalNode.id && isLocalizableContainerNode(child)
  );

  const metadataMatch = siblings.find(child => hasStoredVariantMetadata(child, originalNode.id, locale));
  if (metadataMatch) {
    return metadataMatch;
  }

  const exact = siblings.find(child => child.name === expectedName);
  if (exact) {
    return exact;
  }

  const numberedPrefix = `${expectedName} `;
  const numbered = siblings.find(child => child.name.startsWith(numberedPrefix));
  return numbered || null;
}

function getNextLocalizedVariantY(originalNode: LocalizableContainerNode, spacing: number): number {
  const parent = originalNode.parent;
  if (!parent || !('children' in parent)) {
    return originalNode.y + originalNode.height + spacing;
  }

  const localePrefix = `${originalNode.name}_`;
  let maxBottom = originalNode.y + originalNode.height;

  for (const child of parent.children) {
    if (child.id === originalNode.id) {
      continue;
    }

    if (!isLocalizableContainerNode(child)) {
      continue;
    }

    if (!child.name.startsWith(localePrefix)) {
      continue;
    }

    const childBottom = child.y + child.height;
    if (childBottom > maxBottom) {
      maxBottom = childBottom;
    }
  }

  return maxBottom + spacing;
}

/** Returns sanitized nodeId→translatedText map for a locale. Filters non-string values. */
function getLocaleTranslations(localizations: Localizations, locale: string): Record<string, string> {
  const rawTranslations = localizations[locale];
  if (!rawTranslations || typeof rawTranslations !== 'object') {
    return {};
  }

  const sanitized: Record<string, string> = {};
  for (const [nodeId, translatedText] of Object.entries(rawTranslations)) {
    if (typeof translatedText === 'string') {
      sanitized[nodeId] = translatedText;
    }
  }

  return sanitized;
}

function dedupeLocales(locales: string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();

  for (const locale of locales) {
    if (!seen.has(locale)) {
      seen.add(locale);
      unique.push(locale);
    }
  }

  return unique;
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

function computeTokenDiceScore(tokensA: Set<string>, tokensB: Set<string>): number {
  if (tokensA.size === 0 || tokensB.size === 0) {
    return 0;
  }

  let intersectionCount = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      intersectionCount++;
    }
  }

  const denominator = tokensA.size + tokensB.size;
  if (denominator === 0) {
    return 0;
  }

  return (2 * intersectionCount) / denominator;
}

function buildBigramProfile(value: string): BigramProfile {
  const counts = new Map<string, number>();
  if (value.length === 0) {
    return { counts, total: 0 };
  }

  if (value.length === 1) {
    counts.set(value, 1);
    return { counts, total: 1 };
  }

  let total = 0;
  for (let i = 0; i < value.length - 1; i++) {
    const bigram = value.slice(i, i + 2);
    counts.set(bigram, (counts.get(bigram) || 0) + 1);
    total++;
  }

  return { counts, total };
}

function computeBigramDiceScore(profileA: BigramProfile, profileB: BigramProfile): number {
  if (profileA.total === 0 || profileB.total === 0) {
    return 0;
  }

  let intersection = 0;
  for (const [bigram, countA] of profileA.counts.entries()) {
    const countB = profileB.counts.get(bigram) || 0;
    intersection += Math.min(countA, countB);
  }

  return (2 * intersection) / (profileA.total + profileB.total);
}

function createCanonicalNameProfile(value: string): CanonicalNameProfile {
  const canonical = normalizeImageName(value);
  return {
    canonical,
    tokens: new Set(tokenizeCanonicalName(canonical)),
    bigrams: buildBigramProfile(canonical)
  };
}

/**
 * Scores similarity between node and candidate profiles (0–1).
 * Uses token Dice coefficient and character bigram Dice for fuzzy matching.
 */
function scoreCanonicalNameMatch(nodeProfile: CanonicalNameProfile, candidateProfile: CanonicalNameProfile): number {
  if (!nodeProfile.canonical || !candidateProfile.canonical) {
    return 0;
  }

  if (nodeProfile.canonical === candidateProfile.canonical) {
    return 1;
  }

  const tokenDice = computeTokenDiceScore(nodeProfile.tokens, candidateProfile.tokens);
  const charBigramDice = computeBigramDiceScore(nodeProfile.bigrams, candidateProfile.bigrams);
  const containsBoost =
    nodeProfile.canonical.includes(candidateProfile.canonical) || candidateProfile.canonical.includes(nodeProfile.canonical)
      ? 0.08
      : 0;

  return Math.min(1, (0.55 * tokenDice) + (0.45 * charBigramDice) + containsBoost);
}

function isCandidateBetter(
  lhs: { score: number; stableIndex: number },
  rhs: { score: number; stableIndex: number }
): boolean {
  if (lhs.score !== rhs.score) {
    return lhs.score > rhs.score;
  }
  return lhs.stableIndex < rhs.stableIndex;
}

function rankImageCandidates(nodeProfile: CanonicalNameProfile, candidates: PreparedImageCatalogEntry[]): RankedCandidate[] {
  const top: Array<{ score: number; stableIndex: number; entry: ImageCatalogEntry }> = [];

  for (const candidate of candidates) {
    const scored = {
      entry: candidate.entry,
      score: scoreCanonicalNameMatch(nodeProfile, candidate.profile),
      stableIndex: candidate.stableIndex
    };

    let inserted = false;
    for (let i = 0; i < top.length; i++) {
      if (isCandidateBetter(scored, top[i])) {
        top.splice(i, 0, scored);
        inserted = true;
        break;
      }
    }

    if (!inserted && top.length < 3) {
      top.push(scored);
    }

    if (top.length > 3) {
      top.pop();
    }
  }

  return top.map(item => ({
    entry: item.entry,
    score: item.score
  }));
}

/**
 * Picks best image candidate or returns status: no-candidate, low-confidence, ambiguous, or matched.
 * Uses MIN_MATCH_SCORE and AMBIGUOUS_MARGIN thresholds.
 */
function decideImageCandidate(nodeProfile: CanonicalNameProfile, candidates: PreparedImageCatalogEntry[]): MatchDecision {
  if (candidates.length === 0) {
    return {
      status: 'no-candidate',
      topCandidates: []
    };
  }

  const rankedCandidates = rankImageCandidates(nodeProfile, candidates);
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

function createUiRequestId(): string {
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

function getLocaleCatalog(catalog: FolderImageCatalog): Map<string, PreparedImageCatalogEntry[]> {
  const byLocale = new Map<string, PreparedImageCatalogEntry[]>();

  for (let i = 0; i < catalog.entries.length; i++) {
    const entry = catalog.entries[i];
    if (!ALLOWED_IMAGE_EXTENSIONS.has(entry.extension)) {
      continue;
    }

    if (entry.size > MAX_IMAGE_BYTES) {
      continue;
    }

    const localeEntries = byLocale.get(entry.locale) || [];
    localeEntries.push({
      entry,
      profile: createCanonicalNameProfile(entry.stem),
      stableIndex: i
    });
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
  localeCatalog: Map<string, PreparedImageCatalogEntry[]>,
  locale: string
): PreparedImageCatalogEntry[] {
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
  const fallback: PreparedImageCatalogEntry[] = [];
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

function buildTextNodeLookup(node: SceneNode): Map<string, TextNode> {
  const mapping = new Map<string, TextNode>();
  const textNodes = 'findAllWithCriteria' in node
    ? node.findAllWithCriteria({ types: ['TEXT'] })
    : (node.type === 'TEXT' ? [node] : []);

  for (const textNode of textNodes) {
    mapping.set(textNode.id, textNode);
  }

  return mapping;
}

function getMissingFontTextIds(
  translationKeys: string[],
  unknownTextIds: string[],
  nodeMapping: Map<string, TextNode>
): string[] {
  const unknownIdSet = new Set(unknownTextIds);
  const missingFontIds: string[] = [];

  for (const textId of translationKeys) {
    if (unknownIdSet.has(textId)) {
      continue;
    }

    const textNode = nodeMapping.get(textId);
    if (textNode && textNode.hasMissingFont) {
      missingFontIds.push(textId);
    }
  }

  return missingFontIds;
}

function getUnreplaceableImageIds(
  sourceImages: ImageInfo[],
  sceneNodeMapping: Map<string, SceneNode>
): string[] {
  const invalidIds: string[] = [];

  for (const imageInfo of sourceImages) {
    const targetNode = sceneNodeMapping.get(imageInfo.id);
    if (!targetNode || !isNodeWithFills(targetNode) || targetNode.fills === figma.mixed) {
      invalidIds.push(imageInfo.id);
      continue;
    }

    const fills = targetNode.fills;
    if (imageInfo.fillIndex < 0 || imageInfo.fillIndex >= fills.length) {
      invalidIds.push(imageInfo.id);
      continue;
    }

    if (fills[imageInfo.fillIndex].type !== 'IMAGE') {
      invalidIds.push(imageInfo.id);
    }
  }

  return invalidIds;
}

function buildOutputFormatExample(texts: TextInfo[], locale: string): string {
  const translations: Record<string, string> = {};
  for (const text of texts) {
    translations[text.id] = `translated text for ${text.text}`;
  }

  return JSON.stringify({
    localizations: {
      [locale]: translations
    }
  }, null, 2);
}

function createIssue(code: string, message: string, severity: Severity = 'error'): MessageIssue {
  return {
    code,
    message,
    severity
  };
}

function summarizeBlockingValidationIssues(payload: ValidationResultPayload): string {
  for (const locale of payload.locales) {
    const blockingIssue = locale.issues.find(issue => issue.severity === 'error');
    if (blockingIssue) {
      return blockingIssue.message;
    }
  }

  return 'Fix the validation issues before applying localization.';
}

function toValidationSummary(plan: LocalePlan): LocaleValidationSummary {
  return {
    locale: plan.locale,
    mode: plan.mode,
    translationCount: plan.translationCount,
    missingTextIds: [...plan.missingTextIds],
    unknownTextIds: [...plan.unknownTextIds],
    canApply: plan.canApply,
    issues: [...plan.issues],
    willApplyImages: plan.willApplyImages
  };
}

function analyzeLocalizationRequest(
  originalFrame: LocalizableContainerNode,
  localizations: Localizations,
  requestedLocales: string[],
  imageSource: ImageSourceSettings
): { ok: true; payload: ValidationResultPayload; localePlans: LocalePlan[]; sourceImages: ImageInfo[] }
  | { ok: false; message: string } {
  const locales = dedupeLocales(requestedLocales.length > 0 ? requestedLocales : Object.keys(localizations));
  if (locales.length === 0) {
    return {
      ok: false,
      message: 'No target locales provided'
    };
  }

  if (imageSource.enabled && (imageSource.mode !== 'folder' || !imageSource.catalog)) {
    return {
      ok: false,
      message: 'Choose a localized assets folder before validating or applying image replacement'
    };
  }

  if (imageSource.enabled && imageSource.catalog && imageSource.catalog.entries.length > MAX_CATALOG_ENTRIES) {
    return {
      ok: false,
      message: `Image catalog exceeds limit (${MAX_CATALOG_ENTRIES}). Reduce files and try again.`
    };
  }

  const sourceTexts: TextInfo[] = [];
  extractTextNodes(originalFrame, sourceTexts);
  const sourceTextIds = sourceTexts.map(text => text.id);
  const sourceTextIdSet = new Set(sourceTextIds);
  const sourceTextNodeLookup = buildTextNodeLookup(originalFrame);
  const sourceImages: ImageInfo[] = [];
  if (imageSource.enabled) {
    extractImageNodes(originalFrame, sourceImages);
  }

  const responseLocales = dedupeLocales(
    Object.keys(localizations).filter(locale => Object.keys(getLocaleTranslations(localizations, locale)).length > 0)
  );

  const localePlans = locales.map(locale => {
    const translations = getLocaleTranslations(localizations, locale);
    const translationKeys = Object.keys(translations);
    const translationCount = translationKeys.length;
    const existingNode = findExistingLocalizedNode(originalFrame, locale);
    const mode: LocaleMode = existingNode ? 'update' : 'create';
    const missingTextIds = sourceTextIds.filter(textId => !Object.prototype.hasOwnProperty.call(translations, textId));
    const unknownTextIds = translationKeys.filter(textId => !sourceTextIdSet.has(textId));
    const willApplyImages = imageSource.enabled && sourceImages.length > 0;
    const issues: MessageIssue[] = [];

    if (unknownTextIds.length > 0) {
      issues.push(createIssue(
        'unknown-text-ids',
        `${locale}: ${unknownTextIds.length} response IDs do not exist in the selected source and will be ignored.`,
        'warning'
      ));
    }

    if (mode === 'create' && sourceTextIds.length > 0) {
      if (translationCount === 0) {
        issues.push(createIssue(
          'missing-new-locale-translations',
          `Full JSON is required for new locale ${locale}. Add translations for all ${sourceTextIds.length} text nodes.`
        ));
      } else if (missingTextIds.length > 0) {
        issues.push(createIssue(
          'incomplete-new-locale-translations',
          `New locale ${locale} is missing ${missingTextIds.length} text IDs. Add a complete translation set before applying.`
        ));
      }
    }

    if (mode === 'update' && translationCount === 0 && !willApplyImages) {
      issues.push(createIssue(
        'missing-locale-translations',
        `No translations were found for requested locale ${locale}. Validate a matching JSON response or remove the locale from the request.`
      ));
    }

    if (existingNode) {
      const hasMetadata = hasStoredVariantMetadata(existingNode, originalFrame.id, locale) || hasTaggedDescendants(existingNode);
      if (!hasMetadata) {
        issues.push(createIssue(
          'unsupported-legacy-variant',
          `Existing ${locale} variant was not created by SmartLocal and cannot be updated safely. Recreate or migrate it manually.`
        ));
      } else {
        const resolved = resolveVariantMappings(originalFrame, existingNode, locale);
        if (!resolved.ok) {
          issues.push(createIssue(
            'unsafe-existing-variant',
            resolved.message
          ));
        } else {
          const missingMappedTextIds = translationKeys.filter(
            textId => !unknownTextIds.includes(textId) && !resolved.resolution.nodeMapping.has(textId)
          );
          if (missingMappedTextIds.length > 0) {
            issues.push(createIssue(
              'missing-target-text-nodes',
              `Existing ${locale} variant is missing ${missingMappedTextIds.length} mapped text nodes and cannot be updated safely.`
            ));
          }

          if (translationCount > 0) {
            const missingFontTextIds = getMissingFontTextIds(
              translationKeys,
              unknownTextIds,
              resolved.resolution.nodeMapping
            );
            if (missingFontTextIds.length > 0) {
              issues.push(createIssue(
                'missing-fonts',
                `Existing ${locale} variant has ${missingFontTextIds.length} text nodes with missing fonts. Resolve fonts before applying localization.`
              ));
            }
          }

          if (willApplyImages) {
            const missingMappedImageIds = sourceImages.filter(imageInfo => !resolved.resolution.sceneNodeMapping.has(imageInfo.id));
            if (missingMappedImageIds.length > 0) {
              issues.push(createIssue(
                'missing-target-image-nodes',
                `Existing ${locale} variant is missing ${missingMappedImageIds.length} mapped image nodes and cannot be updated safely.`
              ));
            } else {
              const unreplaceableImageIds = getUnreplaceableImageIds(sourceImages, resolved.resolution.sceneNodeMapping);
              if (unreplaceableImageIds.length > 0) {
                issues.push(createIssue(
                  'unreplaceable-image-fills',
                  `Existing ${locale} variant has ${unreplaceableImageIds.length} image fills that are no longer replaceable. Restore them before applying localization.`
                ));
              }
            }
          }
        }
      }
    } else if (translationCount > 0) {
      const missingFontTextIds = getMissingFontTextIds(
        translationKeys,
        unknownTextIds,
        sourceTextNodeLookup
      );
      if (missingFontTextIds.length > 0) {
        issues.push(createIssue(
          'missing-fonts',
          `Selected source has ${missingFontTextIds.length} text nodes with missing fonts for locale ${locale}. Resolve fonts before applying localization.`
        ));
      }
    }

    if (translationCount === 0 && imageSource.enabled && sourceImages.length === 0) {
      issues.push(createIssue(
        'no-source-images',
        `Image replacement is enabled, but the selected source has no visible image nodes for locale ${locale}.`
      ));
    }

    const hasWork = translationCount > 0 || willApplyImages;
    if (!hasWork) {
      issues.push(createIssue(
        'no-applicable-work',
        `Locale ${locale} has nothing to apply yet. Validate translations or load localized images first.`
      ));
    }

    const canApply = hasWork && !issues.some(issue => issue.severity === 'error');

    return {
      locale,
      mode,
      existingNode,
      translations,
      translationCount,
      missingTextIds,
      unknownTextIds,
      canApply,
      issues,
      willApplyImages
    };
  });

  const summary: ValidationSummary = {
    sourceTextCount: sourceTexts.length,
    sourceImageCount: sourceImages.length,
    localeCount: localePlans.length,
    responseLocaleCount: responseLocales.length,
    creatableCount: localePlans.filter(plan => plan.mode === 'create' && plan.canApply).length,
    updatableCount: localePlans.filter(plan => plan.mode === 'update' && plan.canApply).length,
    blockedCount: localePlans.filter(plan => !plan.canApply).length,
    warningCount: localePlans.reduce(
      (count, plan) => count + plan.issues.filter(issue => issue.severity === 'warning').length,
      0
    ),
    imageSourceEnabled: imageSource.enabled
  };

  return {
    ok: true,
    payload: {
      selectionName: originalFrame.name,
      requestedLocales: locales,
      responseLocales,
      canApply: summary.blockedCount === 0 && localePlans.some(plan => plan.canApply),
      partialIssues: summary.warningCount > 0,
      summary,
      locales: localePlans.map(toValidationSummary)
    },
    localePlans,
    sourceImages
  };
}

/**
 * Message handler for UI ↔ plugin communication.
 * Handled types: image-bytes-response, ui-ready, generate-prompt, extract-all-frames-content,
 * apply-localization, save-locales, save-prompt, save-image-source.
 */
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
    const validation = getValidatedSelection();
    if (!validation.valid) {
      figma.ui.postMessage({ type: 'prompt-error', message: validation.message });
      return;
    }

    const texts: TextInfo[] = [];
    extractTextNodes(validation.node, texts);

    if (texts.length === 0) {
      figma.ui.postMessage({
        type: 'prompt-error',
        message: 'No visible text nodes found in the selected frame'
      });
      return;
    }

    const languages = msg.languages as string[];
    const promptTemplate = msg.promptTemplate as string;

    const extractedData: ExtractedData = {
      texts,
      targetLanguages: languages
    };
    const copyRequestId = createUiRequestId();

    const fullPrompt = `${promptTemplate}

INPUT:
${JSON.stringify(extractedData, null, 2)}

OUTPUT FORMAT:
${buildOutputFormatExample(texts, languages[0])}`;

    figma.ui.postMessage({
      type: 'copy-to-clipboard',
      text: fullPrompt,
      copyRequestId
    });

    figma.ui.postMessage({
      type: 'prompt-generated',
      textCount: texts.length,
      extractedData,
      copyRequestId
    });

    figma.notify(`📋 Prompt copied! Found ${texts.length} text nodes.`);
    return;
  }

  if (msg.type === 'extract-all-frames-content') {
    const archiveFrames = getArchiveFrames(figma.currentPage);

    if (archiveFrames.length === 0) {
      figma.ui.postMessage({
        type: 'all-frames-content-error',
        message: 'No frames found on this page.'
      });
      return;
    }

    const targetLanguages = parseLocaleList(msg.languages);
    let totalTextCount = 0;
    const combinedTexts: TextInfo[] = [];
    const frames: ArchivedFrameContent[] = archiveFrames.map(frame => {
      const texts: TextInfo[] = [];
      extractTextNodes(frame, texts);

      totalTextCount += texts.length;
      combinedTexts.push(...texts);

      return {
        frameId: frame.id,
        frameName: frame.name,
        framePath: getFramePath(frame),
        textCount: texts.length,
        input: {
          texts,
          targetLanguages
        }
      };
    });

    const archiveData: ArchiveExportData = {
      generatedAt: new Date().toISOString(),
      page: {
        id: figma.currentPage.id,
        name: figma.currentPage.name
      },
      targetLanguages,
      frameCount: frames.length,
      totalTextCount,
      combinedInput: {
        texts: combinedTexts,
        targetLanguages
      },
      frames
    };
    const copyRequestId = createUiRequestId();

    figma.ui.postMessage({
      type: 'copy-to-clipboard',
      text: JSON.stringify(archiveData, null, 2),
      copyRequestId
    });

    figma.ui.postMessage({
      type: 'all-frames-content-extracted',
      frameCount: archiveData.frameCount,
      textCount: archiveData.totalTextCount,
      archiveData,
      copyRequestId
    });

    figma.notify(`🗂️ Archived ${archiveData.frameCount} frames (${archiveData.totalTextCount} text nodes).`);
    return;
  }

  if (msg.type === 'validate-localization') {
    const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
    const validation = getValidatedSelection();
    if (!validation.valid) {
      figma.ui.postMessage({ type: 'validation-error', message: validation.message, requestId });
      return;
    }

    const localizations = (msg.localizations && typeof msg.localizations === 'object' && !Array.isArray(msg.localizations))
      ? msg.localizations as Localizations
      : {};
    const requestedLocales = parseLocaleList(msg.locales);
    const imageSource = parseImageSourceSettings(msg.imageSource);
    const analysis = analyzeLocalizationRequest(validation.node, localizations, requestedLocales, imageSource);

    if (!analysis.ok) {
      figma.ui.postMessage({ type: 'validation-error', message: analysis.message, requestId });
      return;
    }

    figma.ui.postMessage({
      type: 'validation-result',
      validation: analysis.payload,
      requestId
    });
    return;
  }

  // Apply Localization
  if (msg.type === 'apply-localization') {
    const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
    if (applyInFlight) {
      figma.ui.postMessage({
        type: 'apply-error',
        message: 'Localization is already running. Wait for the current apply to finish before trying again.',
        requestId
      });
      return;
    }

    const validation = getValidatedSelection();
    if (!validation.valid) {
      const message = validation.message === 'Please select a frame first'
        ? 'Please select the original frame'
        : validation.message;
      figma.ui.postMessage({ type: 'apply-error', message, requestId });
      return;
    }

    const originalFrame = validation.node;
    const localizations = (msg.localizations && typeof msg.localizations === 'object' && !Array.isArray(msg.localizations))
      ? msg.localizations as Localizations
      : {};
    const requestedLocales = parseLocaleList(msg.locales);
    const imageSource = parseImageSourceSettings(msg.imageSource);
    const analysis = analyzeLocalizationRequest(originalFrame, localizations, requestedLocales, imageSource);

    if (!analysis.ok) {
      figma.ui.postMessage({
        type: 'apply-error',
        message: analysis.message,
        requestId
      });
      return;
    }

    if (!analysis.payload.canApply) {
      figma.ui.postMessage({
        type: 'apply-error',
        message: summarizeBlockingValidationIssues(analysis.payload),
        requestId
      });
      return;
    }

    const spacing = 40;
    const localePlans = analysis.localePlans.filter(plan => plan.canApply);
    const imageHashCache = new Map<string, string>();
    const imageIssues: ImageIssue[] = [];
    const localeCatalog = imageSource.catalog ? getLocaleCatalog(imageSource.catalog) : new Map<string, PreparedImageCatalogEntry[]>();

    let createdCount = 0;
    let updatedCount = 0;
    let imageReplacedCount = 0;
    let imageSkippedCount = 0;
    let imageAmbiguousCount = 0;
    let imageFailedCount = 0;
    const localeOutcomes: LocaleApplyOutcome[] = [];

    applyInFlight = true;

    try {
      for (let localeIndex = 0; localeIndex < localePlans.length; localeIndex++) {
        const localePlan = localePlans[localeIndex];
        const locale = localePlan.locale;
        const translations = localePlan.translations;
        const unknownIdSet = new Set(localePlan.unknownTextIds);
        let targetFrame: LocalizableContainerNode | null = null;
        let createdThisRun = false;

        const outcome: LocaleApplyOutcome = {
          locale,
          mode: localePlan.mode,
          status: 'success',
          textAppliedCount: 0,
          textFailedCount: 0,
          imageReplacedCount: 0,
          imageSkippedCount: 0,
          imageAmbiguousCount: 0,
          imageFailedCount: 0,
          issues: localePlan.issues.filter(issue => issue.severity === 'warning')
        };

        try {
          let resolution: VariantResolution;

          if (localePlan.existingNode) {
            targetFrame = localePlan.existingNode;
            const resolved = resolveVariantMappings(originalFrame, targetFrame, locale);
            if (!resolved.ok) {
              outcome.status = 'failed';
              outcome.issues.push(createIssue('variant-drifted', resolved.message));
              localeOutcomes.push(outcome);
              continue;
            }
            resolution = resolved.resolution;
          } else {
            const clonedFrame = originalFrame.clone();
            clonedFrame.name = `${originalFrame.name}_${locale}`;
            clonedFrame.y = getNextLocalizedVariantY(originalFrame, spacing);
            setLocalizedNodeMetadata(originalFrame, clonedFrame, locale, originalFrame.id, true);
            createdThisRun = true;
            targetFrame = clonedFrame;

            const nodeMapping = new Map<string, TextNode>();
            buildNodeMapping(originalFrame, targetFrame, nodeMapping);
            const sceneNodeMapping = new Map<string, SceneNode>();
            buildSceneNodeMapping(originalFrame, targetFrame, sceneNodeMapping);
            resolution = {
              mode: 'tagged',
              nodeMapping,
              sceneNodeMapping
            };
          }

          const missingMappedTextIds = Object.keys(translations).filter(
            sourceNodeId => !unknownIdSet.has(sourceNodeId) && !resolution.nodeMapping.has(sourceNodeId)
          );
          if (missingMappedTextIds.length > 0) {
            outcome.status = 'failed';
            outcome.issues.push(createIssue(
              'missing-target-text-nodes',
              `Existing ${locale} variant is missing ${missingMappedTextIds.length} mapped text nodes and cannot be updated safely.`
            ));
            if (createdThisRun && targetFrame) {
              targetFrame.remove();
            }
            localeOutcomes.push(outcome);
            continue;
          }

          const missingMappedImageIds = analysis.sourceImages
            .filter(imageInfo => !resolution.sceneNodeMapping.has(imageInfo.id))
            .map(imageInfo => imageInfo.id);
          if (localePlan.willApplyImages && missingMappedImageIds.length > 0) {
            outcome.status = 'failed';
            outcome.issues.push(createIssue(
              'missing-target-image-nodes',
              `Existing ${locale} variant is missing ${missingMappedImageIds.length} mapped image nodes and cannot be updated safely.`
            ));
            if (createdThisRun && targetFrame) {
              targetFrame.remove();
            }
            localeOutcomes.push(outcome);
            continue;
          }

          let fontLoadIndex = 0;
          for (const [originalId] of Object.entries(translations)) {
            if (unknownIdSet.has(originalId)) {
              continue;
            }

            const textNode = resolution.nodeMapping.get(originalId);
            if (!textNode) {
              continue;
            }

            try {
              const fontName = textNode.fontName;
              if (fontName !== figma.mixed) {
                await loadFontOnce(fontName);
              } else if (textNode.characters.length > 0) {
                const fontNames = textNode.getRangeAllFontNames(0, textNode.characters.length);
                for (const fn of fontNames) {
                  await loadFontOnce(fn);
                }
              }
            } catch (fontErr) {
              console.warn(`Font loading error for ${locale}/${originalId}:`, fontErr);
              outcome.textFailedCount++;
              outcome.issues.push(createIssue(
                'font-load-failed',
                `Failed to load fonts for locale ${locale} text node ${originalId}.`
              ));
            }

            fontLoadIndex++;
            await yieldIfNeeded(fontLoadIndex, TEXT_APPLY_YIELD_INTERVAL);
          }

          let textApplyIndex = 0;
          for (const [originalId, translatedText] of Object.entries(translations)) {
            if (unknownIdSet.has(originalId)) {
              continue;
            }

            const textNode = resolution.nodeMapping.get(originalId);
            if (!textNode) {
              outcome.textFailedCount++;
              outcome.issues.push(createIssue(
                'missing-target-node',
                `Locale ${locale} could not resolve source text node ${originalId} in the target variant.`
              ));
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
                outcome.textAppliedCount++;
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

              await loadFontOnce(dominantSegment.fontName);

              textNode.characters = translatedText;
              textNode.fontSize = dominantSegment.fontSize;
              textNode.fontName = dominantSegment.fontName;
              textNode.fills = dominantSegment.fills;
              textNode.lineHeight = dominantSegment.lineHeight;
              textNode.letterSpacing = dominantSegment.letterSpacing;
              textNode.textDecoration = dominantSegment.textDecoration;
              textNode.textCase = dominantSegment.textCase;
              outcome.textAppliedCount++;
            } catch (textErr) {
              console.warn(`Text replacement error for ${locale}/${originalId}:`, textErr);
              outcome.textFailedCount++;
              outcome.issues.push(createIssue(
                'text-apply-failed',
                `Failed to apply translated text for locale ${locale} node ${originalId}.`
              ));
            }

            textApplyIndex++;
            await yieldIfNeeded(textApplyIndex, TEXT_APPLY_YIELD_INTERVAL);
          }

          if (localePlan.willApplyImages) {
            const localeCandidates = getCandidatesForLocale(localeCatalog, locale);

            for (let imageIndex = 0; imageIndex < analysis.sourceImages.length; imageIndex++) {
              const imageInfo = analysis.sourceImages[imageIndex];
              const targetNode = resolution.sceneNodeMapping.get(imageInfo.id);

              if (!targetNode || !isNodeWithFills(targetNode) || targetNode.fills === figma.mixed) {
                outcome.imageSkippedCount++;
                imageSkippedCount++;
                addImageIssue(imageIssues, {
                  locale,
                  nodeId: imageInfo.id,
                  nodeName: imageInfo.nodeName,
                  reason: 'no-candidate'
                });
                await yieldIfNeeded(imageIndex + 1, APPLY_YIELD_INTERVAL);
                continue;
              }

              const fills = [...targetNode.fills] as Paint[];
              if (imageInfo.fillIndex < 0 || imageInfo.fillIndex >= fills.length) {
                outcome.imageSkippedCount++;
                imageSkippedCount++;
                addImageIssue(imageIssues, {
                  locale,
                  nodeId: imageInfo.id,
                  nodeName: imageInfo.nodeName,
                  reason: 'no-candidate'
                });
                await yieldIfNeeded(imageIndex + 1, APPLY_YIELD_INTERVAL);
                continue;
              }

              const targetPaint = fills[imageInfo.fillIndex];
              if (targetPaint.type !== 'IMAGE') {
                outcome.imageSkippedCount++;
                imageSkippedCount++;
                addImageIssue(imageIssues, {
                  locale,
                  nodeId: imageInfo.id,
                  nodeName: imageInfo.nodeName,
                  reason: 'no-candidate'
                });
                await yieldIfNeeded(imageIndex + 1, APPLY_YIELD_INTERVAL);
                continue;
              }

              const nodeProfile = createCanonicalNameProfile(imageInfo.nodeName);
              const matchDecision = decideImageCandidate(nodeProfile, localeCandidates);
              const bestScore = matchDecision.best ? Number(matchDecision.best.score.toFixed(3)) : undefined;
              const secondBestScore = matchDecision.second ? Number(matchDecision.second.score.toFixed(3)) : undefined;

              if (matchDecision.status === 'no-candidate') {
                outcome.imageSkippedCount++;
                imageSkippedCount++;
                addImageIssue(imageIssues, {
                  locale,
                  nodeId: imageInfo.id,
                  nodeName: imageInfo.nodeName,
                  reason: 'no-candidate'
                });
                await yieldIfNeeded(imageIndex + 1, APPLY_YIELD_INTERVAL);
                continue;
              }

              if (matchDecision.status === 'low-confidence') {
                outcome.imageSkippedCount++;
                imageSkippedCount++;
                addImageIssue(imageIssues, {
                  locale,
                  nodeId: imageInfo.id,
                  nodeName: imageInfo.nodeName,
                  reason: 'low-confidence',
                  bestScore,
                  secondBestScore,
                  candidates: summarizeCandidates(matchDecision.topCandidates)
                });
                await yieldIfNeeded(imageIndex + 1, APPLY_YIELD_INTERVAL);
                continue;
              }

              if (matchDecision.status === 'ambiguous') {
                outcome.imageSkippedCount++;
                outcome.imageAmbiguousCount++;
                imageSkippedCount++;
                imageAmbiguousCount++;
                addImageIssue(imageIssues, {
                  locale,
                  nodeId: imageInfo.id,
                  nodeName: imageInfo.nodeName,
                  reason: 'ambiguous',
                  bestScore,
                  secondBestScore,
                  candidates: summarizeCandidates(matchDecision.topCandidates)
                });
                await yieldIfNeeded(imageIndex + 1, APPLY_YIELD_INTERVAL);
                continue;
              }

              const matchedEntry = matchDecision.best?.entry;
              if (!matchedEntry) {
                outcome.imageSkippedCount++;
                imageSkippedCount++;
                addImageIssue(imageIssues, {
                  locale,
                  nodeId: imageInfo.id,
                  nodeName: imageInfo.nodeName,
                  reason: 'no-candidate'
                });
                await yieldIfNeeded(imageIndex + 1, APPLY_YIELD_INTERVAL);
                continue;
              }

              let imageHash = imageHashCache.get(matchedEntry.key);
              if (!imageHash) {
                const bytes = await requestImageBytesFromUi(matchedEntry.key);
                if (!bytes || bytes.byteLength === 0) {
                  outcome.imageFailedCount++;
                  imageFailedCount++;
                  addImageIssue(imageIssues, {
                    locale,
                    nodeId: imageInfo.id,
                    nodeName: imageInfo.nodeName,
                    reason: 'read-failed',
                    bestScore,
                    secondBestScore,
                    candidates: summarizeCandidates(matchDecision.topCandidates)
                  });
                  await yieldIfNeeded(imageIndex + 1, APPLY_YIELD_INTERVAL);
                  continue;
                }

                try {
                  imageHash = figma.createImage(bytes).hash;
                  imageHashCache.set(matchedEntry.key, imageHash);
                } catch (imageErr) {
                  console.warn(`Failed to create image for file key ${matchedEntry.key}:`, imageErr);
                  outcome.imageFailedCount++;
                  imageFailedCount++;
                  addImageIssue(imageIssues, {
                    locale,
                    nodeId: imageInfo.id,
                    nodeName: imageInfo.nodeName,
                    reason: 'read-failed',
                    bestScore,
                    secondBestScore,
                    candidates: summarizeCandidates(matchDecision.topCandidates)
                  });
                  await yieldIfNeeded(imageIndex + 1, APPLY_YIELD_INTERVAL);
                  continue;
                }
              }

              try {
                fills[imageInfo.fillIndex] = {
                  ...targetPaint,
                  imageHash
                };
                targetNode.fills = fills;
                outcome.imageReplacedCount++;
                imageReplacedCount++;
              } catch (imageErr) {
                console.warn(`Image replacement failed for ${locale}/${imageInfo.nodeName}:`, imageErr);
                outcome.imageFailedCount++;
                imageFailedCount++;
                addImageIssue(imageIssues, {
                  locale,
                  nodeId: imageInfo.id,
                  nodeName: imageInfo.nodeName,
                  reason: 'read-failed',
                  bestScore,
                  secondBestScore,
                  candidates: summarizeCandidates(matchDecision.topCandidates)
                });
              }

              await yieldIfNeeded(imageIndex + 1, APPLY_YIELD_INTERVAL);
            }
          }

          const hasErrors = outcome.issues.some(issue => issue.severity === 'error')
            || outcome.textFailedCount > 0
            || outcome.imageFailedCount > 0;
          const hasWarnings = outcome.issues.some(issue => issue.severity === 'warning')
            || outcome.imageSkippedCount > 0
            || outcome.imageAmbiguousCount > 0;
          const hasAppliedChanges = outcome.textAppliedCount > 0 || outcome.imageReplacedCount > 0;

          if (hasErrors && !hasAppliedChanges) {
            outcome.status = 'failed';
          } else if (hasErrors || hasWarnings) {
            outcome.status = 'partial';
          }

          if (outcome.status === 'failed' && createdThisRun && targetFrame) {
            targetFrame.remove();
          } else if (outcome.mode === 'create') {
            createdCount++;
          } else {
            updatedCount++;
          }
        } catch (localeErr) {
          console.error(`Failed to process locale ${locale}:`, localeErr);
          outcome.status = 'failed';
          outcome.issues.push(createIssue(
            'locale-apply-failed',
            `Locale ${locale} failed to apply because of an unexpected plugin error.`
          ));
          if (createdThisRun && targetFrame) {
            targetFrame.remove();
          }
        }

        localeOutcomes.push(outcome);
      }
    } finally {
      applyInFlight = false;
    }

    const successfulOutcomes = localeOutcomes.filter(outcome => outcome.status !== 'failed');
    if (successfulOutcomes.length === 0) {
      let firstFailure: MessageIssue | undefined;
      for (const outcome of localeOutcomes) {
        firstFailure = outcome.issues.find(issue => issue.severity === 'error');
        if (firstFailure) {
          break;
        }
      }
      figma.ui.postMessage({
        type: 'apply-error',
        message: firstFailure ? firstFailure.message : 'Localization could not be applied safely. Review the validation results and try again.',
        requestId
      });
      return;
    }

    imageDebug('apply-complete', {
      createdCount,
      updatedCount,
      imageReplacedCount,
      imageSkippedCount,
      imageAmbiguousCount,
      imageFailedCount,
      issueCount: imageIssues.length
    });

    const partialSuccess = localeOutcomes.some(outcome => outcome.status !== 'success');
    const applyResult: ApplyResultPayload = {
      status: partialSuccess ? 'partial' : 'success',
      partialSuccess,
      createdCount,
      updatedCount,
      imageReplacedCount,
      imageSkippedCount,
      imageAmbiguousCount,
      imageFailedCount,
      localeOutcomes,
      imageIssues
    };

    figma.ui.postMessage({
      type: 'apply-result',
      result: applyResult,
      requestId
    });

    const notifyPrefix = partialSuccess ? '⚠️' : '✨';
    figma.notify(
      `${notifyPrefix} Localizations applied. ${createdCount} created, ${updatedCount} updated. Images: ${imageReplacedCount} replaced, ${imageSkippedCount} skipped, ${imageAmbiguousCount} ambiguous, ${imageFailedCount} failed.`
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
    return;
  }
};
