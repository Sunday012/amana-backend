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
  /** Where the buyer completes payment. */
  checkoutUrl: string;
  /** Already settled (fake mode marks this true). */
  settled: boolean;
}

export interface CollectionStatus {
  reference: string;
  settled: boolean;
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
  memo: string;
}

export interface PayoutResult {
  status: 'SENT' | 'PENDING' | 'FAILED';
  providerRef?: string;
  failureReason?: string;
  raw: Record<string, unknown>;
}

export abstract class PaymentProvider {
  abstract createCollection(req: CollectionRequest): Promise<CollectionResult>;
  abstract getCollectionStatus(reference: string): Promise<CollectionStatus>;
  abstract sendPayout(req: PayoutRequest): Promise<PayoutResult>;
  abstract verifyWebhook(rawBody: string, headers: Record<string, unknown>): boolean;
}
