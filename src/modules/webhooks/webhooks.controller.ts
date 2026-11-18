import { Body, Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { WebhooksService } from './webhooks.service';

/**
 * Webhooks acknowledge fast. Signature checking and the raw-body record happen
 * inline; everything downstream is safe to repeat.
 */
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post('paga')
  @HttpCode(200)
  paga(
    @Req() req: Request & { rawBody?: string },
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, unknown>,
  ) {
    return this.webhooks.handlePaga(req.rawBody ?? JSON.stringify(body), body, headers);
  }

  @Post('chowdeck')
  @HttpCode(200)
  chowdeck(
    @Req() req: Request & { rawBody?: string },
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, unknown>,
  ) {
    return this.webhooks.handleChowdeck(req.rawBody ?? JSON.stringify(body), body, headers);
  }

  @Post('github')
  @HttpCode(200)
  github(
    @Req() req: Request & { rawBody?: string },
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, unknown>,
  ) {
    return this.webhooks.handleGithub(req.rawBody ?? JSON.stringify(body), body, headers);
  }
}
