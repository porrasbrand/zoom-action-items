# Phase 09: AI Evaluation Agent — End-to-End Quality Verification

## Context

Phases 08A (Client Roadmap Engine) and 08B (Meeting Prep Generator) have been implemented. This phase performs a comprehensive end-to-end evaluation of both systems using real client data to verify:
- Correctness of roadmap construction from historical meetings
- Accuracy of task taxonomy classification
- Quality of meeting prep documents
- Proper detection of stale items, status transitions, and owner_side classification

This is NOT a simple smoke test — it's a **deep quality evaluation** that validates the AI outputs are genuinely useful for Phil's meeting preparation.

## Objective

Run the full 08A + 08B pipeline on at least 2 real clients with meeting history in the database, evaluate the outputs, and produce a quality report with specific findings, scores, and improvement recommendations.

## Implementation Steps

### 1. Create evaluation script (`src/evaluate-pipeline.js`)

```javascript
// Usage: node src/evaluate-pipeline.js [--client echelon] [--all-clients]
//
// This script:
// 1. Identifies clients with 3+ meetings in the DB
// 2. Runs roadmap-build for each
// 3. Runs meeting-prep for each
// 4. Evaluates outputs using Gemini as judge
// 5. Produces quality report

import 'dotenv/config';
import Database from 'better-sqlite3';
import { generateMeetingPrep } from './lib/prep-generator.js';
```

### 2. Evaluation Criteria

The evaluation script should check these dimensions:

**A. Roadmap Quality (08A)**

| Check | How to Verify |
|-------|--------------|
| A1. Taxonomy compliance | Every roadmap_item has valid category + task_type from taxonomy |
| A2. No orphan items | Every item links to a real meeting_id that exists in meetings table |
| A3. Status transitions make sense | Items don't go from 'done' back to 'agreed' |
| A4. Staleness detection | Items not discussed in 2+ meetings have correct silent_count |
| A5. Owner classification | owner_side is always 'b3x' or 'client' (never null or other) |
| A6. Deduplication | No two items for same client have identical title (AI should normalize) |
| A7. Snapshot integrity | Snapshots exist for each processed meeting, item counts are consistent |
| A8. Category distribution | Items spread across multiple categories (not all 'website') |

**B. Meeting Prep Quality (08B)**

| Check | How to Verify |
|-------|--------------|
| B1. All 4 sections present | status_report, accountability, strategic_direction, suggested_agenda exist |
| B2. Completed items are real | Each completed item in status_report references a roadmap item marked 'done' |
| B3. Stale items surfaced | Items with silent_count >= 2 appear in accountability section |
| B4. Strategic suggestions grounded | Each recommendation references data (service gap, roadmap status, or meeting context) |
| B5. Agenda has time allocations | Every agenda item has minutes > 0 and total is reasonable (20-60 min) |
| B6. Owner attribution correct | B3X overdue lists only owner_side='b3x', client overdue lists only 'client' |
| B7. No hallucinated items | Every item referenced in prep exists in the roadmap DB |
| B8. Service gap awareness | At least one recommendation leverages services_available not in services_active |

**C. AI Quality (Gemini as Judge)**

For a subset of roadmap items and prep sections, send to Gemini for meta-evaluation:

```
You are evaluating the quality of an AI-generated client roadmap and meeting prep document.

MEETING TRANSCRIPT (ground truth):
{transcript}

ROADMAP ITEMS GENERATED:
{items}

MEETING PREP GENERATED:
{prep}

Score each dimension 1-5:
1. ACCURACY: Do the action items match what was actually discussed? (1=hallucinated, 5=precise)
2. COMPLETENESS: Are all action items from the transcript captured? (1=missing many, 5=comprehensive)
3. CLASSIFICATION: Are categories and task types correctly assigned? (1=wrong, 5=perfect)
4. OWNERSHIP: Is B3X vs client correctly identified? (1=wrong, 5=correct)
5. STRATEGIC VALUE: Are prep recommendations useful and grounded? (1=generic, 5=specific and actionable)
6. ACTIONABILITY: Can Phil walk into a meeting with this prep and lead effectively? (1=no, 5=absolutely)

Provide scores and brief justification for each.
Also list any specific errors or improvements.
```

### 3. Quality Report Output

The evaluation should produce `data/evaluation-report.md`:

```markdown
# Zoom Pipeline Evaluation Report
Date: {date}
Clients tested: {list}
Meetings analyzed: {count}

## Scores Summary
| Dimension | Client A | Client B | Average |
|-----------|----------|----------|---------|
| Accuracy | 4/5 | 3/5 | 3.5 |
| Completeness | 5/5 | 4/5 | 4.5 |
| Classification | 3/5 | 4/5 | 3.5 |
| Ownership | 5/5 | 5/5 | 5.0 |
| Strategic Value | 4/5 | 3/5 | 3.5 |
| Actionability | 4/5 | 3/5 | 3.5 |

## Detailed Findings

### Client A: {name}
- Meetings processed: N
- Roadmap items created: N
- Categories used: {list}
- Stale items detected: N
- Issues found: {list}

### Client B: {name}
...

## Roadmap Checks
- [x] A1. Taxonomy compliance: PASS
- [x] A2. No orphan items: PASS
- [ ] A3. Status transitions: FAIL — 2 items went done→agreed
...

## Prep Checks
- [x] B1. All sections present: PASS
...

## Improvement Recommendations
1. {specific issue and fix}
2. {specific issue and fix}

## Overall Verdict
PASS / NEEDS_REVISION (with specific revision items)
```

### 4. Automated fix recommendations

If the evaluation finds systematic issues, the script should output specific revision instructions:

```javascript
if (failedChecks.length > 0) {
  console.log('\n=== REVISION NEEDED ===');
  for (const check of failedChecks) {
    console.log(`FIX: ${check.id} - ${check.description}`);
    console.log(`  File: ${check.file}`);
    console.log(`  Issue: ${check.detail}`);
    console.log(`  Suggested fix: ${check.fix}`);
  }
}
```

## Files to Create

1. `src/evaluate-pipeline.js` — Main evaluation script
2. `data/evaluation-report.md` — Output report (generated, not committed)

## Files to Modify

None — this phase is read-only evaluation.

## Do NOT Touch

Everything — this is a verification-only phase. No code changes to 08A/08B.

## Acceptance Criteria

- [ ] Evaluation runs on at least 2 clients with 3+ meetings each
- [ ] All 8 roadmap checks (A1-A8) are tested and reported
- [ ] All 8 prep checks (B1-B8) are tested and reported
- [ ] Gemini meta-evaluation scores all 6 dimensions for each client
- [ ] Quality report saved to data/evaluation-report.md
- [ ] If any check fails, specific revision instructions are provided
- [ ] Overall verdict is PASS or NEEDS_REVISION with actionable items

## Smoke Tests

```bash
# Run evaluation
cd ~/awsc-new/awesome/zoom-action-items
node src/evaluate-pipeline.js --all-clients

# Check report exists
cat data/evaluation-report.md | head -30

# Verify at least 2 clients evaluated
grep "### Client" data/evaluation-report.md | wc -l
# Expected: >= 2

# Check overall verdict
grep "Overall Verdict" data/evaluation-report.md
```

## Completion Instructions

1. Run full evaluation
2. If verdict is PASS: commit with prefix `[zoom-pipeline-09]`
3. If verdict is NEEDS_REVISION: document specific issues in result.md, do NOT commit as PASS
4. Push result.md regardless of verdict
