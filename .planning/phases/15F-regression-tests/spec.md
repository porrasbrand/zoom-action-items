# Phase 15F: Regression & End-to-End Tests

## Prior Work Summary
Phases 15A-15E have built the complete Session Intelligence subsystem: SQL metrics (15A), AI evaluations with model comparison (15B), rubric calibration (15B-validate), pipeline integration + baselines (15C), API endpoints (15D), and dashboard UI (15E).

**This phase:** Comprehensive testing to ensure everything works correctly and the existing pipeline hasn't been broken.

## Objective
1. Regression tests — existing pipeline still works
2. Session-specific tests — all new components verified
3. Edge case testing
4. Bias validation
5. Generate comprehensive test report

## Implementation

### Create `scripts/session-test-suite.mjs`

```
Usage:
  node scripts/session-test-suite.mjs              # Run all tests
  node scripts/session-test-suite.mjs --suite regression  # Run specific suite
  node scripts/session-test-suite.mjs --suite session
  node scripts/session-test-suite.mjs --suite edge
  node scripts/session-test-suite.mjs --suite bias
  node scripts/session-test-suite.mjs --suite api
  node scripts/session-test-suite.mjs --suite dashboard
```

#### Suite 1: Regression Tests (R1-R5)

**R1. Existing pipeline evaluation**
Run `node src/evaluate-pipeline.js --client prosper-group` and verify scores haven't degraded below 3.5/5 average.

**R2. Action item extraction integrity**
Verify `action_items` table count hasn't changed (should still be 673 or higher).

**R3. Roadmap items intact**
Verify `roadmap_items` count (246+), no orphan items, status transitions valid.

**R4. Dashboard tab regression**
If Playwright is available: run existing `tests/dashboard-audit.js` and verify 45+ tests pass.
If Playwright not available: curl check that Meetings, Roadmap, Meeting Prep tabs still render.

**R5. API endpoint regression**
Verify all existing endpoints still work:
- GET /api/meetings
- GET /api/meetings/:id
- GET /api/roadmap/:clientId
- GET /api/prep/:clientId

#### Suite 2: Session Intelligence Tests (S1-S8)

**S1. Metrics completeness**
Every meeting in `meetings` has a corresponding row in `session_metrics`. Count match.

**S2. Evaluation completeness**
Every meeting has a row in `session_evaluations`. All 12 dimension scores are 1-4.

**S3. Composite score accuracy**
Recalculate composite for 10 random meetings from raw dimension scores. Verify matches stored value (tolerance: 0.01).

**S4. Baselines computed**
`session_baselines` has agency scope for composite + all 12 dimensions. P25 < P50 < P75.

**S5. Coaching quality**
For 5 random meetings: wins array has 2 entries, improvements has 2 entries, each has transcript_quote (non-empty string).

**S6. Pipeline integration**
Verify poll.js imports session-metrics and session-evaluator (grep for import statements).

**S7. API endpoints return valid data**
All 6 session endpoints return 200 with expected JSON structure.

**S8. Backfill integrity**
Verify no meetings are missing from session_metrics OR session_evaluations. Report any gaps.

#### Suite 3: Edge Case Tests (E1-E4)

**E1. Short meeting**
Find shortest meeting (duration < 10 min). Verify it has valid scores (not all zeros or all 3s).

**E2. Long meeting**
Find longest meeting. Verify scores exist and aren't skewed by transcript length.

**E3. No action items**
Find meetings with 0 action items. Verify action_density = 0 and action_discipline score is reasonable.

**E4. Internal meeting**
Find B3X internal meetings. Verify client_sentiment, relationship_health, save_rate scored as neutral (3).

#### Suite 4: Bias Check (B1-B4)

**B1. Team member comparison**
Detect B3X lead for each meeting (from ai_extraction attendees or dominant_speaker). Compare avg composite: Dan vs Phil vs Joe. Report delta. Flag if delta > 0.8 without controlling for clients.

**B2. Duration bias**
Split meetings into short (<25 min) and long (>45 min). Compare avg composite. Flag if delta > 0.5.

**B3. Action count bias**
Split meetings into few items (<3) and many items (>8). Compare avg composite. Flag if high-item meetings always score higher (would indicate quantity bias).

**B4. Meeting type bias**
Compare avg composite for regular vs internal meetings. Report difference.

#### Suite 5: API Contract Tests (A1-A6)

For each session API endpoint, verify:
- Returns 200
- Returns valid JSON
- Contains expected top-level fields
- Handles missing/invalid IDs gracefully (returns 404, not 500)

#### Suite 6: Dashboard Tests (D1-D3)

**D1. Tab exists**
Curl the dashboard HTML. Verify "Session Intelligence" text appears. Verify `data-tab="session"` exists.

**D2. JavaScript syntax**
Extract inline script blocks. Verify key functions exist: `switchSessionView`, `loadSessionOverview`, `renderScorecard`.

**D3. Playwright (if available)**
Navigate to Session Intelligence tab. Verify sub-views load. Take screenshots.

### Output: `data/session-test-report.md`

```markdown
# Session Intelligence — Test Report
Date: {date}
Total tests: {N}
Passed: {N}
Failed: {N}
Warnings: {N}

## Suite Results

### Regression (R1-R5)
- ✅ R1: Pipeline evaluation — avg score {X.X}/5 (threshold: 3.5)
- ✅ R2: Action items intact — 673
...

### Session (S1-S8)
...

### Edge Cases (E1-E4)
...

### Bias Check (B1-B4)
...

### API Contracts (A1-A6)
...

### Dashboard (D1-D3)
...

## Bias Summary
| Comparison | Group A | Group B | Delta | Concern? |
|-----------|---------|---------|-------|----------|
...

## Issues Found
[list any failures with details]

## Verdict
**PASS** / **PASS WITH WARNINGS** / **FAIL**
```

## Expected Files
- `scripts/session-test-suite.mjs` — **NEW** (~500-600 lines)
- `data/session-test-report.md` — **GENERATED**

## Do NOT Touch
- Any source files — this is a read-only testing phase
- `data/zoom-action-items.db` — read-only access (except for Playwright session creation if needed)

## Smoke Tests
```bash
cd ~/awsc-new/awesome/zoom-action-items

# Run full suite
node scripts/session-test-suite.mjs

# Check report
test -f data/session-test-report.md && echo "Report exists"
grep "Verdict" data/session-test-report.md
grep "FAIL" data/session-test-report.md || echo "No failures"
```

## Completion Instructions
1. Create the test suite
2. Run all tests
3. Fix any issues found (minor only — major issues should be reported for rollback)
4. Re-run tests after fixes
5. Commit with `[session-intel-15F]`
6. Report: test counts, pass/fail, any bias findings, verdict
