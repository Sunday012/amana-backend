import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgreementStatus, Payment, PaymentStatus, Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { EVENTS } from '../../common/events';
import { PrismaService } from '../../prisma/prisma.service';
import { PaymentProvider } from '../../providers/paga/paga.types';
import { AuditService } from '../core/audit.service';
import { EventBusService } from '../core/event-bus.service';
import { TransitionService } from '../core/transition.service';
import { checkPayoutGuard } from './payout-guard';

export interface PayoutCommand {
  agreementId: string;
  milestoneId?: string;
  actor: string;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: PaymentProvider,
    private readonly transitions: TransitionService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    private readonly config: ConfigService,
  ) {}

  // ------------------------------------------------------------ collection

  /** One payment reference per agreement, generated on buyer acceptance. */
  async createCollection(agreementId: string): Promise<{
    reference: string;
    accountNumber?: string;
    accountName?: string;
    bankName?: string;
    checkoutUrl?: string;
  }> {
    const agreement = await this.prisma.agreement.findUniqueOrThrow({
      where: { id: agreementId },
      include: { payer: true, payee: true, payments: true },
    });

    if (!['AWAITING_PAYMENT', 'DRAFT'].includes(agreement.status)) {
      throw new ConflictException(`Agreement is ${agreement.status}; nothing to collect`);
    }

    const existing = agreement.payments.find((p) => p.status === 'PENDING');
    const reference = existing?.pagaReference ?? `AMANA-${agreement.id.slice(0, 8)}-${Date.now()}`;

    const result = await this.provider.createCollection({
      reference,
      // Amount is read from the stored agreement, never from a request body.
      amountMinor: agreement.totalAmount,
      currency: agreement.currency,
      payerPhone: agreement.payer.phone,
      payerEmail: agreement.payer.email ?? undefined,
      payerName: agreement.payer.name ?? agreement.payer.phone,
      payeeName: agreement.payee.name ?? agreement.payee.phone,
      description: agreement.title,
    });

    if (existing) {
      await this.prisma.payment.update({
        where: { id: existing.id },
        data: { virtualAccountNumber: result.accountNumber ?? existing.virtualAccountNumber },
      });
    } else {
      await this.prisma.payment.create({
        data: {
          agreementId,
          pagaReference: reference,
          amount: agreement.totalAmount,
          currency: agreement.currency,
          virtualAccountNumber: result.accountNumber,
        },
      });
    }

    await this.audit.record({
      agreementId,
      actor: 'system',
      action: 'payment.collection_created',
      meta: { reference, accountNumber: result.accountNumber },
    });

    return {
      reference,
      // What the buyer actually needs: an account to transfer into.
      accountNumber: result.accountNumber,
      accountName: result.accountName,
      bankName: result.bankName,
      checkoutUrl: result.checkoutUrl,
    };
  }

  /**
   * A verified funding callback credited one of our virtual accounts. The
   * amount comes from the signed callback, never from a client.
   */
  async confirmFundingByAccount(
    accountNumber: string,
    amountMinor: bigint,
    providerTxnId: string,
    raw: Record<string, unknown>,
  ): Promise<Payment | null> {
    const payment = await this.prisma.payment.findFirst({
      where: { virtualAccountNumber: accountNumber },
      include: { agreement: true },
    });
    if (!payment) {
      this.logger.warn(`Funding for unknown virtual account ${accountNumber}; ignored`);
      return null;
    }
    if (payment.status === 'CONFIRMED') return payment;

    if (amountMinor !== payment.amount) {
      // Short or over payment: hold it and let an admin decide rather than
      // crediting an agreement for the wrong amount.
      const mismatched = await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'MISMATCHED' as PaymentStatus,
          rawCallbackJson: raw as Prisma.InputJsonValue,
        },
      });
      await this.audit.record({
        agreementId: payment.agreementId,
        actor: 'paga',
        action: 'payment.amount_mismatch',
        meta: { expected: payment.amount.toString(), received: amountMinor.toString() },
      });
      return mismatched;
    }

    const confirmed = await this.prisma.$transaction(async (tx) => {
      const row = await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: 'CONFIRMED' as PaymentStatus,
          providerTxnId,
          rawCallbackJson: raw as Prisma.InputJsonValue,
          confirmedAt: new Date(),
        },
      });
      await tx.ledgerEntry.create({
        data: {
          agreementId: payment.agreementId,
          type: 'HELD',
          amount: payment.amount,
          reference: payment.pagaReference,
          memo: `Held in Paga account ${accountNumber}`,
        },
      });
      await this.transitions.to(
        payment.agreementId,
        'FUNDED' as AgreementStatus,
        { actor: 'paga', action: 'payment.confirmed', evidenceRef: providerTxnId },
        tx,
      );
      return row;
    });

    await this.events.emit({
      event: EVENTS.paymentConfirmed,
      agreementId: payment.agreementId,
      actor: 'paga',
      data: { reference: payment.pagaReference },
    });
    return confirmed;
  }

  /**
   * PRD section 7.2: Funded only after (a) a verified callback and (b) a
   * server-side status check against Paga by reference. Both must agree on
   * amount and reference. A client-side "I paid" never counts.
   */
  async confirmFunding(
    reference: string,
    callback: Record<string, unknown> | null,
    actor: string,
  ): Promise<Payment> {
    const payment = await this.prisma.payment.findUnique({
      where: { pagaReference: reference },
      include: { agreement: true },
    });
    if (!payment) throw new NotFoundException(`Unknown payment reference ${reference}`);

    // Duplicate callback for a reference we already confirmed: ignore it.
    if (payment.status === 'CONFIRMED') {
      this.logger.log(`Duplicate callback for ${reference}; ignored`);
      return payment;
    }

    const status = await this.provider.getCollectionStatus(reference);
    if (status.checked === false) {
      this.logger.warn(`Status check unavailable for ${reference}; leaving pending`);
      return payment;
    }
    if (!status.settled) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { rawCallbackJson: (callback ?? {}) as Prisma.InputJsonValue },
      });
      this.logger.warn(`Status check says ${reference} is not settled; staying unfunded`);
      return payment;
    }

    if (status.amountMinor !== payment.amount) {
      // Amount mismatch stays unfunded and alerts an admin (section 11).
      const mismatched = await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'MISMATCHED' as PaymentStatus,
          rawCallbackJson: (callback ?? {}) as Prisma.InputJsonValue,
        },
      });
      await this.audit.record({
        agreementId: payment.agreementId,
        actor,
        action: 'payment.amount_mismatch',
        meta: { expected: payment.amount.toString(), received: status.amountMinor.toString() },
      });
      return mismatched;
    }

    const confirmed = await this.prisma.$transaction(async (tx) => {
      const row = await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: 'CONFIRMED' as PaymentStatus,
          providerTxnId: status.providerTxnId,
          rawCallbackJson: (callback ?? status.raw) as Prisma.InputJsonValue,
          confirmedAt: new Date(),
        },
      });

      // Hold: the internal ledger always knows what is owed to whom.
      await tx.ledgerEntry.create({
        data: {
          agreementId: payment.agreementId,
          type: 'HELD',
          amount: payment.amount,
          reference,
          memo: 'Payment confirmed and held',
        },
      });

      await this.transitions.to(
        payment.agreementId,
        'FUNDED' as AgreementStatus,
        { actor, action: 'payment.confirmed', evidenceRef: reference },
        tx,
      );
      return row;
    });

    await this.events.emit({
      event: EVENTS.paymentConfirmed,
      agreementId: payment.agreementId,
      actor,
      data: { reference },
    });
    return confirmed;
  }

  // --------------------------------------------------------------- payout

  /**
   * The guarded, idempotent payout. Writes the payout row with its idempotency
   * key *before* calling the provider, so a retry reuses the key and a crash
   * mid-call can never pay twice.
   */
  async payout(command: PayoutCommand): Promise<{ status: string; payoutId: string }> {
    const agreement = await this.prisma.agreement.findUnique({
      where: { id: command.agreementId },
      include: {
        payee: true,
        payouts: true,
        ledgerEntries: true,
        milestones: true,
        payments: true,
      },
    });
    if (!agreement) throw new NotFoundException('Agreement not found');

    const milestone = command.milestoneId
      ? agreement.milestones.find((m) => m.id === command.milestoneId)
      : undefined;
    if (command.milestoneId && !milestone) throw new NotFoundException('Milestone not found');

    const amount = milestone ? milestone.amount : agreement.totalAmount;
    const held = agreement.ledgerEntries
      .filter((e) => e.type === 'HELD')
      .reduce((sum, e) => sum + e.amount, 0n);
    const released = agreement.ledgerEntries
      .filter((e) => e.type === 'RELEASED' || e.type === 'REFUNDED')
      .reduce((sum, e) => sum + e.amount, 0n);

    const alreadyPaid = agreement.payouts.some(
      (p) =>
        (p.status === 'SENT' || p.status === 'PENDING') &&
        (p.milestoneId ?? null) === (command.milestoneId ?? null),
    );

    const failure = checkPayoutGuard({
      status: agreement.status,
      disputeLock: agreement.disputeLock,
      heldAmount: held - released,
      requestedAmount: amount,
      agreementRecipient: agreement.payee.payoutRef ?? agreement.payee.phone,
      requestedRecipient: agreement.payee.payoutRef ?? agreement.payee.phone,
      recipientBankOnFile: Boolean(agreement.payee.payoutBankUuid && agreement.payee.payoutRef),
      alreadyPaid,
    });

    if (failure) {
      await this.audit.record({
        agreementId: agreement.id,
        actor: command.actor,
        action: `payout.refused:${failure}`,
        meta: { milestoneId: command.milestoneId ?? null },
      });
      throw new ConflictException(`Payout refused: ${failure}`);
    }

    // Deterministic key: the same agreement + milestone always maps to the same
    // payout, so a duplicate attempt collides on the unique index.
    const idempotencyKey = PaymentsService.idempotencyKey(agreement.id, command.milestoneId);
    const recipient = agreement.payee.payoutRef ?? agreement.payee.phone;

    let payoutRow;
    try {
      payoutRow = await this.prisma.payout.create({
        data: {
          agreementId: agreement.id,
          milestoneId: command.milestoneId ?? null,
          idempotencyKey,
          amount,
          recipient,
        },
      });
    } catch (error) {
      if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        throw new ConflictException('Payout refused: ALREADY_PAID');
      }
      throw error;
    }

    await this.transitions.to(agreement.id, 'PAYING_OUT' as AgreementStatus, {
      actor: command.actor,
      action: 'payout.started',
      meta: { payoutId: payoutRow.id, idempotencyKey },
    });

    const result = await this.provider.sendPayout({
      idempotencyKey,
      amountMinor: amount,
      currency: agreement.currency,
      recipient,
      destinationBankUuid: agreement.payee.payoutBankUuid ?? undefined,
      // Funds are held in the agreement's own Paga account, not our balance.
      sourceReference: agreement.payments.find((p) => p.status === 'CONFIRMED')?.pagaReference,
      memo: `Amana ${agreement.title}`.slice(0, 64),
    });

    if (result.status === 'SENT') {
      await this.settlePayout(payoutRow.id, result.providerRef, result.raw);
    } else if (result.status === 'FAILED') {
      await this.failPayout(payoutRow.id, result.failureReason ?? 'unknown', result.raw);
    } else {
      // PENDING: leave the row for the reconciler, which re-checks by reference
      // before any retry with the same key.
      await this.prisma.payout.update({
        where: { id: payoutRow.id },
        data: { rawResponseJson: result.raw as Prisma.InputJsonValue },
      });
      await this.audit.record({
        agreementId: agreement.id,
        actor: 'system',
        action: 'payout.pending',
        meta: { payoutId: payoutRow.id },
      });
    }

    return { status: result.status, payoutId: payoutRow.id };
  }

  async settlePayout(
    payoutId: string,
    providerRef: string | undefined,
    raw: Record<string, unknown>,
  ): Promise<void> {
    const payout = await this.prisma.payout.findUniqueOrThrow({
      where: { id: payoutId },
      include: { agreement: { include: { milestones: true, payouts: true } } },
    });
    if (payout.status === 'SENT') return;

    await this.prisma.$transaction(async (tx) => {
      await tx.payout.update({
        where: { id: payoutId },
        data: {
          status: 'SENT',
          providerRef,
          rawResponseJson: raw as Prisma.InputJsonValue,
        },
      });
      await tx.ledgerEntry.create({
        data: {
          agreementId: payout.agreementId,
          type: 'RELEASED',
          amount: payout.amount,
          reference: payout.idempotencyKey,
          memo: 'Payout sent',
        },
      });
      if (payout.milestoneId) {
        await tx.milestone.update({ where: { id: payout.milestoneId }, data: { status: 'PAID' } });
      }
    });

    // A milestone contract completes only when every milestone is paid.
    const remaining = payout.agreement.milestones.filter(
      (m) => m.id !== payout.milestoneId && m.status !== 'PAID',
    );
    // Another milestone may have gone Releasable while this one was paying out.
    // Land on RELEASABLE in that case so its payout can run straight away.
    const queued = remaining.find((m) => m.status === 'RELEASABLE');
    const nextStatus: AgreementStatus =
      payout.agreement.type === 'MILESTONE' && remaining.length > 0
        ? queued
          ? ('RELEASABLE' as AgreementStatus)
          : ('IN_PROGRESS' as AgreementStatus)
        : ('COMPLETED' as AgreementStatus);

    await this.transitions.to(payout.agreementId, nextStatus, {
      actor: 'system',
      action: nextStatus === 'COMPLETED' ? 'agreement.completed' : 'milestone.paid',
      evidenceRef: payout.idempotencyKey,
      meta: { payoutId, milestoneId: payout.milestoneId },
    });

    await this.events.emit({
      event: EVENTS.payoutSent,
      agreementId: payout.agreementId,
      milestoneId: payout.milestoneId ?? undefined,
      data: { amount: payout.amount.toString() },
    });

    if (queued) {
      await this.events.emit({
        event: EVENTS.milestoneReleasable,
        agreementId: payout.agreementId,
        milestoneId: queued.id,
      });
    }
    if (nextStatus === 'COMPLETED') {
      await this.events.emit({ event: EVENTS.agreementCompleted, agreementId: payout.agreementId });
    }
  }

  async failPayout(payoutId: string, reason: string, raw: Record<string, unknown>): Promise<void> {
    const payout = await this.prisma.payout.update({
      where: { id: payoutId },
      data: {
        status: 'FAILED',
        failureReason: reason,
        rawResponseJson: raw as Prisma.InputJsonValue,
      },
    });
    // Back to RELEASABLE so an admin or the reconciler can retry with the
    // same idempotency key.
    await this.transitions.to(payout.agreementId, 'RELEASABLE' as AgreementStatus, {
      actor: 'system',
      action: 'payout.failed',
      meta: { payoutId, reason },
    });
    await this.events.emit({
      event: EVENTS.payoutFailed,
      agreementId: payout.agreementId,
      data: { reason },
    });
  }

  /** Refund, recorded in the ledger like a payout. */
  async refund(agreementId: string, actor: string, memo: string): Promise<void> {
    const agreement = await this.prisma.agreement.findUniqueOrThrow({
      where: { id: agreementId },
      include: { payer: true, ledgerEntries: true, payments: true },
    });
    const held = agreement.ledgerEntries
      .filter((e) => e.type === 'HELD')
      .reduce((sum, e) => sum + e.amount, 0n);
    const out = agreement.ledgerEntries
      .filter((e) => e.type !== 'HELD')
      .reduce((sum, e) => sum + e.amount, 0n);
    const refundable = held - out;
    if (refundable <= 0n) throw new BadRequestException('Nothing held to refund');

    const key = `refund-${agreement.id}`;
    const result = await this.provider.sendPayout({
      idempotencyKey: key,
      amountMinor: refundable,
      currency: agreement.currency,
      recipient: agreement.payer.payoutRef ?? agreement.payer.phone,
      destinationBankUuid: agreement.payer.payoutBankUuid ?? undefined,
      sourceReference: agreement.payments.find((p) => p.status === 'CONFIRMED')?.pagaReference,
      memo,
    });

    await this.prisma.ledgerEntry.create({
      data: {
        agreementId,
        type: 'REFUNDED',
        amount: refundable,
        reference: key,
        memo,
      },
    });
    await this.transitions.to(agreementId, 'REFUNDED' as AgreementStatus, {
      actor,
      action: 'payment.refunded',
      meta: { amount: refundable.toString(), providerStatus: result.status },
    });
  }

  // ------------------------------------------------------- payout details

  listBanks() {
    return this.provider.listBanks();
  }

  /**
   * Confirms an account with the bank and stores it against the user. We keep
   * the name the bank returned, not one the user typed, so a receipt can show
   * who was actually paid.
   */
  async setPayoutAccount(
    userId: string,
    bankUuid: string,
    accountNumber: string,
  ): Promise<{ accountName: string; bankUuid: string; accountNumber: string }> {
    const check = await this.provider.checkAccount(bankUuid, accountNumber);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        payoutRef: check.accountNumber,
        payoutBankUuid: check.bankUuid,
        payoutAccountName: check.accountName,
      },
    });
    await this.auditIfAny(userId, check);
    return check;
  }

  /** Payout details are account-level, so there is no agreement to log against. */
  private async auditIfAny(userId: string, check: { accountName: string }): Promise<void> {
    this.logger.log(`Payout account set for ${userId}: ${check.accountName}`);
  }

  /** Whether this user can be paid at all. */
  async payoutReadiness(userId: string): Promise<{ ready: boolean; accountName?: string }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return user.payoutBankUuid && user.payoutRef
      ? { ready: true, accountName: user.payoutAccountName ?? undefined }
      : { ready: false };
  }

  // ----------------------------------------------------------- read models

  async statusFor(agreementId: string) {
    const [payments, payouts, ledger] = await Promise.all([
      this.prisma.payment.findMany({ where: { agreementId } }),
      this.prisma.payout.findMany({ where: { agreementId } }),
      this.prisma.ledgerEntry.findMany({ where: { agreementId } }),
    ]);
    const held = ledger.filter((e) => e.type === 'HELD').reduce((s, e) => s + e.amount, 0n);
    const out = ledger.filter((e) => e.type !== 'HELD').reduce((s, e) => s + e.amount, 0n);
    return { payments, payouts, ledger, balance: { held, released: out, net: held - out } };
  }

  static idempotencyKey(agreementId: string, milestoneId?: string): string {
    return createHash('sha256')
      .update(`${agreementId}:${milestoneId ?? 'full'}`)
      .digest('hex')
      .slice(0, 32);
  }

  static freshReference(): string {
    return `AMANA-${randomUUID().slice(0, 8).toUpperCase()}`;
  }

  get mode(): string {
    return this.config.get<string>('PAYMENT_MODE') ?? 'fake';
  }
}
