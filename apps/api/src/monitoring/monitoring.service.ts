import { Injectable, Logger } from '@nestjs/common';
import { CaddyCollector, type CaddySnapshot } from './collectors/caddy.collector.js';

/**
 * Orchestrator for the monitoring panel. For Phase B1-α this just wraps
 * one collector (CaddyCollector). Future B-Bundle 2 adds connections /
 * UFW / fail2ban / SSH collectors and the scheduler that persists
 * snapshots to MonitoringSnapshot.
 *
 * The "live snapshot" path (collect() below) runs every collector
 * synchronously and returns the combined view. Designed for the admin
 * dashboard to call on each refresh (~60s polling). All collectors are
 * read-only against on-disk state so they're safe to run on demand.
 */
export interface MonitoringSnapshot {
  collected_at: string; // ISO timestamp
  caddy: CaddySnapshot;
}

@Injectable()
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name);

  constructor(private readonly caddyCollector: CaddyCollector) {}

  async collect(): Promise<MonitoringSnapshot> {
    const caddy = await this.caddyCollector.collect();
    return {
      collected_at: new Date().toISOString(),
      caddy,
    };
  }
}
