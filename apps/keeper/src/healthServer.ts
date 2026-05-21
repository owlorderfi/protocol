import http from 'node:http';
import { metrics, renderPrometheus } from './metrics';
import { log } from './logger';

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Polyorder Keeper</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
         background: #0f172a; color: #f1f5f9; margin: 0; padding: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #64748b; font-size: 12px; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 12px; max-width: 1200px; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 8px;
          padding: 16px; }
  .label { color: #94a3b8; font-size: 11px; text-transform: uppercase;
           letter-spacing: 0.05em; margin-bottom: 4px; }
  .value { font-size: 24px; font-weight: 600; color: #f1f5f9; }
  .ok { color: #34d399; } .warn { color: #fbbf24; } .err { color: #f87171; }
  .muted { color: #64748b; font-size: 12px; }
  footer { margin-top: 24px; color: #475569; font-size: 11px; }
  a { color: #38bdf8; }
</style>
</head>
<body>
<h1>Polyorder Keeper <span id="status" class="ok">●</span></h1>
<div class="sub">Refresh every 5s. Raw <a href="/health">/health</a> · <a href="/metrics">/metrics</a></div>
<div class="grid" id="grid"></div>
<footer>Last update: <span id="lastUpdate">—</span></footer>
<script>
function fmtTime(ms) {
  if (ms === null || ms === undefined || ms < 0) return '—';
  if (ms < 60) return ms + 's';
  if (ms < 3600) return Math.floor(ms / 60) + 'm ' + (ms % 60) + 's';
  return Math.floor(ms / 3600) + 'h ' + Math.floor((ms % 3600) / 60) + 'm';
}
function since(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
}
async function refresh() {
  try {
    const r = await fetch('/health');
    const d = await r.json();
    const lastPollSec = since(d.last_poll_at);
    const lastFillSec = since(d.last_fill_at);
    const pollClass = lastPollSec === null ? 'muted' : lastPollSec < 10 ? 'ok' : lastPollSec < 60 ? 'warn' : 'err';
    const fillClass = lastFillSec === null ? 'muted' : '';

    document.getElementById('grid').innerHTML = [
      ['Status', d.status, d.status === 'ok' ? 'ok' : 'err'],
      ['Uptime', fmtTime(d.uptime_seconds), ''],
      ['Open orders', d.open_orders, d.open_orders > 0 ? 'ok' : 'muted'],
      ['Last poll', lastPollSec === null ? 'never' : fmtTime(lastPollSec) + ' ago', pollClass],
      ['Last fill', lastFillSec === null ? 'never' : fmtTime(lastFillSec) + ' ago', fillClass],
      ['Orders polled', d.orders_polled, ''],
      ['Orders triggered', d.orders_triggered, ''],
      ['Tx submitted', d.tx_submitted, ''],
      ['Tx replaced', d.tx_replaced, d.tx_replaced > 0 ? 'warn' : 'muted'],
    ].map(([label, value, cls]) =>
      \`<div class="card"><div class="label">\${label}</div><div class="value \${cls}">\${value}</div></div>\`
    ).join('');
    document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString();
    document.getElementById('status').className = 'ok';
  } catch (e) {
    document.getElementById('status').className = 'err';
    document.getElementById('lastUpdate').textContent = 'FAILED: ' + e.message;
  }
}
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;

/**
 * Tiny HTTP server exposing /health and /metrics.
 *
 * - GET /health   → 200 + JSON status snapshot (uptime, last poll/fill, counts)
 * - GET /metrics  → 200 + Prometheus text exposition
 *
 * No extra deps; uses Node's built-in http module. Designed to be scraped by
 * a Prometheus job + checked by a liveness/readiness probe.
 */
export function startHealthServer(port: number): void {
  const server = http.createServer((req, res) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end();
      return;
    }
    const path = req.url.split('?')[0];

    if (path === '/health') {
      const body = {
        status: 'ok',
        uptime_seconds: metrics.uptimeSec(),
        last_poll_at: metrics.lastPollAt ? new Date(metrics.lastPollAt).toISOString() : null,
        last_fill_at: metrics.lastFillAt ? new Date(metrics.lastFillAt).toISOString() : null,
        orders_polled: metrics.ordersPolled.get(),
        orders_triggered: metrics.ordersTriggered.get(),
        tx_submitted: metrics.txSubmitted.get(),
        tx_replaced: metrics.txReplaced.get(),
        open_orders: metrics.openOrderCount,
      };
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body, null, 2));
      return;
    }

    if (path === '/metrics') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      res.end(renderPrometheus());
      return;
    }

    if (path === '/' || path === '/dashboard') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(DASHBOARD_HTML);
      return;
    }

    res.statusCode = 404;
    res.end('Not found. Available: /, /health, /metrics\n');
  });

  server.listen(port, '0.0.0.0', () => {
    log.info(`[health] Listening on http://0.0.0.0:${port}/  (dashboard / health / metrics)`);
  });

  server.on('error', (err) => {
    log.error('[health] Server error:', err);
  });
}
