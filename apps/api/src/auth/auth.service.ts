import { Injectable, Logger, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, createHash } from 'node:crypto';
import { verifyMessage } from 'viem';
import {
  buildLoginMessage,
  type NonceResponse,
  type LoginResponse,
  type JwtPayload,
} from '@polyorder/shared';
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
    this.loginDomain = config.get<string>('LOGIN_DOMAIN') ?? 'polyorder.local';
  }

  /**
   * Step 1: Issue a nonce + login message for the wallet to sign.
   * Stores nonce in DB with expiry. Multiple nonces can be active per wallet
   * (user might request several before signing one).
   */
  async issueNonce(walletAddress: string): Promise<NonceResponse> {
    const normalizedAddr = walletAddress.toLowerCase();
    const nonce = randomBytes(16).toString('hex'); // 32 hex chars

    // Upsert user (just so userId can be linked later; no PII stored)
    const user = await this.prisma.user.upsert({
      where: { walletAddress: normalizedAddr },
      create: { walletAddress: normalizedAddr },
      update: { lastSeenAt: new Date() },
    });

    // Create nonce — DB assigns createdAt. We use this exact timestamp for the
    // message both here AND in login(), to ensure signature verification matches.
    const authNonce = await this.prisma.authNonce.create({
      data: {
        userId: user.id,
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
    if (!authNonce.userId) {
      throw new BadRequestException('Nonce not linked to a user');
    }

    // Reconstruct exact message that was signed
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: authNonce.userId },
    });
    if (user.walletAddress !== normalizedAddr) {
      throw new UnauthorizedException('Address mismatch with nonce');
    }

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

    // Mark nonce used + clean any other pending nonces for this user
    await this.prisma.authNonce.update({
      where: { id: authNonce.id },
      data: { consumed: true },
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
