import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { ChowdeckProvider } from '../src/providers/chowdeck/chowdeck.provider';

const provider = new ChowdeckProvider({ get: () => undefined } as unknown as ConfigService);

/** Relay's real webhook envelope: { category, description, payload }. */
const event = (category: string, reference = 'AG-123') => ({
  category,
  description: 'whatever',
  payload: { reference, id: 99 },
});

describe('Chowdeck Relay event mapping', () => {
  it('treats assignment and awaiting-pickup as still just created', () => {
    expect(provider.parseWebhook(event('ORDER_CREATED'))?.status).toBe('CREATED');
    expect(provider.parseWebhook(event('ORDER_ASSIGNED'))?.status).toBe('CREATED');
    expect(provider.parseWebhook(event('ORDER_AWAITING_PICKUP'))?.status).toBe('CREATED');
  });

  it('maps pickup and arrival onto the in-flight states', () => {
    expect(provider.parseWebhook(event('ORDER_PICKED_UP'))?.status).toBe('PICKED_UP');
    expect(provider.parseWebhook(event('ORDER_ARRIVED_AT_CUSTOMER_LOCATION'))?.status).toBe(
      'IN_TRANSIT',
    );
  });

  it('only ORDER_COMPLETE counts as delivered', () => {
    expect(provider.parseWebhook(event('ORDER_COMPLETE'))?.status).toBe('DELIVERED');
    // Arrival at the customer is NOT delivery: it must not start the
    // confirmation window or the auto-release clock.
    expect(provider.parseWebhook(event('ORDER_ARRIVED_AT_CUSTOMER_LOCATION'))?.status).not.toBe(
      'DELIVERED',
    );
  });

  it('ignores events it does not recognise rather than guessing', () => {
    expect(provider.parseWebhook(event('ORDER_ITEMS_UPDATED'))).toBeNull();
    expect(provider.parseWebhook(event('SOMETHING_NEW'))).toBeNull();
  });

  it('ignores an event with no reference to match back to a delivery', () => {
    expect(provider.parseWebhook({ category: 'ORDER_COMPLETE', payload: {} })).toBeNull();
  });

  it('gives each event a distinct id so duplicates are dropped but states are not', () => {
    const picked = provider.parseWebhook(event('ORDER_PICKED_UP'))!;
    const complete = provider.parseWebhook(event('ORDER_COMPLETE'))!;
    expect(picked.eventId).not.toBe(complete.eventId);
    expect(provider.parseWebhook(event('ORDER_PICKED_UP'))!.eventId).toBe(picked.eventId);
  });
});
