// Deprecated: SmartLocal now supports serverless image folder import directly in the plugin UI.
const fs = require('fs');
const path = require('path');
const http = require('http');

const DEFAULT_PORT = 3000;
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
const IMAGE_CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
};
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept'
};

function parseArgs(argv) {
  const result = {
    root: '',
    port: DEFAULT_PORT
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') {
      result.root = (argv[i + 1] || '').trim();
      i++;
      continue;
    }

    if (arg === '--port') {
      const parsed = Number.parseInt(argv[i + 1] || '', 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        result.port = parsed;
      }
      i++;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return result;
}

function printHelp() {
  console.log('SmartLocal Image Server');
  console.log('');
  console.log('Usage:');
  console.log('  node scripts/local_image_server.js --root <screenshotsRoot> [--port 3000]');
  console.log('');
  console.log('Example:');
  console.log('  npm run image-server -- --root "/Users/x/Developer/WoziAppOne/fastlane/screenshots/Wozi"');
}

function isLocaleLikeName(name) {
  return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*$/.test(name);
}

function resolveRootPath(inputPath) {
  return path.resolve(inputPath);
}

function validateRootPath(rootPath) {
  try {
    const stats = fs.statSync(rootPath);
    if (!stats.isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }

  try {
    const entries = fs.readdirSync(rootPath, { withFileTypes: true });
    return entries.some(entry => entry.isDirectory() && isLocaleLikeName(entry.name));
  } catch {
    return false;
  }
}

function normalizeNodeName(nodeName) {
  return nodeName.trim().replace(/\s+\d+$/, '').trim();
}

function canonicalizeNodeName(nodeName) {
  return normalizeNodeName(nodeName)
    .normalize('NFKC')
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function containsUnsafePathPart(value) {
  return value.includes('/') || value.includes('\\') || value.includes('..');
}

function resolveEffectiveRoot(defaultRoot, rootOverride) {
  if (!rootOverride) {
    return defaultRoot;
  }

  const resolved = resolveRootPath(rootOverride);
  if (!validateRootPath(resolved)) {
    return null;
  }
  return resolved;
}

function findImagePath(rootPath, locale, normalizedNodeName) {
  if (containsUnsafePathPart(locale) || containsUnsafePathPart(normalizedNodeName)) {
    return null;
  }

  const localePath = path.join(rootPath, locale);
  let localeStats;
  try {
    localeStats = fs.statSync(localePath);
  } catch {
    return null;
  }

  if (!localeStats.isDirectory()) {
    return null;
  }

  for (const extension of IMAGE_EXTENSIONS) {
    const candidate = path.join(localePath, `${normalizedNodeName}${extension}`);
    try {
      const stats = fs.statSync(candidate);
      if (stats.isFile()) {
        return candidate;
      }
    } catch {
      // continue
    }
  }

  // Fallback: canonical match (handles dash variants like "–" vs "-")
  const targetCanonical = canonicalizeNodeName(normalizedNodeName);
  let entries;
  try {
    entries = fs.readdirSync(localePath, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (!IMAGE_EXTENSIONS.includes(ext)) {
      continue;
    }

    const stem = path.basename(entry.name, ext);
    if (canonicalizeNodeName(stem) === targetCanonical) {
      return path.join(localePath, entry.name);
    }
  }

  return null;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    ...CORS_HEADERS,
    'Content-Type': 'application/json; charset=utf-8'
  });
  res.end(JSON.stringify(payload));
}

const args = parseArgs(process.argv.slice(2));
if (!args.root) {
  printHelp();
  process.exit(1);
}

const defaultRoot = resolveRootPath(args.root);
if (!validateRootPath(defaultRoot)) {
  console.error(`Invalid root path: ${defaultRoot}`);
  console.error('Root path must exist and contain locale subfolders like en-US/ or zh-Hans/.');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (!req.url) {
    sendJson(res, 400, { error: 'Missing request URL' });
    return;
  }

  const currentUrl = new URL(req.url, 'http://127.0.0.1');
  if (currentUrl.pathname === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (currentUrl.pathname !== '/image') {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  const locale = (currentUrl.searchParams.get('locale') || '').trim();
  const nodeName = (currentUrl.searchParams.get('nodeName') || '').trim();
  const rootOverride = (currentUrl.searchParams.get('rootPath') || '').trim();

  if (!locale || !nodeName) {
    sendJson(res, 400, { error: 'locale and nodeName are required' });
    return;
  }

  const effectiveRoot = resolveEffectiveRoot(defaultRoot, rootOverride);
  if (!effectiveRoot) {
    sendJson(res, 404, { error: 'Root path not found' });
    return;
  }

  const normalizedNodeName = normalizeNodeName(nodeName);
  if (!normalizedNodeName) {
    sendJson(res, 400, { error: 'Invalid nodeName' });
    return;
  }

  const imagePath = findImagePath(effectiveRoot, locale, normalizedNodeName);
  if (!imagePath) {
    sendJson(res, 404, { error: 'Image not found' });
    return;
  }

  const extension = path.extname(imagePath).toLowerCase();
  const contentType = IMAGE_CONTENT_TYPES[extension] || 'application/octet-stream';
  res.writeHead(200, {
    ...CORS_HEADERS,
    'Content-Type': contentType
  });
  fs.createReadStream(imagePath).pipe(res);
});

server.listen(args.port, '127.0.0.1', () => {
  console.log(`SmartLocal image server running at http://127.0.0.1:${args.port}`);
  console.log(`Default root: ${defaultRoot}`);
});
