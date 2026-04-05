# Phase 15B-validate: Rubric Calibration & Consistency Tests

## Prior Work Summary
Phase 15A created `session_metrics` table with SQL-computed metrics for all 99 meetings. Phase 15B created `session_evaluations` table with AI-scored evaluations (12 dimensions, 4-point rubric, 3 weighted tiers) and ran a model comparison across 3-4 models. All 99 meetings should now have both metrics and evaluations.

**This phase validates** the evaluation quality before building pipeline/dashboard/alerts on top of it.

## Objective
1. Test scoring consistency (same meeting scored 3x → variance ≤0.5 per dimension)
2. Identify problematic dimensions (high variance or suspicious patterns)
3. Run bias checks
4. Generate a calibration report with recommendations
5. Determine if the rubric is ready for production or needs prompt revision

## Implementation

### Create `scripts/rubric-calibration.mjs`

```
Usage:
  node scripts/rubric-calibration.mjs
```

**The script runs 4 test suites automatically:**

#### Test 1: Scoring Consistency (5 meetings × 3 runs each = 15 evaluations)

Select 5 diverse meetings (reuse the selectTestMeetings function from Phase 15B comparison). For each meeting, run the evaluation 3 times with the SAME model (the winner from Phase 15B comparison). Compare scores across runs.

```javascript
// For each meeting, for each dimension:
// - Calculate variance across 3 runs
// - Flag dimensions where variance > 0.5
// - Calculate overall consistency rate
```

**Pass criteria:** ≤2 dimensions with variance >0.5 across all 5 meetings.

#### Test 2: Score Distribution Analysis

Analyze the full backfill (99 meetings):

```javascript
// For each dimension:
// - Mean, median, stddev
// - Distribution: how many 1s, 2s, 3s, 4s
// - Flag dimensions where >80% of scores are the same value (no discrimination)
// - Flag dimensions where mean < 1.5 or > 3.5 (ceiling/floor effect)
```

**Failure signal:** A dimension that scores 3 on 85%+ of meetings isn't discriminating — it should either be revised or dropped.

#### Test 3: Cross-Dimension Correlation

```javascript
// Check if all dimensions are just moving together (scoring inflation/deflation)
// If client_sentiment and accountability have correlation > 0.9 across all meetings,
// they might be redundant (model isn't distinguishing them)
```

#### Test 4: Bias Check

```javascript
// Compare average composite scores:
// - Dan-led meetings vs Phil-led meetings (check ai_extraction for attendees)
// - Long meetings (>45min) vs short meetings (<25min)
// - Meetings with many action items vs few
// - Internal meetings vs client meetings
// Report if any group has significantly different scores (>0.5 composite difference)
```

### Output: `data/rubric-calibration.md`

```markdown
# Rubric Calibration Report
Date: {date}
Model: {winning model from 15B}
Meetings analyzed: 99 (backfill) + 15 (consistency test)

## Test 1: Scoring Consistency
| Meeting | Dimension | Run 1 | Run 2 | Run 3 | Variance | Status |
|---------|-----------|-------|-------|-------|----------|--------|
...

Overall: X/60 dimension-tests within tolerance (≤0.5 variance)
**RESULT: PASS/FAIL**

## Test 2: Score Distribution
| Dimension | Mean | Median | StdDev | Mode | Mode% | Status |
|-----------|------|--------|--------|------|-------|--------|
...

Dimensions with poor discrimination (>80% same score): [list]
Dimensions with ceiling/floor effect: [list]
**RESULT: PASS/FAIL**

## Test 3: Correlation Analysis
| Dimension Pair | Correlation | Status |
|---------------|-------------|--------|
...

Potentially redundant pairs (r>0.9): [list]
**RESULT: PASS/FAIL (informational)**

## Test 4: Bias Check
| Comparison | Group A Avg | Group B Avg | Delta | Significant? |
|-----------|------------|------------|-------|-------------|
| Dan-led vs Phil-led | X.XX | X.XX | X.XX | Yes/No |
| Long vs Short | X.XX | X.XX | X.XX | Yes/No |
| High items vs Low items | X.XX | X.XX | X.XX | Yes/No |
| Internal vs Client | X.XX | X.XX | X.XX | Yes/No |

**RESULT: PASS/WARN**

## Overall Verdict
**PASS** — Rubric is ready for production
OR
**NEEDS_REVISION** — [specific issues and recommended changes]

## Recommendations
- [dimension-specific recommendations]
- [prompt adjustment suggestions if needed]
```

## Expected Files
- `scripts/rubric-calibration.mjs` — **NEW** (~300-350 lines)
- `data/rubric-calibration.md` — **GENERATED**

## Do NOT Touch
- `src/lib/session-evaluator.js` — Do not modify the prompt or scoring logic
- `src/lib/session-metrics.js` — Read-only access
- Any existing tables — read-only (the consistency test results go into session_evaluations with a model suffix like `model-consistency-run-2`)

## Acceptance Criteria
- [ ] Consistency test runs 5 meetings × 3 times each
- [ ] Score distribution analyzed for all 12 dimensions
- [ ] Cross-dimension correlation computed
- [ ] Bias check compares Dan vs Phil, long vs short, etc.
- [ ] Calibration report generated with clear PASS/FAIL verdicts
- [ ] Overall verdict documented

## Smoke Tests
```bash
cd ~/awsc-new/awesome/zoom-action-items

# Run calibration
node scripts/rubric-calibration.mjs

# Check report exists
test -f data/rubric-calibration.md && echo "Report exists"

# Check verdict
grep "Overall Verdict" data/rubric-calibration.md
grep "RESULT" data/rubric-calibration.md
```

## Completion Instructions
1. Implement the calibration script
2. Run it (takes ~3-5 min with rate limiting for consistency tests)
3. Review the report
4. If PASS: commit with `[session-intel-15B-validate]` and report results
5. If NEEDS_REVISION: describe the specific issues found and recommend prompt changes
6. In completion message, include the full calibration report
