import { describe, expect, it } from 'vitest';
import { checkPayoutGuard, PayoutGuardInput } from '../src/modules/payments/payout-guard';

const base: PayoutGuardInput = {
  status: 'RELEASABLE' as PayoutGuardInput['status'],
  disputeLock: false,
  heldAmount: 18_000_000n,
  requestedAmount: 18_000_000n,
  agreementRecipient: '+2348012345678',
  requestedRecipient: '+2348012345678',
  alreadyPaid: false,
};

describe('payout guard', () => {
  it('allows a clean releasable payout', () => {
    expect(checkPayoutGuard(base)).toBeNull();
  });

  it('refuses anything that is not releasable', () => {
    for (const status of ['DRAFT', 'AWAITING_PAYMENT', 'FUNDED', 'EVIDENCE_IN', 'COMPLETED']) {
      expect(checkPayoutGuard({ ...base, status: status as PayoutGuardInput['status'] })).toBe(
        'NOT_RELEASABLE',
      );
    }
  });

  it('refuses while a dispute lock is set, even from RELEASABLE', () => {
    expect(checkPayoutGuard({ ...base, disputeLock: true })).toBe('DISPUTE_LOCK');
  });

  it('refuses a second payout for the same agreement', () => {
    expect(checkPayoutGuard({ ...base, alreadyPaid: true })).toBe('ALREADY_PAID');
  });

  it('refuses an amount larger than what is held', () => {
    expect(checkPayoutGuard({ ...base, requestedAmount: 18_000_001n })).toBe('AMOUNT_EXCEEDS_HELD');
  });

  it('refuses a zero or negative amount', () => {
    expect(checkPayoutGuard({ ...base, requestedAmount: 0n })).toBe('AMOUNT_EXCEEDS_HELD');
  });

  it('allows a milestone payout smaller than the held total', () => {
    expect(checkPayoutGuard({ ...base, requestedAmount: 5_000_000n })).toBeNull();
  });

  it('refuses a recipient that does not match the agreement', () => {
    expect(checkPayoutGuard({ ...base, requestedRecipient: '+2349099999999' })).toBe(
      'RECIPIENT_MISMATCH',
    );
  });

  it('refuses when the payee has no payout destination', () => {
    expect(
      checkPayoutGuard({ ...base, agreementRecipient: null, requestedRecipient: null }),
    ).toBe('NO_RECIPIENT');
  });

  it('checks the dispute lock before the status, so a locked deal never slips through', () => {
    expect(checkPayoutGuard({ ...base, disputeLock: true, status: 'DISPUTED' as PayoutGuardInput['status'] })).toBe(
      'DISPUTE_LOCK',
    );
  });
});
