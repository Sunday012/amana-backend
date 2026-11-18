# Amana — backend

**Agree. Verify. Pay.** Two parties agree on terms, the payer funds the deal, Amana holds the
money, and it releases payment only when the agreed outcome is verified.

This repo is workstream **C (Payments and core)** from the PRD: the agreements table, the state
machine, the audit log, auth, the payment engine — plus the OutcomeOS rules, the AI compiler, the
Chowdeck adapter and the bot front door, so the chat and web teams can build against a running API
from day one.

One backend serves every channel. An agreement created in chat shows up unchanged on the web.

---

## Quick start

```bash
pnpm install
docker compose up -d                 # Postgres on 5433, Redis on 6380
cp .env.example .env                 # then point DATABASE_URL at :5433 and REDIS_URL at :6380
pnpm prisma migrate deploy
pnpm seed                            # demo cast: seller, buyer, Grace, David, admin
pnpm dev
```

Check it is alive:

```bash
curl localhost:3001/health
```

Then walk both PRD flows end to end, in fake payment mode:

```bash
./scripts/demo.sh
```

That script creates a protected order, funds it, delivers it, confirms it, pays out once, proves a
second payout is refused, prints the audit log, and then runs a milestone contract through the AI
compiler, approval, funding, evidence and a per-milestone payout.

---

## What the backend enforces

These are the money rules from PRD section 5. They live in code, not in a convention.

| Rule | Where |
| --- | --- |
| Money moves only from `RELEASABLE` | [`src/common/state-machine.ts`](src/common/state-machine.ts) |
| `FUNDED` needs a verified callback **and** a server-side status check | `PaymentsService.confirmFunding` |
| A payout checks status, amount, recipient, dispute lock and prior payouts | [`src/modules/payments/payout-guard.ts`](src/modules/payments/payout-guard.ts) |
| Each payout carries a unique key written **before** the provider call | `PaymentsService.payout` |
| A dispute sets a lock the guard checks every time | `AgreementsService.openDispute` |
| Every transition writes who, what, when and the evidence reference | [`src/modules/core/transition.service.ts`](src/modules/core/transition.service.ts) |
| Amounts and recipients are read from the stored agreement, never from a request body | `PaymentsService`, `/payouts` DTO |
| AI output is schema-validated and binds nobody until both parties approve | [`src/modules/compiler/`](src/modules/compiler) |

Delivery by Chowdeck is **evidence, not release**. A `delivered` webhook moves the agreement to
`EVIDENCE_IN` and starts the confirmation window; money moves only after the buyer confirms, or
after the auto-release window elapses with no dispute.

### Lifecycle

```
DRAFT → AWAITING_PAYMENT → FUNDED → IN_PROGRESS → EVIDENCE_IN → RELEASABLE → PAYING_OUT → COMPLETED
                                         ↘            ↘             ↙
                                          DISPUTED (payout locked) → REFUNDED
```

A milestone contract runs its own `IN_PROGRESS → RELEASABLE → PAYING_OUT` loop per milestone under
one funded contract, and only completes when every milestone is paid.

---

## Layout

```
src/
  common/            state machine, event names, guards, zod pipe, BigInt serialisation
  prisma/            Prisma client module
  providers/
    paga/            PaymentProvider interface + fake and real adapters
    chowdeck/        DeliveryProvider interface + fake and real adapters
    whatsapp/        message channels (log by default, WhatsApp Business when configured)
  modules/
    auth/            phone OTP, JWT, lightweight accounts created on first contact
    core/            audit log, transition service, event bus
    agreements/      creation, approval, versioned terms, delivery, confirm, dispute, next action
    compiler/        AI agreement compiler + its validated JSON schema
    outcome/         OutcomeOS — evaluates evidence against conditions
    payments/        collections, funding verification, guarded idempotent payouts, ledger, refunds
    webhooks/        Paga, Chowdeck and GitHub endpoints with signature checks
    disputes/        lock, evidence, admin ruling
    notifications/   both-party messages for every state change
    jobs/            event consumer, reconciler, auto-release, expiry
    bot/             chat intent parsing and the conversation flow
```

Only the backend talks to Paga, Chowdeck and GitHub. The bots and the web app never touch money or
webhooks directly.

---

## Fake mode

`PAYMENT_MODE=fake` (the default) makes "paying" settle instantly and "payout" write a fake
success, so the chat and web workstreams can demo before Paga sandbox access lands. Flip to
`PAYMENT_MODE=paga` and fill in the Paga keys to use the real engine — nothing outside
`src/providers/paga/` changes. `DELIVERY_MODE` and `AI_MODE` work the same way
(`AI_MODE=heuristic` splits a budget deterministically; `anthropic` calls a model and rejects any
output that fails schema validation).

---

## API

The full contract is in [`openapi.yaml`](openapi.yaml). The shape the other workstreams build
against:

