import 'reflect-metadata';
// Init Sentry FIRST — before any other imports do work, so module-load
// errors and the framework's own throws are captured.
import { initSentry, SentryExceptionFilter } from './sentry.js';
initSentry();

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
  // Optional path prefix — used in prod where Caddy proxies /api/* into
  // here on the same domain as the web app. Dev keeps routes plain
  // (no prefix) because the web hits the API directly on :4001.
  const apiPrefix = config.get<string>('API_GLOBAL_PREFIX') ?? '';
  if (apiPrefix) {
    app.setGlobalPrefix(apiPrefix);
  }

  // CORS origin policy. With an explicit allowlist, use it. Otherwise: dev
  // reflects any origin for convenience, but PROD must NEVER do reflect-any
  // together with credentials:true — that's an open credentialed-CORS hole.
  // In prod the web is same-origin behind Caddy (no CORS needed), so denying
  // cross-origin here is safe and fails loudly if the env is misconfigured.
  const isProd = (config.get<string>('NODE_ENV') ?? '') === 'production';
  let corsOrigin: string[] | boolean;
  if (corsOrigins.length > 0) {
    corsOrigin = corsOrigins;
  } else if (isProd) {
    Logger.error(
      'CORS_ORIGINS is empty in production — refusing cross-origin requests. ' +
        'Set CORS_ORIGINS to the web origin(s) if cross-origin access is intended.',
      'Bootstrap',
    );
    corsOrigin = false;
  } else {
    corsOrigin = true;
  }
  app.enableCors({
    origin: corsOrigin,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Note: Global Zod-based validation pipe will be added via nestjs-zod
  // once we register the first controller with @UsePipes(ZodValidationPipe).
  // We skip @nestjs/common ValidationPipe (class-validator) by design.

  // Bind to localhost only in prod (Caddy proxies into us). Dev still
  // binds 0.0.0.0 so the LAN can hit it. Toggle via env.
  const bindHost = config.get<string>('API_BIND_HOST') ?? '0.0.0.0';

  // Global exception filter — pipes 5xx + uncaught throws to Sentry
  // (no-op when SENTRY_DSN is empty).
  app.useGlobalFilters(new SentryExceptionFilter());

  await app.listen(port, bindHost);
  Logger.log(
    `🚀 OwlOrderFi API listening on http://${bindHost}:${port}${apiPrefix ? '/' + apiPrefix : ''}`,
    'Bootstrap',
  );
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to bootstrap:', err);
  process.exit(1);
});
