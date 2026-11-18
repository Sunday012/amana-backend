import { AgreementStatus } from '@prisma/client';

/**
 * PRD section 5. The only legal transitions. A payout is possible only from
 * RELEASABLE, and a dispute opened before payout locks the money.
 */
export const ALLOWED_TRANSITIONS: Record<AgreementStatus, AgreementStatus[]> = {
  DRAFT: ['AWAITING_PAYMENT', 'EXPIRED'] as AgreementStatus[],
  AWAITING_PAYMENT: ['FUNDED', 'EXPIRED', 'DISPUTED'] as AgreementStatus[],
  FUNDED: ['IN_PROGRESS', 'EVIDENCE_IN', 'RELEASABLE', 'DISPUTED', 'REFUNDED'] as AgreementStatus[],
  IN_PROGRESS: ['EVIDENCE_IN', 'RELEASABLE', 'DISPUTED', 'REFUNDED'] as AgreementStatus[],
  EVIDENCE_IN: ['RELEASABLE', 'IN_PROGRESS', 'DISPUTED', 'REFUNDED'] as AgreementStatus[],
  RELEASABLE: ['PAYING_OUT', 'DISPUTED'] as AgreementStatus[],
  // A payout that fails falls back to RELEASABLE so the reconciler can retry
  // with the same idempotency key. IN_PROGRESS covers the milestone loop.
  PAYING_OUT: ['COMPLETED', 'RELEASABLE', 'IN_PROGRESS'] as AgreementStatus[],
  COMPLETED: [] as AgreementStatus[],
  DISPUTED: ['RELEASABLE', 'REFUNDED'] as AgreementStatus[],
  REFUNDED: [] as AgreementStatus[],
  EXPIRED: [] as AgreementStatus[],
};

/** States in which money is already held by the payment layer. */
export const FUNDED_STATES: AgreementStatus[] = [
  'FUNDED',
  'IN_PROGRESS',
  'EVIDENCE_IN',
  'RELEASABLE',
  'PAYING_OUT',
  'DISPUTED',
] as AgreementStatus[];

export function canTransition(from: AgreementStatus, to: AgreementStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: AgreementStatus,
    readonly to: AgreementStatus,
  ) {
    super(`Illegal agreement transition ${from} -> ${to}`);
  }
}

export function assertTransition(from: AgreementStatus, to: AgreementStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}
