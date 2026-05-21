import http from 'node:http';
import { metrics, renderPrometheus } from './metrics';
import { log } from './logger';

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

    res.statusCode = 404;
    res.end('Not found. Available: /health, /metrics\n');
  });

  server.listen(port, '0.0.0.0', () => {
    log.info(`[health] Listening on http://0.0.0.0:${port}/  (try /health and /metrics)`);
  });

  server.on('error', (err) => {
    log.error('[health] Server error:', err);
  });
}
