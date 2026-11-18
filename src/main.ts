import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  // Webhook signatures are computed over the exact bytes we received, so the
  // raw body is captured before JSON parsing replaces it.
  app.use(
    json({
      verify: (req, _res, buffer: Buffer) => {
        (req as unknown as { rawBody?: string }).rawBody = buffer.toString('utf8');
      },
      limit: '1mb',
    }),
  );

  app.enableCors({ origin: process.env.CORS_ORIGINS?.split(',') ?? true, credentials: true });
  // Validation is per-route with zod schemas (see common/zod.pipe.ts).

  const port = Number(process.env.PORT ?? 3001);
  // Bind to all interfaces: hosted runtimes proxy in from outside the
  // container, so listening only on localhost makes the app unreachable.
  await app.listen(port, '0.0.0.0');
  new Logger('Amana').log(`API listening on :${port} (payments: ${process.env.PAYMENT_MODE ?? 'fake'})`);
}

void bootstrap();
