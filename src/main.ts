import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe, LogLevel } from '@nestjs/common';
import * as express from 'express';
import { AppModule } from './app.module';
import { VALIDATE_ONLY_FLAG, runValidateOnly } from './validate-only';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  const logLevels = (
    process.env.LOG_LEVELS?.split(',').map((s) => s.trim()) ?? [
      'log',
      'error',
      'warn',
    ]
  ).filter((s) => s.length > 0) as LogLevel[];

  const app = await NestFactory.create(AppModule, { logger: logLevels });

  // Capture the raw body so the Floatra webhook handler can
  // HMAC-verify before parsing tampers with byte order. Only the
  // /adapter/*/floatra-webhook route needs this, but applying the
  // verify hook globally is cheaper than route-scoping.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = Buffer.from(buf);
      },
    }),
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
    }),
  );

  const port = Number(process.env.PORT ?? 3100);
  await app.listen(port);
  logger.log(`Floatra Generic REST Adapter listening on :${port}`);
}

if (process.argv.includes(VALIDATE_ONLY_FLAG)) {
  // exitCode, not exit(): lets piped stdout/stderr flush before Node exits.
  process.exitCode = runValidateOnly();
} else {
  bootstrap().catch((err) => {
    // Hard fail on bootstrap errors (almost always a config issue —
    // ConfigLoaderService throws on invalid JSON or missing files).
    const logger = new Logger('Bootstrap');
    logger.error(
      `Bootstrap failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
}
