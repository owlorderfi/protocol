import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { getAddress } from 'viem';
import { Web3JwtAuthGuard } from '../common/guards/web3-jwt.guard.js';
import { OwnerService } from './owner.service.js';
import type { SessionInfo } from '../common/decorators/current-session.decorator.js';

/**
 * Admin-only gate. Runs Web3JwtAuthGuard first (rejects unauthenticated)
 * then compares the JWT's wallet address against the on-chain owner of
 * the requested chain's router. Mismatch → 403.
 *
 * Chain is read from `?chainId=<n>` query param. Defaulting is
 * deliberately rejected — owner is a per-chain concept, the caller
 * must say which chain they're asking about.
 *
 * Fails closed: any error reading owner from chain throws, returning
 * 403 / 500 — never silently allowing access.
 */
@Injectable()
export class OwnerOnlyGuard implements CanActivate {
  private readonly logger = new Logger(OwnerOnlyGuard.name);

  constructor(
    private readonly jwtGuard: Web3JwtAuthGuard,
    private readonly ownerService: OwnerService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Step 1: standard JWT auth (attaches request.session).
    const jwtPassed = await this.jwtGuard.canActivate(context);
    if (!jwtPassed) return false;

    const req = context.switchToHttp().getRequest<FastifyRequest & { session?: SessionInfo }>();
    if (!req.session) {
      // Shouldn't happen if jwtPassed is true, but defensive.
      throw new ForbiddenException('No session attached');
    }

    // Step 2: chainId param required.
    const q = req.query as Record<string, string | undefined> | undefined;
    const chainIdRaw = q?.chainId;
    if (!chainIdRaw) {
      throw new BadRequestException('chainId query param required');
    }
    const chainId = Number.parseInt(chainIdRaw, 10);
    if (!Number.isFinite(chainId) || chainId <= 0) {
      throw new BadRequestException(`Invalid chainId: ${chainIdRaw}`);
    }

    // Step 3: compare session wallet to chain's owner.
    let owner: string;
    try {
      owner = await this.ownerService.getOwner(chainId);
    } catch (err) {
      this.logger.warn(
        `Owner lookup failed for chain ${chainId}: ${(err as Error).message}`,
      );
      throw new ForbiddenException(
        `Cannot resolve owner for chain ${chainId} — fail closed`,
      );
    }

    const sessionAddrChecksum = getAddress(req.session.walletAddress);
    if (sessionAddrChecksum !== owner) {
      this.logger.warn(
        `Admin access denied: session ${sessionAddrChecksum} != owner ${owner} (chain ${chainId})`,
      );
      throw new ForbiddenException('Not owner of this chain');
    }

    return true;
  }
}
