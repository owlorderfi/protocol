import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { FastifyRequest } from 'fastify';
import { JwtPayloadSchema } from '@polyorder/shared';
import { AuthService } from '../../auth/auth.service.js';
import type { SessionInfo } from '../decorators/current-session.decorator.js';

/**
 * Validates Bearer JWT + verifies the session is still active (non-revoked).
 *
 * On success: attaches `request.session = { walletAddress, sessionId }`
 * for use via @CurrentSession() decorator in controllers.
 */
@Injectable()
export class Web3JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(Web3JwtAuthGuard.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest & { session?: SessionInfo }>();
    const authHeader = req.headers['authorization'];

    if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }
    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) throw new UnauthorizedException('Empty token');

    // Verify JWT signature + expiry
    let rawPayload: unknown;
    try {
      rawPayload = await this.jwt.verifyAsync(token);
    } catch (err) {
      this.logger.debug(`JWT verify failed: ${(err as Error).message}`);
      throw new UnauthorizedException('Invalid or expired token');
    }

    // Validate payload structure
    const parsed = JwtPayloadSchema.safeParse(rawPayload);
    if (!parsed.success) {
      throw new UnauthorizedException('Malformed token payload');
    }

    // Check session is still active (not revoked, not expired in DB)
    const active = await this.auth.isSessionActive(parsed.data.sid);
    if (!active) {
      throw new UnauthorizedException('Session revoked or expired');
    }

    // Attach for downstream decorators
    req.session = {
      walletAddress: parsed.data.sub,
      sessionId: parsed.data.sid,
    };

    return true;
  }
}
