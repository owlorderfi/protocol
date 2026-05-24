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
import { getAddress, type Address } from 'viem';
import { isSupportedChainId } from '@owlorderfi/shared';
import { Web3JwtAuthGuard } from '../common/guards/web3-jwt.guard.js';
import { CurrentSession, type SessionInfo } from '../common/decorators/current-session.decorator.js';
import { OwnerService } from './owner.service.js';
import { OwnerOnlyGuard } from './owner-only.guard.js';
import { ContractStateService } from './contract-state.service.js';

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
    private readonly contractState: ContractStateService,
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

  /**
   * Contract-wide view state: pause, fee recipient, reserve target +
   * current accumulated reserve, daily refill stats, wrapped native.
   * Used by the dashboard's Reserve panel and pause badge.
   */
  @Get('contract-state')
  @UseGuards(OwnerOnlyGuard)
  async getContractState(@Query('chainId') chainIdRaw: string): Promise<unknown> {
    const chainId = Number.parseInt(chainIdRaw, 10);
    try {
      return await this.contractState.getContractState(chainId);
    } catch (err) {
      this.logger.warn(`contract-state failed for chain ${chainId}: ${(err as Error).message}`);
      throw new ServiceUnavailableException(
        `Cannot read contract state for chain ${chainId}: ${(err as Error).message.slice(0, 120)}`,
      );
    }
  }

  /**
   * Per-token accumulated fees + sweep threshold. Caller supplies the
   * token list (?tokens=0x..,0x..) — the frontend's own token registry
   * is the source of truth so we don't duplicate it here. Capped at
   * 50 addresses to bound the RPC fan-out.
   */
  @Get('fees')
  @UseGuards(OwnerOnlyGuard)
  async fees(
    @Query('chainId') chainIdRaw: string,
    @Query('tokens') tokensRaw?: string,
  ): Promise<unknown> {
    const chainId = Number.parseInt(chainIdRaw, 10);
    const tokens = this.parseAddressList(tokensRaw, 'tokens');
    try {
      return await this.contractState.getFeesForTokens(chainId, tokens);
    } catch (err) {
      this.logger.warn(`fees failed for chain ${chainId}: ${(err as Error).message}`);
      throw new ServiceUnavailableException(
        `Cannot read fees for chain ${chainId}: ${(err as Error).message.slice(0, 120)}`,
      );
    }
  }

  /**
   * Per-keeper authorization status + native gas balance. Same query
   * pattern as fees: caller supplies the address list (?addresses=...).
   * Single-keeper deploys pass just INITIAL_KEEPER; multi-keeper or
   * rotation tracking is its own future endpoint.
   */
  @Get('keepers')
  @UseGuards(OwnerOnlyGuard)
  async keepers(
    @Query('chainId') chainIdRaw: string,
    @Query('addresses') addressesRaw?: string,
  ): Promise<unknown> {
    const chainId = Number.parseInt(chainIdRaw, 10);
    const addresses = this.parseAddressList(addressesRaw, 'addresses');
    try {
      return await this.contractState.getKeepersStatus(chainId, addresses);
    } catch (err) {
      this.logger.warn(`keepers failed for chain ${chainId}: ${(err as Error).message}`);
      throw new ServiceUnavailableException(
        `Cannot read keeper status for chain ${chainId}: ${(err as Error).message.slice(0, 120)}`,
      );
    }
  }

  /**
   * Parse a comma-separated list of hex addresses from a query param.
   * Returns them in EIP-55 checksum form so downstream comparison logic
   * doesn't have to lowercase-normalize. Empty / missing → empty array.
   * Invalid entries throw 400 so the frontend's bug surfaces loudly.
   */
  private parseAddressList(raw: string | undefined, paramName: string): Address[] {
    if (!raw) return [];
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    // Pre-cap before getAddress() loops over the whole list — a
    // malicious caller sending 10k addresses shouldn't run O(n)
    // checksum work just to be told "too many" at the service layer.
    // 50 covers tokens (cap) + headroom; 20 covers keepers (cap).
    // Both service-side caps still enforce their stricter limit.
    if (parts.length > 50) {
      throw new BadRequestException(`${paramName}: too many entries (${parts.length} > 50)`);
    }
    return parts.map((p) => {
      if (!/^0x[a-fA-F0-9]{40}$/.test(p)) {
        throw new BadRequestException(`${paramName}: invalid address "${p}"`);
      }
      return getAddress(p);
    });
  }
}
