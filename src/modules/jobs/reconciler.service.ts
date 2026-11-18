import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { AgreementStatus } from '@prisma/client';
import { EVENTS } from '../../common/events';
import { FUNDED_STATES } from '../../common/state-machine';
import { PrismaService } from '../../prisma/prisma.service';
import { PaymentProvider } from '../../providers/paga/paga.types';
import { AuditService } from '../core/audit.service';
import { EventBusService } from '../core/event-bus.service';
import { TransitionService } from '../core/transition.service';
import { OutcomeService } from '../outcome/outcome.service';
import { PaymentsService } from '../payments/payments.service';

@Injectable()
export class ReconcilerService {
  private readonly logger = new Logger(ReconcilerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: PaymentProvider,
    private readonly payments: PaymentsService,
    private readonly outcome: OutcomeService,
    private readonly transitions: TransitionService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Re-checks any payment whose callback never arrived, by reference, until it
   * resolves to success or failure.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async reconcilePayments(): Promise<void> {
    const stale = await this.prisma.payment.findMany({
      where: { status: 'PENDING', createdAt: { lt: new Date(Date.now() - 60_000) } },
      take: 50,
    });
    for (const payment of stale) {
      try {
        await this.payments.confirmFunding(payment.pagaReference, null, 'reconciler');
      } catch (error) {
        this.logger.warn(`Reconcile ${payment.pagaReference} failed: ${(error as Error).message}`);
      }
    }
  }

  /**
   * A payout that timed out stays PENDING. We re-check by reference before any
   * retry, and the retry reuses the same idempotency key.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async reconcilePayouts(): Promise<void> {
    const pending = await this.prisma.payout.findMany({
      where: { status: 'PENDING', createdAt: { lt: new Date(Date.now() - 60_000) } },
      take: 50,
    });
    for (const payout of pending) {
      try {
        const status = await this.provider.getCollectionStatus(payout.idempotencyKey);
        if (status.settled) {
          await this.payments.settlePayout(payout.id, status.providerTxnId, status.raw);
        }
      } catch (error) {
        this.logger.warn(`Payout reconcile ${payout.id} failed: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Auto-release (P1): Chowdeck confirmed delivery and the buyer stayed silent
   * for the agreed window with no dispute, so the agreement becomes Releasable.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async autoRelease(): Promise<void> {
    const due = await this.prisma.agreement.findMany({
      where: {
        status: 'EVIDENCE_IN' as AgreementStatus,
        disputeLock: false,
        releasableAt: { lte: new Date() },
      },
      take: 50,
    });
    for (const agreement of due) {
      await this.audit.record({
        agreementId: agreement.id,
        actor: 'system',
        action: 'auto_release.window_elapsed',
        meta: { window: agreement.autoReleaseHours },
      });
      await this.transitions.to(agreement.id, 'RELEASABLE' as AgreementStatus, {
        actor: 'system',
        action: 'auto_release',
      });
      await this.events.emit({ event: EVENTS.agreementReleasable, agreementId: agreement.id });
    }
  }

  /** An unpaid agreement expires after the set time. */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async expireUnpaid(): Promise<void> {
    const expired = await this.prisma.agreement.findMany({
      where: {
        status: { in: ['DRAFT', 'AWAITING_PAYMENT'] as AgreementStatus[] },
        expiresAt: { lte: new Date() },
      },
      take: 50,
    });
    for (const agreement of expired) {
      await this.transitions.to(agreement.id, 'EXPIRED' as AgreementStatus, {
        actor: 'system',
        action: 'agreement.expired',
      });
      await this.events.emit({ event: EVENTS.agreementExpired, agreementId: agreement.id });
    }
  }

  /** Re-evaluates funded agreements so a missed evidence event still settles. */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async sweepConditions(): Promise<void> {
    const open = await this.prisma.agreement.findMany({
      where: { status: { in: FUNDED_STATES }, disputeLock: false, type: 'TRADE' },
      take: 100,
      select: { id: true },
    });
    for (const agreement of open) {
      try {
        await this.outcome.evaluateTrade(agreement.id);
      } catch (error) {
        this.logger.debug(`Sweep skipped ${agreement.id}: ${(error as Error).message}`);
      }
    }
  }
}
