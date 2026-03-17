const fs = require('fs');
const path = require('path');

const UI_TEMPLATE = path.join(__dirname, '../ui.template.html');
const PROMPT_FILE = path.join(__dirname, '../prompt.md');
const UI_HELPERS_FILE = path.join(__dirname, '../ui_helpers.js');
const UI_OUTPUT = path.join(__dirname, '../ui.html');
const WATCH_MODE = process.argv.includes('--watch');

function buildUi() {
    const template = fs.readFileSync(UI_TEMPLATE, 'utf8');
    const prompt = fs.readFileSync(PROMPT_FILE, 'utf8');
    const uiHelpers = fs.readFileSync(UI_HELPERS_FILE, 'utf8');

    if (!template.includes('{{PROMPT}}') || !template.includes('{{UI_HELPERS}}')) {
        throw new Error('Template must contain {{PROMPT}} and {{UI_HELPERS}} placeholders');
    }

    const safePrompt = prompt.replace(/<\/textarea/gi, '<\\/textarea');
    const safeUiHelpers = uiHelpers.replace(/<\/script/gi, '<\\/script');
    const output = template
        .replace('{{PROMPT}}', safePrompt)
        .replace('{{UI_HELPERS}}', safeUiHelpers);
    fs.writeFileSync(UI_OUTPUT, output);
    console.log('✅ Generated ui.html with updated prompt');
}

function watchFile(filepath, onChange) {
    fs.watch(filepath, { persistent: true }, (eventType) => {
        if (eventType === 'change' || eventType === 'rename') {
            onChange();
        }
    });
}

function startWatchMode() {
    console.log('👀 Watching ui.template.html, prompt.md, and ui_helpers.js for changes...');
    let timeoutId = null;
    const rebuild = () => {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
        timeoutId = setTimeout(() => {
            try {
                buildUi();
            } catch (err) {
                console.error('❌ Error rebuilding UI:', err);
            }
        }, 50);
    };

    watchFile(UI_TEMPLATE, rebuild);
    watchFile(PROMPT_FILE, rebuild);
    watchFile(UI_HELPERS_FILE, rebuild);
}

try {
    buildUi();
    if (WATCH_MODE) {
        startWatchMode();
    }
} catch (err) {
    console.error('❌ Error building UI:', err);
    process.exit(1);
}
