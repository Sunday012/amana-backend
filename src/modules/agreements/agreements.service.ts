import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgreementStatus, AgreementType, Channel, Prisma } from '@prisma/client';
import { EVENTS } from '../../common/events';
import { PrismaService } from '../../prisma/prisma.service';
import { DeliveryProvider } from '../../providers/chowdeck/chowdeck.types';
import { AuthService } from '../auth/auth.service';
import { AuditService } from '../core/audit.service';
import { EventBusService } from '../core/event-bus.service';
import { TransitionService } from '../core/transition.service';
import { OutcomeService } from '../outcome/outcome.service';
import { PaymentsService } from '../payments/payments.service';
import {
  CreateMilestoneAgreementDto,
  CreatePurchaseDto,
  CreateTradeDto,
} from './agreements.dto';
import { nextAction } from './next-action';
import { z } from 'zod';
import { confirmSchema, deliverySchema, disputeSchema, patchTermsSchema } from './agreements.dto';

const AGREEMENT_INCLUDE = {
  payer: true,
  payee: true,
  milestones: { orderBy: { position: 'asc' } },
  terms: { orderBy: { version: 'desc' } },
  evidence: { orderBy: { receivedAt: 'desc' } },
  deliveries: true,
  disputes: true,
  payments: true,
  payouts: true,
} satisfies Prisma.AgreementInclude;

@Injectable()
export class AgreementsService {
  private readonly logger = new Logger(AgreementsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly transitions: TransitionService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    private readonly outcome: OutcomeService,
    private readonly payments: PaymentsService,
    private readonly delivery: DeliveryProvider,
    private readonly config: ConfigService,
  ) {}

  // -------------------------------------------------------------- creation

  /** Flow 1 and Flow 3: the seller creates a protected order. */
  async createTrade(sellerId: string, dto: CreateTradeDto) {
    const buyer = await this.auth.findOrCreateByPhone(dto.buyerPhone);
    if (buyer.id === sellerId) throw new BadRequestException('Buyer and seller must differ');

    const expiryHours = Number(this.config.get('UNPAID_EXPIRY_HOURS') ?? 48);
    const agreement = await this.prisma.agreement.create({
      data: {
        type: 'TRADE' as AgreementType,
        payerId: buyer.id,
        payeeId: sellerId,
        title: dto.title,
        totalAmount: BigInt(dto.amount),
        currency: dto.currency,
        createdVia: dto.createdVia as Channel,
        autoReleaseHours: dto.autoReleaseHours ?? Number(this.config.get('AUTO_RELEASE_HOURS') ?? 24),
        expiresAt: new Date(Date.now() + expiryHours * 3_600_000),
        terms: {
          create: {
            version: 1,
            termsJson: {
              title: dto.title,
              amount: dto.amount,
              currency: dto.currency,
              deliveryTerms: dto.deliveryTerms ?? 'Delivery by Chowdeck; buyer confirms receipt',
              pickupAddress: dto.pickupAddress,
              dropoffAddress: dto.dropoffAddress,
            } as Prisma.InputJsonValue,
            // The seller writing the order is taken as the seller's approval.
            approvedByPayeeAt: new Date(),
          },
        },
      },
      include: AGREEMENT_INCLUDE,
    });

    await this.audit.record({
      agreementId: agreement.id,
      actor: sellerId,
      action: 'agreement.created',
      toStatus: 'DRAFT' as AgreementStatus,
      meta: { via: dto.createdVia },
    });
    await this.events.emit({
      event: EVENTS.agreementCreated,
      agreementId: agreement.id,
      actor: sellerId,
    });

    return this.decorate(agreement, sellerId);
  }

