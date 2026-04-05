# Phase 15B: AI Session Evaluator + Model Comparison

## Prior Work Summary
Phase 15A added a `session_metrics` table with SQL-computed metrics for all 99 meetings: action density, due date rates, owner assignment, speaker ratios (B3X vs client), stale items, meeting type classification. These metrics are available via `src/lib/session-metrics.js` and API endpoint `/api/session/:meetingId/metrics`.

The existing `src/evaluate-pipeline.js` (Phase 09) evaluates roadmap/prep quality using Gemini-as-judge. Phase 12 built a model comparison framework in `scripts/model-comparison.mjs`. This phase follows both patterns.

**This phase adds:** An AI evaluation pass that scores meeting QUALITY (not content extraction) using a weighted 4-point rubric, plus a multi-model comparison to pick the best model for this task.

## Objective
1. Build a session evaluator that scores meetings on 12 dimensions using a 4-point rubric
2. Run a 4-model comparison on 5 diverse meetings to pick the best model
3. Store evaluations in a new `session_evaluations` table

## Scoring Framework

### 4-Point Rubric
- **4 = Excellent** — Top quartile, exemplary behavior
- **3 = Good** — Meets professional expectations
- **2 = Needs Improvement** — Specific issues identified
- **1 = Failing** — Immediate coaching needed

### 12 Dimensions in 3 Weighted Tiers

**Tier 1 — Deal Breakers (40% weight):**
1. `client_sentiment` — Frustration vs satisfaction signals, engagement level
2. `accountability` — Follow-through on past commitments, stale item acknowledgment
3. `relationship_health` — Trust signals, vulnerability, client openly sharing problems

**Tier 2 — Core Competence (35% weight):**
4. `meeting_structure` — Agenda, recap of prior items, clear wrap-up with next steps
5. `value_delivery` — Presenting results/data/progress vs just asking "what do you need?"
6. `action_discipline` — Specific owners, due dates, clear next steps (not vague commitments)
7. `proactive_leadership` — B3X bringing ideas vs only responding to client asks

**Tier 3 — Efficiency (25% weight):**
8. `time_utilization` — Substance density, off-topic ratio, productive use of time
9. `redundancy` — Same topics rehashed without resolution, repeated action items
10. `client_confusion` — Jargon without context, client needing clarification
11. `meeting_momentum` — Relationship progressing (new initiatives) vs stagnating (same topics)
12. `save_rate` — When frustration occurs, does B3X recover in-meeting?

### Composite Score Calculation
```
tier1_avg = avg(client_sentiment, accountability, relationship_health)
tier2_avg = avg(meeting_structure, value_delivery, action_discipline, proactive_leadership)
tier3_avg = avg(time_utilization, redundancy, client_confusion, meeting_momentum, save_rate)
composite = (tier1_avg * 0.40) + (tier2_avg * 0.35) + (tier3_avg * 0.25)
```

## New Database Table

```sql
CREATE TABLE IF NOT EXISTS session_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id),
  model_used TEXT NOT NULL,
  
  -- Tier 1 scores (1-4)
  client_sentiment INTEGER,
  accountability INTEGER,
  relationship_health INTEGER,
  
  -- Tier 2 scores (1-4)
  meeting_structure INTEGER,
  value_delivery INTEGER,
  action_discipline INTEGER,
  proactive_leadership INTEGER,
  
  -- Tier 3 scores (1-4)
  time_utilization INTEGER,
  redundancy INTEGER,
  client_confusion INTEGER,
  meeting_momentum INTEGER,
  save_rate INTEGER,
  
  -- Composite
  tier1_avg REAL,
  tier2_avg REAL,
  tier3_avg REAL,
  composite_score REAL,
  
  -- Coaching output
  meeting_type TEXT,                  -- regular, internal, kickoff, vip-session, escalation, renewal
  wins TEXT,                          -- JSON array of top 2 things done well, with transcript quotes
  improvements TEXT,                  -- JSON array of top 2 improvement areas, with transcript quotes
  coaching_notes TEXT,                -- 2-3 sentence coaching summary
  frustration_moments TEXT,           -- JSON array of detected frustration moments with quotes
  
  -- Performance data
  tokens_in INTEGER,
  tokens_out INTEGER,
  latency_ms INTEGER,
  
  -- Timestamps
  computed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  UNIQUE(meeting_id, model_used)
);
```

