import { Codex } from '@openai/codex-sdk';
import { paths, agentEnv, haMcpSpec, nowContext } from './config.js';
import { haAvailable, homeContext } from './ha.js';
import { haLabel, FILES_NOTE } from './claude.js';

const LIMIT_RE = /usage limit|rate limit|too many requests|429|limit reached|quota/i;

function stepFromItem(item) {
  switch (item.type) {
    case 'command_execution': {
      const out = item.aggregated_output || '';
      return {
        id: item.id, kind: 'command', label: item.command,
        status: item.status === 'in_progress' ? 'running' : item.status === 'failed' || (item.exit_code ?? 0) !== 0 ? 'failed' : 'done',
        outputChars: out.length,
        detail: out.length > 1200 ? out.slice(0, 600) + '\n…\n' + out.slice(-500) : out,
      };
    }
    case 'file_change':
      return { id: item.id, kind: 'edit', label: item.changes.map((c) => `${c.kind} ${c.path}`).join(', '), status: item.status === 'failed' ? 'failed' : 'done' };
    case 'web_search':
      return { id: item.id, kind: 'web', label: `Search: ${item.query}`, status: 'done' };
    case 'mcp_tool_call': {
      const status = item.status === 'in_progress' ? 'running' : item.status === 'failed' ? 'failed' : 'done';
      if (item.server === 'ha') return { id: item.id, kind: 'home', label: haLabel(item.tool, item.arguments || {}), status };
      return { id: item.id, kind: 'tool', label: `${item.server}: ${item.tool}`, status };
    }
    case 'todo_list':
      return { id: item.id, kind: 'note', label: 'Updated plan', status: 'done' };
    default:
      return null;
  }
}

/**
 * Runs one user turn on ChatGPT through the Codex SDK, using the "Sign in with ChatGPT" login.
 */
export async function* runCodex({ prompt, sessionId, route, opts, abortController }) {
  const agent = route.mode === 'agent';
  const lookup = route.mode === 'lookup';
  const home = (agent || lookup) && opts.home_access && haAvailable();
  const spec = home ? haMcpSpec() : null;
  const codex = new Codex({
    env: agentEnv({ CODEX_HOME: paths.codexHome }),
    ...(spec ? { config: { mcp_servers: { ha: { command: spec.command, args: spec.args, env: spec.env, default_tools_approval_mode: 'approve', startup_timeout_sec: 20 } } } } : {}),
  });

  const threadOptions = {
    workingDirectory: paths.workspace,
    skipGitRepoCheck: true,
    approvalPolicy: 'never',
    modelReasoningEffort: route.heavy ? 'high' : route.effort,
    sandboxMode: agent ? opts.codex_agent_sandbox : 'read-only',
    networkAccessEnabled: agent,
    webSearchMode: agent || lookup ? 'live' : 'disabled',
    ...(opts.codex_model ? { model: opts.codex_model } : {}),
  };

  const thread = sessionId ? codex.resumeThread(sessionId, threadOptions) : codex.startThread(threadOptions);
  const textSoFar = new Map();

  // Chat mode still runs the Codex agent, so ask it to just answer.
  const LOOKUP_NOTE = home
    ? 'Answer directly. For questions about my home, devices or local weather, use the Home Assistant tools (read-only) first; use web search for anything else. Do not run commands or edit files.'
    : 'Answer directly, using web search if you need current information. Do not run commands or edit files.';
  const when = nowContext(await homeContext(), opts);
  const input = agent ? `${when} ${FILES_NOTE}\n\n${prompt}`
    : lookup ? `${LOOKUP_NOTE} ${when}\n\n${prompt}`
    : `Answer this directly. Do not run commands, search, or edit files. If a correct answer depends on current information (scores, standings, news, weather, prices, schedules, or my home), reply with exactly NEEDS_LOOKUP and nothing else. ${when}\n\n${prompt}`;

  try {
    const { events } = await thread.runStreamed(input, { signal: abortController.signal });
    for await (const ev of events) {
      if (ev.type === 'thread.started') { yield { type: 'session', sessionId: ev.thread_id }; continue; }

      if (ev.type === 'item.started' || ev.type === 'item.updated' || ev.type === 'item.completed') {
        const item = ev.item;
        if (item.type === 'agent_message') {
          const prev = textSoFar.get(item.id) || '';
          const now = item.text || '';
          if (now.startsWith(prev) && now.length > prev.length) yield { type: 'text', delta: (prev ? '' : (textSoFar.size ? '\n\n' : '')) + now.slice(prev.length) };
          textSoFar.set(item.id, now);
          continue;
        }
        if (item.type === 'error') {
          if (LIMIT_RE.test(item.message)) yield { type: 'limit', provider: 'codex' };
          else yield { type: 'step', step: { id: item.id, kind: 'note', label: item.message, status: 'failed' } };
          continue;
        }
        const s = stepFromItem(item);
        if (s) yield { type: 'step', step: s };
        continue;
      }

      if (ev.type === 'turn.completed') { yield { type: 'usage', usage: ev.usage }; continue; }

      if (ev.type === 'turn.failed' || ev.type === 'error') {
        const message = ev.error?.message || ev.message || 'Codex turn failed';
        if (ev.type === 'error' && /^reconnecting/i.test(message)) {
          yield { type: 'step', step: { id: 'reconnect', kind: 'note', label: message, status: 'running' } };
          continue;
        }
        if (LIMIT_RE.test(message)) yield { type: 'limit', provider: 'codex' };
        else if (/login|unauthori[sz]ed|401|not logged in|auth/i.test(message)) yield { type: 'error', message: 'ChatGPT is not connected. Open Settings in Relay and connect your ChatGPT account.' };
        else yield { type: 'error', message: `ChatGPT: ${message}` };
      }
    }
  } catch (err) {
    if (abortController.signal.aborted) { yield { type: 'stopped' }; return; }
    const text = String(err?.message || err);
    if (LIMIT_RE.test(text)) yield { type: 'limit', provider: 'codex' };
    else if (/login|unauthori[sz]ed|401|auth/i.test(text)) yield { type: 'error', message: 'ChatGPT is not connected. Open Settings in Relay and connect your ChatGPT account.' };
    else yield { type: 'error', message: `ChatGPT: ${text}` };
  }
}
