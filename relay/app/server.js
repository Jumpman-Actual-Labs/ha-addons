import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOptions, ensureDirs, paths, internal } from './lib/config.js';
import { haAvailable, findEntities, getEntity, getForecast } from './lib/ha.js';
import { toText, toTextLog, exportFilename } from './lib/export.js';
import { listFiles, snapshot, changedSince, resolveSafe, contentType } from './lib/files.js';
import * as store from './lib/store.js';
import { route } from './lib/router.js';
import { runClaude, claudeConnected } from './lib/claude.js';
import { runCodex } from './lib/codex.js';
import { codexStatus, startCodexLogin, codexLoginState, codexLogout } from './lib/auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8099);
const DEV = process.env.RELAY_DEV === '1';
const INGRESS_IP = '172.30.32.2';

ensureDirs();
const opts = loadOptions();
const cooldowns = { claude: 0, codex: 0 };
const running = new Map(); // conversationId -> AbortController
const NAMES = { claude: 'Claude', codex: 'ChatGPT' };
export const LOOKUP_TOKEN = 'NEEDS_LOOKUP';
const runners = { claude: runClaude, codex: runCodex };

// ---------- helpers ----------
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
const readBody = (req) => new Promise((resolve) => {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 2e6) req.destroy(); });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
});
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };

// Ask a provider for a summary in a fresh, tool-less session. Used for compaction.
async function summarize(provider, conv) {
  const prompt = 'Summarize this conversation so it can be continued in a new session. Keep decisions, facts, file paths, open tasks and the user\'s preferences. Be compact.\n\n'
    + store.digest(conv, { turns: 40, perMessage: 4000 });
  let text = '';
  const ac = new AbortController();
  for await (const ev of runners[provider]({ prompt, sessionId: null, route: { provider, mode: 'chat', effort: 'low', heavy: false }, opts, abortController: ac })) {
    if (ev.type === 'text') text += ev.delta;
  }
  return text.trim();
}