  /**
   * A buyer acting on a published listing (Amana Plug).
   *
   * `createTrade` assumes the seller is the caller, which is the wrong way
   * round here: the listing is the seller's standing offer, so pressing Buy is
   * the buyer accepting terms the seller already published. Both approvals are
   * therefore present from the start, and approving on the buyer's behalf
   * drives the normal transition into AWAITING_PAYMENT and opens the holding
   * account — the buyer lands straight on a payable screen.
   */
  async createPurchase(buyerId: string, dto: CreatePurchaseDto) {
    const seller = await this.auth.findOrCreateByPhone(dto.sellerPhone);
    if (seller.id === buyerId) throw new BadRequestException('You cannot buy from yourself');

    const expiryHours = Number(this.config.get('UNPAID_EXPIRY_HOURS') ?? 48);
    const agreement = await this.prisma.agreement.create({
      data: {
        type: 'TRADE' as AgreementType,
        payerId: buyerId,
        payeeId: seller.id,
        title: dto.title,
        totalAmount: BigInt(dto.amount),
        currency: dto.currency,
        createdVia: dto.createdVia as Channel,
        autoReleaseHours: dto.autoReleaseHours ?? Number(this.config.get('AUTO_RELEASE_HOURS') ?? 24),
        expiresAt: new Date(Date.now() + expiryHours * 3_600_000),
        terms: {
          create: {
            version: 1,
            termsJson: {
              title: dto.title,
              amount: dto.amount,
              currency: dto.currency,
              deliveryTerms: dto.deliveryTerms ?? 'Delivery by Chowdeck; buyer confirms receipt',
              dropoffAddress: dto.dropoffAddress,
              listingRef: dto.listingRef,
            } as Prisma.InputJsonValue,
            // Publishing the listing is the seller's approval of these terms.
            approvedByPayeeAt: new Date(),
          },
        },
      },
      include: AGREEMENT_INCLUDE,
    });

    await this.audit.record({
      agreementId: agreement.id,
      actor: buyerId,
      action: 'agreement.created',
      toStatus: 'DRAFT' as AgreementStatus,
      meta: { via: dto.createdVia, listingRef: dto.listingRef },
    });
    await this.events.emit({
      event: EVENTS.agreementCreated,
      agreementId: agreement.id,
      actor: buyerId,
    });

    // Pressing Buy is the buyer's approval, which opens the holding account.
    return this.approve(agreement.id, buyerId);
  }

  /** Flow 2: a milestone contract, usually from the AI compiler's output. */
  async createMilestoneAgreement(clientId: string, dto: CreateMilestoneAgreementDto) {
    const freelancer = await this.auth.findOrCreateByPhone(dto.freelancerPhone);
    if (freelancer.id === clientId) throw new BadRequestException('Client and freelancer must differ');

    const sum = dto.milestones.reduce((total, m) => total + m.amount, 0);
    if (sum !== dto.totalAmount) {
      throw new BadRequestException(
        `Milestone amounts (${sum}) must sum to the contract total (${dto.totalAmount})`,
      );
    }

    const agreement = await this.prisma.agreement.create({
      data: {
        type: 'MILESTONE' as AgreementType,
        payerId: clientId,
        payeeId: freelancer.id,
        title: dto.title,
        totalAmount: BigInt(dto.totalAmount),
        currency: dto.currency,
        createdVia: dto.createdVia as Channel,
        milestones: {
          create: dto.milestones.map((m, index) => ({
            position: index,
            title: m.title,
            amount: BigInt(m.amount),
            conditionsJson: m.conditions as Prisma.InputJsonValue,
            verification: m.verification,
          })),
        },
        terms: {
          create: {
            version: 1,
            aiGenerated: dto.aiGenerated,
            termsJson: {
              title: dto.title,
              totalAmount: dto.totalAmount,
              currency: dto.currency,
              milestones: dto.milestones,
              disputeTerms:
                dto.disputeTerms ?? 'Payout paused; admin reviews evidence from both parties',
            } as Prisma.InputJsonValue,
          },
        },
      },
      include: AGREEMENT_INCLUDE,
    });

    await this.audit.record({
      agreementId: agreement.id,
      actor: clientId,
      action: dto.aiGenerated ? 'agreement.created:ai_compiled' : 'agreement.created',
      toStatus: 'DRAFT' as AgreementStatus,
    });
    await this.events.emit({
      event: EVENTS.agreementCreated,
      agreementId: agreement.id,
      actor: clientId,
    });

    return this.decorate(agreement, clientId);
  }

  // -------------------------------------------------------------- approval

  /**
   * A party approves the current version. AI never binds anyone silently:
   * both parties must approve the latest version before funding.
   */
  async approve(agreementId: string, userId: string) {
    const agreement = await this.loadOrThrow(agreementId);
    this.assertParty(agreement, userId);
    if (agreement.status !== 'DRAFT') {
      throw new ConflictException(`Terms are already locked (status ${agreement.status})`);
    }

    const current = agreement.terms[0];
    const isPayer = agreement.payerId === userId;
    const updated = await this.prisma.agreementTerms.update({
      where: { id: current.id },
      data: isPayer ? { approvedByPayerAt: new Date() } : { approvedByPayeeAt: new Date() },
    });

    await this.audit.record({
      agreementId,
      actor: userId,
      action: isPayer ? 'terms.approved:payer' : 'terms.approved:payee',
      meta: { version: current.version },
    });

    if (updated.approvedByPayerAt && updated.approvedByPayeeAt) {
      await this.transitions.to(agreementId, 'AWAITING_PAYMENT' as AgreementStatus, {
        actor: 'system',
        action: 'agreement.approved',
        meta: { version: current.version },
      });
      // Both approved: create the collection so the payer gets a pay link.
      const collection = await this.payments.createCollection(agreementId);
      await this.events.emit({
        event: EVENTS.agreementApproved,
        agreementId,
        data: {
          checkoutUrl: collection.checkoutUrl,
          reference: collection.reference,
          accountNumber: collection.accountNumber,
          bankName: collection.bankName,
        },
      });
      return this.get(agreementId, userId);
    }

    return this.get(agreementId, userId);
  }

