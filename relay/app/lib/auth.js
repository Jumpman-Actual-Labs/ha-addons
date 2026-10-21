import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, agentEnv } from './config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CODEX_BIN = path.join(here, '..', 'node_modules', '.bin', 'codex');
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

const env = () => agentEnv({ CODEX_HOME: paths.codexHome });

export function codexStatus() {
  return new Promise((resolve) => {
    execFile(CODEX_BIN, ['login', 'status'], { env: env(), timeout: 15000 }, (err, stdout, stderr) => {
      const text = strip(`${stdout}${stderr}`).trim();
      resolve({ connected: !err && /logged in/i.test(text) && !/not logged in/i.test(text), detail: text });
    });
  });
}

let login = null; // { proc, log: string[], done, ok }

export function startCodexLogin() {
  if (login && !login.done) return login;
  const proc = spawn(CODEX_BIN, ['login', '--device-auth'], { env: env() });
  login = { proc, log: [], done: false, ok: false };
  const push = (b) => { for (const line of strip(b.toString()).split('\n')) if (line.trim()) login.log.push(line); };
  proc.stdout.on('data', push);
  proc.stderr.on('data', push);
  proc.on('close', (code) => { login.done = true; login.ok = code === 0; });
  setTimeout(() => { if (login && !login.done) proc.kill(); }, 15 * 60 * 1000);
  return login;
}

export function codexLoginState() {
  if (!login) return { running: false, log: [] };
  return { running: !login.done, ok: login.ok, log: login.log.slice(-30) };
}

export function codexLogout() {
  return new Promise((resolve) => execFile(CODEX_BIN, ['logout'], { env: env() }, () => resolve()));
}
