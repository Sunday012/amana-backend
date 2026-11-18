#!/usr/bin/env bash
# End-to-end walk of both PRD flows against a running API, in fake payment mode.
# Usage: ./scripts/demo.sh [base_url]
set -euo pipefail

BASE="${1:-http://localhost:3001}"
INTERNAL_KEY="${INTERNAL_API_KEY:-dev-internal-key}"
SELLER="+2348010000001"
BUYER="+2348010000002"
CLIENT="+2348010000003"
FREELANCER="+2348010000004"

jqr() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d);console.log(eval('o'+process.argv[1])??'')})" "$1"; }

login() {
  local phone="$1"
  local code
  code=$(curl -sS -X POST "$BASE/auth/otp/request" -H 'content-type: application/json' \
    -d "{\"phone\":\"$phone\"}" | jqr '.debugCode')
  curl -sS -X POST "$BASE/auth/otp/verify" -H 'content-type: application/json' \
    -d "{\"phone\":\"$phone\",\"code\":\"$code\"}" | jqr '.token'
}

say() { printf '\n\033[1;36m%s\033[0m\n' "$*"; }

say "0. Signing in all four parties by phone OTP"
SELLER_T=$(login "$SELLER")
BUYER_T=$(login "$BUYER")
CLIENT_T=$(login "$CLIENT")
FREELANCER_T=$(login "$FREELANCER")

# ----------------------------------------------------------- Flow 1: TradeProof
say "1. Seller creates a protected order (Samsung phone, NGN 180,000)"
AG=$(curl -sS -X POST "$BASE/agreements" -H "authorization: Bearer $SELLER_T" \
  -H 'content-type: application/json' \
  -d "{\"title\":\"Samsung phone\",\"amount\":18000000,\"buyerPhone\":\"$BUYER\",\"createdVia\":\"WHATSAPP\"}" \
  | jqr '.id')
echo "agreement: $AG"

say "2. Buyer reviews and accepts the terms"
curl -sS -X POST "$BASE/agreements/$AG/approve" -H "authorization: Bearer $BUYER_T" \
  | jqr '.status'

say "3. Buyer pays (fake mode settles instantly); Amana verifies and holds"
REF=$(curl -sS "$BASE/payments/$AG" -H "authorization: Bearer $BUYER_T" | jqr '.payments[0].pagaReference')
curl -sS -X POST "$BASE/webhooks/paga" -H 'content-type: application/json' \
  -d "{\"referenceNumber\":\"$REF\",\"status\":\"SUCCESS\",\"transactionId\":\"demo-txn-$RANDOM\"}" >/dev/null
curl -sS "$BASE/agreements/$AG" -H "authorization: Bearer $BUYER_T" | jqr '.status'

say "4. Seller hands the item to Chowdeck"
DLV=$(curl -sS -X POST "$BASE/agreements/$AG/delivery" -H "authorization: Bearer $SELLER_T" \
  -H 'content-type: application/json' \
  -d '{"pickupAddress":"12 Allen Ave, Ikeja","dropoffAddress":"4 Bourdillon, Ikoyi","itemDescription":"Samsung phone"}' \
  | jqr '.deliveries[0].chowdeckDeliveryId')
echo "delivery: $DLV"

say "5. Chowdeck reports delivered (evidence, not release)"
curl -sS -X POST "$BASE/webhooks/chowdeck" -H 'content-type: application/json' \
  -d "{\"delivery_id\":\"$DLV\",\"status\":\"delivered\",\"event_id\":\"evt-$RANDOM\"}" >/dev/null
curl -sS "$BASE/agreements/$AG" -H "authorization: Bearer $BUYER_T" | jqr '.status'

say "6. Buyer confirms receipt -> releasable -> payout fires once"
curl -sS -X POST "$BASE/agreements/$AG/confirm" -H "authorization: Bearer $BUYER_T" \
  -H 'content-type: application/json' -d '{"outcome":"CONFIRM"}' >/dev/null
sleep 2
curl -sS "$BASE/agreements/$AG" -H "authorization: Bearer $BUYER_T" | jqr '.status'

say "7. Try to pay twice — the guard refuses"
curl -sS -X POST "$BASE/payouts" -H "x-internal-key: $INTERNAL_KEY" \
  -H 'content-type: application/json' -d "{\"agreementId\":\"$AG\"}" | jqr '.message'

say "8. Audit log"
curl -sS "$BASE/agreements/$AG/timeline" -H "authorization: Bearer $BUYER_T" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>JSON.parse(d).forEach(r=>console.log(\`  \${r.actor.padEnd(12)} \${r.action.padEnd(28)} \${r.fromStatus??'-'} -> \${r.toStatus??'-'}\`)))"

# -------------------------------------------------------- Flow 2: milestones
say "9. Client describes a project; AI proposes milestones"
curl -sS -X POST "$BASE/agreements/compile" -H "authorization: Bearer $CLIENT_T" \
  -H 'content-type: application/json' \
  -d '{"description":"Build a marketing website. Finish the homepage design. Then deploy the site with passing tests.","budgetAmount":10000000}' \
  | jqr '.terms.milestones.map(m=>m.title+" "+m.amount).join(" | ")'

say "10. Both approve and the client funds the contract"
MAG=$(curl -sS -X POST "$BASE/agreements/milestone" -H "authorization: Bearer $CLIENT_T" \
  -H 'content-type: application/json' \
  -d "{\"title\":\"Marketing website\",\"freelancerPhone\":\"$FREELANCER\",\"totalAmount\":10000000,\"aiGenerated\":true,\"milestones\":[{\"title\":\"Homepage completed\",\"amount\":5000000,\"conditions\":[\"client_approval\"]},{\"title\":\"Website deployed\",\"amount\":5000000,\"conditions\":[\"tests_pass\",\"client_approval\"]}]}" \
  | jqr '.id')
curl -sS -X POST "$BASE/agreements/$MAG/approve" -H "authorization: Bearer $CLIENT_T" >/dev/null
curl -sS -X POST "$BASE/agreements/$MAG/approve" -H "authorization: Bearer $FREELANCER_T" >/dev/null
MREF=$(curl -sS "$BASE/payments/$MAG" -H "authorization: Bearer $CLIENT_T" | jqr '.payments[0].pagaReference')
curl -sS -X POST "$BASE/webhooks/paga" -H 'content-type: application/json' \
  -d "{\"referenceNumber\":\"$MREF\",\"status\":\"SUCCESS\"}" >/dev/null
curl -sS "$BASE/agreements/$MAG" -H "authorization: Bearer $CLIENT_T" | jqr '.status'

say "11. Freelancer submits milestone 1; client approves; that milestone pays"
M1=$(curl -sS "$BASE/agreements/$MAG" -H "authorization: Bearer $CLIENT_T" | jqr '.milestones[0].id')
curl -sS -X POST "$BASE/milestones/$M1/evidence" -H "authorization: Bearer $FREELANCER_T" \
  -H 'content-type: application/json' \
  -d '{"type":"GITHUB","prUrl":"https://github.com/amana/demo/pull/1"}' | jqr '.outcome'
curl -sS -X POST "$BASE/milestones/$M1/approve" -H "authorization: Bearer $CLIENT_T" | jqr '.outcome'
sleep 2
curl -sS "$BASE/payments/$MAG" -H "authorization: Bearer $CLIENT_T" \
  | jqr '.payouts.map(p=>p.status+" "+p.amount).join(", ")'

say "Done. One engine, two very different deals."
