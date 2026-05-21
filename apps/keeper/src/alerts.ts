import { log } from './logger';

/**
 * Fire-and-forget Discord notification via webhook.
 *
 * Discord webhooks accept POSTs with { content, username, embeds, ... };
 * the bare-bones form is fine for an ops ping. No auth required — the
 * webhook URL is the secret. Set ALERT_DISCORD_WEBHOOK env var.
 *
 * If the webhook is unset or unreachable, we log and continue — never
 * crash the keeper because Discord is having a bad day.
 */
export async function sendDiscordAlert(message: string, webhookUrl: string | undefined): Promise<void> {
  if (!webhookUrl) return;
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message, username: 'Polyorder Keeper' }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      // The AbortSignal applies to the connection, not to reading the body.
      // Cap that separately so a hung-chunked-response can't stall the log.
      const body = await Promise.race([
        res.text().catch(() => '<unreadable>'),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve('<body read timeout>'), 2_000),
        ),
      ]);
      log.warn(`[alert] Discord webhook returned ${res.status}: ${body}`);
    }
  } catch (err) {
    log.error('[alert] Discord webhook failed', err);
  }
}
