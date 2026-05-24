import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import {
  NonceRequestSchema,
  LoginRequestSchema,
  type NonceRequest,
  type LoginRequest,
} from '@owlorderfi/shared';
import { AuthService } from './auth.service.js';
import { Web3JwtAuthGuard } from '../common/guards/web3-jwt.guard.js';
import { CurrentSession, type SessionInfo } from '../common/decorators/current-session.decorator.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('nonce')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(NonceRequestSchema))
  async nonce(@Body() body: NonceRequest) {
    return this.auth.issueNonce(body.walletAddress);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(LoginRequestSchema))
  async login(@Body() body: LoginRequest) {
    return this.auth.login({
      walletAddress: body.walletAddress,
      nonce: body.nonce,
      signature: body.signature,
    });
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(Web3JwtAuthGuard)
  async logout(@CurrentSession() session: SessionInfo): Promise<void> {
    await this.auth.logout(session.sessionId);
  }
}
