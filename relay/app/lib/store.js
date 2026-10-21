import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from './config.js';

const file = (id) => path.join(paths.conversations, `${id.replace(/[^a-z0-9-]/gi, '')}.json`);

export function newConversation() {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: 'New chat',
    created: now,
    updated: now,
    provider: null,      // bound on first message: 'claude' | 'codex'
    sessionId: null,     // provider's own session/thread id
    carryover: null,     // summary or digest to prepend after a compaction or hand-off
    messages: [],
  };
}

export function save(conv) {
  conv.updated = Date.now();
  const tmp = file(conv.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(conv));
  fs.renameSync(tmp, file(conv.id));
}

export function load(id) {
  try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return null; }
}

export function remove(id) {
  try { fs.unlinkSync(file(id)); } catch { /* already gone */ }
}

export function list() {
  return fs.readdirSync(paths.conversations)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(paths.conversations, f), 'utf8'));
        return { id: c.id, title: c.title, updated: c.updated, provider: c.provider };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.updated - a.updated);
}

// Rough token estimate for what the provider is carrying for this conversation.
export function estimateTokens(conv) {
  let chars = (conv.carryover || '').length;
  const since = conv.compactedAt || 0;
  for (const m of conv.messages.slice(since)) {
    chars += (m.text || '').length;
    for (const s of m.steps || []) chars += (s.label || '').length + (s.outputChars || 0);
  }
  return Math.round(chars / 3.2);
}

// Short transcript used to hand a conversation to the other provider.
export function digest(conv, { turns = 12, perMessage = 1500 } = {}) {
  const recent = conv.messages.slice(-turns);
  const lines = recent.map((m) => {
    const who = m.role === 'user' ? 'User' : `Assistant (${m.route?.provider === 'codex' ? 'ChatGPT' : 'Claude'})`;
    let t = (m.text || '').trim();
    if (t.length > perMessage) t = t.slice(0, perMessage) + ' […]';
    const steps = (m.steps || []).filter((s) => s.kind !== 'note').map((s) => `  - ${s.label}`).join('\n');
    return `${who}: ${t}${steps ? `\n  Steps taken:\n${steps}` : ''}`;
  });
  const head = conv.carryover ? `Earlier summary:\n${conv.carryover}\n\n` : '';
  return `${head}${lines.join('\n\n')}`;
}
