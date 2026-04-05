# Phase 16B: Run AI Audit Agent, Fix Bugs, Re-verify

## Objective
Run the Session Intelligence audit agent built in Phase 16A, analyze its report, fix all discovered bugs and UX issues, then re-run to verify. Also run the existing dashboard-audit.js as a regression check.

## Prior Work Summary
- **Phase 16A** created `tests/session-intelligence-audit.js` — AI-powered Playwright audit agent
- **Phase 16A** fixed the missing `/session/team` aggregate endpoint
- The agent tests 4 layers: Functional (45 checks), Data Validation (8 checks), AI UX Evaluation (8 screenshots via Gemini), Report Generation
- **Existing test:** `tests/dashboard-audit.js` (Phase 11) — regression baseline for Meetings/Roadmap/Prep tabs

## Steps

### Step 1: Run the audit agent
```bash
cd ~/awsc-new/awesome/zoom-action-items
node tests/session-intelligence-audit.js
```

### Step 2: Read and analyze the report
```bash
cat data/session-audit-report.md
```

Categorize findings:
- **HIGH severity bugs** → fix immediately
- **MEDIUM severity bugs** → fix in this phase
- **LOW severity bugs** → document, can defer
- **UX issues scoring below 3/5** → fix if straightforward CSS/HTML change
- **UX issues scoring 3-4/5** → note but don't fix unless trivial

### Step 3: Fix discovered bugs
Apply targeted fixes to:
- `public/index.html` — frontend rendering bugs, CSS issues, broken interactions
- `src/api/routes.js` — API response issues
- `src/lib/session-queries.js` — data structure issues

Rules:
- Each fix should be minimal and targeted
- Do NOT refactor working code
- Do NOT touch code outside the Session Intelligence section unless it's a regression

### Step 4: Re-run the audit agent
```bash
node tests/session-intelligence-audit.js
```

Verify:
- All previously failing checks now pass
- No new failures introduced
- UX scores improved for fixed items

### Step 5: Regression check
```bash
node tests/dashboard-audit.js
```
Verify the existing Meetings/Roadmap/Prep tabs still pass all 45 checks.

### Step 6: Commit
```bash
git add -A
git commit -m "[phase-16] AI-powered Session Intelligence audit agent + bug fixes

- Created tests/session-intelligence-audit.js (AI + Playwright audit)
- Fixed missing /session/team aggregate endpoint
- Fixed N bugs discovered by the audit agent
- UX average: X.X/5.0
- Functional: X/Y passed
- Regression: dashboard-audit.js still passes"
```

## Smoke Tests
```bash
# 1. Audit report exists and has verdict
grep "Verdict" data/session-audit-report.md

# 2. No HIGH severity bugs remaining
grep -c "HIGH" data/session-audit-report.md
# Expected: 0 or only in "fixed" context

# 3. Screenshots captured
ls data/session-audit-screenshots/*.png | wc -l
# Expected: 8+

# 4. Regression passes
node tests/dashboard-audit.js 2>&1 | tail -5
# Expected: all pass

# 5. Dashboard still running
curl -s http://localhost:3875/zoom/api/health
# Expected: {"status":"ok"}
```

## Files to Modify
- `public/index.html` — bug fixes discovered by agent
- `src/api/routes.js` — any API fixes needed
- `src/lib/session-queries.js` — any data fixes needed
- May also touch CSS within index.html for UX improvements

## Success Criteria
- 0 HIGH severity bugs remaining
- 0 MEDIUM severity bugs remaining
- All functional checks PASS (or PASS WITH WARNINGS for known limitations)
- UX average >= 3.5/5.0
- Regression: dashboard-audit.js passes
- Clean commit with all changes
