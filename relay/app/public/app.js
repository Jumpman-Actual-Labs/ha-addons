(() => {
  const $ = (id) => document.getElementById(id);
  const NAMES = { claude: 'Claude', codex: 'ChatGPT' };
  const EFFORT = { low: 'low effort', medium: 'medium effort', high: 'high effort' };
  const state = { convId: null, controls: { provider: 'auto', mode: 'auto', effort: 'auto' }, busy: false, status: null, openRequest: 0 };
  try { const saved = JSON.parse(localStorage.getItem('relay-controls') || '{}'); for (const k of Object.keys(state.controls)) if (({provider:['auto','claude','codex'],mode:['auto','chat','lookup','agent'],effort:['auto','low','medium','high']})[k].includes(saved[k])) state.controls[k] = saved[k]; } catch {}

  // Markdown is built with DOM nodes only. Model text is never parsed as HTML.
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  };
  const fileUrl = (p) => `./api/files/download?path=${encodeURIComponent(p)}`;
  const fmtSize = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
  function fileLink(f) {
    const a = make('a', 'file-chip');
    a.href = fileUrl(f.path);
    a.setAttribute('download', '');
    a.append(make('span', 'file-icon', '⤓'), make('span', 'file-name', f.path.split('/').pop()), make('span', 'file-size', fmtSize(f.size || 0)));
    a.title = f.path;
    return a;
  }
  function inlineNodes(container, source) {
    const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
    let last = 0;
    const input = String(source ?? '');
    for (const match of input.matchAll(pattern)) {
      const at = match.index;
      if (at > last) container.append(document.createTextNode(input.slice(last, at)));
      const token = match[0];
      if (token.startsWith('`')) container.append(make('code', '', token.slice(1, -1)));
      else if (token.startsWith('**')) container.append(make('strong', '', token.slice(2, -2)));
      else if (token.startsWith('*')) container.append(make('em', '', token.slice(1, -1)));
      else {
        const split = token.lastIndexOf('](');
        const label = token.slice(1, split);
        const url = token.slice(split + 2, -1);
        try {
          const parsed = new URL(url);
          if (['http:', 'https:'].includes(parsed.protocol)) {
            const link = make('a', '', label);
            link.href = parsed.href;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            container.append(link);
          } else container.append(document.createTextNode(token));
        } catch { container.append(document.createTextNode(token)); }
      }
      last = at + token.length;
    }
    if (last < input.length) container.append(document.createTextNode(input.slice(last)));
  }
  function renderMarkdown(container, source) {
    container.replaceChildren();
    const text = String(source ?? '');
    const parts = text.split('```');
    parts.forEach((part, index) => {
      if (index % 2) {
        const first = part.indexOf('\n');
        const code = first < 0 ? part : part.slice(first + 1);
        const pre = make('pre');
        pre.append(make('code', '', code.replace(/\n$/, '')));
        container.append(pre);
        return;
      }
      for (const block of part.split(/\n{2,}/)) {
        const lines = block.split('\n').filter(line => line.trim());
        if (!lines.length) continue;
        const unordered = lines.every(line => /^\s*[-*]\s+/.test(line));
        const ordered = lines.every(line => /^\s*\d+[.)]\s+/.test(line));
        if (unordered || ordered) {
          const list = make(ordered ? 'ol' : 'ul');
          for (const line of lines) {
            const li = make('li');
            inlineNodes(li, line.replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/, ''));
            list.append(li);
          }
          container.append(list);
        } else if (lines.length === 1 && /^#{1,6}\s/.test(lines[0])) {
          const heading = make('h4');
          inlineNodes(heading, lines[0].replace(/^#+\s*/, ''));
          container.append(heading);
        } else {
          const paragraph = make('p');
          lines.forEach((line, i) => {
            if (i) paragraph.append(make('br'));
            inlineNodes(paragraph, line);
          });
          container.append(paragraph);
        }
      }
    });
  }

  // ---------- API ----------
  const api = async (path, init) => {
    const r = await fetch(`./api/${path}`, { headers: { 'Content-Type': 'application/json' }, ...init });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    if (r.status === 204) return null;
    const raw = await r.text();
    return raw ? JSON.parse(raw) : null;
  };

  // ---------- rendering ----------
  function routeText(route = {}) {
    const how = { agent: 'agent', lookup: 'look-up', chat: 'chat' }[route.mode] || route.mode || 'auto';
    const name = NAMES[route.provider] || 'Assistant';
    return `${name} · ${how} mode · ${EFFORT[route.effort] || route.effort || 'auto'}${route.heavy ? ', hard problem' : ''}`;
  }
  function renderSteps(el, steps) {
    const previous = el.querySelector('details.steps');
    const wasOpen = previous ? previous.open : steps.some(s => s.status === 'running');
    // Remember which step outputs were expanded before the list is rebuilt.
    const openKeys = new Set([...el.querySelectorAll('details[data-step-key]')].filter(node => node.open).map(node => node.dataset.stepKey));
    el.replaceChildren();
    if (!steps.length) return;
    const running = steps.filter(s => s.status === 'running').length;
    const failed = steps.filter(s => s.status === 'failed').length;
    const group = make('details', 'steps');
    group.open = wasOpen;
    group.append(make('summary', '', `${steps.length} step${steps.length === 1 ? '' : 's'}${running ? ', working' : ''}${failed ? `, ${failed} failed` : ''}`));
    for (const step of steps) {
      const row = make('div', `step ${['running','done','failed'].includes(step.status) ? step.status : ''} ${step.kind === 'note' ? 'note' : ''}`);
      row.append(make('span', 's', step.status === 'running' ? '…' : step.status === 'failed' ? '✕' : '✓'));
      if (step.detail) {
        const detail = make('details');
        detail.open = openKeys.has(String(step.id ?? ''));
        detail.dataset.stepKey = String(step.id ?? '');
        detail.append(make('summary', 'l', step.label || ''), make('pre', '', step.detail));
        row.append(detail);
      } else row.append(make('span', 'l', step.label || ''));
      group.append(row);
    }
    el.append(group);
  }
  function addUser(text) {
    const d = make('div', 'msg user');
    d.append(make('div', 'bubble', text));
    $('thread').append(d);
    return d;
  }
  function addAssistant(m) {
    const d = make('div', 'msg assistant');
    const route = make('div', 'route');
    const stepsWrap = make('div', 'stepsWrap');
    const body = make('div', 'body');
    const err = make('div', 'err');
    const filesWrap = make('div', 'files');
    d.append(route, stepsWrap, body, filesWrap, err);
    $('thread').append(d);
    const view = {
      el: d, text: m.text || '', steps: Array.isArray(m.steps) ? m.steps : [],
      setRoute(r) {
        d.className = `msg assistant ${['claude','codex'].includes(r?.provider) ? r.provider : ''}`;
        route.textContent = routeText(r);
      },
      draw(streaming) {
        renderSteps(stepsWrap, this.steps);
        this.drawText(streaming);
      },
      // Text deltas only redraw the reply body, so the step list isn't rebuilt
      // (and clicks on it aren't lost) on every streamed word.
      drawText(streaming) {
        renderMarkdown(body, this.text);
        body.classList.toggle('cursor', !!streaming);
      },
      error(message) { err.textContent = String(message ?? ''); },
      setFiles(files) {
        filesWrap.replaceChildren();
        for (const f of Array.isArray(files) ? files : []) if (f && typeof f.path === 'string') filesWrap.append(fileLink(f));
      },
    };
    if (m.files) view.setFiles(m.files);
    if (m.route) view.setRoute(m.route);
    view.draw(false);
    if (m.error) view.error(m.error);
    return view;
  }
  const scrollDown = () => { const t = $('thread'); if (t.scrollHeight - t.scrollTop - t.clientHeight < 200) t.scrollTop = t.scrollHeight; };

  async function loadList() {
    const list = await api('conversations');
    const nav = $('chatList');
    nav.replaceChildren();
    if (!list.length) { const p = document.createElement('p'); p.className = 'hint'; p.style.padding = '0 12px'; p.textContent = 'No conversations yet.'; nav.append(p); }
    for (const c of list) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'chat-item'; b.dataset.id = String(c.id); b.setAttribute('aria-current', String(c.id === state.convId));
      const dot = document.createElement('span'); dot.className = 'who' + (['claude','codex'].includes(c.provider) ? ' ' + c.provider : ''); dot.setAttribute('aria-hidden','true');
      const name = document.createElement('span'); name.className = 't'; name.textContent = c.title || 'Untitled conversation';
      b.append(dot,name); nav.append(b);
    }
  }

  async function openConversation(id) {
    if (state.busy) return;
    const requestId = ++state.openRequest;
    state.convId = id;
    $('thread').replaceChildren();
    $('limitBar').hidden = true;
    if (!id) {
      $('thread').appendChild(emptyEl);
      $('chatTitle').textContent = 'New conversation';
      $('chatActions').hidden = true;
    } else {
      const c = await api(`conversations/${encodeURIComponent(id)}`);
      if (requestId !== state.openRequest || state.convId !== id) return;
      $('chatTitle').textContent = c.title;
      $('chatActions').hidden = false;
      for (const m of c.messages) (m.role === 'user' ? addUser(m.text) : addAssistant(m));
      $('thread').scrollTop = $('thread').scrollHeight;
    }
    closeSidebar();
    loadList().catch(console.error);
  }

  // ---------- sending ----------
  function setBusy(b) {
    state.busy = b;
    $('send').disabled = b;
    $('stop').hidden = !b;
    $('stop').disabled = false;
  }

  async function sendMessage(text, overrides = {}) {
    if (state.busy || !text.trim()) return;
    emptyEl.remove();
    $('limitBar').hidden = true;
    addUser(text);
    const view = addAssistant({ route: null });
    view.draw(true);
    scrollDown();
    setBusy(true);

    const body = { conversationId: state.convId, text, ...state.controls, heavy: $('heavy').checked, ...overrides };
    try {
      const r = await fetch('./api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok || !r.body) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        buf = buf.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try { handleEvent(JSON.parse(line.slice(5).trim()), view, text); } catch (e) { console.warn('Invalid stream event', e); }
          }
        }
      }
      buf += dec.decode();
      for (const line of buf.trim().split('\n')) if (line.startsWith('data:')) { try { handleEvent(JSON.parse(line.slice(5).trim()), view, text); } catch {} }
    } catch (e) {
      view.error(String(e.message || e));
    } finally {
      view.draw(false);
      setBusy(false);
      loadList();
    }
  }

  function handleEvent(ev, view, text) {
    switch (ev.type) {
      case 'conversation':
        state.convId = ev.id;
        $('chatTitle').textContent = ev.title;
        $('chatActions').hidden = false;
        break;
      case 'route': view.setRoute(ev.route); break;
      case 'text': view.text += ev.delta; view.drawText(true); scrollDown(); break;
      case 'step': {
        const i = view.steps.findIndex((s) => s.id === ev.step.id);
        if (i >= 0) view.steps[i] = { ...view.steps[i], ...ev.step }; else view.steps.push(ev.step);
        view.draw(true); scrollDown();
        break;
      }
      case 'files': view.setFiles(ev.files); scrollDown(); break;
      case 'limit': showLimit(ev, text); break;
      case 'warning': break;
      case 'error': view.error(ev.message); break;
      case 'stopped': view.error('Stopped.'); break;
      default: break;
    }
  }

  function showLimit(ev, text) {
    const bar = $('limitBar');
    const when = ev.until ? new Date(ev.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;
    bar.replaceChildren();
    const info = document.createElement('span');
    info.textContent = `${ev.name || NAMES[ev.provider] || 'Provider'} has reached its usage limit${when ? ` until about ${when}` : ''}.`;
    bar.append(info);
    const b = document.createElement('button');
    b.className = 'btn primary';
    b.textContent = `Continue with ${ev.otherName || NAMES[ev.other] || 'other assistant'}`;
    b.onclick = () => { if (!['claude','codex'].includes(ev.other) || state.busy) return; bar.hidden = true; sendMessage(text, { provider: ev.other }); };
    b.disabled = !['claude','codex'].includes(ev.other);
    bar.appendChild(b);
    bar.hidden = false;
  }

  // ---------- status & accounts ----------
  async function refreshStatus() {
    try {
      const s = await api('status');
      state.status = s;
      $('connClaude').classList.toggle('ok', s.claude.connected);
      $('connCodex').classList.toggle('ok', s.codex.connected);
      const home = s.home?.enabled && s.home?.available;
      $('connHome').classList.toggle('ok', !!home);
      $('homeState').textContent = home ? 'Connected, read-only.' : s.home?.enabled ? 'Not available outside Home Assistant.' : 'Turned off in the add-on configuration.';
      $('claudeState').textContent = s.claude.connected ? 'Connected with your Claude subscription.' : 'Not connected.';
      $('codexState').textContent = s.codex.connected ? 'Connected with your ChatGPT subscription.' : 'Not connected.';
      $('wsPath').textContent = s.workspace;
    } catch { /* keep last known state */ }
  }
  let loginTimer = null;
  async function pollLogin() {
    const s = await api('auth/codex/login');
    const log = $('codexLog');
    log.hidden = !s.log.length;
    log.textContent = s.log.join('\n');
    if (s.running) loginTimer = setTimeout(pollLogin, 2000);
    else { loginTimer = null; refreshStatus(); }
  }

  // ---------- wiring ----------
  const emptyEl = $('empty');
  document.querySelectorAll('.seg').forEach((seg) => {
    seg.querySelectorAll('button[data-v]').forEach(b => b.setAttribute('aria-pressed', String(state.controls[seg.dataset.key] === b.dataset.v)));
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      seg.querySelectorAll('button[data-v]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      state.controls[seg.dataset.key] = b.dataset.v;
      try { localStorage.setItem('relay-controls', JSON.stringify(state.controls)); } catch {}
    });
  });
  const closeSidebar = () => { $('sidebar').classList.remove('open'); $('toggleSidebar').setAttribute('aria-expanded','false'); };
  const input = $('input');
  const grow = () => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`; };
  input.addEventListener('input', grow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); }
  });
  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = input.value;
    if (!t.trim() || state.busy) return;
    input.value = ''; grow();
    sendMessage(t);
  });
  $('stop').onclick = async () => { $('stop').disabled = true; try { await api('stop', { method: 'POST', body: JSON.stringify({ conversationId: state.convId }) }); } catch (e) { console.error(e); } finally { $('stop').disabled = false; } };
  $('newChat').onclick = () => openConversation(null);
  $('chatList').addEventListener('click', (e) => {
    const b = e.target.closest('.chat-item');
    if (b && !state.busy) openConversation(b.dataset.id);
  });
  $('deleteChat').onclick = async () => {
    if (!state.convId || !confirm('Delete this chat?')) return;
    await api(`conversations/${encodeURIComponent(state.convId)}`, { method: 'DELETE' });
    openConversation(null);
  };
  $('toggleSidebar').onclick = () => { const open = $('sidebar').classList.toggle('open'); $('toggleSidebar').setAttribute('aria-expanded', String(open)); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSidebar(); });
  $('thread').addEventListener('click', () => { if ($('sidebar').classList.contains('open')) closeSidebar(); });
  $('openSettings').onclick = () => { refreshStatus(); $('settings').showModal(); };
  $('codexLogin').onclick = async () => { await api('auth/codex/login', { method: 'POST' }); if (!loginTimer) pollLogin(); };
  $('codexLogout').onclick = async () => { await api('auth/codex/logout', { method: 'POST' }); refreshStatus(); };

  // ---------- copy & export ----------
  let toastTimer = null;
  function toast(message) {
    const t = $('toast');
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2500);
  }
  // The Clipboard API needs HTTPS; Home Assistant on a plain LAN address is http, so fall back.
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch { /* fall through */ }
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }
  $('copyChat').onclick = async () => {
    if (!state.convId) return;
    try {
      const r = await fetch(`./api/conversations/${encodeURIComponent(state.convId)}/export?format=text`);
      if (!r.ok) throw new Error(r.statusText);
      toast((await copyText(await r.text())) ? 'Chat copied.' : 'Your browser blocked copying. Use Export log instead.');
    } catch (e) { toast(`Couldn't copy the chat: ${e.message || e}`); }
  };
  $('exportLog').onclick = () => {
    if (!state.convId) return;
    const a = document.createElement('a');
    a.href = `./api/conversations/${encodeURIComponent(state.convId)}/export?download=1`;
    a.download = '';
    document.body.append(a);
    a.click();
    a.remove();
    toast('Log exported.');
  };

  $('openFiles').onclick = async () => {
    const list = $('fileList');
    list.replaceChildren(make('p', 'hint', 'Loading…'));
    $('filesDialog').showModal();
    try {
      const files = await api('files');
      list.replaceChildren();
      if (!files.length) list.append(make('p', 'hint', 'No files yet. Ask an agent to make one, like "save that as a Word document".'));
      for (const f of files) {
        const row = make('div', 'file-row');
        row.append(fileLink(f), make('span', 'file-when', new Date(f.mtime).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })));
        list.append(row);
      }
    } catch (e) { list.replaceChildren(make('p', 'hint', `Couldn't load files: ${e.message || e}`)); }
  };

  refreshStatus();
  loadList();
  setInterval(refreshStatus, 60000);
})();
