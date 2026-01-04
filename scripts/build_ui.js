const fs = require('fs');
const path = require('path');

const UI_TEMPLATE = path.join(__dirname, '../ui.template.html');
const PROMPT_FILE = path.join(__dirname, '../prompt.md');
const UI_OUTPUT = path.join(__dirname, '../ui.html');

try {
    // Read files
    const template = fs.readFileSync(UI_TEMPLATE, 'utf8');
    const prompt = fs.readFileSync(PROMPT_FILE, 'utf8');

    // Inject prompt (escape backticks if necessary, but simple replacement is fine for <textarea>)
    // Note: We might want to escape HTML entities if the prompt contains them, 
    // but for a textarea value, largely it's okay unless it contains </textarea>
    // Let's do a basic safety check for </textarea>
    const safePrompt = prompt.replace(/<\/textarea/gi, '<\\/textarea');

    const output = template.replace('{{PROMPT}}', safePrompt);

    // Write output
    fs.writeFileSync(UI_OUTPUT, output);
    console.log('✅ Generated ui.html with updated prompt');

} catch (err) {
    console.error('❌ Error building UI:', err);
    process.exit(1);
}
