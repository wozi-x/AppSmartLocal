(function (globalScope) {
    const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

    function isObjectRecord(value) {
        return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    }

    function normalizeLocaleCode(value) {
        if (typeof value !== 'string') {
            return null;
        }

        const trimmed = value.trim().replace(/_/g, '-');
        if (!trimmed || !LOCALE_PATTERN.test(trimmed)) {
            return null;
        }

        try {
            const canonical = Intl.getCanonicalLocales(trimmed)[0];
            return canonical || trimmed;
        } catch (_err) {
            return trimmed;
        }
    }

    function parseLocaleInput(value) {
        if (typeof value !== 'string') {
            return [];
        }

        const locales = [];
        const seen = new Set();
        for (const rawLocale of value.split(',')) {
            const normalized = normalizeLocaleCode(rawLocale);
            if (!normalized) {
                continue;
            }

            const key = normalized.toLowerCase();
            if (seen.has(key)) {
                continue;
            }

            seen.add(key);
            locales.push(normalized);
        }

        return locales;
    }

    function sanitizeTranslations(value) {
        if (!isObjectRecord(value)) {
            return null;
        }

        const translations = {};
        for (const [nodeId, text] of Object.entries(value)) {
            if (typeof text === 'string') {
                translations[nodeId] = text;
            }
        }

        return translations;
    }

    function mergeLocalizations(target, source) {
        for (const [locale, translations] of Object.entries(source)) {
            if (!Object.prototype.hasOwnProperty.call(target, locale)) {
                target[locale] = {};
            }

            for (const [nodeId, text] of Object.entries(translations)) {
                target[locale][nodeId] = text;
            }
        }
    }

    function sanitizeLocalizations(value, requireLocaleLikeKeys) {
        if (!isObjectRecord(value)) {
            return null;
        }

        const localizations = {};
        for (const [locale, translations] of Object.entries(value)) {
            const normalizedLocale = normalizeLocaleCode(locale);
            if (requireLocaleLikeKeys && !normalizedLocale) {
                continue;
            }

            if (!normalizedLocale) {
                continue;
            }

            const sanitizedTranslations = sanitizeTranslations(translations);
            if (!sanitizedTranslations) {
                continue;
            }

            if (!Object.prototype.hasOwnProperty.call(localizations, normalizedLocale)) {
                localizations[normalizedLocale] = {};
            }

            mergeLocalizations(localizations, {
                [normalizedLocale]: sanitizedTranslations
            });
        }

        return Object.keys(localizations).length > 0 ? localizations : null;
    }

    function extractLocalizationsFromResponse(response) {
        if (!isObjectRecord(response)) {
            return null;
        }

        const direct = sanitizeLocalizations(response.localizations, false);
        if (direct) {
            return direct;
        }

        const nestedContainers = ['output', 'result', 'data', 'combinedOutput'];
        for (const key of nestedContainers) {
            const container = response[key];
            if (!isObjectRecord(container)) {
                continue;
            }

            const nestedLocalizations = sanitizeLocalizations(container.localizations, false);
            if (nestedLocalizations) {
                return nestedLocalizations;
            }
        }

        if (Array.isArray(response.frames)) {
            const merged = {};

            for (const frame of response.frames) {
                if (!isObjectRecord(frame)) {
                    continue;
                }

                const candidates = [
                    frame.localizations,
                    isObjectRecord(frame.output) ? frame.output.localizations : null,
                    isObjectRecord(frame.result) ? frame.result.localizations : null,
                    isObjectRecord(frame.data) ? frame.data.localizations : null
                ];

                for (const candidate of candidates) {
                    const frameLocalizations = sanitizeLocalizations(candidate, false);
                    if (frameLocalizations) {
                        mergeLocalizations(merged, frameLocalizations);
                    }
                }
            }

            if (Object.keys(merged).length > 0) {
                return merged;
            }
        }

        return sanitizeLocalizations(response, true);
    }

    function buildValidationSignature(input) {
        const selectionId = typeof input.selectionId === 'string' ? input.selectionId : '';
        const languagesValue = typeof input.languagesValue === 'string' ? input.languagesValue : '';
        const responseText = typeof input.responseText === 'string' ? input.responseText : '';
        const imageSourceEnabled = Boolean(input.imageSourceEnabled);
        const imageCatalogEntries = Number.isInteger(input.imageCatalogEntries) ? input.imageCatalogEntries : 0;

        return JSON.stringify({
            selectionId,
            languages: parseLocaleInput(languagesValue).join(','),
            response: responseText.trim(),
            imageSourceEnabled,
            imageCatalogEntries
        });
    }

    function parseImageCatalogPath(relativePath) {
        if (typeof relativePath !== 'string') {
            return null;
        }

        const normalizedPath = relativePath.replace(/\\/g, '/').trim();
        if (!normalizedPath) {
            return null;
        }

        const pathSegments = normalizedPath.split('/').filter(Boolean);
        if (pathSegments.length < 3) {
            return null;
        }

        const locale = normalizeLocaleCode(pathSegments[1]);
        if (!locale) {
            return null;
        }

        return {
            locale,
            relPathFromLocale: pathSegments.slice(1).join('/')
        };
    }

    function isMatchingRequestId(expectedRequestId, actualRequestId) {
        return typeof expectedRequestId === 'string'
            && expectedRequestId.length > 0
            && expectedRequestId === actualRequestId;
    }

    const api = {
        LOCALE_PATTERN,
        isObjectRecord,
        normalizeLocaleCode,
        parseLocaleInput,
        sanitizeTranslations,
        sanitizeLocalizations,
        mergeLocalizations,
        extractLocalizationsFromResponse,
        buildValidationSignature,
        parseImageCatalogPath,
        isMatchingRequestId
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    globalScope.SmartLocalUiHelpers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
