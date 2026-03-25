#!/bin/bash
# Full validation pipeline integration test
# Phase 04: Historical Tracking + Accuracy Dashboard

BASE="http://localhost:3875/zoom/api"
PASS=0
FAIL=0

echo "=== Validation Pipeline Integration Test ==="
echo ""

# Test 1: Keyword scanner (validate endpoint)
echo -n "1. Keyword scan (validate)... "
RESULT=$(curl -sf -X POST $BASE/meetings/2/validate 2>/dev/null)
if echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'signal' in d and 'keywordCount' in d" 2>/dev/null; then
  echo "PASS"
  ((PASS++))
else
  echo "FAIL"
  ((FAIL++))
fi

# Test 2: Adversarial verification
echo -n "2. Adversarial verify... "
RESULT=$(curl -sf -X POST $BASE/meetings/6/verify 2>/dev/null)
if echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'completeness_assessment' in d" 2>/dev/null; then
  echo "PASS"
  ((PASS++))
else
  echo "FAIL - $(echo $RESULT | head -c 100)"
  ((FAIL++))
fi

# Test 3: Coverage analysis
echo -n "3. Coverage map... "
RESULT=$(curl -sf $BASE/meetings/2/coverage 2>/dev/null)
if echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'stats' in d and 'sections' in d" 2>/dev/null; then
  echo "PASS"
  ((PASS++))
else
  echo "FAIL"
  ((FAIL++))
fi

# Test 4: Validation stats
echo -n "4. Validation stats... "
RESULT=$(curl -sf $BASE/validation/stats 2>/dev/null)
if echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'accuracy' in d and 'confidence_distribution' in d" 2>/dev/null; then
  echo "PASS"
  ((PASS++))
else
  echo "FAIL"
  ((FAIL++))
fi

# Test 5: Spot check
echo -n "5. Spot check endpoint... "
RESULT=$(curl -sf $BASE/validation/spot-check 2>/dev/null)
if echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'meetings' in d" 2>/dev/null; then
  echo "PASS"
  ((PASS++))
else
  echo "FAIL"
  ((FAIL++))
fi

# Test 6: Accept suggested item (need to find a suggested item first)
echo -n "6. Accept suggested item... "
# Find a suggested item
SUGGESTED=$(curl -sf "$BASE/meetings?limit=50" 2>/dev/null | python3 -c "
import sys,json
meetings = json.load(sys.stdin).get('meetings', [])
for m in meetings:
    if m.get('suggested_count', 0) > 0:
        print(m['id'])
        break
" 2>/dev/null)

if [ -n "$SUGGESTED" ]; then
  # Get action items for this meeting
  ITEM_ID=$(curl -sf "$BASE/meetings/$SUGGESTED" 2>/dev/null | python3 -c "
import sys,json
d = json.load(sys.stdin)
items = d.get('action_items', [])
for i in items:
    if i.get('status') == 'suggested':
        print(i['id'])
        break
" 2>/dev/null)

  if [ -n "$ITEM_ID" ]; then
    RESULT=$(curl -sf -X POST "$BASE/action-items/$ITEM_ID/accept" 2>/dev/null)
    if echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('status') == 'open'" 2>/dev/null; then
      echo "PASS (item $ITEM_ID)"
      ((PASS++))
    else
      echo "FAIL"
      ((FAIL++))
    fi
  else
    echo "SKIP (no suggested items found)"
  fi
else
  echo "SKIP (no meetings with suggestions)"
fi

# Test 7: Dismiss suggested item
echo -n "7. Dismiss suggested item... "
# Find another suggested item
SUGGESTED=$(curl -sf "$BASE/meetings?limit=50" 2>/dev/null | python3 -c "
import sys,json
meetings = json.load(sys.stdin).get('meetings', [])
for m in meetings:
    if m.get('suggested_count', 0) > 0:
        print(m['id'])
        break
" 2>/dev/null)

if [ -n "$SUGGESTED" ]; then
  ITEM_ID=$(curl -sf "$BASE/meetings/$SUGGESTED" 2>/dev/null | python3 -c "
import sys,json
d = json.load(sys.stdin)
items = d.get('action_items', [])
for i in items:
    if i.get('status') == 'suggested':
        print(i['id'])
        break
" 2>/dev/null)

  if [ -n "$ITEM_ID" ]; then
    RESULT=$(curl -sf -X POST "$BASE/action-items/$ITEM_ID/dismiss" 2>/dev/null)
    if echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('status') == 'dismissed'" 2>/dev/null; then
      echo "PASS (item $ITEM_ID)"
      ((PASS++))
    else
      echo "FAIL"
      ((FAIL++))
    fi
  else
    echo "SKIP (no suggested items found)"
  fi
else
  echo "SKIP (no meetings with suggestions)"
fi

# Test 8: Add manual item
echo -n "8. Add manual item... "
RESULT=$(curl -sf -X POST "$BASE/meetings/2/action-items" \
  -H "Content-Type: application/json" \
  -d '{"title":"Test manual item","owner_name":"Phil","source":"manual_added","priority":"medium"}' 2>/dev/null)
if echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('source') == 'manual_added'" 2>/dev/null; then
  echo "PASS"
  ((PASS++))
  # Clean up test item
  ITEM_ID=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
  if [ -n "$ITEM_ID" ]; then
    curl -sf -X DELETE "$BASE/action-items/$ITEM_ID" 2>/dev/null
  fi
else
  echo "FAIL"
  ((FAIL++))
fi

# Test 9: Confidence signals are correct
echo -n "9. Confidence signals... "
RESULT=$(curl -sf "$BASE/meetings?limit=10" 2>/dev/null)
if echo "$RESULT" | python3 -c "
import sys,json
d = json.load(sys.stdin)
meetings = d.get('meetings', [])
valid_signals = ['green', 'yellow', 'red', 'pending', None]
for m in meetings:
    sig = m.get('confidence_signal')
    if sig not in valid_signals:
        sys.exit(1)
sys.exit(0)
" 2>/dev/null; then
  echo "PASS"
  ((PASS++))
else
  echo "FAIL"
  ((FAIL++))
fi

# Test 10: Dashboard loads
echo -n "10. Dashboard loads... "
RESULT=$(curl -sf "http://localhost:3875/zoom/" 2>/dev/null)
MATCHES=$(echo "$RESULT" | grep -c 'validation-stats\|hallucination\|miss-rate\|spot-check')
if [ "$MATCHES" -ge 3 ]; then
  echo "PASS ($MATCHES validation markers found)"
  ((PASS++))
else
  echo "FAIL ($MATCHES markers)"
  ((FAIL++))
fi

echo ""
echo "=== Results ==="
echo "Passed: $PASS"
echo "Failed: $FAIL"
echo ""

if [ $FAIL -eq 0 ]; then
  echo "ALL TESTS PASSED"
  exit 0
else
  echo "SOME TESTS FAILED"
  exit 1
fi
