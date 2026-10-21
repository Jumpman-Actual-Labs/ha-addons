#!/usr/bin/env node
// Stdio MCP server that gives the agents read-only Home Assistant tools.
// It holds no Home Assistant credentials: every call goes back to Relay's
// internal endpoints, which only answer read-only questions.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const URL_BASE = process.env.RELAY_INTERNAL_URL;
const SECRET = process.env.RELAY_INTERNAL_SECRET;

const TOOLS = [
  {
    name: 'ha_find_entities',
    description: "Search the user's Home Assistant entities (lights, doors, sensors, people, climate and more). Returns entity ids, names and current states. Filter by words in the name, by domain (light, sensor, binary_sensor, lock, cover, climate, person, weather, switch, media_player) and/or by area name.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to match in the entity id or name, like "garage door" or "kitchen temperature".' },
        domain: { type: 'string', description: 'Only this domain, like "light" or "binary_sensor".' },
        area: { type: 'string', description: 'Only entities in this area, like "Kitchen".' },
        limit: { type: 'number', description: 'Maximum results (default 40).' },
      },
    },
  },
  {
    name: 'ha_get_entity',
    description: 'Get the current state and attributes of one Home Assistant entity.',
    inputSchema: { type: 'object', properties: { entity_id: { type: 'string' } }, required: ['entity_id'] },
  },
  {
    name: 'ha_get_forecast',
    description: "Get current conditions and the forecast from the user's Home Assistant weather entity. Use this for questions about local weather before searching the web.",
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'A weather.* entity. Leave empty to use the first one.' },
        type: { type: 'string', enum: ['daily', 'hourly', 'twice_daily'] },
      },
    },
  },
];

const server = new Server({ name: 'home-assistant', version: '0.2.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  if (!TOOLS.some((t) => t.name === name)) return { isError: true, content: [{ type: 'text', text: `Unknown tool ${name}` }] };
  try {
    const r = await fetch(`${URL_BASE}/internal/ha/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Relay-Secret': SECRET },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(20000),
    });
    const body = await r.json();
    if (!r.ok) return { isError: true, content: [{ type: 'text', text: body.error || `Request failed (${r.status})` }] };
    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: String(err?.message || err) }] };
  }
});

await server.connect(new StdioServerTransport());