  /** Any edit creates a new version, and both parties must approve it again. */
  async patchTerms(agreementId: string, userId: string, dto: z.infer<typeof patchTermsSchema>) {
    const agreement = await this.loadOrThrow(agreementId);
    this.assertParty(agreement, userId);
    if (agreement.status !== 'DRAFT') {
      throw new ConflictException('Terms can only be edited before funding');
    }

    const current = agreement.terms[0];
    const merged = { ...(current.termsJson as Record<string, unknown>), ...dto };

    if (dto.milestones) {
      const total = dto.totalAmount ?? Number(agreement.totalAmount);
      const sum = dto.milestones.reduce((acc, m) => acc + m.amount, 0);
      if (sum !== total) {
        throw new BadRequestException(`Milestone amounts (${sum}) must sum to the total (${total})`);
      }
      await this.prisma.milestone.deleteMany({ where: { agreementId } });
      await this.prisma.milestone.createMany({
        data: dto.milestones.map((m, index) => ({
          agreementId,
          position: index,
          title: m.title,
          amount: BigInt(m.amount),
          conditionsJson: m.conditions as Prisma.InputJsonValue,
          verification: m.verification,
        })),
      });
    }

    const version = current.version + 1;
    await this.prisma.$transaction([
      this.prisma.agreementTerms.create({
        data: {
          agreementId,
          version,
          termsJson: merged as Prisma.InputJsonValue,
          aiGenerated: false,
        },
      }),
      this.prisma.agreement.update({
        where: { id: agreementId },
        data: {
          version,
          ...(dto.totalAmount ? { totalAmount: BigInt(dto.totalAmount) } : {}),
        },
      }),
    ]);

    await this.audit.record({
      agreementId,
      actor: userId,
      action: 'terms.edited',
      meta: { version },
    });
    return this.get(agreementId, userId);
  }

  // -------------------------------------------------------------- delivery

  /** Seller hands the item to Chowdeck. */
  async startDelivery(agreementId: string, userId: string, dto: z.infer<typeof deliverySchema>) {
    const agreement = await this.loadOrThrow(agreementId);
    if (agreement.payeeId !== userId) {
      throw new ForbiddenException('Only the seller hands over the item');
    }
    if (agreement.status !== 'FUNDED') {
      throw new ConflictException('The agreement must be funded before delivery');
    }

    const result = await this.delivery.createDelivery({
      agreementId,
      pickupAddress: dto.pickupAddress,
      dropoffAddress: dto.dropoffAddress,
      pickupPoint: dto.pickupPoint,
      dropoffPoint: dto.dropoffPoint,
      itemDescription: dto.itemDescription,
      // Drives Relay's safety coverage, so it comes from the stored agreement.
      itemValueMinor: agreement.totalAmount,
      senderName: agreement.payee.name ?? agreement.payee.phone,
      senderPhone: agreement.payee.phone,
      recipientName: agreement.payer.name ?? agreement.payer.phone,
      recipientPhone: agreement.payer.phone,
    });

    await this.prisma.delivery.create({
      data: {
        agreementId,
        chowdeckDeliveryId: result.deliveryId,
        trackingUrl: result.trackingUrl,
        pickupAddress: dto.pickupAddress,
        dropoffAddress: dto.dropoffAddress,
      },
    });

    await this.transitions.to(agreementId, 'IN_PROGRESS' as AgreementStatus, {
      actor: userId,
      action: 'delivery.created',
      evidenceRef: result.deliveryId,
      meta: { trackingUrl: result.trackingUrl },
    });
    await this.events.emit({
      event: EVENTS.deliveryUpdated,
      agreementId,
      data: { status: 'CREATED', trackingUrl: result.trackingUrl },
    });

    return this.get(agreementId, userId);
  }

