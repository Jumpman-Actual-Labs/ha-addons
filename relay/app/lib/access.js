// The Configuration tab's Allowed users. server.js checks this after the ingress-address check,
// so the X-Remote-User-* headers are Supervisor's and can't be forged.

// Lowercased and trimmed once at startup (the add-on restarts when its options change).
export function allowedUsers(opts) {
  return new Set((opts.allowed_users || []).map((u) => String(u).trim().toLowerCase()).filter(Boolean));
}

// The viewer's username, or their user id if ingress sent no name. '' when there's neither.
export function remoteUser(req) {
  return String(req.headers['x-remote-user-name'] || req.headers['x-remote-user-id'] || '').trim();
}

// A request with no user is always refused; an empty list lets every user in.
export function isAllowed(user, allowed) {
  return !!user && (allowed.size === 0 || allowed.has(user.toLowerCase()));
}

// Styled like public/style.css, since the panel itself never loads for a refused user.
export const NO_ACCESS_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relay</title>
<style>
:root{color-scheme:light;--bg:#f2f5f9;--surface:#fff;--ink:#172538;--muted:#718098;--line:#e2e8f0;--accent:#3668e8;--accent-soft:#eaf0ff}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#0c131d;--surface:#151f2c;--ink:#eff5fc;--muted:#9cacc0;--line:#2a3a4a;--accent:#7a9cfa;--accent-soft:#223859}}
html,body{margin:0;height:100%}body{background:var(--bg);color:var(--muted);font:14px/1.6 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;display:grid;place-items:center;padding:0 16px}
.card{max-width:420px;background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:32px 28px;text-align:center}
.mark{height:44px;width:44px;margin:0 auto 16px;border-radius:13px;background:var(--accent-soft);color:var(--accent);display:grid;place-items:center;font-size:20px;font-weight:750}
h1{margin:0 0 8px;color:var(--ink);font-size:17px;letter-spacing:-.2px}p{margin:0}
</style>
</head>
<body>
<div class="card">
<div class="mark">&#x2715;</div>
<h1>You don't have access to this add-on</h1>
<p>Ask a Home Assistant administrator to add your username to Relay's Allowed users option.</p>
</div>
</body>
</html>
`;
