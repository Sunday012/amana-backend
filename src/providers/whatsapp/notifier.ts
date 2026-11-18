import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface OutboundMessage {
  to: string;
  template: string;
  body: string;
}

export abstract class MessageChannel {
  abstract readonly name: string;
  abstract send(message: OutboundMessage): Promise<void>;
}

/** Default channel: writes the message to the log and the notifications table. */
@Injectable()
export class LogChannel extends MessageChannel {
  readonly name = 'log';
  private readonly logger = new Logger('Notify');

  async send(message: OutboundMessage): Promise<void> {
    this.logger.log(`-> ${message.to} [${message.template}] ${message.body}`);
  }
}

/**
 * WhatsApp Business Platform sender. Templates must be approved before the
 * demo for messages outside the 24-hour service window (PRD section 8).
 */
@Injectable()
export class WhatsAppChannel extends MessageChannel {
  readonly name = 'whatsapp';
  private readonly logger = new Logger(WhatsAppChannel.name);

  constructor(private readonly config: ConfigService) {
    super();
  }

  async send(message: OutboundMessage): Promise<void> {
    const phoneId = this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID');
    const token = this.config.get<string>('WHATSAPP_TOKEN');
    if (!phoneId || !token) {
      this.logger.warn('WhatsApp not configured; dropping message');
      return;
    }
    const response = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: message.to.replace('+', ''),
        type: 'text',
        text: { body: message.body },
      }),
    });
    if (!response.ok) throw new Error(`WhatsApp send failed with ${response.status}`);
  }
}
