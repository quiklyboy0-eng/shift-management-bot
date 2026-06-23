import { spawn } from 'child_process';
import { watch } from 'fs';
import path from 'path';

const scriptPath = path.resolve('index.js');
let child = null;
let restartTimer = null;

function startBot() {
  console.log('Starting shift bot...');
  child = spawn(process.execPath, [scriptPath], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });

  child.on('exit', (code, signal) => {
    console.log(`Shift bot stopped (code=${code}, signal=${signal}).`);
    child = null;
  });
}

function restartBot(reason) {
  if (restartTimer) {
    clearTimeout(restartTimer);
  }
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (child) {
      console.log(`Restarting shift bot because ${reason}...`);
      child.kill('SIGTERM');
      child.on('exit', () => startBot());
    } else {
      startBot();
    }
  }, 500);
}

function shouldWatchFile(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.includes('node_modules') || normalized.includes('.git')) return false;
  return normalized.endsWith('.js') || normalized.endsWith('.json') || normalized.endsWith('.env');
}

watch('.', { recursive: true }, (eventType, filename) => {
  if (!filename) return;
  if (!shouldWatchFile(filename)) return;
  restartBot(filename);
});

startBot();
