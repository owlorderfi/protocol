/**
 * Tiny metrics store. Hand-rolled because the `prom-client` library is
 * 50+ KB for what amounts to a few counters + a text serializer.
 */

class Counter {
  private value = 0;
  inc(by = 1): void { this.value += by; }
  get(): number { return this.value; }
}

/** Map of label-value-combinations → count for a single metric. */
class LabeledCounter {
  private values = new Map<string, number>();

  inc(labels: Record<string, string>, by = 1): void {
    const k = labelKey(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }

  entries(): Array<{ labels: Record<string, string>; value: number }> {
    return [...this.values.entries()].map(([k, v]) => ({
      labels: parseLabelKey(k),
      value: v,
    }));
  }
}

function labelKey(labels: Record<string, string>): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
}

function parseLabelKey(key: string): Record<string, string> {
  if (!key) return {};
  return Object.fromEntries(key.split(',').map((p) => p.split('=')));
}

export const metrics = {
  startedAt: Date.now(),

  /** Orders the poller examined (cycle counter). */
  ordersPolled: new Counter(),
  /** Orders that hit the trigger condition. */
  ordersTriggered: new Counter(),
  /** Tx submissions to the LimitOrderRouter. */
  txSubmitted: new Counter(),
  /** Tx replacements (gas-bump same nonce). */
  txReplaced: new Counter(),
  /** Final disposition by status: filled / failed / cancelled / etc. */
  ordersByStatus: new LabeledCounter(),
  /** Quote / RPC errors by stage. */
  errorsByStage: new LabeledCounter(),

  /** Last time the poller completed a cycle (epoch ms). */
  lastPollAt: 0,
  /** Last time we marked an order FILLED (epoch ms). */
  lastFillAt: 0,
  /** Current open order count from DB (set by poller). */
  openOrderCount: 0,

  uptimeSec(): number {
    return Math.floor((Date.now() - this.startedAt) / 1000);
  },
};

/** Serialize to Prometheus text exposition format. */
export function renderPrometheus(): string {
  const lines: string[] = [];
  const m = metrics;

  const escape = (v: string) => v.replace(/[\\"\n]/g, (c) =>
    c === '\\' ? '\\\\' : c === '"' ? '\\"' : '\\n',
  );

  const writeLabeled = (
    name: string,
    help: string,
    type: 'counter' | 'gauge',
    counter: LabeledCounter,
  ) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    const entries = counter.entries();
    if (entries.length === 0) lines.push(`${name} 0`);
    else
      for (const { labels, value } of entries) {
        const labelStr = Object.entries(labels)
          .map(([k, v]) => `${k}="${escape(v)}"`)
          .join(',');
        lines.push(`${name}{${labelStr}} ${value}`);
      }
  };

  const writeSimple = (name: string, help: string, type: 'counter' | 'gauge', value: number) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    lines.push(`${name} ${value}`);
  };

  writeSimple('polyorder_keeper_uptime_seconds', 'Seconds since keeper start', 'gauge', m.uptimeSec());
  writeSimple('polyorder_orders_polled_total', 'Orders examined by the poller', 'counter', m.ordersPolled.get());
  writeSimple('polyorder_orders_triggered_total', 'Orders that hit trigger condition', 'counter', m.ordersTriggered.get());
  writeSimple('polyorder_tx_submitted_total', 'On-chain tx submissions', 'counter', m.txSubmitted.get());
  writeSimple('polyorder_tx_replaced_total', 'Stuck-tx replacements with bumped gas', 'counter', m.txReplaced.get());
  writeSimple(
    'polyorder_seconds_since_last_poll',
    'Seconds since poller last completed a cycle',
    'gauge',
    m.lastPollAt === 0 ? -1 : Math.floor((Date.now() - m.lastPollAt) / 1000),
  );
  writeSimple(
    'polyorder_seconds_since_last_fill',
    'Seconds since the last successful order fill',
    'gauge',
    m.lastFillAt === 0 ? -1 : Math.floor((Date.now() - m.lastFillAt) / 1000),
  );
  writeSimple('polyorder_open_orders', 'Current OPEN order count', 'gauge', m.openOrderCount);
  writeLabeled('polyorder_orders_total', 'Orders by final status', 'counter', m.ordersByStatus);
  writeLabeled('polyorder_errors_total', 'Errors by pipeline stage', 'counter', m.errorsByStage);

  return lines.join('\n') + '\n';
}
