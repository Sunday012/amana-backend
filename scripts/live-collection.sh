#!/usr/bin/env bash
# Creates an agreement and takes it to the point where a real Paga collection
# is requested. Use against a server running with PAYMENT_MODE=paga.
set -euo pipefail
BASE="${1:-http://localhost:3001}"
SELLER="+2348010000001"
BUYER="+2348010000002"

jqr() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d);const v=eval('o'+process.argv[1]);console.log(typeof v==='string'?v:JSON.stringify(v))})" "$1"; }

login() {
  local code
  code=$(curl -sS -X POST "$BASE/auth/otp/request" -H 'content-type: application/json' \
    -d "{\"phone\":\"$1\"}" | jqr '.debugCode')
  curl -sS -X POST "$BASE/auth/otp/verify" -H 'content-type: application/json' \
    -d "{\"phone\":\"$1\",\"code\":\"$code\"}" | jqr '.token'
}

S=$(login "$SELLER"); B=$(login "$BUYER")

AG=$(curl -sS -X POST "$BASE/agreements" -H "authorization: Bearer $S" \
  -H 'content-type: application/json' \
  -d "{\"title\":\"Live sandbox test\",\"amount\":50000,\"buyerPhone\":\"$BUYER\"}" | jqr '.id')
echo "agreement: $AG"

echo "--- buyer approves (fires the live Paga collection) ---"
curl -sS -X POST "$BASE/agreements/$AG/approve" -H "authorization: Bearer $B" | head -c 400
echo
echo "--- payment record ---"
curl -sS "$BASE/payments/$AG" -H "authorization: Bearer $B" | head -c 400
echo
