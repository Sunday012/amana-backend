import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LogChannel, MessageChannel, WhatsAppChannel } from '../../providers/whatsapp/notifier';
import { NotificationsService } from './notifications.service';

@Module({
  providers: [
    NotificationsService,
    LogChannel,
    WhatsAppChannel,
    {
      provide: MessageChannel,
      inject: [ConfigService, LogChannel, WhatsAppChannel],
      useFactory: (config: ConfigService, log: LogChannel, whatsapp: WhatsAppChannel) =>
        config.get<string>('WHATSAPP_TOKEN') ? whatsapp : log,
    },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
