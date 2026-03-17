const { spawn } = require('child_process');
const path = require('path');

const repoRoot = path.join(__dirname, '..');

function startProcess(command, args) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });

  child.on('exit', code => {
    if (code !== 0) {
      process.exitCode = code || 1;
    }
  });

  return child;
}

const uiWatcher = startProcess('node', ['scripts/build_ui.js', '--watch']);
const tscWatcher = startProcess('npx', ['tsc', '--watch']);

function shutdown() {
  uiWatcher.kill();
  tscWatcher.kill();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
