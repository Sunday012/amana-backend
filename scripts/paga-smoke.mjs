/**
 * Paga credential smoke test. Run from the backend folder:
 *   node scripts/paga-smoke.mjs
 *
 * accountBalance is the cheapest call that proves keys + IP + account are all
 * good. It needs the Business API channel whitelisted, not Collect.
 */
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).split('#')[0].trim()];
    }),
);

const reference = `SMOKE-${randomUUID().slice(0, 8)}`;
const hash = createHash('sha512').update(reference + env.PAGA_HMAC_KEY).digest('hex');

const res = await fetch(
  `${env.PAGA_BUSINESS_BASE_URL}/paga-webservices/business-rest/secured/accountBalance`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      principal: env.PAGA_PUBLIC_KEY,
      credentials: env.PAGA_SECRET_KEY,
      hash,
    },
    body: JSON.stringify({ referenceNumber: reference }),
  },
);

const body = await res.text();
console.log('HTTP', res.status);
console.log(body.slice(0, 500));
console.log(
  res.ok && !body.includes('"responseCode":-1')
    ? '\n✅ Keys, IP and account all good.'
    : '\n❌ Still blocked — quote this response to Paga support.',
);
