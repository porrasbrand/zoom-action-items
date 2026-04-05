# Phase 17: Human Calibration — Validate AI Model Quality Against Human Judgment

## Context
We compared 4 AI models for session evaluation (claude-opus-4-6, gpt-5.4, gemini-2.0-flash, gemini-3.1-pro-preview) but the judge was another AI (gemini-2.5-pro). To eliminate AI bias, Manuel will manually score 10 meetings on the same 12-dimension rubric, then we measure which AI model most closely matches his human judgment.

## Architecture
- **No new files** — extends existing `index.html`, `routes.js`, `session-queries.js`
- **DB:** Human scores stored as `model_used = 'human-calibration'` in `session_evaluations` table
- **Bias prevention:** The scoring form shows ONLY transcript + summary + action items. NO AI scores visible until all 10 meetings are scored.

## The 10 Test Meetings
IDs: 70, 23, 63, 71, 102, 82, 2, 5, 26, 20 (all have evaluations from 4 AI models)

## Phase 17A: Build Calibration Scoring Form

### Backend (`src/lib/session-queries.js` + `src/api/routes.js`)

**3 new query functions:**
- `getCalibrationStatus(db)` — returns 10 meetings with scored/unscored status
- `saveCalibrationScores(db, meetingId, scores, notes)` — validates, computes tiers/composite, INSERT OR REPLACE with model_used='human-calibration'
- `getCalibrationComparison(db)` — computes MAE + Pearson correlation for each AI model vs human scores (only when all 10 scored)

**3 API endpoints (place BEFORE `:meetingId` catch-all):**
- `GET /api/session/calibration/status`
- `POST /api/session/calibration/:meetingId`
- `GET /api/session/calibration/comparison`

### Frontend (`public/index.html`)

**6th sub-nav button:** "Calibration" in `.session-subnav`

**Calibration List View:**
- 10 meeting cards with topic, client, date, duration
- Green border = scored, gray = unscored
- Progress bar: "X/10 scored"
- "View Comparison" button (disabled until 10/10)

**Scoring Form (when user clicks a meeting):**
- Meeting metadata (topic, client, date, duration)
- AI summary (from ai_extraction.summary) — this is NOT an AI score, just a factual summary
- Action items extracted
- Transcript excerpt (scrollable, ~5000 chars, "Show full" toggle)
- 12 dimension dropdowns grouped by tier:
  - **Tier 1 — Deal Breakers (40%):** client_sentiment, accountability, relationship_health
  - **Tier 2 — Core Competence (35%):** meeting_structure, value_delivery, action_discipline, proactive_leadership
  - **Tier 3 — Efficiency (25%):** time_utilization, redundancy, client_confusion, meeting_momentum, save_rate
- Each dropdown: options 1-4 with rubric hint text
- Optional notes textarea
- Submit button
- Pre-populates if already scored (allows re-scoring)

**Critical: NO AI scores visible in the form.** Only raw meeting content.

**Comparison View (unlocked after 10/10):**
1. **Summary Table:** Model | MAE | Correlation | Closest Dims | Furthest Dims — sorted by MAE, winner highlighted green
2. **Per-Meeting Heatmap:** Expandable rows, each shows 12-dimension grid with human + 4 models. Cells colored: green (exact match), yellow (off by 1), red (off by 2+)
3. **Per-Dimension Bars:** Which model has lowest MAE per dimension
4. **Verdict Card:** "Model X most closely matches human judgment" with stats

### Comparison Algorithm
- **MAE:** mean(|human - model|) across 10 meetings × 12 dimensions = 120 data points per model
- **Pearson r:** correlation between human scores vector (120) and model scores vector (120)
- **Per-dimension MAE:** 10 values per dimension per model
- **Winner:** lowest overall MAE (tie-break: higher correlation)

### Rubric Hints (one-line per dimension)
| Dimension | 4 (Excellent) | 1 (Failing) |
|-----------|--------------|-------------|
| client_sentiment | Engaged, trusting, enthusiastic | Frustrated, withdrawn |
| accountability | Past items acknowledged | Commitments ignored |
| relationship_health | Open sharing, trust | Surface-level, transactional |
| meeting_structure | Clear agenda + wrap-up | No structure, chaotic |
| value_delivery | Data, results, strategy | Only "what do you need?" |
| action_discipline | Specific owners + due dates | Vague "we'll look into it" |
| proactive_leadership | Brought ideas, forward-looking | Only responded to asks |
| time_utilization | High substance density | Tangents, dead air |
| redundancy | New ground, progress | Same topics rehashed |
| client_confusion | Clear communication | Jargon, needed clarification |
| meeting_momentum | Expanding scope | Stagnating, same maintenance |
| save_rate | Recovered from frustration | No recovery (N/A = score 3) |

## Files to Modify
| File | Changes |
|------|---------|
| `src/lib/session-queries.js` | +3 functions (~200 lines) |
| `src/api/routes.js` | +3 endpoints (~40 lines) |
| `public/index.html` | +Calibration sub-view: CSS, HTML, JS (~400 lines) |

## Smoke Tests
1. `GET /calibration/status` returns 10 meetings, scored_count = 0
2. `POST /calibration/70` with valid scores → success, composite computed
3. `GET /calibration/status` shows scored_count = 1, meeting 70 marked scored
4. `GET /calibration/comparison` returns `{ ready: false, scored: 1, remaining: 9 }`
5. Scoring form pre-populates when re-opening meeting 70
6. Dashboard renders Calibration sub-view with meeting list
