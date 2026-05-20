import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { Web3JwtAuthGuard } from '../common/guards/web3-jwt.guard.js';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('JWT_SECRET');
        if (!secret || secret.length < 32) {
          throw new Error('JWT_SECRET must be set and at least 32 chars long');
        }
        return {
          secret,
          signOptions: {
            issuer: 'polyorder-api',
          },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, Web3JwtAuthGuard],
  exports: [AuthService, Web3JwtAuthGuard, JwtModule],
})
export class AuthModule {}
