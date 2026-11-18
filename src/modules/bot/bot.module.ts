import { Module } from '@nestjs/common';
import { AgreementsModule } from '../agreements/agreements.module';
import { BotController } from './bot.controller';
import { BotService } from './bot.service';

@Module({
  imports: [AgreementsModule],
  controllers: [BotController],
  providers: [BotService],
})
export class BotModule {}
