import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { InternalOnlyGuard } from '../../common/guards';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { BotService } from './bot.service';

const messageSchema = z.object({
  phone: z.string().min(7),
  message: z.string().min(1).max(2000),
});

/**
 * The bot process posts inbound chat messages here. It is internal-only: the
 * WhatsApp webhook itself terminates in the bot service, not in this API.
 */
@Controller('bot')
@UseGuards(InternalOnlyGuard)
export class BotController {
  constructor(private readonly bot: BotService) {}

  @Post('message')
  @HttpCode(200)
  message(@Body(new ZodValidationPipe(messageSchema)) body: z.infer<typeof messageSchema>) {
    return this.bot.handleMessage(body.phone, body.message);
  }
}
