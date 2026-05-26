import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, createHash } from 'node:crypto';
import { verifyMessage } from 'viem';
import {
  buildLoginMessage,
  type NonceResponse,
  type LoginResponse,
  type JwtPayload,
} from '@owlorderfi/shared';
import { PrismaService } from '../common/prisma/prisma.service.js';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly nonceTtlMs = 5 * 60 * 1000; // 5 min
  private readonly sessionTtlMs = 24 * 60 * 60 * 1000; // 24h
  private readonly loginDomain: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.loginDomain = config.get<string>('LOGIN_DOMAIN') ?? 'owlorderfi.local';
  }

  /**
   * Step 1: Issue a nonce + login message for the wallet to sign.
   * Stores nonce in DB with expiry. Multiple nonces can be active per wallet
   * (user might request several before signing one).
   *
   * We deliberately do NOT create a User row here. External bots scrape
   * on-chain `KeeperAuthorizationChanged` events to harvest elevated
   * wallet addresses, then hit /auth/nonce in burst attempts to probe
   * the auth surface — they never sign because they don't have the key,
   * but they used to inflate the User table. Now we only create User on
   * a successful login() below. AuthNonce.userId stays nullable until
   * the wallet actually signs.
   */
  async issueNonce(walletAddress: string): Promise<NonceResponse> {
    const normalizedAddr = walletAddress.toLowerCase();
    const nonce = randomBytes(16).toString('hex'); // 32 hex chars

    // Look up user if it already exists (returning logins). Don't create.
    const user = await this.prisma.user.findUnique({
      where: { walletAddress: normalizedAddr },
    });

    // Create nonce — DB assigns createdAt. We use this exact timestamp for the
    // message both here AND in login(), to ensure signature verification matches.
    const authNonce = await this.prisma.authNonce.create({
      data: {
        userId: user?.id ?? null,
        nonce,
        expiresAt: new Date(Date.now() + this.nonceTtlMs),
      },
    });

    const message = buildLoginMessage({
      domain: this.loginDomain,
      walletAddress: normalizedAddr,
      nonce,
      issuedAt: authNonce.createdAt,
    });

    return { nonce, message, expiresAt: authNonce.expiresAt };
  }

  /**
   * Step 2: Verify signature against the message we issued.
   * On success: mark nonce used, create session, emit JWT.
   */
  async login(input: {
    walletAddress: string;
    nonce: string;
    signature: string;
  }): Promise<LoginResponse> {
    const normalizedAddr = input.walletAddress.toLowerCase();

    // Lookup nonce
    const authNonce = await this.prisma.authNonce.findFirst({
      where: { nonce: input.nonce },
    });
    if (!authNonce) {
      throw new UnauthorizedException('Unknown nonce');
    }
    if (authNonce.consumed) {
      throw new UnauthorizedException('Nonce already used');
    }
    if (authNonce.expiresAt < new Date()) {
      throw new UnauthorizedException('Nonce expired');
    }
    // authNonce.userId may legitimately be null (first-time login: nonce
    // was issued before any User row existed for this wallet). We verify
    // the signature against the request's walletAddress first; only after
    // that's valid do we upsert the User row and link the nonce.

    // Reconstruct the exact message that was signed using the request's
    // walletAddress (which is also what was used in issueNonce).
    const message = buildLoginMessage({
      domain: this.loginDomain,
      walletAddress: normalizedAddr,
      nonce: input.nonce,
      issuedAt: authNonce.createdAt,
    });

    // Verify EIP-191 personal_sign signature
    const valid = await verifyMessage({
      address: input.walletAddress as `0x${string}`,
      message,
      signature: input.signature as `0x${string}`,
    });
    if (!valid) {
      this.logger.warn(`Invalid signature attempt for ${normalizedAddr}`);
      throw new UnauthorizedException('Invalid signature');
    }

    // If the nonce was pre-linked to an existing user (returning login),
    // sanity-check that the linked address matches the request — otherwise
    // someone could try to redeem another user's nonce.
    if (authNonce.userId) {
      const linkedUser = await this.prisma.user.findUnique({
        where: { id: authNonce.userId },
      });
      if (linkedUser && linkedUser.walletAddress !== normalizedAddr) {
        throw new UnauthorizedException('Address mismatch with nonce');
      }
    }

    // Signature verified. Create or update the User row now (first
    // successful login creates it — see issueNonce comment for why).
    const user = await this.prisma.user.upsert({
      where: { walletAddress: normalizedAddr },
      create: { walletAddress: normalizedAddr },
      update: { lastSeenAt: new Date() },
    });

    // Mark nonce used + link to the (possibly newly-created) user.
    await this.prisma.authNonce.update({
      where: { id: authNonce.id },
      data: { consumed: true, userId: user.id },
    });

    // Create session + emit JWT
    const expiresAt = new Date(Date.now() + this.sessionTtlMs);
    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: '', // updated below once JWT signed
        expiresAt,
      },
    });

    const payload: JwtPayload = { sub: normalizedAddr, sid: session.id };
    const accessToken = await this.jwt.signAsync(payload, {
      expiresIn: Math.floor(this.sessionTtlMs / 1000),
    });

    // Persist token hash so we can revoke later
    const tokenHash = createHash('sha256').update(accessToken).digest('hex');
    await this.prisma.session.update({
      where: { id: session.id },
      data: { tokenHash },
    });

    this.logger.log(`Login OK: ${normalizedAddr} (session ${session.id})`);

    return {
      accessToken,
      expiresAt,
      user: { walletAddress: normalizedAddr as `0x${string}` },
    };
  }

  /**
   * Revoke a session (logout).
   * JWT remains technically valid until expiry, but guard rejects it.
   */
  async logout(sessionId: string): Promise<void> {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.revokedAt) return; // idempotent
    await this.prisma.session.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() },
    });
    this.logger.log(`Session revoked: ${sessionId}`);
  }

  /**
   * Used by guard to verify session is still active.
   */
  async isSessionActive(sessionId: string): Promise<boolean> {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session) return false;
    if (session.revokedAt) return false;
    if (session.expiresAt < new Date()) return false;
    return true;
  }
}
