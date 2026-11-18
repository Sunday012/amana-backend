export type IntentName =
  | 'create_order'
  | 'check_status'
  | 'confirm_delivery'
  | 'report_problem'
  | 'help'
  | 'unknown';

export interface ParsedIntent {
  intent: IntentName;
  /** Fields found in the message; missing ones are asked for one at a time. */
  slots: { item?: string; amountMinor?: number; buyerPhone?: string; deliveryTerms?: string };
}

const AMOUNT = /(?:₦|ngn\s*)?([\d][\d,]*(?:\.\d{1,2})?)\s*(k|m)?/i;
const PHONE = /(\+?234\d{10}|0\d{10})/;

/** Parses a free-text chat message into an intent plus whatever slots it carries. */
export function parseIntent(message: string): ParsedIntent {
  const text = message.trim();
  const lower = text.toLowerCase();

  if (text === '1' || /^(confirm|received|yes)\b/.test(lower)) {
    return { intent: 'confirm_delivery', slots: {} };
  }
  if (text === '2' || /^(problem|issue|report|no)\b/.test(lower)) {
    return { intent: 'report_problem', slots: {} };
  }
  if (/\b(status|where|track)\b/.test(lower)) return { intent: 'check_status', slots: {} };
  if (/^(help|menu|start)\b/.test(lower)) return { intent: 'help', slots: {} };

  if (/\b(create|new|protect)\b.*\b(order|deal|sale)\b/.test(lower) || /protected order/.test(lower)) {
    return { intent: 'create_order', slots: extractSlots(text) };
  }
  return { intent: 'unknown', slots: extractSlots(text) };
}

export function extractSlots(text: string): ParsedIntent['slots'] {
  const slots: ParsedIntent['slots'] = {};

  const phone = text.match(PHONE);
  if (phone) slots.buyerPhone = phone[1];

  // Strip the phone before reading the amount so they cannot be confused.
  const withoutPhone = phone ? text.replace(phone[1], ' ') : text;
  const amount = withoutPhone.match(AMOUNT);
  if (amount) {
    let major = Number(amount[1].replace(/,/g, ''));
    if (amount[2]?.toLowerCase() === 'k') major *= 1_000;
    if (amount[2]?.toLowerCase() === 'm') major *= 1_000_000;
    if (major > 0) slots.amountMinor = Math.round(major * 100);
  }

  const item = withoutPhone
    .replace(/^.*?\bfor\b/i, '')
    .replace(AMOUNT, '')
    .replace(/[₦,]/g, '')
    .trim();
  if (item.length >= 2) slots.item = item.slice(0, 140);

  return slots;
}

/** The bot asks for missing fields one at a time, in this order. */
export const SLOT_PROMPTS: { slot: keyof ParsedIntent['slots']; question: string }[] = [
  { slot: 'item', question: 'What are you selling?' },
  { slot: 'amountMinor', question: 'What is the price?' },
  { slot: 'buyerPhone', question: "What is the buyer's phone number?" },
  { slot: 'deliveryTerms', question: 'What are the delivery terms? (or reply "skip")' },
];