| Method and path | Purpose | Caller |
| --- | --- | --- |
| `POST /auth/otp/request`, `/auth/otp/verify` | Phone OTP login | Web, bot |
| `POST /agreements` | Create a TRADE agreement | Bot, web |
| `POST /agreements/milestone` | Create a MILESTONE agreement | Web |
| `POST /agreements/compile` | AI proposes milestone terms | Web |
| `POST /agreements/:id/approve` | A party approves the current version | Web |
| `PATCH /agreements/:id/terms` | Edit terms, creating a new version | Web |
| `GET /agreements/:id` | Agreement with status and next action | All |
| `GET /agreements/:id/timeline` | The audit log, read-only | Web |
| `POST /agreements/:id/delivery` | Seller hands the item to Chowdeck | Bot, web |
| `POST /agreements/:id/confirm` | Buyer confirms receipt | Bot, web |
| `POST /agreements/:id/dispute` | Open a dispute and lock the payout | Bot, web |
| `POST /milestones/:id/evidence` | Freelancer submits evidence | Web |
| `POST /milestones/:id/approve` | Client approves a milestone | Web |
| `POST /payments/collections`, `GET /payments/:agreementId` | Collection and status | Web, bots |
| `POST /payouts` | Guarded payout | **Backend only** (`x-internal-key`) |
| `POST /webhooks/paga`, `/webhooks/chowdeck`, `/webhooks/github` | Provider events | Providers |
| `GET /admin/disputes`, `POST /admin/disputes/:id/rule` | Dispute review | Admin |
| `POST /bot/message` | Inbound chat message | Bot process (`x-internal-key`) |

### Events

The internal queue carries `agreement.created`, `agreement.approved`, `payment.confirmed`,
`delivery.updated`, `evidence.received`, `milestone.releasable`, `payout.sent`, `payout.failed`,
`dispute.opened`, `dispute.ruled`, `agreement.completed` and `agreement.expired`. The notification
sender and the payout trigger both consume them, and both are safe to repeat.

---

## Background jobs

Run in-process with the API (`@nestjs/schedule` + BullMQ):

- **Payment reconciler** — re-checks by reference any payment whose callback never arrived.
- **Payout reconciler** — re-checks a pending payout before any retry, reusing the same key.
- **Auto-release** — releases after the confirmation window if the buyer is silent and nothing is disputed.
- **Expiry** — expires unpaid agreements after `UNPAID_EXPIRY_HOURS`.
- **Condition sweep** — re-evaluates funded trades so a missed webhook still settles.

To scale, split these into their own process and set `--only` on the Bull worker; the API will then
publish without consuming.

---

## Tests

```bash
pnpm test
```

33 unit tests cover the parts where a mistake moves money: the payout guard (every refusal in PRD
section 11), the state machine (payout is reachable only from `RELEASABLE`, terminal states stay
terminal), AI output validation (amounts must sum; unknown conditions rejected), bot intent
parsing, and the next-action resolver.

---

## Chowdeck integration status

**Not connected yet.** `DELIVERY_MODE=fake` is the default.

The product we want is **Relay by Chowdeck** — on-demand last-mile delivery with a REST API,
webhooks and a sandbox. Keys come from the Chowdeck dashboard under Settings → Developer Settings,
which is also where the webhook URL is configured.

Dispatching is **two calls, not one**:

| Step | Endpoint | Returns |
| --- | --- | --- |
| 1. Quote | `POST /relay/delivery/fee` | `data.id` (the fee id), `data.total_amount` |
| 2. Dispatch | `POST /relay/delivery` | `data.reference`, `data.id`, `data.status` |

The dispatch is authorised by the quote's `fee_id`, so step 1 is not optional.

Three things that shape the product, not just the adapter:

- **Relay quotes on coordinates, not addresses.** `source_address` and `destination_address` are
  lat/lng pairs; the address strings are labels. The "hand it to Chowdeck" screen therefore needs a
  map picker or a geocoder — a free-text address is not enough to dispatch.
- **Fees are charged to a Relay wallet**, so that wallet needs a balance or dispatch fails.
- **Phone numbers go as local 11-digit**, while we store E.164. The adapter converts.

Relay's webhook envelope is `{ category, description, payload }`, and its event names map onto our
delivery states like this:

| Relay event | Our state | Note |
| --- | --- | --- |
| `ORDER_CREATED`, `ORDER_ASSIGNED`, `ORDER_AWAITING_PICKUP` | `CREATED` | Rider not holding it yet |
| `ORDER_PICKED_UP` | `PICKED_UP` | Agreement moves to `IN_PROGRESS` |
| `ORDER_ARRIVED_AT_CUSTOMER_LOCATION` | `IN_TRANSIT` | **Not** delivery |
| `ORDER_COMPLETE` | `DELIVERED` | Starts the buyer confirmation window |

