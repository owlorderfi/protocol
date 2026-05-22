/**
 * Sentry init + global exception filter for the NestJS API.
 *
 * We use @sentry/node (not @sentry/nestjs) because our Nest app runs on
 * Fastify, while @sentry/nestjs auto-wires Express middleware.
 * @sentry/node + a manual ExceptionFilter is the cleanest fit.
 *
 * No-op when SENTRY_DSN is empty (dev / local builds).
 *
 * 4xx errors are intentionally NOT reported — they're caller mistakes,
 * not bugs. Sentry only sees 5xx + unhandled throws.
 */

import * as Sentry from '@sentry/node';
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

const DSN = process.env.SENTRY_DSN;

export function initSentry(): void {
  if (!DSN) return;
  Sentry.init({
    dsn: DSN,
    environment: process.env.NODE_ENV ?? 'development',
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: 0,
    // Keep ip + user-agent for triage, drop request bodies (PII risk).
    sendDefaultPii: false,
  });
}

@Catch()
export class SentryExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('SentryExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    // Only ship 5xx + non-HttpException throws to Sentry; 4xx is noise.
    if (DSN && status >= 500) {
      Sentry.captureException(exception);
    }

    // Re-throw so Nest's default formatter still builds the response.
    // (We don't write a response here — that's the framework's job.)
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse();
    const body =
      exception instanceof HttpException
        ? exception.getResponse()
        : { statusCode: status, message: 'Internal server error' };

    if (status >= 500) {
      this.logger.error(exception instanceof Error ? exception.stack : exception);
    }
    reply.status(status).send(body);
  }
}