## Implementation

### Create `src/lib/session-evaluator.js`

The core evaluation engine. Main export: `evaluateMeeting(meetingId, options)`.

**Gemini Prompt Design (CRITICAL — this is the heart of the system):**

```javascript
function buildEvaluationPrompt(meeting, metrics, aiExtraction, transcript) {
  return `You are an expert meeting quality analyst evaluating an agency-client meeting.

CONTEXT:
- Agency: Breakthrough 3x (B3X), a digital marketing agency
- B3X Team Members: Dan Kuschell (CEO/founder), Philip Mutrie (account manager), Joe Boland (media buyer), Richard Bond (operations)
- Meeting: ${meeting.topic}
- Client: ${meeting.client_name}
- Date: ${meeting.start_time}
- Duration: ${meeting.duration_minutes} minutes

QUANTITATIVE METRICS (pre-computed):
- Action items: ${metrics.action_item_count} (${metrics.action_density?.toFixed(2)} per minute)
- Due date assignment rate: ${(metrics.due_date_rate * 100).toFixed(0)}%
- Owner assignment rate: ${(metrics.owner_assignment_rate * 100).toFixed(0)}%
- Decisions made: ${metrics.decision_count}
- B3X speaking ratio: ${metrics.speaker_ratio_b3x?.toFixed(0)}% | Client: ${metrics.speaker_ratio_client?.toFixed(0)}%
- Dominant speaker: ${metrics.dominant_speaker} (${metrics.dominant_speaker_pct?.toFixed(0)}%)
- B3X stale items (promised but silent 3+ meetings): ${metrics.b3x_stale_items}
- Client stale items: ${metrics.client_stale_items}

AI-EXTRACTED SUMMARY:
${aiExtraction?.summary || 'No summary available'}

ACTION ITEMS EXTRACTED:
${JSON.stringify(aiExtraction?.action_items?.map(ai => ({ title: ai.title, owner: ai.owner, priority: ai.priority, has_due_date: !!ai.due_date })) || [], null, 2)}

DECISIONS MADE:
${JSON.stringify(aiExtraction?.decisions || [], null, 2)}

FULL TRANSCRIPT:
${transcript}

---

EVALUATE this meeting on 12 dimensions using a 4-point rubric:
4 = Excellent (exemplary), 3 = Good (meets expectations), 2 = Needs Improvement (issues found), 1 = Failing (coaching needed)

DIMENSIONS:

**Tier 1 — Deal Breakers (most important):**
1. client_sentiment: Is the client engaged, satisfied, and trusting? Look for: enthusiasm, voluntary disclosure, future commitment (high) vs complaints, withdrawal, monosyllabic responses, frustration (low). Key markers: "I already told you" = frustration, "Could you also..." = engagement, "My boss is asking..." = escalation signal.

2. accountability: Did B3X acknowledge past commitments? Were previous action items referenced? Are stale items (${metrics.b3x_stale_items} B3X-owned silent 3+ meetings) addressed or ignored?

3. relationship_health: Trust signals — client sharing problems openly ("I'm worried about..."), delegating decisions ("You decide"), personal disclosure. Vs surface-level, transactional interactions.

**Tier 2 — Core Competence:**
4. meeting_structure: Was there an agenda or at least a clear opening? Did B3X recap prior action items? Was there a clear wrap-up with confirmed next steps? Or was it reactive/chaotic?

5. value_delivery: Did B3X present results, data, or progress? Strategic recommendations? Or just asked "what do you need?" without bringing anything to the table?

6. action_discipline: Were action items specific (not vague)? Owners assigned? Due dates discussed? Or just "we'll look into it" with no accountability structure?

7. proactive_leadership: Did B3X bring ideas, suggestions, opportunities? Or only responded to client questions/requests? Forward-looking ("next quarter we should...") vs firefighting only?

**Tier 3 — Efficiency:**
8. time_utilization: Was the meeting time used productively? High substance density? Or lots of dead air, tangents, circular discussions?

