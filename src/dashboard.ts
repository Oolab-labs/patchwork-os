/**
 * dashboard.ts — lightweight status dashboard served at GET /dashboard
 *
 * Unauthenticated (same as /ping) — safe for localhost-only use.
 * For VPS deployments (--bind 0.0.0.0), restrict at nginx/firewall or
 * disable with --no-dashboard flag.
 *
 * Data comes from GET /dashboard/data (also unauthenticated) which exposes
 * only: version, uptimeMs, sessions, extensionConnected, extensionVersion.
 * No workspace paths, no tool outputs, no session content.
 */

export function renderDashboardHtml(version: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude IDE Bridge</title>
<style>
  :root { --bg: #0d0f12; --card: #161b22; --border: #30363d; --text: #e6edf3; --muted: #7d8590; --green: #3fb950; --orange: #f0883e; --red: #f85149; --blue: #58a6ff; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", monospace; font-size: 14px; padding: 24px; }
  h1 { font-size: 18px; font-weight: 600; margin-bottom: 4px; color: var(--blue); }
  .subtitle { color: var(--muted); font-size: 12px; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .card-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-bottom: 8px; }
  .card-value { font-size: 22px; font-weight: 600; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 500; }
  .badge-green { background: rgba(63,185,80,.15); color: var(--green); }
  .badge-orange { background: rgba(240,136,62,.15); color: var(--orange); }
  .badge-red { background: rgba(248,81,73,.15); color: var(--red); }
  .events { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .events h2 { font-size: 13px; font-weight: 600; color: var(--muted); margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
  .event-row { display: flex; gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--muted); }
  .event-row:last-child { border-bottom: none; }
  .event-time { flex-shrink: 0; font-variant-numeric: tabular-nums; }
  .event-msg { color: var(--text); }
  .footer { margin-top: 16px; text-align: right; font-size: 11px; color: var(--muted); }
  .error-banner { background: rgba(248,81,73,.1); border: 1px solid var(--red); border-radius: 6px; padding: 10px 14px; margin-bottom: 16px; font-size: 12px; color: var(--red); display: none; }
</style>
</head>
<body>
<h1>Claude IDE Bridge</h1>
<p class="subtitle" id="sub">v${version} — loading&hellip;</p>
<div class="error-banner" id="err"></div>
<div class="grid">
  <div class="card"><div class="card-label">Status</div><div class="card-value" id="status">&mdash;</div></div>
  <div class="card"><div class="card-label">Uptime</div><div class="card-value" id="uptime">&mdash;</div></div>
  <div class="card"><div class="card-label">Sessions</div><div class="card-value" id="sessions">&mdash;</div></div>
  <div class="card"><div class="card-label">Extension</div><div class="card-value" id="ext">&mdash;</div></div>
</div>
<div class="events">
  <h2>Recent Events</h2>
  <div id="events"><div class="event-row"><span class="event-msg" style="color:var(--muted)">Loading&hellip;</span></div></div>
</div>
<div class="footer" id="footer"></div>

<script>
const fmt = (ms) => {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
};

const badge = (ok) => ok
  ? '<span class="badge badge-green">Connected</span>'
  : '<span class="badge badge-orange">Disconnected</span>';

async function refresh() {
  try {
    const r = await fetch('/dashboard/data');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    document.getElementById('err').style.display = 'none';
    document.getElementById('sub').textContent = 'v' + d.version + ' — auto-refreshes every 10s';
    document.getElementById('status').innerHTML = '<span class="badge badge-green">Running</span>';
    document.getElementById('uptime').textContent = fmt(d.uptimeMs);
    document.getElementById('sessions').textContent = d.sessions;
    document.getElementById('ext').innerHTML = badge(d.extensionConnected);

    const evEl = document.getElementById('events');
    if (d.events && d.events.length > 0) {
      evEl.innerHTML = d.events.slice(-10).reverse().map(e => {
        const t = new Date(e.at).toLocaleTimeString();
        return '<div class="event-row"><span class="event-time">' + t + '</span><span class="event-msg">' + e.msg.replace(/</g,'&lt;') + '</span></div>';
      }).join('');
    } else {
      evEl.innerHTML = '<div class="event-row"><span class="event-msg" style="color:var(--muted)">No events yet</span></div>';
    }
    document.getElementById('footer').textContent = 'Last updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    const el = document.getElementById('err');
    el.textContent = 'Failed to fetch data: ' + e.message;
    el.style.display = 'block';
    document.getElementById('status').innerHTML = '<span class="badge badge-red">Error</span>';
  }
}

refresh();
setInterval(refresh, 10_000);
</script>
</body>
</html>`;
}
