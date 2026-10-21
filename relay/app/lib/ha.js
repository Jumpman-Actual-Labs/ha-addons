// Read-only access to Home Assistant through the Supervisor proxy.
// The Supervisor token never leaves this process: agents reach these functions
// only through Relay's internal endpoints, which expose nothing that changes state.

const BASE = process.env.RELAY_HA_URL || 'http://supervisor/core/api';
const TOKEN = () => process.env.SUPERVISOR_TOKEN || process.env.RELAY_HA_TOKEN || '';

export const haAvailable = () => !!TOKEN();

async function call(path, init = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN()}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`Home Assistant returned ${r.status} for ${path}`);
  const type = r.headers.get('content-type') || '';
  return type.includes('json') ? r.json() : r.text();
}

const globToRe = (g) => new RegExp('^' + g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
function hiddenMatcher(opts) {
  const res = (opts.home_hidden_entities || []).filter(Boolean).map(globToRe);
  return (id) => res.some((re) => re.test(id));
}

const DROP_ATTRS = new Set(['entity_picture', 'supported_features', 'icon', 'friendly_name', 'supported_color_modes', 'effect_list', 'source_list', 'sound_mode_list', 'preset_modes', 'hvac_modes', 'fan_modes', 'swing_modes', 'options']);
function trimAttrs(attrs = {}) {
  const out = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (DROP_ATTRS.has(k)) continue;
    const s = JSON.stringify(v);
    out[k] = s && s.length > 400 ? `${s.slice(0, 400)}…` : v;
  }
  return out;
}
const brief = (s) => ({
  entity_id: s.entity_id,
  name: s.attributes?.friendly_name || s.entity_id,
  state: s.state,
  ...(s.attributes?.unit_of_measurement ? { unit: s.attributes.unit_of_measurement } : {}),
});

async function areaEntityIds(area) {
  const tpl = `{{ area_entities(${JSON.stringify(area)}) | tojson }}`;
  try { return JSON.parse(await call('/template', { method: 'POST', body: JSON.stringify({ template: tpl }) })); } catch { return []; }
}

export async function findEntities(opts, { query = '', domain = '', area = '', limit = 40 } = {}) {
  const hidden = hiddenMatcher(opts);
  let states = (await call('/states')).filter((s) => !hidden(s.entity_id));
  if (domain) states = states.filter((s) => s.entity_id.startsWith(`${domain}.`));
  if (area) {
    const ids = new Set(await areaEntityIds(area));
    states = states.filter((s) => ids.has(s.entity_id));
  }
  if (query) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    states = states.filter((s) => {
      const hay = `${s.entity_id} ${s.attributes?.friendly_name || ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }
  const cap = Math.min(Math.max(Number(limit) || 40, 1), 100);
  return { total: states.length, entities: states.slice(0, cap).map(brief) };
}

export async function getEntity(opts, { entity_id }) {
  if (!entity_id || hiddenMatcher(opts)(entity_id)) throw new Error(`No entity named ${entity_id}.`);
  const s = await call(`/states/${encodeURIComponent(entity_id)}`);
  return { ...brief(s), attributes: trimAttrs(s.attributes), last_changed: s.last_changed };
}

export async function getForecast(opts, { entity_id, type = 'daily' } = {}) {
  const hidden = hiddenMatcher(opts);
  let id = entity_id;
  if (!id) {
    const w = (await call('/states')).find((s) => s.entity_id.startsWith('weather.') && !hidden(s.entity_id));
    if (!w) throw new Error('No weather entity found in Home Assistant.');
    id = w.entity_id;
  }
  if (hidden(id)) throw new Error(`No entity named ${id}.`);
  const kind = ['daily', 'hourly', 'twice_daily'].includes(type) ? type : 'daily';
  const res = await call('/services/weather/get_forecasts?return_response', { method: 'POST', body: JSON.stringify({ entity_id: id, type: kind }) });
  const forecast = res?.service_response?.[id]?.forecast || [];
  const current = await getEntity(opts, { entity_id: id });
  return { entity_id: id, current: { state: current.state, ...current.attributes }, type: kind, forecast: forecast.slice(0, kind === 'hourly' ? 12 : 7) };
}

// Where and when the user is, from Home Assistant's own configuration. Cached for an hour.
let homeCache = { at: 0, value: null };
export async function homeContext() {
  if (!haAvailable()) return null;
  if (homeCache.value && Date.now() - homeCache.at < 3600_000) return homeCache.value;
  try {
    const c = await call('/config');
    const generic = !c.location_name || /^(home|my home|house)$/i.test(c.location_name.trim());
    const approx = typeof c.latitude === 'number' && typeof c.longitude === 'number' ? `near latitude ${c.latitude.toFixed(1)}, longitude ${c.longitude.toFixed(1)}` : '';
    homeCache = { at: Date.now(), value: { location: generic ? approx : c.location_name, timeZone: c.time_zone || '', units: c.unit_system?.temperature || '' } };
  } catch { /* keep whatever we had */ }
  return homeCache.value;
}
