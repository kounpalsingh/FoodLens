#!/bin/sh
# Times each free image-reading model on the test label. Usage: sh scripts/bench.sh
cd "$(dirname "$0")/.."
K=$(grep '^LLM_API_KEY=' .env.local | cut -d= -f2- | tr -d '"[:space:]')
IMG=$(base64 -i scripts/test-label.jpg | tr -d '\n')
PROMPT='Copy the ingredient list from this food label exactly as printed. Return ONLY JSON: {"ingredients_original": "..."}'
for M in "$@"; do
  S=$(echo "$M" | tr '/:' '__')
  printf '{"model":"%s","temperature":0,"max_tokens":1200,"messages":[{"role":"user","content":[{"type":"text","text":%s},{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,%s"}}]}]}' "$M" "$(printf '%s' "$PROMPT" | /opt/homebrew/bin/node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))')" "$IMG" > /tmp/bench-$S.json
  (curl -s -m 70 -w '\n[%{http_code} %{time_total}s]' https://openrouter.ai/api/v1/chat/completions -H "Authorization: Bearer $K" -H 'content-type: application/json' --data-binary @/tmp/bench-$S.json > /tmp/bench-$S.out 2>&1 &)
done
