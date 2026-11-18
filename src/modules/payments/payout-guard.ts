import { AgreementStatus } from '@prisma/client';

export interface PayoutGuardInput {
  status: AgreementStatus;
  disputeLock: boolean;
  /** Amount the ledger says is held for this agreement. */
  heldAmount: bigint;
  /** Amount we are about to send. */
  requestedAmount: bigint;
  /** Payee on the stored agreement. */
  agreementRecipient: string | null;
  /** Recipient resolved for this payout. */
  requestedRecipient: string | null;
  /** A payout row already SENT for this agreement/milestone. */
  alreadyPaid: boolean;
}

export type GuardFailure =
  | 'NOT_RELEASABLE'
  | 'DISPUTE_LOCK'
  | 'AMOUNT_EXCEEDS_HELD'
  | 'RECIPIENT_MISMATCH'
  | 'NO_RECIPIENT'
  | 'ALREADY_PAID';

/**
 * PRD section 5, payout guard. Pure function so every edge case in section 11
 * is a unit test. Returns null when the payout may proceed.
 */
export function checkPayoutGuard(input: PayoutGuardInput): GuardFailure | null {
  if (input.alreadyPaid) return 'ALREADY_PAID';
  if (input.disputeLock) return 'DISPUTE_LOCK';
  if (input.status !== ('RELEASABLE' as AgreementStatus)) return 'NOT_RELEASABLE';
  if (!input.requestedRecipient || !input.agreementRecipient) return 'NO_RECIPIENT';
  if (input.requestedRecipient !== input.agreementRecipient) return 'RECIPIENT_MISMATCH';
  if (input.requestedAmount <= 0n || input.requestedAmount > input.heldAmount) {
    return 'AMOUNT_EXCEEDS_HELD';
  }
  return null;
}
