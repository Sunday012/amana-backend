import { AgreementStatus, AgreementType } from '@prisma/client';

export interface NextAction {
  /** Machine key the web app and bot switch on. */
  key: string;
  label: string;
  /** Who can act: 'payer', 'payee', 'both', 'admin' or 'nobody'. */
  actor: 'payer' | 'payee' | 'both' | 'admin' | 'nobody';
}

/**
 * PRD section 9: the agreement detail page always shows one thing — the current
 * status and the single next action for the signed-in user.
 */
export function nextAction(
  status: AgreementStatus,
  type: AgreementType,
  flags: { bothApproved: boolean; hasOpenDispute: boolean },
): NextAction {
  if (flags.hasOpenDispute) {
    return { key: 'await_admin_ruling', label: 'Awaiting admin ruling', actor: 'admin' };
  }
  switch (status) {
    case 'DRAFT':
      return flags.bothApproved
        ? { key: 'fund', label: 'Fund the agreement', actor: 'payer' }
        : { key: 'approve_terms', label: 'Review and approve the terms', actor: 'both' };
    case 'AWAITING_PAYMENT':
      return { key: 'fund', label: 'Pay to fund the agreement', actor: 'payer' };
    case 'FUNDED':
      return type === 'TRADE'
        ? { key: 'hand_to_delivery', label: 'Hand the item to Chowdeck', actor: 'payee' }
        : { key: 'submit_evidence', label: 'Submit milestone evidence', actor: 'payee' };
    case 'IN_PROGRESS':
      return type === 'TRADE'
        ? { key: 'await_delivery', label: 'Delivery in progress', actor: 'nobody' }
        : { key: 'submit_evidence', label: 'Submit the next milestone', actor: 'payee' };
    case 'EVIDENCE_IN':
      return type === 'TRADE'
        ? { key: 'confirm_receipt', label: 'Confirm receipt or report a problem', actor: 'payer' }
        : { key: 'approve_milestone', label: 'Review evidence and approve', actor: 'payer' };
    case 'RELEASABLE':
      return { key: 'await_payout', label: 'Releasing payment', actor: 'nobody' };
    case 'PAYING_OUT':
      return { key: 'await_payout', label: 'Payout in progress', actor: 'nobody' };
    case 'COMPLETED':
      return { key: 'view_receipt', label: 'View receipt', actor: 'both' };
    case 'DISPUTED':
      return { key: 'await_admin_ruling', label: 'Awaiting admin ruling', actor: 'admin' };
    case 'REFUNDED':
      return { key: 'view_receipt', label: 'Refunded', actor: 'both' };
    case 'EXPIRED':
      return { key: 'none', label: 'Expired', actor: 'nobody' };
    default:
      return { key: 'none', label: 'No action', actor: 'nobody' };
  }
}
