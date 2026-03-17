const assert = require('node:assert/strict');
const test = require('node:test');

const {
    buildValidationSignature,
    extractLocalizationsFromResponse,
    isMatchingRequestId,
    normalizeLocaleCode,
    parseImageCatalogPath,
    parseLocaleInput
} = require('../ui_helpers.js');

test('parseLocaleInput normalizes, canonicalizes, and dedupes locale input', () => {
    assert.deepEqual(
        parseLocaleInput('es, fil, pt_BR, zh-Hans, es, invalid_locale'),
        ['es', 'fil', 'pt-BR', 'zh-Hans']
    );
});

test('normalizeLocaleCode accepts valid 3-letter locales and rejects invalid shapes', () => {
    assert.equal(normalizeLocaleCode('fil'), 'fil');
    assert.equal(normalizeLocaleCode('pt_BR'), 'pt-BR');
    assert.equal(normalizeLocaleCode(''), null);
    assert.equal(normalizeLocaleCode('bad!locale'), null);
});

test('extractLocalizationsFromResponse supports root locale maps with valid 3-letter locales', () => {
    const extracted = extractLocalizationsFromResponse({
        fil: {
            headline: 'Kamusta'
        },
        'pt_BR': {
            cta: 'Continuar'
        }
    });

    assert.deepEqual(extracted, {
        fil: {
            headline: 'Kamusta'
        },
        'pt-BR': {
            cta: 'Continuar'
        }
    });
});

test('parseImageCatalogPath only accepts locale folders immediately under the selected root', () => {
    assert.deepEqual(
        parseImageCatalogPath('assets/en-US/file.png'),
        {
            locale: 'en-US',
            relPathFromLocale: 'en-US/file.png'
        }
    );

    assert.deepEqual(
        parseImageCatalogPath('assets/en-US/subdir/file.png'),
        {
            locale: 'en-US',
            relPathFromLocale: 'en-US/subdir/file.png'
        }
    );

    assert.equal(parseImageCatalogPath('assets/marketing/en-US/file.png'), null);
    assert.equal(parseImageCatalogPath('en/marketing/file.png'), null);
});

test('buildValidationSignature keys freshness off selectionId instead of label text', () => {
    const base = {
        languagesValue: 'es, fil',
        responseText: '{"localizations":{"es":{"id":"Hola"}}}',
        imageSourceEnabled: false,
        imageCatalogEntries: 0
    };

    const first = buildValidationSignature({
        ...base,
        selectionId: 'node-1'
    });
    const second = buildValidationSignature({
        ...base,
        selectionId: 'node-2'
    });

    assert.notEqual(first, second);
});

test('isMatchingRequestId only accepts the current in-flight request id', () => {
    assert.equal(isMatchingRequestId('req-1', 'req-1'), true);
    assert.equal(isMatchingRequestId('req-1', 'req-2'), false);
    assert.equal(isMatchingRequestId('', 'req-1'), false);
});
