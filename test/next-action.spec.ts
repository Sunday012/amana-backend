import { AgreementStatus, AgreementType } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { nextAction } from '../src/modules/agreements/next-action';

const trade = 'TRADE' as AgreementType;
const milestone = 'MILESTONE' as AgreementType;
const flags = { bothApproved: false, hasOpenDispute: false };

describe('next action', () => {
  it('asks for approval before funding, then for payment', () => {
    expect(nextAction('DRAFT' as AgreementStatus, trade, flags).key).toBe('approve_terms');
    expect(nextAction('DRAFT' as AgreementStatus, trade, { ...flags, bothApproved: true }).key).toBe('fund');
  });

  it('sends the funded trade to delivery and the funded contract to evidence', () => {
    expect(nextAction('FUNDED' as AgreementStatus, trade, flags).key).toBe('hand_to_delivery');
    expect(nextAction('FUNDED' as AgreementStatus, milestone, flags).key).toBe('submit_evidence');
  });

  it('puts the confirm step on the buyer once evidence is in', () => {
    const action = nextAction('EVIDENCE_IN' as AgreementStatus, trade, flags);
    expect(action.key).toBe('confirm_receipt');
    expect(action.actor).toBe('payer');
  });

  it('hands everything to the admin while a dispute is open', () => {
    const action = nextAction('FUNDED' as AgreementStatus, trade, { ...flags, hasOpenDispute: true });
    expect(action.key).toBe('await_admin_ruling');
    expect(action.actor).toBe('admin');
  });

  it('gives nobody an action while money is moving', () => {
    expect(nextAction('PAYING_OUT' as AgreementStatus, trade, flags).actor).toBe('nobody');
  });
});