// ---------- chat ----------
async function handleChat(req, res) {
  const body = await readBody(req);
  const text = String(body.text || '').trim();
  if (!text) return send(res, 400, { error: 'Type a message first.' });

  let conv = body.conversationId ? store.load(body.conversationId) : null;
  if (!conv) conv = store.newConversation();
  if (running.has(conv.id)) return send(res, 409, { error: 'This chat is still working. Stop it or wait for it to finish.' });

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const emit = (ev) => { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* client left; keep working and save */ } };
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 15000);

  const r = route(text, body, conv, opts, cooldowns);
  const ac = new AbortController();
  running.set(conv.id, ac);

  if (conv.messages.length === 0) conv.title = text.replace(/\s+/g, ' ').slice(0, 60);
  emit({ type: 'conversation', id: conv.id, title: conv.title });

  const notes = [];
  try {
    // Switching providers mid-chat: hand over a short digest instead of the full transcript.
    if (r.switched && conv.messages.length) {
      conv.carryover = store.digest(conv);
      conv.sessionId = null;
      conv.compactedAt = conv.messages.length;
      notes.push({ id: `n${Date.now()}`, kind: 'note', label: `Moved this chat to ${NAMES[r.provider]} with a summary of the conversation so far`, status: 'done' });
    }
    conv.provider = r.provider;

    // Compaction: once the carried context gets big, summarize and start a fresh session.
    if (conv.sessionId && store.estimateTokens(conv) > opts.compact_at_tokens) {
      emit({ type: 'step', step: { id: 'compact', kind: 'note', label: 'Summarizing the conversation to keep it light', status: 'running' } });
      const summary = await summarize(r.provider, conv);
      if (summary) {
        conv.carryover = summary;
        conv.sessionId = null;
        conv.compactedAt = conv.messages.length;
        notes.push({ id: 'compact', kind: 'note', label: 'Summarized the conversation and continued in a fresh session', status: 'done' });
      }
    }

    const prompt = conv.carryover && !conv.sessionId
      ? `Context carried over from earlier in this conversation:\n\n${conv.carryover}\n\n---\n\n${text}`
      : text;

    conv.messages.push({ role: 'user', text, ts: Date.now() });
    const reply = { role: 'assistant', text: '', steps: [...notes], route: { provider: r.provider, mode: r.mode, effort: r.effort, heavy: r.heavy }, ts: Date.now() };
    conv.messages.push(reply);
    emit({ type: 'route', route: reply.route });
    for (const s of notes) emit({ type: 'step', step: s });

    let lastSave = Date.now();

    // One pass through a provider. In chat mode, the first few characters are held back so a
    // NEEDS_LOOKUP reply (the model saying it needs current information) never reaches the screen.
    const runPass = async (route, passPrompt) => {
      const holdBack = route.mode === 'chat';
      let pending = '';
      let flushed = !holdBack;
      let triedTools = false;
      let heldError = null;
      const flush = () => { if (pending) { reply.text += pending; emit({ type: 'text', delta: pending }); pending = ''; } flushed = true; };
      for await (const ev of runners[r.provider]({ prompt: passPrompt, sessionId: conv.sessionId, route, opts, abortController: ac })) {
        switch (ev.type) {
          case 'session':
            conv.sessionId = ev.sessionId;
            conv.carryover = null; // now held by the provider's session
            break;
          case 'text':
            if (flushed) { reply.text += ev.delta; emit(ev); break; }
            pending += ev.delta;
            if (pending.length >= LOOKUP_TOKEN.length + 4 && !pending.trimStart().startsWith(LOOKUP_TOKEN)) flush();
            break;
          case 'step': {
            // In chat mode there are no tools; an attempted tool call means the request needs the agent.
            if (holdBack && ev.step.kind !== 'note') { triedTools = true; break; }
            const i = reply.steps.findIndex((s) => s.id === ev.step.id);
            if (i >= 0) reply.steps[i] = { ...reply.steps[i], ...ev.step }; else reply.steps.push(ev.step);
            emit(ev);
            break;
          }
          case 'limit': {
            const until = ev.resetsAt || Date.now() + 60 * 60 * 1000;
            cooldowns[ev.provider] = until;
            const other = ev.provider === 'claude' ? 'codex' : 'claude';
            reply.limit = { provider: ev.provider, until, other };
            emit({ type: 'limit', provider: ev.provider, until, other, otherName: NAMES[other], name: NAMES[ev.provider] });
            break;
          }
          case 'warning':
            emit(ev);
            break;
          case 'context':
            reply.context = ev.tokens;
            break;
          case 'usage':
            reply.usage = ev.usage;
            break;
          case 'error':
            if (holdBack && !heldError) { heldError = ev.message; break; }
            if (reply.error) break; // first error is the useful one
            reply.error = ev.message;
            emit(ev);
            break;
          case 'stopped':
            reply.stopped = true;
            emit(ev);
            break;
          default:
            break;
        }
        if (Date.now() - lastSave > 5000) { store.save(conv); lastSave = Date.now(); }
      }
      if (holdBack && triedTools && !reply.stopped) { pending = ''; return 'needs-agent'; }
      if (holdBack && pending.trim().startsWith(LOOKUP_TOKEN)) return 'needs-lookup';
      flush();
      if (heldError && !reply.error) { reply.error = heldError; emit({ type: 'error', message: heldError }); }
      return 'ok';
    };

    const before = snapshot();
    const outcome = await runPass(r, prompt);

    // Chat mode has no tools. If the model needs current information or tries to use a tool,
    // rerun the same request in the right mode instead of failing.
    const escalate = async (mode, label, passPrompt) => {
      const next = { ...r, mode, effort: r.effort === 'low' ? 'medium' : r.effort };
      reply.route = { provider: next.provider, mode: next.mode, effort: next.effort, heavy: next.heavy };
      emit({ type: 'route', route: reply.route });
      const note = { id: `esc${Date.now()}`, kind: 'note', label, status: 'done' };
      reply.steps.push(note);
      emit({ type: 'step', step: note });
      await runPass(next, passPrompt);
    };
    if (outcome === 'needs-lookup' && !reply.error && !reply.stopped) {
      await escalate('lookup', 'This needs current information, so Relay looked it up', `Use your tools to answer my last question with current information: ${text}`);
    } else if (outcome === 'needs-agent' && !reply.stopped) {
      await escalate('agent', 'This needs tools, so Relay switched to agent mode', text);
    }

    // Link any files this reply created or changed so they can be downloaded from the chat.
    const made = changedSince(before);
    if (made.length) {
      reply.files = made.map((f) => ({ path: f.path, size: f.size }));
      emit({ type: 'files', files: reply.files });
    }
    // Anything still marked running when the turn ends didn't finish.
    for (const st of reply.steps) {
      if (st.status === 'running') { st.status = reply.error || reply.stopped ? 'failed' : 'done'; emit({ type: 'step', step: st }); }
    }
    store.save(conv);
    emit({ type: 'done', id: conv.id });
  } catch (err) {
    emit({ type: 'error', message: String(err?.message || err) });
    store.save(conv);
  } finally {
    clearInterval(ping);
    running.delete(conv.id);
    try { res.end(); } catch { /* ignore */ }
  }
}

// ---------- server ----------
const HA_HANDLERS = { ha_find_entities: findEntities, ha_get_entity: getEntity, ha_get_forecast: getForecast };

