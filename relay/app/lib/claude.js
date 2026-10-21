import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { paths, agentEnv, haMcpSpec, HA_TOOL_NAMES, nowContext, todayString } from './config.js';
import { haAvailable, homeContext } from './ha.js';

export const FILES_NOTE = 'When the user wants a file (a document, spreadsheet, slides, CSV, image or code), create it in the current working directory with a clear file name; the app automatically shows a download link for every file you create or change, so do not paste the whole contents back unless asked. Available converters: pandoc (Markdown to .docx, .pptx, .html, .odt, .epub) and python3 with python-docx, openpyxl and python-pptx.';
const CHAT_PROMPT = 'You are a helpful assistant in a personal chat app. Answer directly and concisely. Use Markdown for code. You have no tools in this mode. If a correct answer depends on current information (anything that may have changed since your training, such as scores, standings, news, weather, prices, schedules, or the state of the user\'s home), reply with exactly NEEDS_LOOKUP and nothing else; the app will then look it up for you.';
const AGENT_APPEND = 'You are running inside a personal Home Assistant add-on. Work only inside the current working directory unless told otherwise. Prefer reading parts of large files over whole files, and keep command output short (pipe through head/tail or grep). ' + FILES_NOTE;
const AGENT_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite'];
const LOOKUP_TOOLS = ['WebSearch', 'WebFetch'];
const LOOKUP_PROMPT = 'You are a helpful assistant in a personal chat app running inside the user\'s Home Assistant. Answer directly and concisely. For questions about the user\'s home, devices or local weather, use the Home Assistant tools first. Use web search only for things outside the home. You can read Home Assistant but not control it; if asked to change something, say so. Use Markdown for code.';
const HA_HINT = ' You also have read-only Home Assistant tools (ha_find_entities, ha_get_entity, ha_get_forecast) for questions about the user\'s home and local weather.';
const LOOKUP_STEPS = 6;

export function claudeConnected(opts) {
  if (opts.claude_oauth_token) return true;
  return fs.existsSync(path.join(paths.home, '.claude', '.credentials.json'));
}

export function haLabel(tool, i = {}) {
  if (tool === 'ha_get_forecast') return `Home Assistant: forecast${i.entity_id ? ` for ${i.entity_id}` : ''}`;
  if (tool === 'ha_get_entity') return `Home Assistant: ${i.entity_id || 'entity'}`;
  const bits = [i.query, i.domain && `${i.domain}s`, i.area && `in ${i.area}`].filter(Boolean).join(' ');
  return `Home Assistant: find ${bits || 'entities'}`;
}

function stepFromToolUse(block) {
  const i = block.input || {};
  const name = block.name;
  if (name.startsWith('mcp__ha__')) return { id: block.id, kind: 'home', label: haLabel(name.slice(9), i), status: 'running' };
  const kinds = { Bash: 'command', Read: 'read', Edit: 'edit', Write: 'edit', Glob: 'search', Grep: 'search', WebSearch: 'web', WebFetch: 'web', TodoWrite: 'note' };
  const label =
    name === 'Bash' ? i.command :
    name === 'Read' || name === 'Edit' || name === 'Write' ? `${name} ${i.file_path || ''}` :
    name === 'Glob' || name === 'Grep' ? `${name} ${i.pattern || ''}` :
    name === 'WebSearch' ? `Search: ${i.query || ''}` :
    name === 'WebFetch' ? `Fetch ${i.url || ''}` :
    name === 'TodoWrite' ? 'Updated plan' :
    name.startsWith('mcp__ha__') ? haLabel(name.slice(9), i) : name;
  return { id: block.id, kind: kinds[name] || 'tool', label: String(label || name).slice(0, 300), status: 'running' };
}

function resultText(block) {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => x.text || '').join('');
  return '';
}

/**
 * Runs one user turn on Claude through the Agent SDK, using the subscription login.
 * Yields normalized events: route/text/step/usage/limit/error/session.
 */
