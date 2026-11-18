import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { EVENTS } from '../../common/events';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../core/audit.service';
import { EventBusService } from '../core/event-bus.service';
import { OutcomeService } from '../outcome/outcome.service';
import { milestoneEvidenceSchema } from './agreements.dto';

@Injectable()
export class MilestonesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outcome: OutcomeService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
  ) {}

  /** Freelancer submits evidence. Evidence is immutable once attached. */
  async submitEvidence(
    milestoneId: string,
    userId: string,
    dto: z.infer<typeof milestoneEvidenceSchema>,
  ) {
    const milestone = await this.load(milestoneId);
    if (milestone.agreement.payeeId !== userId) {
      throw new ForbiddenException('Only the freelancer submits evidence');
    }
    if (milestone.agreement.status === 'DRAFT' || milestone.agreement.status === 'AWAITING_PAYMENT') {
      throw new ConflictException('The contract must be funded before evidence is submitted');
    }
    if (milestone.status === 'PAID') throw new ConflictException('This milestone is already paid');

    let evidence;
    try {
      evidence = await this.prisma.evidence.create({
        data: {
          agreementId: milestone.agreementId,
          milestoneId,
          type: dto.type,
          source: 'freelancer',
          externalId: dto.prUrl ?? null,
          payloadJson: {
            prUrl: dto.prUrl ?? null,
            screenshots: dto.screenshots,
            note: dto.note ?? null,
          } as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      // Evidence is immutable once attached, so re-submitting the same PR is a
      // conflict, not a crash.
      if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        throw new ConflictException('That evidence is already attached to this agreement');
      }
      throw error;
    }

    await this.prisma.milestone.update({
      where: { id: milestoneId },
      data: { status: 'SUBMITTED' },
    });
    await this.audit.record({
      agreementId: milestone.agreementId,
      actor: userId,
      action: 'milestone.evidence_submitted',
      evidenceRef: evidence.id,
      meta: { milestoneId },
    });
    await this.events.emit({
      event: EVENTS.evidenceReceived,
      agreementId: milestone.agreementId,
      milestoneId,
    });

    return this.outcome.evaluateMilestone(milestoneId);
  }

  /** Client approves a milestone. Approval alone does not release money. */
  async approve(milestoneId: string, userId: string) {
    const milestone = await this.load(milestoneId);
    if (milestone.agreement.payerId !== userId) {
      throw new ForbiddenException('Only the client approves a milestone');
    }
    if (milestone.status === 'PAID') throw new ConflictException('This milestone is already paid');

    await this.prisma.milestone.update({
      where: { id: milestoneId },
      data: { approvedAt: new Date() },
    });
    await this.audit.record({
      agreementId: milestone.agreementId,
      actor: userId,
      action: 'milestone.approved',
      meta: { milestoneId },
    });

    return this.outcome.evaluateMilestone(milestoneId);
  }

  async reject(milestoneId: string, userId: string, reason: string) {
    const milestone = await this.load(milestoneId);
    if (milestone.agreement.payerId !== userId) {
      throw new ForbiddenException('Only the client rejects a milestone');
    }
    await this.prisma.milestone.update({
      where: { id: milestoneId },
      data: { status: 'REJECTED', approvedAt: null },
    });
    await this.audit.record({
      agreementId: milestone.agreementId,
      actor: userId,
      action: 'milestone.rejected',
      meta: { milestoneId, reason },
    });
    return this.outcome.evaluateMilestone(milestoneId);
  }

  private async load(milestoneId: string) {
    const milestone = await this.prisma.milestone.findUnique({
      where: { id: milestoneId },
      include: { agreement: true },
    });
    if (!milestone) throw new NotFoundException('Milestone not found');
    return milestone;
  }
}
