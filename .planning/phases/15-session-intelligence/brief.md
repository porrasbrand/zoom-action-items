# Session Intelligence — Subsystem Brief

## Problem
B3X runs ~30 client meetings per week. The zoom-action-items pipeline captures WHAT happened (action items, decisions, summaries) but has zero insight into HOW WELL the meetings are run. There's no way to detect:
- Client frustration or declining satisfaction
- Meetings with poor structure (no agenda, no recap, no wrap-up)
- Action items that slip across meetings without resolution
- Team members who need coaching
- Clients at churn risk

## Goal
Add a Session Intelligence module that evaluates meeting quality, scores sessions on a weighted rubric, tracks trends per client and team member, and produces actionable coaching output — not vanity metrics.

## Success Criteria
1. Every meeting gets an automated scorecard (4-point rubric, 3 weighted tiers)
2. SQL baseline metrics computed for all 99 existing meetings (backfill)
3. AI evaluation pass on transcripts produces sentiment, structure, and coaching insights
4. Dashboard tab showing per-meeting scores, client trends, team benchmarks
5. Weekly digest flags declining clients and highlights wins
6. Coaching output includes specific transcript quotes, not generic advice

## Data Available
- 99 meetings with full speaker-attributed transcripts
- 673 action items (owner, priority, category, transcript excerpts, confidence tier)
- 246 roadmap items (status, silent count, owner side)
- Decisions per meeting
- 20 clients with cadence, services, B3X lead assignment

## Framework Source
- Internal analysis + Gemini consultation (2026-04-04)
- Scoring: 4-point rubric (Excellent/Good/Needs Improvement/Failing)
- Weighting: Tier 1 (40%) Client Sentiment + Accountability | Tier 2 (35%) Structure + Value + Discipline | Tier 3 (25%) Efficiency
- Key additions from Gemini: Relationship Health, Meeting Momentum, Save Rate, Meeting Type Context, bias controls
