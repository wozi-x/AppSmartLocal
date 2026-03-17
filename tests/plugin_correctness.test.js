const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const CODE_PATH = path.resolve(__dirname, '../code.js');
const PLUGIN_DATA_SOURCE_NODE_ID = 'smartlocal_source_node_id';
const PLUGIN_DATA_SOURCE_FRAME_ID = 'smartlocal_source_frame_id';
const PLUGIN_DATA_LOCALE = 'smartlocal_locale';

function withPluginData(node, initialValues = {}) {
    const store = new Map(Object.entries(initialValues));
    node.getPluginData = (key) => store.get(key) || '';
    node.setPluginData = (key, value) => {
        store.set(key, value);
    };
    return node;
}

function linkChildren(parent, children) {
    parent.children = children;
    for (const child of children) {
        child.parent = parent;
        if (Array.isArray(child.children)) {
            linkChildren(child, child.children);
        }
    }
}

function collectTextNodes(node) {
    const texts = [];
    if (node.type === 'TEXT') {
        texts.push(node);
    }

    if (Array.isArray(node.children)) {
        for (const child of node.children) {
            texts.push(...collectTextNodes(child));
        }
    }

    return texts;
}

function createTextNode({ id, characters, hasMissingFont = false }) {
    return withPluginData({
        type: 'TEXT',
        id,
        name: id,
        visible: true,
        characters,
        hasMissingFont,
        height: 24,
        width: 120,
        fontSize: 14,
        parent: null
    });
}

function createImageNode({ id, name, fills, pluginData }) {
    return withPluginData({
        type: 'RECTANGLE',
        id,
        name,
        visible: true,
        fills,
        parent: null
    }, pluginData);
}

function createFrame({ id, name, children = [], pluginData = {} }) {
    const frame = withPluginData({
        type: 'FRAME',
        id,
        name,
        visible: true,
        width: 320,
        height: 200,
        x: 0,
        y: 0,
        children: [],
        parent: null,
        findAllWithCriteria(criteria) {
            if (Array.isArray(criteria.types) && criteria.types.includes('TEXT')) {
                return collectTextNodes(frame);
            }

            return [];
        }
    }, pluginData);

    linkChildren(frame, children);
    return frame;
}

function createParent(children) {
    const parent = {
        type: 'SECTION',
        children: []
    };
    for (const child of children) {
        child.parent = parent;
    }
    parent.children = children;
    return parent;
}

function createPluginEnv(selectionNode) {
    const messages = [];
    const figma = {
        mixed: Symbol('mixed'),
        skipInvisibleInstanceChildren: false,
        showUI() {},
        on() {},
        notify() {},
        loadFontAsync: async () => {},
        ui: {
            postMessage(message) {
                messages.push(message);
            },
            onmessage: null
        },
        clientStorage: {
            async getAsync() {
                return null;
            },
            async setAsync() {}
        },
        currentPage: {
            id: 'page-1',
            name: 'Page 1',
            selection: selectionNode ? [selectionNode] : [],
            findAllWithCriteria() {
                return [];
            }
        }
    };

    return {
        figma,
        messages
    };
}

function loadPlugin(selectionNode) {
    const env = createPluginEnv(selectionNode);
    delete require.cache[CODE_PATH];
    global.figma = env.figma;
    global.__html__ = '';
    require(CODE_PATH);
    return env;
}

function getLastMessage(messages, type) {
    return messages.filter((message) => message.type === type).at(-1);
}

test('generate-prompt emits a JSON-safe output example', { concurrency: false }, async (t) => {
    t.after(() => {
        delete global.figma;
        delete global.__html__;
    });

    const textNode = createTextNode({
        id: 'text-1',
        characters: 'He said "Hi"\nNext line'
    });
    const frame = createFrame({
        id: 'frame-1',
        name: 'Card',
        children: [textNode]
    });

    const env = loadPlugin(frame);
    await env.figma.ui.onmessage({
        type: 'generate-prompt',
        languages: ['es'],
        promptTemplate: 'Translate the copy.'
    });

    const copyMessage = getLastMessage(env.messages, 'copy-to-clipboard');
    const promptMessage = getLastMessage(env.messages, 'prompt-generated');
    assert.ok(copyMessage);
    assert.ok(promptMessage);
    assert.equal(copyMessage.copyRequestId, promptMessage.copyRequestId);

    const outputFormat = copyMessage.text.split('OUTPUT FORMAT:\n')[1];
    const parsed = JSON.parse(outputFormat);
    assert.equal(parsed.localizations.es['text-1'], 'translated text for He said "Hi"\nNext line');
});

