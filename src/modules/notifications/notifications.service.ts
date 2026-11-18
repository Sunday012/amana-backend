import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { EventPayload } from '../../common/events';
import { formatAmount } from '../../common/serialize';
import { PrismaService } from '../../prisma/prisma.service';
import { MessageChannel } from '../../providers/whatsapp/notifier';
import { DELIVERED_PROMPT, render, TEMPLATES } from './templates';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly channel: MessageChannel,
    private readonly config: ConfigService,
  ) {}

  /** Sends the pair of messages for an event; one row per recipient. */
  async notify(payload: EventPayload): Promise<void> {
    const template = TEMPLATES[payload.event];
    if (!template) return;

    const agreement = await this.prisma.agreement.findUnique({
      where: { id: payload.agreementId },
      include: { payer: true, payee: true },
    });
    if (!agreement) return;

    const base = this.config.get<string>('PUBLIC_WEB_URL') ?? 'http://localhost:3000';
    const values: Record<string, string> = {
      title: agreement.title,
      amount: formatAmount(agreement.totalAmount, agreement.currency),
      link: String(payload.data?.checkoutUrl ?? `${base}/a/${agreement.id}`),
      status: String(payload.data?.status ?? ''),
      accountNumber: String(payload.data?.accountNumber ?? ''),
      bankName: String(payload.data?.bankName ?? 'Paga'),
    };

    const payerBody =
      payload.data?.status === 'DELIVERED'
        ? render(DELIVERED_PROMPT, values)
        : render(template.payer, values);

    await Promise.all([
      this.deliver(agreement.payeeId, agreement.payee.phone, payload, render(template.payee, values)),
      this.deliver(agreement.payerId, agreement.payer.phone, payload, payerBody),
    ]);
  }

  private async deliver(
    userId: string,
    phone: string,
    payload: EventPayload,
    body: string,
  ): Promise<void> {
    const row = await this.prisma.notification.create({
      data: {
        userId,
        agreementId: payload.agreementId,
        channel: this.channel.name,
        template: payload.event,
        payloadJson: { body } as Prisma.InputJsonValue,
      },
    });
    try {
      await this.channel.send({ to: phone, template: payload.event, body });
      await this.prisma.notification.update({
        where: { id: row.id },
        data: { status: 'SENT', sentAt: new Date() },
      });
    } catch (error) {
      this.logger.error(`Notification ${row.id} failed: ${(error as Error).message}`);
      await this.prisma.notification.update({
        where: { id: row.id },
        data: { status: 'FAILED', error: (error as Error).message },
      });
    }
  }
}