9. redundancy: Were topics rehashed from previous meetings without progress? Same action items re-assigned? "We already covered this" moments?

10. client_confusion: Did B3X use jargon without explanation (CTR, ROAS, CPC, CPA)? Did the client need to ask for clarification? "Wait, what?" moments?

11. meeting_momentum: Is the client relationship progressing — new initiatives, expanding scope, strategic discussions? Or stagnating — same maintenance topics every meeting?

12. save_rate: When the client expressed frustration or concern, did B3X recover well? Pattern: complaint → B3X acknowledgment → resolution → "OK that makes sense". Score 3 if no frustration occurred (neutral).

RETURN VALID JSON:
{
  "scores": {
    "client_sentiment": N,
    "accountability": N,
    "relationship_health": N,
    "meeting_structure": N,
    "value_delivery": N,
    "action_discipline": N,
    "proactive_leadership": N,
    "time_utilization": N,
    "redundancy": N,
    "client_confusion": N,
    "meeting_momentum": N,
    "save_rate": N
  },
  "meeting_type": "regular|internal|kickoff|vip-session|escalation|renewal",
  "wins": [
    { "description": "What B3X did well", "transcript_quote": "Exact quote from transcript showing this", "dimension": "which dimension this relates to" },
    { "description": "Second win", "transcript_quote": "Exact quote", "dimension": "dimension" }
  ],
  "improvements": [
    { "description": "What could be improved", "transcript_quote": "Quote showing the issue or missed opportunity", "dimension": "dimension", "suggestion": "Specific coaching suggestion" },
    { "description": "Second improvement", "transcript_quote": "Quote", "dimension": "dimension", "suggestion": "Suggestion" }
  ],
  "frustration_moments": [
    { "speaker": "Client name", "quote": "Exact frustrated quote", "context": "What triggered it", "recovered": true|false }
  ],
  "coaching_notes": "2-3 sentence overall assessment and key coaching points for the B3X team member leading this meeting"
}

RULES:
- Score each dimension independently based on transcript evidence
- Wins and improvements MUST include verbatim transcript quotes (copy exact words)
- If a dimension can't be assessed (e.g., save_rate when no frustration occurred), score 3 (neutral)
- For internal B3X meetings (no external client), score client_sentiment, relationship_health, and save_rate as 3 (neutral)
- Be specific in coaching_notes — name the B3X team member and reference specific moments
- frustration_moments array can be empty if none detected`;
}
```

**Key functions:**

#### `evaluateMeeting(meetingId, options = {})`
```javascript
// options: { model: 'gemini-3-flash-preview', skipMetrics: false }
// 1. Load meeting from DB (topic, client_name, start_time, duration_minutes, transcript_raw, ai_extraction)
// 2. Load session_metrics for this meeting (from Phase 15A)
// 3. Parse ai_extraction JSON
// 4. Build evaluation prompt
// 5. Call Gemini with specified model
// 6. Parse response JSON
// 7. Calculate tier averages and composite score
// 8. INSERT INTO session_evaluations
// 9. Return the full evaluation object
```

#### `evaluateWithModel(meetingId, modelId)`
Same as evaluateMeeting but allows specifying any model. Used by comparison script.

### Create `src/session-evaluate.js` (CLI)

```
Usage:
  node src/session-evaluate.js --meeting 42                           # Evaluate single meeting (default model)
  node src/session-evaluate.js --meeting 42 --model gemini-3-pro-preview  # Use specific model
  node src/session-evaluate.js --backfill                             # Evaluate all 99 meetings
  node src/session-evaluate.js --backfill --model gemini-2.5-flash-preview  # Backfill with specific model
```

For backfill, add 2-second delays between API calls (rate limiting).

### Create `scripts/session-eval-comparison.mjs` (Model Comparison)

Following the Phase 12 `model-comparison.mjs` pattern exactly:

**Models to compare:**
```javascript
const MODELS = [
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (current pipeline model)' },
  { id: 'gemini-2.5-flash-preview-05-20', label: 'Gemini 2.5 Flash' },
  { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro (highest quality)' },
];

const JUDGE_MODEL = 'gemini-2.5-pro-preview-05-14';
```

