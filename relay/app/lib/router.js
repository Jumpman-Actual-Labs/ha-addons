// Picks provider, mode and effort when the user leaves them on Auto.
// Plain rules, no model call, so routing itself costs nothing.

const AGENT_HINTS = /\b(file|files|folder|repo|repository|code|script|function|bug|error|traceback|stack ?trace|fix|build|compile|install|run|deploy|refactor|test|tests|commit|branch|docker|compose|yaml|json|config|log|logs|integration|add-?on|automation|migrate|debug)\b/i;
// Questions that need live information: the outside world (web) or the house (Home Assistant).
const LOOKUP_HINTS = /\b(how (are|is|did|have) (the |my )?\w+( \w+)? (do|doing|done|play|playing)|weather|forecast|rain|snow|wind|temperature|humid(ity)?|today|tonight|tomorrow|this (week|weekend)|right now|currently|current|latest|news|score|scores|game|price|prices|stock|open now|hours|traffic|who'?s home|anyone home|is (the|my) .+ (on|off|open|closed|locked|unlocked)|lights?|doors?|garage|lock(ed)?|thermostat|sensor|battery|alarm|vacuum|blinds|shades)\b/i;
const RECENT_HINTS = /\b(last (game|night|week|match)|score|scores|won|lost|beat|news|latest|standings|schedule|price|stock)\b/i;
const HARD_HINTS = /\b(think (hard|carefully)|step by step|tricky|complex|architecture|design (a|the)|prove|edge cases?|optimi[sz]e)\b/i;

export function route(text, req, conv, opts, cooldowns) {
  const now = Date.now();
  const cooling = (p) => (cooldowns[p] || 0) > now;

  // Mode
  let mode = req.mode;
  if (!mode || mode === 'auto') {
    const looksAgent = AGENT_HINTS.test(text) || /```/.test(text) || /(^|\s)(\/|~\/|\.\/)[\w.-]+/.test(text);
    mode = looksAgent ? 'agent' : LOOKUP_HINTS.test(text) ? 'lookup' : 'chat';
    // Follow-ups stay in the mode the conversation is working in ("docx", "now make it shorter").
    const last = [...(conv.messages || [])].reverse().find((m) => m.role === 'assistant' && m.route)?.route.mode;
    if (mode === 'chat' && (last === 'agent' || last === 'lookup')) mode = last;
  }

  // Provider: a conversation stays with its provider unless the user switches it.
  let provider = req.provider && req.provider !== 'auto' ? req.provider : null;
  let switched = false;
  if (!provider) {
    provider = conv.provider || (mode === 'agent' ? opts.default_agent_provider : opts.default_chat_provider);
    if (cooling(provider)) {
      const other = provider === 'claude' ? 'codex' : 'claude';
      if (!cooling(other)) provider = other;
    }
  }
  if (conv.provider && conv.provider !== provider) switched = true;

  // Effort
  let effort = req.effort;
  if (!effort || effort === 'auto') {
    effort = mode === 'agent' ? 'medium' : 'low';
    if (mode === 'lookup' && RECENT_HINTS.test(text)) effort = 'medium';
    if (HARD_HINTS.test(text)) effort = 'high';
  }

  const heavy = !!req.heavy;
  return { provider, mode, effort, heavy, switched };
}
