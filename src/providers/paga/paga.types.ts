export interface CollectionRequest {
  reference: string;
  amountMinor: bigint;
  currency: string;
  payerPhone: string;
  /** Part of the Collect payment-request hash, so it must be sent if held. */
  payerEmail?: string;
  /** Collect requires a name for both sides of the request. */
  payerName: string;
  payeeName: string;
  description: string;
}

export interface CollectionResult {
  reference: string;
  providerRef: string;
  /**
   * The account the buyer transfers into. Paga holds the money here until we
   * move it, which is what makes this escrow rather than a payment that has
   * already landed in our own balance.
   */
  accountNumber?: string;
  /** Shown to the payer in their bank app when they confirm the transfer. */
  accountName?: string;
  bankName?: string;
  /** Only for providers that use a hosted checkout page. */
  checkoutUrl?: string;
  /** Already settled (fake mode marks this true). */
  settled: boolean;
}

export interface CollectionStatus {
  reference: string;
  settled: boolean;
  /** False when the provider could not be asked, as opposed to "not paid". */
  checked?: boolean;
  amountMinor: bigint;
  currency: string;
  providerTxnId?: string;
  raw: Record<string, unknown>;
}

export interface PayoutRequest {
  idempotencyKey: string;
  amountMinor: bigint;
  currency: string;
  /** Destination bank account number (or wallet id in fake mode). */
  recipient: string;
  /** Paga's UUID for the destination bank; required by depositToBank. */
  destinationBankUuid?: string;
  /**
   * The payment reference whose held funds are being released. Money sits in
   * the agreement's own account, so it has to be charged back to the business
   * balance before it can be sent on.
   */
  sourceReference?: string;
  memo: string;
}

export interface PayoutResult {
  status: 'SENT' | 'PENDING' | 'FAILED';
  providerRef?: string;
  failureReason?: string;
  raw: Record<string, unknown>;
}

/** What a provider's funding webhook told us, once verified. */
export interface FundingEvent {
  /** The account the money landed in. */
  accountNumber: string;
  amountMinor: bigint;
  providerTxnId: string;
  eventId: string;
}

export abstract class PaymentProvider {
  abstract createCollection(req: CollectionRequest): Promise<CollectionResult>;
  abstract getCollectionStatus(reference: string): Promise<CollectionStatus>;
  abstract sendPayout(req: PayoutRequest): Promise<PayoutResult>;
  abstract verifyWebhook(rawBody: string, headers: Record<string, unknown>): boolean;
  /** Pulls a funding event out of the provider's webhook body, or null. */
  abstract parseFunding(body: Record<string, unknown>): FundingEvent | null;
}
