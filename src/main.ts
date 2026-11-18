import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { json } from 'express';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { AppModule } from './app.module';

/**
 * openapi.yaml is the hand-written contract the web and bot teams build
 * against (PRD section 12, handoff #1). Serving it means the spec and the
 * running API are never two different documents.
 */
function mountDocs(app: Parameters<typeof SwaggerModule.setup>[1]): void {
  try {
    const document = parseYaml(readFileSync('openapi.yaml', 'utf8'));
    SwaggerModule.setup('docs', app, document, {
      customSiteTitle: 'Amana API',
      swaggerOptions: { persistAuthorization: true },
    });
  } catch (error) {
    new Logger('Amana').warn(`API docs not mounted: ${(error as Error).message}`);
  }
}

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
  mountDocs(app);
  // Validation is per-route with zod schemas (see common/zod.pipe.ts).

  const port = Number(process.env.PORT ?? 3001);
  // Bind to all interfaces: hosted runtimes proxy in from outside the
  // container, so listening only on localhost makes the app unreachable.
  await app.listen(port, '0.0.0.0');
  const logger = new Logger('Amana');
  logger.log(`API listening on :${port} (payments: ${process.env.PAYMENT_MODE ?? 'fake'})`);
  logger.log(`API docs at /docs`);
}

void bootstrap();
