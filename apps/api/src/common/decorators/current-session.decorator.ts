import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { FastifyRequest } from 'fastify';

export interface SessionInfo {
  walletAddress: string;
  sessionId: string;
}

/**
 * @CurrentSession() — controller parameter decorator.
 *
 * Requires Web3JwtAuthGuard upstream (which attaches `request.session`).
 *
 * Usage:
 *   @Get('me')
 *   @UseGuards(Web3JwtAuthGuard)
 *   me(@CurrentSession() session: SessionInfo) { ... }
 */
export const CurrentSession = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SessionInfo => {
    const req = ctx.switchToHttp().getRequest<FastifyRequest & { session?: SessionInfo }>();
    if (!req.session) {
      throw new Error('CurrentSession used without Web3JwtAuthGuard');
    }
    return req.session;
  },
);
