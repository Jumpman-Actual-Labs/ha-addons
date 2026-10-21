// Files in the agent workspace: listing, safe path resolution for downloads,
// and before/after snapshots so each reply can link the files it created or changed.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';

const SKIP = new Set(['node_modules', '.git', '__pycache__', '.venv', '.cache']);
const MAX_FILES = 2000;

function walk(dir, depth, out) {
  if (depth > 4 || out.length >= MAX_FILES) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, depth + 1, out);
    else if (e.isFile()) {
      try {
        const st = fs.statSync(full);
        out.push({ path: path.relative(paths.workspace, full).split(path.sep).join('/'), size: st.size, mtime: st.mtimeMs });
      } catch { /* vanished */ }
    }
    if (out.length >= MAX_FILES) return;
  }
}

export function listFiles() {
  const out = [];
  walk(paths.workspace, 0, out);
  return out.sort((a, b) => b.mtime - a.mtime);
}

export function snapshot() {
  const map = new Map();
  for (const f of listFiles()) map.set(f.path, f.mtime);
  return map;
}

// Files that are new or modified since the snapshot was taken.
export function changedSince(before) {
  return listFiles().filter((f) => !before.has(f.path) || before.get(f.path) !== f.mtime).slice(0, 20);
}

// Resolves a workspace-relative path, refusing anything that escapes the workspace (including via symlinks).
export function resolveSafe(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return null;
  const root = fs.realpathSync(paths.workspace);
  let full;
  try { full = fs.realpathSync(path.resolve(root, rel)); } catch { return null; }
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  try { if (!fs.statSync(full).isFile()) return null; } catch { return null; }
  return full;
}

const TYPES = {
  '.md': 'text/markdown', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json', '.html': 'text/html',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip', '.yaml': 'text/yaml', '.yml': 'text/yaml',
};
export const contentType = (file) => TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