export async function* runClaude({ prompt, sessionId, route, opts, abortController }) {
  const agent = route.mode === 'agent';
  const lookup = route.mode === 'lookup';
  const home = opts.home_access && haAvailable();
  const haTools = home ? HA_TOOL_NAMES.map((t) => `mcp__ha__${t}`) : [];
  const mcpServers = home ? { ha: { type: 'stdio', ...haMcpSpec() } } : undefined;
  const when = (agent || lookup) ? ' ' + nowContext(await homeContext(), opts) : '';
  const env = agentEnv({
    CLAUDE_AGENT_SDK_CLIENT_APP: 'relay-ha/0.1.0',
    BASH_MAX_OUTPUT_LENGTH: String(opts.bash_max_output_chars),
    ...(opts.claude_oauth_token ? { CLAUDE_CODE_OAUTH_TOKEN: opts.claude_oauth_token } : {}),
  });

  const options = {
    model: route.heavy ? opts.claude_heavy_model : opts.claude_model,
    effort: route.effort,
    cwd: paths.workspace,
    env,
    abortController,
    includePartialMessages: true,
    settingSources: [],          // no CLAUDE.md, no user settings: keeps every request small and stable
    ...(sessionId ? { resume: sessionId } : {}),
  };

  const deny = async (toolName) => ({ behavior: 'deny', message: `${toolName} is not enabled in Relay.` });
  if (agent) {
    Object.assign(options, {
      systemPrompt: { type: 'preset', preset: 'claude_code', append: AGENT_APPEND + (home ? HA_HINT : '') + when, excludeDynamicSections: true },
      tools: AGENT_TOOLS,
      allowedTools: [...AGENT_TOOLS, ...haTools],
      ...(mcpServers ? { mcpServers } : {}),
      permissionMode: 'acceptEdits',
      maxTurns: opts.max_agent_turns,
      canUseTool: deny,
    });
  } else if (lookup) {
    Object.assign(options, {
      systemPrompt: LOOKUP_PROMPT + when,
      tools: LOOKUP_TOOLS,
      allowedTools: [...LOOKUP_TOOLS, ...haTools],
      ...(mcpServers ? { mcpServers } : {}),
      maxTurns: LOOKUP_STEPS,
      canUseTool: deny,
    });
  } else {
    Object.assign(options, { systemPrompt: `${CHAT_PROMPT} Today is ${todayString(await homeContext())}.`, tools: [], maxTurns: 1 });
  }

  let session = sessionId;
  let streamedText = false;
  const steps = new Map();

  try {
    for await (const msg of query({ prompt, options })) {
      if (msg.session_id && msg.session_id !== session) {
        session = msg.session_id;
        yield { type: 'session', sessionId: session };
      }

      if (msg.type === 'stream_event' && !msg.parent_tool_use_id) {
        const ev = msg.event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          streamedText = true;
          yield { type: 'text', delta: ev.delta.text };
        }
        continue;
      }

      if (msg.type === 'assistant') {
        if (msg.error) {
          if (msg.error === 'rate_limit') { yield { type: 'limit', provider: 'claude' }; continue; }
          if (msg.error === 'authentication_failed') { yield { type: 'error', message: opts.claude_oauth_token
            ? 'Claude rejected the token. Generate a new one with "claude setup-token" and update the add-on configuration.'
            : 'Claude is not connected yet. Open Accounts in Relay for the one-time setup.' }; continue; }
        }
        if (msg.parent_tool_use_id) continue; // subagent detail stays out of the main transcript
        for (const block of msg.message?.content || []) {
          if (block.type === 'tool_use') {
            const s = stepFromToolUse(block);
            steps.set(s.id, s);
            yield { type: 'step', step: s };
          } else if (block.type === 'text' && !streamedText) {
            yield { type: 'text', delta: block.text };
          }
        }
        const u = msg.message?.usage;
        if (u) yield { type: 'context', tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) };
        streamedText = false;
        continue;
      }

      if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content) {
          if (block.type !== 'tool_result') continue;
          const s = steps.get(block.tool_use_id);
          if (!s) continue;
          const out = resultText(block);
          s.status = block.is_error ? 'failed' : 'done';
          s.outputChars = out.length;
          s.detail = out.length > 1200 ? out.slice(0, 600) + '\n…\n' + out.slice(-500) : out;
          yield { type: 'step', step: s };
        }
        continue;
      }

      if (msg.type === 'rate_limit_event') {
        const info = msg.rate_limit_info || {};
        if (info.status === 'rejected') {
          yield { type: 'limit', provider: 'claude', resetsAt: info.resetsAt ? info.resetsAt * 1000 : null, which: info.rateLimitType };
        } else if (info.status === 'allowed_warning') {
          yield { type: 'warning', provider: 'claude', utilization: info.utilization, which: info.rateLimitType };
        }
        continue;
      }

      if (msg.type === 'result') {
        if (msg.subtype === 'error_max_turns') {
          yield { type: 'error', message: agent
            ? `Stopped after ${opts.max_agent_turns} steps. Send "continue" to keep going, or raise the step limit in the add-on configuration.`
            : 'This needed more steps than this mode allows. Try again with How set to Agent.' };
        }
        else if (msg.subtype !== 'success' && msg.errors?.length) yield { type: 'error', message: msg.errors.join('\n') };
        yield { type: 'usage', usage: msg.usage, turns: msg.num_turns };
      }
    }
  } catch (err) {
    if (abortController.signal.aborted) { yield { type: 'stopped' }; return; }
    const text = String(err?.message || err);
    if (/rate.?limit|usage limit|429/i.test(text)) yield { type: 'limit', provider: 'claude' };
    else yield { type: 'error', message: `Claude: ${text}` };
  }
}