  /** Buyer confirms receipt, or reports a problem. */
  async confirm(agreementId: string, userId: string, dto: z.infer<typeof confirmSchema>) {
    const agreement = await this.loadOrThrow(agreementId);
    if (agreement.payerId !== userId) {
      throw new ForbiddenException('Only the buyer confirms receipt');
    }
    if (!['IN_PROGRESS', 'EVIDENCE_IN', 'FUNDED'].includes(agreement.status)) {
      throw new ConflictException(`Cannot confirm from status ${agreement.status}`);
    }

    const evidence = await this.prisma.evidence.create({
      data: {
        agreementId,
        type: dto.outcome === 'CONFIRM' ? 'BUYER_CONFIRM' : 'BUYER_PROBLEM',
        source: 'buyer',
        payloadJson: { note: dto.note ?? null } as Prisma.InputJsonValue,
      },
    });
    await this.audit.record({
      agreementId,
      actor: userId,
      action: `buyer.${dto.outcome.toLowerCase()}`,
      evidenceRef: evidence.id,
    });

    if (dto.outcome === 'PROBLEM') {
      return this.openDispute(agreementId, userId, {
        reason: dto.note ?? 'Buyer reported a problem with the delivery',
      });
    }

    await this.outcome.evaluateTrade(agreementId);
    return this.get(agreementId, userId);
  }

  // --------------------------------------------------------------- dispute

  /** Either party can open a dispute before release; the payout is locked. */
  async openDispute(agreementId: string, userId: string, dto: z.infer<typeof disputeSchema>) {
    const agreement = await this.loadOrThrow(agreementId);
    this.assertParty(agreement, userId);

    if (['COMPLETED', 'REFUNDED'].includes(agreement.status)) {
      throw new ConflictException('This agreement is already settled');
    }
    if (agreement.status === 'PAYING_OUT') {
      // Section 11: cannot be stopped; handled as a recovery case and logged.
      await this.audit.record({
        agreementId,
        actor: userId,
        action: 'dispute.after_payout_started',
        meta: { reason: dto.reason, recovery: true },
      });
      throw new ConflictException(
        'Payout already started; this is logged as a recovery case for admin review',
      );
    }

    const dispute = await this.prisma.dispute.create({
      data: {
        agreementId,
        milestoneId: dto.milestoneId,
        openedBy: userId,
        reason: dto.reason,
      },
    });
    await this.prisma.agreement.update({
      where: { id: agreementId },
      data: { disputeLock: true },
    });
    await this.transitions.to(agreementId, 'DISPUTED' as AgreementStatus, {
      actor: userId,
      action: 'dispute.opened',
      evidenceRef: dispute.id,
      meta: { reason: dto.reason },
    });
    await this.events.emit({ event: EVENTS.disputeOpened, agreementId, actor: userId });

    return this.get(agreementId, userId);
  }

  // ------------------------------------------------------------------ read

  async get(agreementId: string, viewerId: string) {
    const agreement = await this.loadOrThrow(agreementId);
    return this.decorate(agreement, viewerId);
  }

  async list(userId: string, status?: AgreementStatus) {
    const rows = await this.prisma.agreement.findMany({
      where: {
        OR: [{ payerId: userId }, { payeeId: userId }],
        ...(status ? { status } : {}),
      },
      include: AGREEMENT_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.decorate(row, userId));
  }

  timeline(agreementId: string) {
    return this.audit.list(agreementId);
  }

  // --------------------------------------------------------------- helpers

  private async loadOrThrow(agreementId: string) {
    const agreement = await this.prisma.agreement.findUnique({
      where: { id: agreementId },
      include: AGREEMENT_INCLUDE,
    });
    if (!agreement) throw new NotFoundException('Agreement not found');
    return agreement;
  }

  private assertParty(
    agreement: { payerId: string; payeeId: string },
    userId: string,
  ): void {
    if (agreement.payerId !== userId && agreement.payeeId !== userId) {
      throw new ForbiddenException('You are not a party to this agreement');
    }
  }

  private decorate(
    agreement: Prisma.AgreementGetPayload<{ include: typeof AGREEMENT_INCLUDE }>,
    viewerId: string,
  ) {
    const current = agreement.terms[0];
    const bothApproved = !!current?.approvedByPayerAt && !!current?.approvedByPayeeAt;
    const hasOpenDispute = agreement.disputes.some((d) => d.status === 'OPEN');
    const action = nextAction(agreement.status, agreement.type, { bothApproved, hasOpenDispute });
    const role =
      agreement.payerId === viewerId ? 'payer' : agreement.payeeId === viewerId ? 'payee' : 'observer';

    return {
      ...agreement,
      viewerRole: role,
      approvals: {
        payer: current?.approvedByPayerAt ?? null,
        payee: current?.approvedByPayeeAt ?? null,
        bothApproved,
      },
      nextAction: {
        ...action,
        /** True when the signed-in user is the one who has to act. */
        isYours: action.actor === 'both' || action.actor === role,
      },
    };
  }
}
