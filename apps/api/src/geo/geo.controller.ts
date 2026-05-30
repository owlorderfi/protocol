/**
 * GET /api/geo/check
 *
 * Read by the SPA on load to decide whether to render the "service
 * unavailable in your region" overlay. See GeoService for the full
 * defense-in-depth rationale.
 *
 * Inputs:
 *   - CF-Connecting-IP — real visitor IP, set by Cloudflare's edge,
 *     forwarded by Caddy via trusted_proxies. Falls back to req.ip
 *     (the Caddy-resolved IP) if absent — useful for local dev where
 *     CF isn't in the path.
 *   - CF-IPCountry — ISO 3166-1 alpha-2 country code, also CF-set.
 *
 * Response:
 *   { blocked: boolean, reason: 'country' | 'subnational' | null }
 *
 * The endpoint is intentionally unauthenticated — it has to work on
 * the very first page load before any sign-in. Rate-limited by the
 * global ThrottlerModule.
 */

import { Controller, Get, Req } from '@nestjs/common';
// Namespace import dodges the isolatedModules + emitDecoratorMetadata
// conflict around using FastifyRequest as a decorated parameter type.
// Other controllers sidestep it by typing through getRequest<>() inside
// guards; we're a controller so the param-type pattern is cleaner.
import * as fastify from 'fastify';
import { GeoService } from './geo.service.js';
import type { GeoCheckResult } from './geo.service.js';

@Controller('geo')
export class GeoController {
  constructor(private readonly geo: GeoService) {}

  @Get('check')
  check(@Req() req: fastify.FastifyRequest): GeoCheckResult {
    const headers = req.headers;
    const ip =
      (headers['cf-connecting-ip'] as string | undefined) ?? req.ip;
    const country = headers['cf-ipcountry'] as string | undefined;
    return this.geo.check(ip, country);
  }
}
