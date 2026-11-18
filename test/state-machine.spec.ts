import { AgreementStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { ALLOWED_TRANSITIONS, canTransition } from '../src/common/state-machine';

const s = (name: string) => name as AgreementStatus;

describe('agreement state machine', () => {
  it('walks the happy TradeProof path', () => {
    const path = [
      'DRAFT',
      'AWAITING_PAYMENT',
      'FUNDED',
      'IN_PROGRESS',
      'EVIDENCE_IN',
      'RELEASABLE',
      'PAYING_OUT',
      'COMPLETED',
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(s(path[i]), s(path[i + 1]))).toBe(true);
    }
  });

  it('never pays out from anything but RELEASABLE', () => {
    const sources = Object.keys(ALLOWED_TRANSITIONS) as AgreementStatus[];
    const payable = sources.filter((from) => ALLOWED_TRANSITIONS[from].includes(s('PAYING_OUT')));
    expect(payable).toEqual([s('RELEASABLE')]);
  });

  it('cannot skip funding', () => {
    expect(canTransition(s('DRAFT'), s('FUNDED'))).toBe(false);
    expect(canTransition(s('AWAITING_PAYMENT'), s('RELEASABLE'))).toBe(false);
  });

  it('lets a dispute open from every state before payout', () => {
    for (const from of ['AWAITING_PAYMENT', 'FUNDED', 'IN_PROGRESS', 'EVIDENCE_IN', 'RELEASABLE']) {
      expect(canTransition(s(from), s('DISPUTED'))).toBe(true);
    }
  });

  it('does not let a dispute reopen a completed or refunded agreement', () => {
    expect(canTransition(s('COMPLETED'), s('DISPUTED'))).toBe(false);
    expect(canTransition(s('REFUNDED'), s('DISPUTED'))).toBe(false);
  });

  it('treats COMPLETED, REFUNDED and EXPIRED as terminal', () => {
    for (const terminal of ['COMPLETED', 'REFUNDED', 'EXPIRED']) {
      expect(ALLOWED_TRANSITIONS[s(terminal)]).toHaveLength(0);
    }
  });

  it('lets a failed payout fall back to RELEASABLE for a same-key retry', () => {
    expect(canTransition(s('PAYING_OUT'), s('RELEASABLE'))).toBe(true);
  });

  it('resolves a dispute only to release or refund', () => {
    expect(ALLOWED_TRANSITIONS[s('DISPUTED')].sort()).toEqual([s('REFUNDED'), s('RELEASABLE')].sort());
  });
});
