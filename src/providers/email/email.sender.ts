import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Email delivery. Resend when configured, otherwise the code is written to the
 * server log so development still works without an API key.
 */
@Injectable()
export class EmailSender {
  private readonly logger = new Logger(EmailSender.name);

  constructor(private readonly config: ConfigService) {}

  get configured(): boolean {
    return !!this.config.get<string>('RESEND_API_KEY');
  }

  /** Returns true when the message actually left the building. */
  async send(message: OutboundEmail): Promise<boolean> {
    if (!this.configured) {
      this.logger.warn(`[no email provider] to ${message.to}: ${message.text}`);
      return false;
    }

    const from = this.config.get<string>('RESEND_FROM') ?? 'Amana <onboarding@resend.dev>';
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.get<string>('RESEND_API_KEY')}`,
        },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
        }),
      });

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        this.logger.error(`Resend rejected the message: ${response.status} ${detail}`);
        return false;
      }
      return true;
    } catch (error) {
      this.logger.error(`Email send failed: ${(error as Error).message}`);
      return false;
    }
  }
}
