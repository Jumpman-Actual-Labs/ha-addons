import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DATA = process.env.RELAY_DATA || '/data';
const SHARE = process.env.RELAY_SHARE || '/share/relay';

const DEFAULTS = {
  claude_oauth_token: '',
  default_chat_provider: 'codex',
  default_agent_provider: 'claude',
  claude_model: 'sonnet',
  claude_heavy_model: 'opus',
  codex_model: '',
  codex_agent_sandbox: 'danger-full-access',
  max_agent_turns: 60,
  bash_max_output_chars: 20000,
  compact_at_tokens: 120000,
  home_access: true,
  home_hidden_entities: [],
  home_area: '',
};

export const paths = {
  data: DATA,
  conversations: path.join(DATA, 'conversations'),
  home: process.env.HOME || path.join(DATA, 'home'),
  codexHome: process.env.CODEX_HOME || path.join(DATA, 'home', '.codex'),
  workspace: path.join(SHARE, 'workspace'),
};

export function loadOptions() {
  const file = process.env.RELAY_OPTIONS || path.join(DATA, 'options.json');
  let opts = {};
  try { opts = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first boot or dev */ }
  return { ...DEFAULTS, ...opts };
}

export function ensureDirs() {
  for (const p of [paths.conversations, paths.home, paths.codexHome, paths.workspace]) {
    fs.mkdirSync(p, { recursive: true });
  }
}

// A clean environment for the agent processes: never pass API keys through,
// so usage always comes from the subscriptions and never from per-token billing.
export function agentEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'SUPERVISOR_TOKEN', 'HASSIO_TOKEN']) {
    delete env[k];
  }
  return env;
}

// Per-boot secret for the internal endpoints the Home Assistant MCP server calls.
export const internal = {
  secret: crypto.randomBytes(24).toString('hex'),
  url: `http://127.0.0.1:${Number(process.env.PORT || 8099)}`,
};

const here = path.dirname(fileURLToPath(import.meta.url));
export const HA_MCP_PATH = path.join(here, '..', 'mcp', 'ha-mcp.js');
export const HA_TOOL_NAMES = ['ha_find_entities', 'ha_get_entity', 'ha_get_forecast'];

// The stdio MCP server definition both agents use for read-only Home Assistant tools.
export function haMcpSpec() {
  return {
    command: process.execPath,
    args: [HA_MCP_PATH],
    env: { RELAY_INTERNAL_URL: internal.url, RELAY_INTERNAL_SECRET: internal.secret, PATH: process.env.PATH || '' },
  };
}

// "Today is ..." context so searches about recent events target the right dates.
export function todayString(home) {
  const tz = home?.timeZone || process.env.TZ || 'UTC';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date());
  } catch { return new Date().toUTCString(); }
}

export function nowContext(home, opts = {}) {
  const tz = home?.timeZone || process.env.TZ || 'UTC';
  const today = todayString(home);
  const place = (opts.home_area || '').trim() || home?.location || '';
  const where = place ? ` The user lives ${opts.home_area ? `in ${place}` : place} (time zone ${tz}); when a question is ambiguous, such as a team, store or event name shared by several places, assume the one local to the user's home and say which you assumed.` : '';
  return `Today is ${today}.${where} For anything recent (scores, news, prices, schedules), put the month and year in your searches, prefer sources dated in the last few days, and open the most relevant result to confirm its date before answering. If you can't confirm a recent result, say so plainly.`;
}