test('validation blocks updates for untagged legacy variants', { concurrency: false }, async (t) => {
    t.after(() => {
        delete global.figma;
        delete global.__html__;
    });

    const sourceText = createTextNode({
        id: 'text-1',
        characters: 'Hello'
    });
    const sourceFrame = createFrame({
        id: 'frame-1',
        name: 'Card',
        children: [sourceText]
    });
    const legacyText = createTextNode({
        id: 'legacy-text-1',
        characters: 'Hola'
    });
    const legacyVariant = createFrame({
        id: 'frame-2',
        name: 'Card_es',
        children: [legacyText]
    });
    createParent([sourceFrame, legacyVariant]);

    const env = loadPlugin(sourceFrame);
    await env.figma.ui.onmessage({
        type: 'validate-localization',
        requestId: 'validate-legacy',
        localizations: {
            es: {
                'text-1': 'Hola'
            }
        },
        locales: ['es'],
        imageSource: {
            enabled: false
        }
    });

    const validationMessage = getLastMessage(env.messages, 'validation-result');
    assert.ok(validationMessage);
    assert.equal(validationMessage.requestId, 'validate-legacy');
    const localeSummary = validationMessage.validation.locales.find((locale) => locale.locale === 'es');
    assert.equal(localeSummary.canApply, false);
    assert.ok(localeSummary.issues.some((issue) => issue.code === 'unsupported-legacy-variant'));
    assert.equal(validationMessage.validation.canApply, false);
});

test('validation blocks create flows when source text has missing fonts', { concurrency: false }, async (t) => {
    t.after(() => {
        delete global.figma;
        delete global.__html__;
    });

    const sourceText = createTextNode({
        id: 'text-1',
        characters: 'Hello',
        hasMissingFont: true
    });
    const sourceFrame = createFrame({
        id: 'frame-1',
        name: 'Card',
        children: [sourceText]
    });
    createParent([sourceFrame]);

    const env = loadPlugin(sourceFrame);
    await env.figma.ui.onmessage({
        type: 'validate-localization',
        requestId: 'validate-fonts',
        localizations: {
            es: {
                'text-1': 'Hola'
            }
        },
        locales: ['es'],
        imageSource: {
            enabled: false
        }
    });

    const validationMessage = getLastMessage(env.messages, 'validation-result');
    const localeSummary = validationMessage.validation.locales.find((locale) => locale.locale === 'es');
    assert.equal(localeSummary.canApply, false);
    assert.ok(localeSummary.issues.some((issue) => issue.code === 'missing-fonts'));
});

test('validation blocks image replacement when mapped target fills are no longer replaceable', { concurrency: false }, async (t) => {
    t.after(() => {
        delete global.figma;
        delete global.__html__;
    });

    const sourceImage = createImageNode({
        id: 'image-1',
        name: 'Hero',
        fills: [{ type: 'IMAGE', imageHash: 'source' }]
    });
    const sourceFrame = createFrame({
        id: 'frame-1',
        name: 'Card',
        children: [sourceImage]
    });
    const targetImage = createImageNode({
        id: 'image-2',
        name: 'Hero',
        fills: [{ type: 'SOLID' }],
        pluginData: {
            [PLUGIN_DATA_SOURCE_NODE_ID]: 'image-1'
        }
    });
    const taggedVariant = createFrame({
        id: 'frame-2',
        name: 'Card_es',
        children: [targetImage],
        pluginData: {
            [PLUGIN_DATA_SOURCE_FRAME_ID]: 'frame-1',
            [PLUGIN_DATA_LOCALE]: 'es',
            [PLUGIN_DATA_SOURCE_NODE_ID]: 'frame-1'
        }
    });
    createParent([sourceFrame, taggedVariant]);

    const env = loadPlugin(sourceFrame);
    await env.figma.ui.onmessage({
        type: 'validate-localization',
        requestId: 'validate-images',
        localizations: {},
        locales: ['es'],
        imageSource: {
            enabled: true,
            mode: 'folder',
            catalog: {
                version: 1,
                mode: 'folder',
                entries: [
                    {
                        key: 'es::Hero.png::1::1::0',
                        locale: 'es',
                        relPath: 'es/Hero.png',
                        stem: 'Hero',
                        extension: 'png',
                        size: 1
                    }
                ]
            }
        }
    });

    const validationMessage = getLastMessage(env.messages, 'validation-result');
    const localeSummary = validationMessage.validation.locales.find((locale) => locale.locale === 'es');
    assert.equal(localeSummary.canApply, false);
    assert.ok(localeSummary.issues.some((issue) => issue.code === 'unreplaceable-image-fills'));
});