**Note on OpenAI:** Only include GPT-4o if OPENAI_API_KEY is available in the environment. Check with `process.env.OPENAI_API_KEY`. If available, add `{ id: 'gpt-4o', label: 'GPT-4o', provider: 'openai' }` to MODELS and use the OpenAI SDK to call it. If not available, skip it and note in the report.

**Test meetings — select 5 diverse meetings:**
```javascript
// Select diverse meetings programmatically:
// 1. Shortest meeting (likely quick check-in)
// 2. Longest meeting (deep strategic session)
// 3. Meeting with most action items (productive)
// 4. Meeting with fewest action items and >15min duration (possibly unproductive)
// 5. An internal B3X meeting (different dynamics)

function selectTestMeetings(db) {
  const shortest = db.prepare('SELECT id FROM meetings WHERE duration_minutes > 5 ORDER BY duration_minutes ASC LIMIT 1').get();
  const longest = db.prepare('SELECT id FROM meetings ORDER BY duration_minutes DESC LIMIT 1').get();
  const mostItems = db.prepare('SELECT meeting_id as id FROM action_items GROUP BY meeting_id ORDER BY COUNT(*) DESC LIMIT 1').get();
  const fewestItems = db.prepare(`
    SELECT m.id FROM meetings m 
    LEFT JOIN action_items ai ON ai.meeting_id = m.id 
    WHERE m.duration_minutes > 15 
    GROUP BY m.id 
    ORDER BY COUNT(ai.id) ASC LIMIT 1
  `).get();
  const internal = db.prepare("SELECT id FROM meetings WHERE client_name LIKE '%B3X%' OR client_name LIKE '%Internal%' LIMIT 1").get();
  
  return [shortest, longest, mostItems, fewestItems, internal]
    .filter(Boolean)
    .map(m => m.id)
    .filter((id, i, arr) => arr.indexOf(id) === i); // dedupe
}
```

**Comparison flow:**
1. Select 5 test meetings
2. For each meeting × each model: run evaluation, store results
3. Run judge evaluation comparing all models for each meeting
4. Aggregate scores and produce report

**Judge prompt:**
```javascript
function buildJudgePrompt(meetingContext, evaluations) {
  return `You are judging the quality of AI-generated meeting evaluations. 
Multiple AI models evaluated the same meeting. Judge which model produced the most accurate, insightful, and actionable evaluation.

MEETING CONTEXT:
${meetingContext}

${evaluations.map((e, i) => `
MODEL ${String.fromCharCode(65 + i)} (${e.model}):
Scores: ${JSON.stringify(e.scores)}
Wins: ${JSON.stringify(e.wins)}
Improvements: ${JSON.stringify(e.improvements)}
Coaching notes: ${e.coaching_notes}
`).join('\n')}

EVALUATE each model on:
1. SCORE_ACCURACY (1-5): Do the scores match what the transcript actually shows?
2. EVIDENCE_QUALITY (1-5): Are transcript quotes accurate and relevant?
3. COACHING_VALUE (1-5): Are the coaching notes specific and actionable?
4. BIAS_DETECTION (1-5): Does the model avoid common biases (action quantity≠quality, penalizing relationship-building)?
5. NUANCE (1-5): Does the model pick up on subtle signals (frustration, trust, momentum)?

Return JSON:
{
  "model_scores": {
    "${evaluations.map(e => e.model).join('": {...}, "')}": {
      "score_accuracy": N,
      "evidence_quality": N,
      "coaching_value": N,
      "bias_detection": N,
      "nuance": N,
      "avg": N.N
    }
  },
  "winner": "model_id",
  "reasoning": "Why this model is best for session evaluation",
  "per_model_notes": { "model_id": "Specific strengths/weaknesses" }
}`;
}
```

**Output:** `data/session-eval-comparison-report.md` and `data/session-eval-comparison-raw.json`

