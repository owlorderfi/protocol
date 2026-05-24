import {
  Controller,
  Get,
  Logger,
  Query,
  UseGuards,
  ServiceUnavailableException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isSupportedChainId } from '@owlorderfi/shared';
import { Web3JwtAuthGuard } from '../common/guards/web3-jwt.guard.js';
import { CurrentSession, type SessionInfo } from '../common/decorators/current-session.decorator.js';
import { OwnerService } from './owner.service.js';
import { OwnerOnlyGuard } from './owner-only.guard.js';

/**
 * Admin endpoints — surfaces operator-only data (keeper health,
 * dashboards) gated by the on-chain owner address.
 *
 * Routing:
 *   GET /api/admin/whoami?chainId=N    — JWT-only; returns { owner, isOwner }
 *                                        so the frontend can hide/show
 *                                        the Admin tab without leaking
 *                                        anything privileged.
 *   GET /api/admin/keeper-health?chainId=N
 *                                      — OwnerOnly; proxies keeper's
 *                                        /health JSON (LAN-only port).
 */
@Controller('admin')
export class AdminController {
  private readonly logger = new Logger(AdminController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly ownerService: OwnerService,
  ) {}

  /**
   * Cheap probe used by the frontend to decide whether to render the
   * Admin nav link. Returns the owner address + a boolean so the UI
   * doesn't have to hard-code anything. JWT required (so anonymous
   * callers can't enumerate owners) but NOT owner-only — the answer
   * IS public information (owner is on-chain), the JWT gate is just
   * rate-limiting through the session layer.
   */
  @Get('whoami')
  @UseGuards(Web3JwtAuthGuard)
  async whoami(
    @CurrentSession() session: SessionInfo,
    @Query('chainId') chainIdRaw?: string,
  ): Promise<{ chainId: number; owner: string; walletAddress: string; isOwner: boolean }> {
    if (!chainIdRaw) {
      throw new BadRequestException('chainId query param required');
    }
    const chainId = Number.parseInt(chainIdRaw, 10);
    if (!Number.isFinite(chainId) || !isSupportedChainId(chainId)) {
      throw new BadRequestException(`Unsupported chainId: ${chainIdRaw}`);
    }

    let owner: string;
    try {
      owner = await this.ownerService.getOwner(chainId);
    } catch (err) {
      this.logger.warn(`whoami: owner lookup failed for chain ${chainId}: ${(err as Error).message}`);
      throw new ServiceUnavailableException(
        `Owner cannot be resolved for chain ${chainId} right now`,
      );
    }

    const isOwner =
      owner.toLowerCase() === session.walletAddress.toLowerCase();
    return {
      chainId,
      owner,
      walletAddress: session.walletAddress,
      isOwner,
    };
  }

  /**
   * Proxy the keeper's /health JSON. The keeper exposes this on a
   * LAN-only port (`HEALTH_PORT` in apps/keeper/.env, default 4002);
   * we don't want to expose that port directly through Caddy because
   * it bypasses any auth.
   *
   * Per-chain keeper URL resolution order (mirrors how routers are
   * resolved):
   *   1. `CHAIN_<id>_KEEPER_HEALTH_URL` env (e.g. http://127.0.0.1:4002)
   *   2. legacy `KEEPER_HEALTH_URL` for single-chain dev
   *   3. derived `http://127.0.0.1:${4000 + chainId%1000}` — matches the
   *      systemd unit's per-chain offset (Base Sepolia 84532 → 4532;
   *      single-instance setups using the default 4002 must set the
   *      env explicitly).
   */
  @Get('keeper-health')
  @UseGuards(OwnerOnlyGuard)
  async keeperHealth(@Query('chainId') chainIdRaw: string): Promise<unknown> {
    const chainId = Number.parseInt(chainIdRaw, 10); // already validated upstream
    const url = `${this.resolveKeeperHealthUrl(chainId)}/health`;

    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    } catch (err) {
      this.logger.warn(`keeper-health fetch failed (${url}): ${(err as Error).message}`);
      throw new ServiceUnavailableException(
        `Keeper health endpoint unreachable for chain ${chainId}`,
      );
    }
    if (!res.ok) {
      throw new ServiceUnavailableException(
        `Keeper returned ${res.status} on ${url}`,
      );
    }
    return await res.json();
  }

  private resolveKeeperHealthUrl(chainId: number): string {
    const perChain = this.config.get<string>(`CHAIN_${chainId}_KEEPER_HEALTH_URL`);
    if (perChain) return perChain.replace(/\/$/, '');
    const legacy = this.config.get<string>('KEEPER_HEALTH_URL');
    if (legacy) return legacy.replace(/\/$/, '');
    // Derived default: 4000 + (chainId mod 1000). 84532 → 4532.
    // Matches the convention in ops/systemd/polyorder-keeper@.service.
    const port = 4000 + (chainId % 1000);
    return `http://127.0.0.1:${port}`;
  }
}
