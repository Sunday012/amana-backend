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

// 4 & 5. Subsidiary (persistent) accounts — a ledger-backed account that HOLDS
// funds is exactly the escrow primitive we want. Basic auth suggests the
// Collect host, but try both since the docs omit the base URL.
const accountRef = `amana${Date.now()}`.slice(0, 20);
const callbackUrl = `${env.PUBLIC_API_URL ?? 'https://example.com'}/webhooks/paga`;
const subsidiaryBody = {
  referenceNumber: ref,
  accountReference: accountRef,
  accountName: 'Amana Test Escrow',
  firstName: 'Amana',
  lastName: 'Escrow',
  phoneNumber: '08010000002',
  email: 'escrow@example.com',
  status: 'ACTIVE',
  callbackUrl,
};
// referenceNumber + accountReference + iifiNumber + autoSweep.bankPublicId
// + autoSweep.destination + autoSweep.accountNumber + callbackUrl
const subsidiaryHash = hash([ref, accountRef, '', '', '', '', callbackUrl]);

await probe(
  '4. Create subsidiary account (ledger-backed, holds funds)',
  `${collect}/subsidiary-accounts`,
  { Authorization: `Basic ${basic}`, hash: subsidiaryHash },
  subsidiaryBody,
);

// 5. Read it back: this is the server-side balance check that will back up
// the funding callback, exactly as the status check did for collections.
process.stdout.write(`\n--- 5. Retrieve subsidiary account ${accountRef}\n`);
try {
  const res = await fetch(`${collect}/subsidiary-accounts/${accountRef}`, {
    method: 'GET',
    headers: { Authorization: `Basic ${basic}`, hash: hash([accountRef]) },
  });
  console.log(`    GET -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
} catch (e) {
  console.log(`    network error: ${e.message}`);
}

console.log('\nDone.');
