import { Injectable, Logger } from '@nestjs/common';
import { Agreement, AgreementStatus, Milestone, MilestoneStatus } from '@prisma/client';
import { EVENTS } from '../../common/events';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../core/audit.service';
import { EventBusService } from '../core/event-bus.service';
import { TransitionService } from '../core/transition.service';

export type Outcome = 'VERIFIED' | 'AWAITING_EVIDENCE' | 'NEEDS_HUMAN_REVIEW' | 'FAILED' | 'DISPUTED';

export interface ConditionResult {
  condition: string;
  met: boolean;
  evidenceRef?: string;
}

export interface Evaluation {
  outcome: Outcome;
  conditions: ConditionResult[];
  releasable: boolean;
}

/**
 * OutcomeOS. Evaluates evidence against the agreement's conditions and says
 * whether a payout is eligible. It never pays anyone — Payments does that.
 */
@Injectable()
export class OutcomeService {
  private readonly logger = new Logger(OutcomeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly transitions: TransitionService,
    private readonly events: EventBusService,
    private readonly audit: AuditService,
  ) {}

  /**
   * TradeProof: delivery by Chowdeck is evidence, not release. Money moves only
   * after buyer confirmation, or after the auto-release window with no dispute.
   */
  async evaluateTrade(agreementId: string): Promise<Evaluation> {
    const agreement = await this.prisma.agreement.findUniqueOrThrow({
      where: { id: agreementId },
      include: { evidence: true, deliveries: true, disputes: { where: { status: 'OPEN' } } },
    });

    const delivered = agreement.deliveries.some((d) => d.status === 'DELIVERED');
    const deliveryEvidence = agreement.evidence.find((e) => e.type === 'CHOWDECK');
    const confirmed = agreement.evidence.find((e) => e.type === 'BUYER_CONFIRM');
    const problem = agreement.evidence.find((e) => e.type === 'BUYER_PROBLEM');

    const conditions: ConditionResult[] = [
      { condition: 'chowdeck_delivered', met: delivered, evidenceRef: deliveryEvidence?.id },
      { condition: 'buyer_confirmed', met: !!confirmed, evidenceRef: confirmed?.id },
    ];

    let outcome: Outcome = 'AWAITING_EVIDENCE';
    if (agreement.disputeLock || agreement.disputes.length > 0) outcome = 'DISPUTED';
    else if (problem) outcome = 'NEEDS_HUMAN_REVIEW';
    else if (conditions.every((c) => c.met)) outcome = 'VERIFIED';

    const releasable = outcome === 'VERIFIED';
    if (releasable) await this.markReleasable(agreement, conditions);
    return { outcome, conditions, releasable };
  }

  /**
   * Milestone: a milestone is paid only when **all** its required conditions are
   * true. Tests alone do not release money if client approval is also required.
   */
  async evaluateMilestone(milestoneId: string): Promise<Evaluation> {
    const milestone = await this.prisma.milestone.findUniqueOrThrow({
      where: { id: milestoneId },
      include: { evidence: true, agreement: { include: { disputes: { where: { status: 'OPEN' } } } } },
    });

    const required = this.requiredConditions(milestone);
    const conditions: ConditionResult[] = required.map((condition) => {
      switch (condition) {
        case 'tests_pass':
          return {
            condition,
            met: !!milestone.testsPassedAt,
            evidenceRef: milestone.evidence.find((e) => e.type === 'GITHUB')?.id,
          };
        case 'client_approval':
          return { condition, met: !!milestone.approvedAt };
        case 'evidence_submitted':
          return {
            condition,
            met: milestone.evidence.length > 0,
            evidenceRef: milestone.evidence[0]?.id,
          };
        default:
          // An unknown condition is never auto-satisfied; an admin decides.
          return { condition, met: false };
      }
    });

    let outcome: Outcome;
    if (milestone.agreement.disputeLock || milestone.agreement.disputes.length > 0) {
      outcome = 'DISPUTED';
    } else if (conditions.every((c) => c.met)) {
      outcome = 'VERIFIED';
    } else if (conditions.some((c) => c.condition === 'tests_pass' && !c.met) && milestone.evidence.length > 0) {
      outcome = 'NEEDS_HUMAN_REVIEW';
    } else {
      outcome = 'AWAITING_EVIDENCE';
    }

    const releasable = outcome === 'VERIFIED';
    const nextStatus: MilestoneStatus = releasable
      ? 'RELEASABLE'
      : milestone.evidence.length > 0
        ? 'SUBMITTED'
        : milestone.status;

    if (nextStatus !== milestone.status) {
      await this.prisma.milestone.update({ where: { id: milestone.id }, data: { status: nextStatus } });
    }

    await this.audit.record({
      agreementId: milestone.agreementId,
      actor: 'outcomeos',
      action: `milestone.evaluated:${outcome}`,
      meta: { milestoneId: milestone.id, conditions },
    });

    if (releasable) {
      // Each milestone runs its own loop to Releasable under one funded
      // contract, so the agreement itself has to be Releasable for the payout
      // guard to let this milestone's money move.
      if (milestone.agreement.status !== ('RELEASABLE' as AgreementStatus)) {
        await this.transitions.to(milestone.agreementId, 'RELEASABLE' as AgreementStatus, {
          actor: 'outcomeos',
          action: 'milestone.releasable',
          meta: { milestoneId: milestone.id, conditions },
        });
      }
      await this.events.emit({
        event: EVENTS.milestoneReleasable,
        agreementId: milestone.agreementId,
        milestoneId: milestone.id,
      });
    }

    return { outcome, conditions, releasable };
  }

  private requiredConditions(milestone: Milestone): string[] {
    const raw = milestone.conditionsJson;
    if (Array.isArray(raw) && raw.length > 0) return raw.map(String);
    return ['client_approval'];
  }

  private async markReleasable(agreement: Agreement, conditions: ConditionResult[]): Promise<void> {
    if (agreement.status === ('RELEASABLE' as AgreementStatus)) return;
    await this.transitions.to(agreement.id, 'RELEASABLE' as AgreementStatus, {
      actor: 'outcomeos',
      action: 'outcome.verified',
      meta: { conditions },
    });
    await this.events.emit({ event: EVENTS.agreementReleasable, agreementId: agreement.id });
  }
}
