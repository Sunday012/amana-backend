import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  CollectionRequest,
  FundingEvent,
  CollectionResult,
  CollectionStatus,
  PaymentProvider,
  PayoutRequest,
  PayoutResult,
} from './paga.types';

/**
 * PRD section 12, handoff contract #4: the fake payment switch. "Paying"
 * instantly settles and "payout" writes a fake success, so the chat and web
 * teams can demo before Paga sandbox access lands.
 */
@Injectable()
export class FakePagaProvider extends PaymentProvider {
  private readonly logger = new Logger(FakePagaProvider.name);
  private readonly collections = new Map<string, CollectionStatus>();

  constructor(private readonly config: ConfigService) {
    super();
  }

  async createCollection(req: CollectionRequest): Promise<CollectionResult> {
    this.collections.set(req.reference, {
      reference: req.reference,
      settled: false,
      amountMinor: req.amountMinor,
      currency: req.currency,
      raw: { mode: 'fake' },
    });
    const base = this.config.get<string>('PUBLIC_WEB_URL') ?? 'http://localhost:3000';
    this.logger.warn(`[fake] collection ${req.reference} for ${req.amountMinor}`);
    return {
      reference: req.reference,
      providerRef: `fake-col-${randomUUID().slice(0, 8)}`,
      // Mirrors the real flow: the buyer is given an account to pay into.
      accountNumber: `90${randomUUID().replace(/\D/g, '').padEnd(8, '0').slice(0, 8)}`,
      accountName: `Amana · ${req.description}`.slice(0, 100),
      bankName: 'Fake Bank',
      checkoutUrl: `${base}/pay/${req.reference}`,
      settled: false,
    };
  }

  /** In fake mode a status check always reports the payment as settled. */
  async getCollectionStatus(reference: string): Promise<CollectionStatus> {
    const held = this.collections.get(reference);
    return {
      reference,
      settled: true,
      amountMinor: held?.amountMinor ?? 0n,
      currency: held?.currency ?? 'NGN',
      providerTxnId: `fake-txn-${reference.slice(0, 8)}`,
      raw: { mode: 'fake', settled: true },
    };
  }

  async sendPayout(req: PayoutRequest): Promise<PayoutResult> {
    this.logger.warn(`[fake] payout ${req.idempotencyKey} -> ${req.recipient} ${req.amountMinor}`);
    return {
      status: 'SENT',
      providerRef: `fake-payout-${req.idempotencyKey.slice(0, 12)}`,
      raw: { mode: 'fake', recipient: req.recipient, amount: req.amountMinor.toString() },
    };
  }

  verifyWebhook(): boolean {
    return true;
  }

  parseFunding(body: Record<string, unknown>): FundingEvent | null {
    const accountNumber = String(body.accountNumber ?? '');
    const amount = Number(body.amount ?? 0);
    if (!accountNumber || !(amount > 0)) return null;
    return {
      accountNumber,
      amountMinor: BigInt(Math.round(amount * 100)),
      providerTxnId: String(body.transactionReference ?? `fake-${randomUUID().slice(0, 8)}`),
      eventId: String(body.transactionReference ?? randomUUID()),
    };
  }
}
