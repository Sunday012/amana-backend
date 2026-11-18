import { describe, expect, it } from 'vitest';
import { parseIntent } from '../src/modules/bot/intent';

describe('bot intent parsing', () => {
  it('reads the demo message from the PRD', () => {
    const result = parseIntent('Create protected order for Samsung phone, ₦180,000');
    expect(result.intent).toBe('create_order');
    expect(result.slots.amountMinor).toBe(18_000_000);
    expect(result.slots.item?.toLowerCase()).toContain('samsung phone');
  });

  it('expands shorthand amounts', () => {
    expect(parseIntent('Create protected order for laptop 250k').slots.amountMinor).toBe(25_000_000);
  });

  it('does not mistake a phone number for a price', () => {
    const result = parseIntent('Create protected order for phone 180000 buyer 08012345678');
    expect(result.slots.buyerPhone).toBe('08012345678');
    expect(result.slots.amountMinor).toBe(18_000_000);
  });

  it('maps the numeric replies', () => {
    expect(parseIntent('1').intent).toBe('confirm_delivery');
    expect(parseIntent('2').intent).toBe('report_problem');
  });

  it('recognises status and help', () => {
    expect(parseIntent('status').intent).toBe('check_status');
    expect(parseIntent('help').intent).toBe('help');
  });
});
