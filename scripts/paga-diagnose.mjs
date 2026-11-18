/**
 * Probes both Paga APIs and prints what each says. Run it anywhere the
 * credentials are present — including from the deploy build script, where the
 * output lands in the deployment log.
 */
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

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
  } catch {}
  return { ...fileVars, ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v)) };
}

const env = loadEnv();
const hash = (parts) =>
  createHash('sha512').update(parts.join('') + env.PAGA_HMAC_KEY).digest('hex');
const basic = Buffer.from(`${env.PAGA_PUBLIC_KEY}:${env.PAGA_SECRET_KEY}`).toString('base64');

async function probe(label, url, headers, body) {
  process.stdout.write(`\n--- ${label}\n    ${url}\n`);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    console.log(`    HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  } catch (e) {
    console.log(`    network error: ${e.message}`);
  }
}

console.log('Paga diagnostics');
console.log(`  public key: ${(env.PAGA_PUBLIC_KEY ?? '').slice(0, 8)}…  (${(env.PAGA_PUBLIC_KEY ?? '').length} chars)`);
console.log(`  secret key: ${(env.PAGA_SECRET_KEY ?? '').length} chars, hash key: ${(env.PAGA_HMAC_KEY ?? '').length} chars`);

const ref = `DIAG-${randomUUID().slice(0, 8)}`;
const business = env.PAGA_BUSINESS_BASE_URL ?? 'https://beta.mypaga.com';
const collect = env.PAGA_COLLECT_BASE_URL ?? 'https://beta-collect.paga.com';

// 1. Business API: does the account answer at all?
await probe(
  '1. Business API accountBalance (tests keys + IP on BUSINESS_API)',
  `${business}/paga-webservices/business-rest/secured/accountBalance`,
  { principal: env.PAGA_PUBLIC_KEY, credentials: env.PAGA_SECRET_KEY, hash: hash([ref]) },
  { referenceNumber: ref },
);

// 2. Collect status for an unknown reference: tests keys + IP on COLLECT_API.
await probe(
  '2. Collect /status for an unknown reference (tests keys + IP on COLLECT_API)',
  `${collect}/status`,
  { Authorization: `Basic ${basic}`, hash: hash([ref]) },
  { referenceNumber: ref },
);

// 3. The real payment request, minus our extras, to see if a leaner body passes.
const amount = 500;
await probe(
  '3. Collect /paymentRequest, minimal body',
  `${collect}/paymentRequest`,
  { Authorization: `Basic ${basic}`, hash: hash([ref, String(amount), 'NGN', '08010000002', '']) },
  {
    referenceNumber: ref,
    amount,
    currency: 'NGN',
    payer: { name: 'Diag Payer', phoneNumber: '08010000002' },
    payee: { name: 'Diag Payee' },
    payerCollectionFeeShare: 1,
    payeeCollectionFeeShare: 0,
    callBackUrl: `${env.PUBLIC_API_URL ?? 'https://example.com'}/webhooks/paga`,
  },
);

console.log('\nDone.');
