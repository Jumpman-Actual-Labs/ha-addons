// Turns a stored conversation into plain text (for copying) or a full Markdown log
// (every message, route, step, command output, error and usage figure).

const NAMES = { claude: 'Claude', codex: 'ChatGPT' };
const MODES = { chat: 'chat', lookup: 'look-up', agent: 'agent' };
const ICON = { done: '✓', failed: '✕', running: '…' };

const who = (m) => (m.role === 'user' ? 'You' : NAMES[m.route?.provider] || 'Assistant');
const stamp = (ts) => (ts ? new Date(ts).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '');

// A code fence longer than any backtick run inside the content, so output can't break out of it.
function fence(text) {
  const longest = Math.max(2, ...(String(text).match(/`+/g) || []).map((r) => r.length));
  const f = '`'.repeat(longest + 1);
  return `${f}\n${String(text).replace(/\n+$/, '')}\n${f}`;
}

export function toText(conv) {
  const lines = [`${conv.title}`, ''];
  for (const m of conv.messages) {
    lines.push(`${who(m)}:`, (m.text || (m.error ? `[${m.error}]` : '')).trim(), '');
  }
  return lines.join('\n').trim() + '\n';
}

export function toMarkdownLog(conv) {
  const out = [
    `# ${conv.title}`,
    '',
    `- Conversation id: ${conv.id}`,
    `- Started: ${stamp(conv.created)}`,
    `- Last activity: ${stamp(conv.updated)}`,
    `- Current provider: ${NAMES[conv.provider] || 'none yet'}`,
    `- Exported: ${stamp(Date.now())}`,
    '',
  ];
  conv.messages.forEach((m, i) => {
    out.push('---', '');
    if (m.role === 'user') {
      out.push(`## ${i + 1}. You (${stamp(m.ts)})`, '', m.text || '', '');
      return;
    }
    const r = m.route || {};
    const route = [MODES[r.mode] ? `${MODES[r.mode]} mode` : null, r.effort ? `${r.effort} effort` : null, r.heavy ? 'hard problem' : null].filter(Boolean).join(', ');
    out.push(`## ${i + 1}. ${who(m)}${route ? `, ${route}` : ''} (${stamp(m.ts)})`, '');
    const steps = m.steps || [];
    if (steps.length) {
      out.push(`### Steps (${steps.length})`, '');
      for (const s of steps) {
        out.push(`- ${ICON[s.status] || '•'} **${s.kind || 'step'}**: ${s.label || ''}${s.status === 'failed' ? ' (failed)' : ''}`);
        if (s.detail) out.push('', fence(s.detail).split('\n').map((l) => `  ${l}`).join('\n'), '');
      }
      out.push('');
    }
    out.push('### Reply', '', m.text || '_No reply text._', '');
    if (m.files?.length) out.push(`### Files`, '', ...m.files.map((f) => `- ${f.path} (${f.size} bytes)`), '');
    if (m.error) out.push(`**Error:** ${m.error}`, '');
    if (m.stopped) out.push('**Stopped by you.**', '');
    if (m.limit) out.push(`**Usage limit:** ${NAMES[m.limit.provider] || m.limit.provider} until ${stamp(m.limit.until)}`, '');
    if (m.usage) {
      const u = m.usage;
      const parts = [
        u.input_tokens != null && `input ${u.input_tokens}`,
        (u.cache_read_input_tokens ?? u.cached_input_tokens) != null && `cached ${u.cache_read_input_tokens ?? u.cached_input_tokens}`,
        u.cache_creation_input_tokens != null && `cache writes ${u.cache_creation_input_tokens}`,
        u.output_tokens != null && `output ${u.output_tokens}`,
        u.reasoning_output_tokens != null && `reasoning ${u.reasoning_output_tokens}`,
      ].filter(Boolean);
      if (parts.length) out.push(`_Tokens: ${parts.join(', ')}_`, '');
    }
  });
  return out.join('\n');
}

export function exportFilename(conv) {
  const slug = (conv.title || 'chat').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'chat';
  const d = new Date().toISOString().slice(0, 10);
  return `relay-${slug}-${d}.txt`;
}

// Plain-text version of the full log (no Markdown markers), for the .txt export.
const indent = (text, pad = '      ') => String(text).replace(/\n+$/, '').split('\n').map((l) => pad + l).join('\n');

export function toTextLog(conv) {
  const rule = '='.repeat(72);
  const thin = '-'.repeat(72);
  const out = [
    rule,
    conv.title,
    rule,
    `Conversation id: ${conv.id}`,
    `Started:         ${stamp(conv.created)}`,
    `Last activity:   ${stamp(conv.updated)}`,
    `Provider:        ${NAMES[conv.provider] || 'none yet'}`,
    `Exported:        ${stamp(Date.now())}`,
    '',
  ];
  conv.messages.forEach((m, i) => {
    out.push(thin);
    if (m.role === 'user') {
      out.push(`[${i + 1}] YOU  (${stamp(m.ts)})`, '', m.text || '', '');
      return;
    }
    const r = m.route || {};
    const route = [MODES[r.mode] ? `${MODES[r.mode]} mode` : null, r.effort ? `${r.effort} effort` : null, r.heavy ? 'hard problem' : null].filter(Boolean).join(', ');
    out.push(`[${i + 1}] ${who(m).toUpperCase()}${route ? `  (${route})` : ''}  ${stamp(m.ts)}`, '');
    const steps = m.steps || [];
    if (steps.length) {
      out.push(`  Steps (${steps.length}):`);
      for (const st of steps) {
        const status = st.status === 'failed' ? 'FAILED' : st.status === 'running' ? 'UNFINISHED' : 'OK';
        out.push(`    [${status}] ${st.kind || 'step'}: ${st.label || ''}`);
        if (st.detail) out.push('      Output:', indent(st.detail, '        '));
      }
      out.push('');
    }
    out.push('  Reply:', indent(m.text || '(no reply text)', '    '), '');
    if (m.files?.length) out.push('  Files:', ...m.files.map((f) => `    ${f.path} (${f.size} bytes)`), '');
    if (m.error) out.push(`  Error: ${m.error}`, '');
    if (m.stopped) out.push('  Stopped by you.', '');
    if (m.limit) out.push(`  Usage limit: ${NAMES[m.limit.provider] || m.limit.provider} until ${stamp(m.limit.until)}`, '');
    if (m.usage) {
      const u = m.usage;
      const parts = [
        u.input_tokens != null && `input ${u.input_tokens}`,
        (u.cache_read_input_tokens ?? u.cached_input_tokens) != null && `cached ${u.cache_read_input_tokens ?? u.cached_input_tokens}`,
        u.cache_creation_input_tokens != null && `cache writes ${u.cache_creation_input_tokens}`,
        u.output_tokens != null && `output ${u.output_tokens}`,
        u.reasoning_output_tokens != null && `reasoning ${u.reasoning_output_tokens}`,
      ].filter(Boolean);
      if (parts.length) out.push(`  Tokens: ${parts.join(', ')}`, '');
    }
  });
  out.push(rule, '');
  return out.join('\n');
}
