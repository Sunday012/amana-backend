/**
 * Paga credential smoke test. Run from the backend folder:
 *   node scripts/paga-smoke.mjs
 *
 * accountBalance is the cheapest call that proves keys + IP + account are all
 * good. It needs the Business API channel whitelisted, not Collect.
 */
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

// Prefer real environment variables (how a host supplies them), and fall back
// to a local .env for development.
function loadEnv() {
  let fileVars = {};
  try {
    fileVars = Object.fromEntries(
      readFileSync('.env', 'utf8')
        .split('\n')
        .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
        .map((l) => {
          const i = l.indexOf('=');
          return [l.slice(0, i).trim(), l.slice(i + 1).split('#')[0].trim()];
        }),
    );
  } catch {
    // No .env here — expected on a server.
  }
  return { ...fileVars, ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v)) };
}

const env = loadEnv();

for (const key of ['PAGA_PUBLIC_KEY', 'PAGA_SECRET_KEY', 'PAGA_HMAC_KEY']) {
  if (!env[key]) {
    console.error(`Missing ${key} — set it in the environment or .env`);
    process.exit(1);
  }
}

const reference = `SMOKE-${randomUUID().slice(0, 8)}`;
const hash = createHash('sha512').update(reference + env.PAGA_HMAC_KEY).digest('hex');

const res = await fetch(
  `${env.PAGA_BUSINESS_BASE_URL ?? 'https://beta.mypaga.com'}/paga-webservices/business-rest/secured/accountBalance`,
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
