# Amana API — guide for the web app

Base URL: **`https://amana-api.favoursunday.dev`**
Interactive docs: **`https://amana-api.favoursunday.dev/docs`** (try requests straight from the page)
Full contract: [`openapi.yaml`](openapi.yaml)

Everything below is already live. You do not need the backend running locally.

---

## 1. Signing in

Phone OTP only — there are no passwords and no sign-up screen. A user is created on first contact.

```ts
// 1. ask for a code
await fetch(`${API}/auth/otp/request`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ phone: '+2348010000001' }),
});
// -> { "sent": true, "debugCode": "527448" }   debugCode only while OTP_DEBUG=true

// 2. exchange it for a token
const { token, user } = await fetch(`${API}/auth/otp/verify`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ phone: '+2348010000001', code: '527448' }),
}).then((r) => r.json());
```

Send `Authorization: Bearer <token>` on every other call. Tokens last 7 days.

**While we are on the sandbox, `debugCode` is returned in the response** so you can build without
WhatsApp delivery. That will go away before launch — do not build a UI that depends on it. Show a
normal "enter the code we sent you" screen and read the code from the response only in dev.

### Demo accounts (already seeded)

| Phone | Who |
| --- | --- |
| `+2348010000001` | Seller / vendor |
| `+2348010000002` | Buyer |
| `+2348010000003` | Grace, the client |
| `+2348010000004` | David, the freelancer |
| `+2348010000009` | Admin |

---

## 2. The one object you render: the agreement

`GET /agreements/:id` returns the agreement plus two things computed for the signed-in user:

```jsonc
{
  "id": "d1ab12b3-…",
  "type": "TRADE",                  // or MILESTONE
  "status": "FUNDED",
  "title": "Samsung phone",
  "totalAmount": "18000000",        // minor units (kobo), as a STRING
  "currency": "NGN",
  "viewerRole": "payer",            // payer | payee | observer
  "approvals": { "payer": "2026-11-18T…", "payee": "2026-11-18T…", "bothApproved": true },
  "nextAction": {
    "key": "hand_to_delivery",
    "label": "Hand the item to Chowdeck",
    "actor": "payee",
    "isYours": false                // true when THIS user is the one who must act
  },
  "milestones": [ … ], "evidence": [ … ], "deliveries": [ … ], "payments": [ … ]
}
```

**Build the detail screen off `nextAction`.** The PRD asks for one thing on screen: the current
status and the single next step for whoever is looking. `isYours` tells you whether to show a
button or a waiting state — you should not be deriving that from `status` yourself, because the
rules differ between TRADE and MILESTONE agreements.

`nextAction.key` is the stable value to switch on:

| key | Meaning | Who acts |
| --- | --- | --- |
| `approve_terms` | Review and approve | both |
| `fund` | Transfer the money | payer |
| `hand_to_delivery` | Give the item to Chowdeck | payee |
| `submit_evidence` | Submit milestone evidence | payee |
| `confirm_receipt` | Confirm delivery or report a problem | payer |
| `approve_milestone` | Review evidence and approve | payer |
| `await_delivery` / `await_payout` | Nothing to do, show progress | nobody |
| `await_admin_ruling` | Dispute open | admin |
| `view_receipt` | Finished | both |

### Amounts

Every amount is **an integer in minor units (kobo), serialised as a string**. `"18000000"` is
₦180,000. Parse with `BigInt` or a decimal library, never `parseFloat`, and divide by 100 only at
display time. Send amounts as plain integers (`18000000`), not strings, not decimals.

---

## 3. The two flows

### TradeProof (buy and sell)

```
POST /agreements                     seller creates the order
POST /agreements/:id/approve         buyer accepts the terms  → account number appears
     buyer transfers to that account → Paga holds it → status becomes FUNDED
POST /agreements/:id/delivery        seller hands item to Chowdeck
     Chowdeck webhook                → status EVIDENCE_IN
POST /agreements/:id/confirm         buyer confirms            → payout fires once
```

**Funding is a bank transfer, not a card payment.** When both parties approve, the agreement's
`payments[0]` carries `virtualAccountNumber` — a real Nigerian account number created for that one
agreement. Show it with the bank name and the exact amount, and poll the agreement until `status`
becomes `FUNDED`. There is no redirect and no card form to build.

### Milestone contract

```
POST /agreements/compile             AI proposes milestones from a text description
POST /agreements/milestone           create with the (possibly edited) milestones
POST /agreements/:id/approve         BOTH parties must call this
     client funds as above
POST /milestones/:id/evidence        freelancer submits a PR link / screenshots
POST /milestones/:id/approve         client approves → that milestone pays out
```

`POST /agreements/compile` returns `{ terms, source, disclaimer }`. Render the milestones as
**editable** fields and label them with the `disclaimer` — the PRD requires AI output be marked
"suggested by AI, please review". The form must block approval unless the milestone amounts sum
exactly to the total; the API rejects it otherwise with a 400 naming the mismatch.

---

## 4. Polling, not sockets

There are no websockets. State changes arrive from providers, so poll `GET /agreements/:id` every
3–5 seconds on any screen that is waiting (funding, delivery, payout). `GET /agreements/:id/timeline`
returns the audit log, which is exactly what the status timeline should render — it is append-only,
so you can treat it as an immutable list.

---

## 5. Errors

Standard Nest shapes:

| Status | Means | Show |
| --- | --- | --- |
| 400 | Validation failed; `issues[]` names the fields | Field errors |
| 401 | Missing/expired token | Send back to sign-in |
| 403 | Not a party to this agreement | "You do not have access" |
| 409 | Legal but not now — wrong state, already paid, dispute lock | The message is user-safe |
| 502 | A provider (Paga, Chowdeck) refused | "Payment provider unavailable, try again" |

409 is the interesting one: the backend refuses anything that would break the money rules —
approving twice, paying out from the wrong state, disputing after payout started. Surface
`message` directly; it is written to be read by a person.

---

## 6. What is mocked right now

| | State |
| --- | --- |
| Payments | **Live** against the Paga sandbox when `PAYMENT_MODE=paga`, otherwise simulated |
| Delivery | Simulated — Chowdeck credentials not issued yet; webhook shapes are real |
| AI compiler | Deterministic fallback unless an Anthropic key is set; output shape identical |
| Notifications | Written to the server log; WhatsApp sending not configured |

In fake payment mode an agreement reaches `FUNDED` as soon as the callback is simulated, so you can
build every screen end to end without waiting on providers.
