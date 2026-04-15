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
  <div class="card"><div class="card-label">Health Score</div><div class="card-value" id="health-score">&mdash;</div></div>
  <div class="card"><div class="card-label">Top Tool p95</div><div class="card-value" id="top-p95">&mdash;</div></div>
</div>
<div class="events" id="latency-section" style="display:none;margin-bottom:16px">
  <h2>Latency (top tools by p95)</h2>
  <table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead><tr style="color:var(--muted)"><th style="text-align:left;padding:4px 6px">Tool</th><th style="text-align:right;padding:4px 6px">p50</th><th style="text-align:right;padding:4px 6px">p95</th><th style="text-align:right;padding:4px 6px">p99</th><th style="text-align:right;padding:4px 6px">Calls/m</th></tr></thead>
    <tbody id="latency-rows"></tbody>
  </table>
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

    // Health card
    if (d.perf) {
      var score = d.perf.health && d.perf.health.score !== undefined ? d.perf.health.score : null;
      var scoreEl = document.getElementById('health-score');
      if (score !== null) {
        var cls = score >= 80 ? 'badge-green' : score >= 50 ? 'badge-orange' : 'badge-red';
        scoreEl.innerHTML = '<span class="badge ' + cls + '">' + score + '</span>';
      }
      // Top tool p95
      var p95El = document.getElementById('top-p95');
      if (d.perf.latency && d.perf.latency.overallP95Ms !== undefined) {
        p95El.textContent = d.perf.latency.overallP95Ms + 'ms';
      }
      // Latency table
      var perTool = d.perf.latency && d.perf.latency.perTool ? d.perf.latency.perTool : {};
      var tools = Object.entries(perTool).sort(function(a, b) { return b[1].p95 - a[1].p95; }).slice(0, 8);
      if (tools.length > 0) {
        document.getElementById('latency-section').style.display = '';
        document.getElementById('latency-rows').innerHTML = tools.map(function(e) {
          var t = e[0]; var v = e[1];
          return '<tr style="border-top:1px solid var(--border)">' +
            '<td style="padding:3px 6px">' + t.replace(/</g,'&lt;') + '</td>' +
            '<td style="text-align:right;padding:3px 6px">' + (v.p50 || 0) + 'ms</td>' +
            '<td style="text-align:right;padding:3px 6px">' + (v.p95 || 0) + 'ms</td>' +
            '<td style="text-align:right;padding:3px 6px">' + (v.p99 || 0) + 'ms</td>' +
            '<td style="text-align:right;padding:3px 6px">' + (v.calls || 0) + '</td>' +
            '</tr>';
        }).join('');
      }
    }

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
