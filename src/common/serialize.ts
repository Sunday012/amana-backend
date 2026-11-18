/**
 * Amounts are stored as BigInt minor units. JSON.stringify cannot serialize
 * BigInt, so every response passes through this.
 */
export function serialize<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v)),
  ) as T;
}

export function toMinor(majorUnits: number): bigint {
  return BigInt(Math.round(majorUnits * 100));
}

export function formatAmount(minor: bigint, currency = 'NGN'): string {
  const symbol = currency === 'NGN' ? '₦' : `${currency} `;
  const major = Number(minor) / 100;
  return `${symbol}${major.toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}
