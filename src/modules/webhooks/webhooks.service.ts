import { Injectable, Logger } from '@nestjs/common';
import { DeliveryStatus, Prisma } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { EVENTS } from '../../common/events';
import { PrismaService } from '../../prisma/prisma.service';
import { DeliveryProvider } from '../../providers/chowdeck/chowdeck.types';
import { PaymentProvider } from '../../providers/paga/paga.types';
import { AuditService } from '../core/audit.service';
import { EventBusService } from '../core/event-bus.service';
import { TransitionService } from '../core/transition.service';
import { OutcomeService } from '../outcome/outcome.service';
import { PaymentsService } from '../payments/payments.service';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly outcome: OutcomeService,
    private readonly transitions: TransitionService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    private readonly paymentProvider: PaymentProvider,
    private readonly deliveryProvider: DeliveryProvider,
    private readonly config: ConfigService,
  ) {}

  /** Stores every raw body; returns false if this event was already seen. */
  private async record(
    provider: string,
    externalId: string | null,
    signatureOk: boolean,
    body: unknown,
    headers: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      await this.prisma.webhookEvent.create({
        data: {
          provider,
          externalId,
          signatureOk,
          rawBody: body as Prisma.InputJsonValue,
          headers: headers as Prisma.InputJsonValue,
        },
      });
      return true;
    } catch (error) {
      if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        this.logger.log(`Duplicate ${provider} event ${externalId}; ignored`);
        return false;
      }
      throw error;
    }
  }

  // ----------------------------------------------------------------- Paga

  async handlePaga(
    rawBody: string,
    body: Record<string, unknown>,
    headers: Record<string, unknown>,
  ): Promise<{ accepted: boolean }> {
    const signatureOk = this.paymentProvider.verifyWebhook(rawBody, headers);
    const reference = String(body.referenceNumber ?? body.reference ?? '');
    const eventId = String(
      body.transactionReference ?? body.transactionId ?? body.eventId ?? reference,
    );

    const isNew = await this.record('paga', eventId || null, signatureOk, body, headers);
    if (!isNew) return { accepted: true };
    if (!signatureOk) {
      this.logger.warn('Rejected Paga webhook with a bad signature');
      return { accepted: false };
    }

    // A subsidiary account was funded: the money has landed in escrow.
    const funding = this.paymentProvider.parseFunding(body);
    if (funding) {
      await this.payments.confirmFundingByAccount(
        funding.accountNumber,
        funding.amountMinor,
        funding.providerTxnId,
        body,
      );
      return { accepted: true };
    }

    const payout = await this.prisma.payout.findUnique({ where: { idempotencyKey: reference } });
    if (payout) {
      const status = String(body.status ?? '').toUpperCase();
      if (['SUCCESS', 'SUCCESSFUL', 'SENT', 'COMPLETED'].includes(status)) {
        await this.payments.settlePayout(payout.id, String(body.transactionId ?? ''), body);
      } else if (['FAILED', 'REVERSED', 'DECLINED'].includes(status)) {
        await this.payments.failPayout(payout.id, status, body);
      }
      return { accepted: true };
    }

    if (!reference) return { accepted: false };

    // Collection callback: confirm funding (callback + server-side status check).
    await this.payments.confirmFunding(reference, body, 'paga');
    return { accepted: true };
  }

  // ------------------------------------------------------------- Chowdeck

  async handleChowdeck(
    rawBody: string,
    body: Record<string, unknown>,
    headers: Record<string, unknown>,
  ): Promise<{ accepted: boolean }> {
    const signatureOk = this.deliveryProvider.verifyWebhook(rawBody, headers);
    const parsed = this.deliveryProvider.parseWebhook(body);
    const eventId = parsed?.eventId ?? null;

    const isNew = await this.record('chowdeck', eventId, signatureOk, body, headers);
    if (!isNew) return { accepted: true };
    if (!signatureOk) return { accepted: false };
    if (!parsed) return { accepted: true };
    const deliveryId = parsed.deliveryId;

    const delivery = await this.prisma.delivery.findUnique({
      where: { chowdeckDeliveryId: deliveryId },
      include: { agreement: true },
    });
    if (!delivery) {
      this.logger.warn(`Unknown delivery id ${deliveryId}; rejected`);
      return { accepted: false };
    }

    const mapped = parsed.status as DeliveryStatus;

    await this.prisma.delivery.update({
      where: { id: delivery.id },
      data: { status: mapped, trackingUrl: (body.tracking_url as string) ?? delivery.trackingUrl },
    });

    const evidence = await this.prisma.evidence.create({
      data: {
        agreementId: delivery.agreementId,
        type: 'CHOWDECK',
        source: 'chowdeck',
        externalId: eventId ?? undefined,
        payloadJson: body as Prisma.InputJsonValue,
      },
    });

    await this.audit.record({
      agreementId: delivery.agreementId,
      actor: 'chowdeck',
      action: `delivery.${mapped.toLowerCase()}`,
      evidenceRef: evidence.id,
    });

    if (mapped === 'PICKED_UP' || mapped === 'IN_TRANSIT') {
      if (delivery.agreement.status === 'FUNDED') {
        await this.transitions.to(delivery.agreementId, 'IN_PROGRESS', {
          actor: 'chowdeck',
          action: 'delivery.in_progress',
          evidenceRef: evidence.id,
        });
      }
    } else if (mapped === 'DELIVERED') {
      const hours = delivery.agreement.autoReleaseHours ?? 24;
      await this.transitions.to(delivery.agreementId, 'EVIDENCE_IN', {
        actor: 'chowdeck',
        action: 'delivery.delivered',
        evidenceRef: evidence.id,
        // Starts the buyer confirmation window; the auto-release job reads this.
        data: { releasableAt: new Date(Date.now() + hours * 3_600_000) },
      });
      // Delivery is evidence, not release: this only re-evaluates conditions.
      await this.outcome.evaluateTrade(delivery.agreementId);
    } else if (mapped === 'FAILED' || mapped === 'RETURNED') {
      await this.audit.record({
        agreementId: delivery.agreementId,
        actor: 'chowdeck',
        action: 'delivery.failed_hold',
        evidenceRef: evidence.id,
        meta: { alert: 'seller_and_admin' },
      });
    }

    await this.events.emit({
      event: EVENTS.deliveryUpdated,
      agreementId: delivery.agreementId,
      data: { status: mapped },
    });
    return { accepted: true };
  }

  // --------------------------------------------------------------- GitHub

  async handleGithub(
    rawBody: string,
    body: Record<string, unknown>,
    headers: Record<string, unknown>,
  ): Promise<{ accepted: boolean }> {
    const signatureOk = this.verifyGithub(rawBody, headers);
    const deliveryHeader = String(headers['x-github-delivery'] ?? '');

    const isNew = await this.record('github', deliveryHeader || null, signatureOk, body, headers);
    if (!isNew) return { accepted: true };
    if (!signatureOk) return { accepted: false };

    // check_suite / workflow_run completed with success == tests passed.
    const payload = (body.check_suite ?? body.workflow_run) as
      | { conclusion?: string; pull_requests?: { html_url?: string }[]; html_url?: string }
      | undefined;
    if (!payload) return { accepted: true };

    const prUrl = payload.pull_requests?.[0]?.html_url ?? (body.pull_request as { html_url?: string })?.html_url;
    if (!prUrl) return { accepted: true };

    // Match the PR back to the milestone whose evidence carries that URL.
    const evidence = await this.prisma.evidence.findFirst({
      where: { type: 'GITHUB', externalId: prUrl },
      orderBy: { receivedAt: 'desc' },
    });
    if (!evidence?.milestoneId) {
      this.logger.warn(`No milestone evidence matches ${prUrl}`);
      return { accepted: true };
    }

    const passed = payload.conclusion === 'success';
    await this.prisma.milestone.update({
      where: { id: evidence.milestoneId },
      data: { testsPassedAt: passed ? new Date() : null },
    });
    await this.audit.record({
      agreementId: evidence.agreementId,
      actor: 'github',
      action: passed ? 'tests.passed' : 'tests.failed',
      evidenceRef: evidence.id,
      meta: { prUrl, conclusion: payload.conclusion },
    });

    await this.outcome.evaluateMilestone(evidence.milestoneId);
    return { accepted: true };
  }

  private verifyGithub(rawBody: string, headers: Record<string, unknown>): boolean {
    const secret = this.config.get<string>('GITHUB_WEBHOOK_SECRET');
    if (!secret) return false;
    const provided = String(headers['x-hub-signature-256'] ?? '');
    const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
