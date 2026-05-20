import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false }),
    { bufferLogs: true },
  );

  const config = app.get(ConfigService);
  // ConfigService.get returns string from env; coerce explicitly
  const port = Number(config.get<string>('API_PORT') ?? 3001);
  const corsOrigins = (config.get<string>('CORS_ORIGINS') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Dev fallback: if no CORS_ORIGINS set, reflect any origin (echo back).
  // ⚠️ For production: ensure CORS_ORIGINS is explicitly set to allowed list.
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : true,
    credentials: true,
  });

  // Note: Global Zod-based validation pipe will be added via nestjs-zod
  // once we register the first controller with @UsePipes(ZodValidationPipe).
  // We skip @nestjs/common ValidationPipe (class-validator) by design.

  await app.listen(port, '0.0.0.0');
  Logger.log(`🚀 Polyorder API listening on http://localhost:${port}`, 'Bootstrap');
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to bootstrap:', err);
  process.exit(1);
});