Report format:
```markdown
# Session Evaluation — Model Comparison Report
Date: {date}
Test meetings: 5
Models compared: 3-4

## Summary
| Model | Score Accuracy | Evidence Quality | Coaching Value | Bias Detection | Nuance | Overall |
|-------|---------------|-----------------|---------------|---------------|--------|---------|
| gemini-3-flash | X.X | X.X | X.X | X.X | X.X | X.X |
| gemini-2.5-flash | X.X | X.X | X.X | X.X | X.X | X.X |
| gemini-3-pro | X.X | X.X | X.X | X.X | X.X | X.X |
| gpt-4o | X.X | X.X | X.X | X.X | X.X | X.X |

## Winner: {model}
{reasoning}

## Per-Meeting Breakdown
{detailed table per meeting}

## Recommendation
Based on quality/cost/latency tradeoff:
- **Production model:** {recommendation}
- **Reasoning:** {cost vs quality analysis}
```

## Expected Files
- `src/lib/session-evaluator.js` — **NEW** (~300-400 lines)
- `src/session-evaluate.js` — **NEW** CLI (~100 lines)
- `scripts/session-eval-comparison.mjs` — **NEW** (~400-500 lines)
- `data/session-eval-comparison-report.md` — **GENERATED**
- `data/session-eval-comparison-raw.json` — **GENERATED**
- `data/zoom-action-items.db` — **MODIFY** (new table + data)

## Do NOT Touch
- `src/lib/ai-extractor.js` — Extraction prompt stays unchanged
- `src/lib/session-metrics.js` — Phase 15A code stays unchanged
- `src/poll.js` — Pipeline integration is Phase 15C
- `public/index.html` — Dashboard is Phase 15E

## Acceptance Criteria
- [ ] `session_evaluations` table created
- [ ] Single meeting evaluation works with default model
- [ ] All 12 dimensions scored 1-4
- [ ] Coaching notes include specific B3X team member names
- [ ] Wins/improvements include verbatim transcript quotes
- [ ] Composite score calculated correctly (tier weights: 40/35/25)
- [ ] Model comparison runs on 5 meetings × 3-4 models
- [ ] Judge evaluation produces winner recommendation
- [ ] Comparison report saved with clear recommendation
- [ ] Backfill works for all 99 meetings (with winning model)

## Smoke Tests
```bash
cd ~/awsc-new/awesome/zoom-action-items

# Test single evaluation
node src/session-evaluate.js --meeting 1

# Verify stored
node -e "
const Database = require('better-sqlite3');
const db = new Database('data/zoom-action-items.db', { readonly: true });
const eval1 = db.prepare('SELECT * FROM session_evaluations WHERE meeting_id = 1').get();
console.log('composite:', eval1.composite_score);
console.log('model:', eval1.model_used);
console.log('wins:', JSON.parse(eval1.wins).length);
console.log('improvements:', JSON.parse(eval1.improvements).length);
console.assert(eval1.composite_score > 0 && eval1.composite_score <= 4, 'Score out of range');
db.close();
"

# Run model comparison
node scripts/session-eval-comparison.mjs

# Check comparison report
test -f data/session-eval-comparison-report.md && echo "Report exists"
grep -i "winner" data/session-eval-comparison-report.md

# Backfill all meetings with winning model
node src/session-evaluate.js --backfill

# Verify all meetings evaluated
node -e "
const Database = require('better-sqlite3');
const db = new Database('data/zoom-action-items.db', { readonly: true });
const total = db.prepare('SELECT COUNT(DISTINCT meeting_id) as c FROM session_evaluations').get();
const meetings = db.prepare('SELECT COUNT(*) as c FROM meetings').get();
console.log('evaluated:', total.c, '/ total:', meetings.c);
console.assert(total.c === meetings.c, 'Not all meetings evaluated');
db.close();
"
```

## Completion Instructions
1. Create the DB table
2. Implement session-evaluator.js with the evaluation prompt
3. Create CLI (session-evaluate.js)
4. Create comparison script (session-eval-comparison.mjs)
5. Run comparison on 5 test meetings
6. Review comparison report — note the winning model
7. Run backfill with the winning model for all 99 meetings
8. Run all smoke tests
9. Commit with prefix: `[session-intel-15B]`
10. In your completion message, include:
    - The model comparison summary table
    - The winning model and reasoning
    - Sample evaluation for 1 meeting (scores + coaching notes)
    - Stats: avg composite score, score distribution