const server = http.createServer(async (req, res) => {
  const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
  const url = new URL(req.url, 'http://local');
  const p = url.pathname.replace(/\/+$/, '') || '/';

  // Internal, read-only Home Assistant lookups for the agents' MCP server (loopback + per-boot secret).
  if (p.startsWith('/internal/')) {
    if (ip !== '127.0.0.1' || req.headers['x-relay-secret'] !== internal.secret) return send(res, 403, { error: 'Forbidden.' });
    const m = p.match(/^\/internal\/ha\/(\w+)$/);
    const fn = m && HA_HANDLERS[m[1]];
    if (!fn || req.method !== 'POST') return send(res, 404, { error: 'Unknown lookup.' });
    if (!opts.home_access || !haAvailable()) return send(res, 400, { error: 'Home Assistant access is turned off in Relay\'s configuration.' });
    try { return send(res, 200, await fn(opts, await readBody(req))); }
    catch (err) { return send(res, 400, { error: String(err?.message || err) }); }
  }

  if (!DEV && ip !== INGRESS_IP) return send(res, 403, { error: 'Relay is only reachable through Home Assistant.' });

  try {
    if (req.method === 'GET' && STATIC[p]) {
      const [file, type] = STATIC[p];
      return send(res, 200, fs.readFileSync(path.join(here, 'public', file)), type);
    }

    if (p === '/api/status' && req.method === 'GET') {
      const codex = await codexStatus();
      return send(res, 200, {
        claude: { connected: claudeConnected(opts) },
        codex: { connected: codex.connected },
        home: { enabled: !!opts.home_access, available: haAvailable() },
        cooldowns,
        defaults: { chat: opts.default_chat_provider, agent: opts.default_agent_provider, claudeModel: opts.claude_model, claudeHeavy: opts.claude_heavy_model },
        workspace: paths.workspace,
      });
    }

    if (p === '/api/conversations' && req.method === 'GET') return send(res, 200, store.list());

    if (p === '/api/files' && req.method === 'GET') return send(res, 200, listFiles().slice(0, 300));
    if (p === '/api/files/download' && req.method === 'GET') {
      const full = resolveSafe(url.searchParams.get('path'));
      if (!full) return send(res, 404, { error: 'File not found in the workspace.' });
      const name = path.basename(full).replace(/["\\\r\n]/g, '_');
      res.writeHead(200, {
        'Content-Type': contentType(full),
        'Content-Disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(path.basename(full))}`,
        'Content-Length': fs.statSync(full).size,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      return fs.createReadStream(full).pipe(res);
    }

    const ex = p.match(/^\/api\/conversations\/([\w-]+)\/export$/);
    if (ex && req.method === 'GET') {
      const c = store.load(ex[1]);
      if (!c) return send(res, 404, { error: 'Chat not found.' });
      if (url.searchParams.get('format') === 'text') return send(res, 200, toText(c), 'text/plain; charset=utf-8');
      const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' };
      if (url.searchParams.get('download') === '1') headers['Content-Disposition'] = `attachment; filename="${exportFilename(c)}"`;
      res.writeHead(200, headers);
      // UTF-8 byte-order mark so Windows Notepad shows symbols like °F correctly.
      return res.end('\uFEFF' + toTextLog(c));
    }

    const m = p.match(/^\/api\/conversations\/([\w-]+)$/);
    if (m && req.method === 'GET') {
      const c = store.load(m[1]);
      return c ? send(res, 200, { ...c, running: running.has(c.id) }) : send(res, 404, { error: 'Chat not found.' });
    }
    if (m && req.method === 'DELETE') {
      running.get(m[1])?.abort();
      store.remove(m[1]);
      return send(res, 200, { ok: true });
    }

    if (p === '/api/chat' && req.method === 'POST') return handleChat(req, res);

    if (p === '/api/stop' && req.method === 'POST') {
      const { conversationId } = await readBody(req);
      running.get(conversationId)?.abort();
      return send(res, 200, { ok: true });
    }

    if (p === '/api/auth/codex/login' && req.method === 'POST') { startCodexLogin(); return send(res, 200, codexLoginState()); }
    if (p === '/api/auth/codex/login' && req.method === 'GET') return send(res, 200, codexLoginState());
    if (p === '/api/auth/codex/logout' && req.method === 'POST') { await codexLogout(); return send(res, 200, { ok: true }); }

    return send(res, 404, { error: 'Not found.' });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: String(err?.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`Relay listening on ${PORT} (workspace ${paths.workspace})`);
  if (DEV) console.log(`dev internal secret ${internal.secret}`);
});
