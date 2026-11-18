import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AgreementStatus } from '@prisma/client';
import { EVENTS } from '../../common/events';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../core/audit.service';
import { EventBusService } from '../core/event-bus.service';
import { TransitionService } from '../core/transition.service';
import { PaymentsService } from '../payments/payments.service';

@Injectable()
export class DisputesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly transitions: TransitionService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
  ) {}

  /** Admin queue: open disputes with both sides' evidence attached. */
  listOpen() {
    return this.prisma.dispute.findMany({
      where: { status: { in: ['OPEN', 'UNDER_REVIEW'] } },
      include: {
        agreement: {
          include: { payer: true, payee: true, evidence: true, deliveries: true, milestones: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * A human decides. AI organises evidence; it never rules (PRD non-goals).
   * Releasing clears the lock and lets the normal payout guard run.
   */
  async rule(
    disputeId: string,
    adminId: string,
    decision: 'RELEASE' | 'REFUND',
    reasoning: string,
  ) {
    const dispute = await this.prisma.dispute.findUnique({
      where: { id: disputeId },
      include: { agreement: true },
    });
    if (!dispute) throw new NotFoundException('Dispute not found');
    if (dispute.status !== 'OPEN' && dispute.status !== 'UNDER_REVIEW') {
      throw new ConflictException('This dispute is already ruled');
    }

    await this.prisma.dispute.update({
      where: { id: disputeId },
      data: {
        status: decision === 'RELEASE' ? 'RULED_RELEASE' : 'RULED_REFUND',
        ruling: reasoning,
        ruledBy: adminId,
        ruledAt: new Date(),
      },
    });
    await this.prisma.agreement.update({
      where: { id: dispute.agreementId },
      data: { disputeLock: false },
    });
    await this.audit.record({
      agreementId: dispute.agreementId,
      actor: `admin:${adminId}`,
      action: `dispute.ruled:${decision.toLowerCase()}`,
      evidenceRef: disputeId,
      meta: { reasoning },
    });

    if (decision === 'RELEASE') {
      await this.transitions.to(dispute.agreementId, 'RELEASABLE' as AgreementStatus, {
        actor: `admin:${adminId}`,
        action: 'dispute.release',
        evidenceRef: disputeId,
      });
      await this.payments.payout({
        agreementId: dispute.agreementId,
        milestoneId: dispute.milestoneId ?? undefined,
        actor: `admin:${adminId}`,
      });
    } else {
      await this.payments.refund(
        dispute.agreementId,
        `admin:${adminId}`,
        `Refund on dispute ruling: ${reasoning}`.slice(0, 120),
      );
    }

    await this.events.emit({
      event: EVENTS.disputeRuled,
      agreementId: dispute.agreementId,
      data: { decision },
    });
    return { disputeId, decision };
  }
}