Only `ORDER_COMPLETE` counts as delivered — arrival at the customer must not start the
confirmation window or the auto-release clock. That rule is locked by a test.

**There appears to be no sandbox.** The developer docs describe a single API key type, a single
base URL (`api.chowdeck.com`) and no test mode, test keys or key prefixes. Only the Relay marketing
page claims a sandbox, and nothing in the docs supports it. Until Chowdeck confirms otherwise,
assume a dispatch is real: `createDelivery` sends an actual rider and bills the actual wallet.

So `DELIVERY_MODE=fake` is the default for demos, and `chowdeck` is for a deliberate, real
delivery. The fake provider emits the same ids and webhook shapes, so the TradeProof flow demos
identically without dispatching anyone.

Auth is confirmed as `Authorization: Bearer <secret key>`.

Still open:

- Relay documents no failed, cancelled or returned events. There is a cancel endpoint, so those
  states may simply never arrive by webhook — which would leave the "delivery failed, hold and
  alert" path in the PRD with nothing to trigger it. Polling `GET /relay/delivery` would be the
  fallback.
- Signup is at `app.chowdeck.com/register` (vendor) while the docs point at
  `dashboard.chowdeck.com/auth/signup`. Worth confirming which issues Relay API keys.

## Compliance note

Holding funds for others is regulated. This runs on the Paga sandbox with an internal ledger.
Production needs a licensed or provider-held safeguarding arrangement.

**Intended model: Paga holds the funds until release.** Collected money stays in a Paga-controlled
wallet and Amana triggers a transfer out when an agreement becomes `RELEASABLE`; our
`ledger_entries` table is a mirror of what is owed, not the custody record. This still needs
confirming with Paga during onboarding — ask whether collections settle out to our bank account on
receipt, or stay in the wallet until we move them. If it is the former, Amana is holding customer
funds itself and that is the licensed path, not the sandbox path.

## Paga integration status

**Not connected yet.** `PAYMENT_MODE=fake` is the default and no credentials are set.

Blocking item: a sandbox account still has to be approved before its keys work, so start that
first.

1. Register at https://beta-business.paga.com/partner/register
2. Note the sandbox account number shown on the dashboard.
3. Ask for activation — email `business.support@paga.com` with the business name and that account
   number (docs say up to 24 hours), or post the same in the shipathon Slack channel.
4. Once approved, collect the keys from **Developer Tools → API Keys**:

| Key | `.env` variable |
| --- | --- |
| Public key | `PAGA_PUBLIC_KEY` |
| Secret key | `PAGA_SECRET_KEY` |
| Hash key | `PAGA_HMAC_KEY` |

Sandbox and live keys are not interchangeable. The secret and hash keys never go in source control
or a chat channel.

Paga is **two products with two auth schemes**, and the adapter now uses both:

| | Host (sandbox) | Auth | Used for |
| --- | --- | --- | --- |
| Collect | `beta-collect.paga.com` | HTTP Basic `public:secret` + `hash` | Money in |
| Business | `beta.mypaga.com` | `principal` / `credentials` + `hash` | Money out |

Live hosts are `collect.paga.com` and `www.mypaga.com`.

**IP whitelisting is required in Sandbox as well as Live** (portal: Developer Tools -> IP
Whitelist). Requests from an unlisted address are rejected even with valid keys, so the API has to
call Paga from a fixed-IP host — a laptop on a home or office connection will not work.

Verified against the docs and implemented:

- `depositToBank` on the Business API for payouts, hashed over
  `referenceNumber + amount + destinationBankUUID + destinationBankAccountNumber + hashKey`.
- The payment-request hash order on Collect:
  `referenceNumber + amount + currency + payer.phoneNumber + payer.email + hashKey`.
- The hash is SHA-512 with the key **appended to the parameter string**, not an HMAC.

Still open in [`src/providers/paga/paga.provider.ts`](src/providers/paga/paga.provider.ts):

- **Which Collect payment method** the buyer link uses — hosted Checkout, dynamic virtual account,
  bank USSD or Paga wallet. That decides the create and status endpoint paths, which are currently
  placeholders. The Postman collection in the docs is the fastest way to settle it.
- The webhook signature scheme — header name and whether it is an HMAC over the raw body.

## Decisions taken here

The PRD leaves these open; this is what the code assumes, and each is a one-line change:

- **Buyer identity** — phone OTP only, no separate account. A user is created on first contact.
- **Who creates first** — seller for TRADE, client for MILESTONE, one agreement model underneath.
- **Auto-release window** — 24 h after `DELIVERED` (`AUTO_RELEASE_HOURS`); unpaid orders expire at 48 h.
- **Amounts** — integers in minor units (kobo) everywhere, serialised as strings in JSON.
- **Discord** — ops and demo only; the bot service is shared if it becomes a customer channel.
