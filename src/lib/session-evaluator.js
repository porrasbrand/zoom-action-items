/**
 * Session Evaluator
 * AI evaluation of meeting quality using a 12-dimension, 4-point rubric.
 * Uses Gemini for transcript analysis and scoring.
 */

import Database from 'better-sqlite3';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getMetrics } from './session-metrics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', '..', 'data', 'zoom-action-items.db');

// Default model for evaluations
export const DEFAULT_MODEL = 'gemini-2.0-flash';

// Dimension weights by tier
const TIER_WEIGHTS = { tier1: 0.40, tier2: 0.35, tier3: 0.25 };

/**
 * Initialize database and create session_evaluations table if needed
 */
export function initDatabase(dbPath = DB_PATH) {
  const db = new Database(dbPath);

  db.exec(`
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
      meeting_type TEXT,
      wins TEXT,
      improvements TEXT,
      coaching_notes TEXT,
      frustration_moments TEXT,

      -- Performance data
      tokens_in INTEGER,
      tokens_out INTEGER,
      latency_ms INTEGER,

      -- Timestamps
      computed_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      UNIQUE(meeting_id, model_used)
    );
  `);

  return db;
}

/**
 * Build evaluation prompt
 */
function buildEvaluationPrompt(meeting, metrics, aiExtraction, transcript) {
  return `You are an expert meeting quality analyst evaluating an agency-client meeting.

CONTEXT:
- Agency: Breakthrough 3x (B3X), a digital marketing agency
- B3X Team Members: Dan Kuschell (CEO/founder), Philip Mutrie (account manager), Joe Boland (media buyer), Richard Bond (operations)
- Meeting: ${meeting.topic}
- Client: ${meeting.client_name}
- Date: ${meeting.start_time}
- Duration: ${meeting.duration_minutes || 0} minutes

QUANTITATIVE METRICS (pre-computed):
- Action items: ${metrics.action_item_count || 0} (${(metrics.action_density || 0).toFixed(2)} per minute)
- Due date assignment rate: ${(metrics.due_date_rate || 0).toFixed(0)}%
- Owner assignment rate: ${(metrics.owner_assignment_rate || 0).toFixed(0)}%
- Decisions made: ${metrics.decision_count || 0}
- B3X speaking ratio: ${(metrics.speaker_ratio_b3x || 0).toFixed(0)}% | Client: ${(metrics.speaker_ratio_client || 0).toFixed(0)}%
- Dominant speaker: ${metrics.dominant_speaker || 'unknown'} (${(metrics.dominant_speaker_pct || 0).toFixed(0)}%)
- B3X stale items (promised but silent 3+ meetings): ${metrics.b3x_stale_items || 0}
- Client stale items: ${metrics.client_stale_items || 0}

AI-EXTRACTED SUMMARY:
${aiExtraction?.summary || 'No summary available'}

ACTION ITEMS EXTRACTED:
${JSON.stringify(aiExtraction?.action_items?.slice(0, 10).map(ai => ({ title: ai.title, owner: ai.owner_name || ai.owner, priority: ai.priority, has_due_date: !!ai.due_date })) || [], null, 2)}

TRANSCRIPT (first 15000 chars):
${(transcript || '').slice(0, 15000)}

---

EVALUATE this meeting on 12 dimensions using a 4-point rubric:
4 = Excellent (exemplary), 3 = Good (meets expectations), 2 = Needs Improvement (issues found), 1 = Failing (coaching needed)

DIMENSIONS:

**Tier 1 — Deal Breakers (most important):**
1. client_sentiment: Is the client engaged, satisfied, and trusting? Look for enthusiasm, voluntary disclosure, future commitment (high) vs complaints, withdrawal, frustration (low).

2. accountability: Did B3X acknowledge past commitments? Were previous action items referenced? Are stale items addressed?

3. relationship_health: Trust signals — client sharing problems openly, delegating decisions. Vs surface-level, transactional interactions.

**Tier 2 — Core Competence:**
4. meeting_structure: Was there an agenda or clear opening? Recap of prior items? Clear wrap-up with next steps?

5. value_delivery: Did B3X present results, data, or progress? Strategic recommendations? Or just asked "what do you need?"

6. action_discipline: Were action items specific? Owners assigned? Due dates discussed?

7. proactive_leadership: Did B3X bring ideas, suggestions, opportunities? Forward-looking vs firefighting only?

**Tier 3 — Efficiency:**
8. time_utilization: Was meeting time used productively? High substance density?

9. redundancy: Topics rehashed without progress? Same action items re-assigned?

10. client_confusion: Jargon without explanation? Client needed clarification?

11. meeting_momentum: Relationship progressing (new initiatives, expanding scope) vs stagnating?

12. save_rate: When frustration occurred, did B3X recover? Score 3 if no frustration occurred.

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
    { "description": "What B3X did well", "transcript_quote": "Exact quote from transcript", "dimension": "dimension" },
    { "description": "Second win", "transcript_quote": "Exact quote", "dimension": "dimension" }
  ],
  "improvements": [
    { "description": "What could be improved", "transcript_quote": "Quote showing the issue", "dimension": "dimension", "suggestion": "Specific coaching suggestion" },
    { "description": "Second improvement", "transcript_quote": "Quote", "dimension": "dimension", "suggestion": "Suggestion" }
  ],
  "frustration_moments": [],
  "coaching_notes": "2-3 sentence overall assessment"
}

RULES:
- Score each dimension independently based on transcript evidence
- Wins and improvements MUST include transcript quotes
- If a dimension can't be assessed, score 3 (neutral)
- For internal B3X meetings, score client_sentiment, relationship_health, and save_rate as 3
- Be specific in coaching_notes — name the B3X team member if identifiable`;
}

/**
 * Calculate tier averages and composite score
 */
function calculateComposite(scores) {
  const tier1 = ['client_sentiment', 'accountability', 'relationship_health'];
  const tier2 = ['meeting_structure', 'value_delivery', 'action_discipline', 'proactive_leadership'];
  const tier3 = ['time_utilization', 'redundancy', 'client_confusion', 'meeting_momentum', 'save_rate'];

  const avg = (dims) => {
    const values = dims.map(d => scores[d]).filter(v => v != null);
    return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 3;
  };

  const tier1_avg = avg(tier1);
  const tier2_avg = avg(tier2);
  const tier3_avg = avg(tier3);

  const composite = (tier1_avg * TIER_WEIGHTS.tier1) +
                    (tier2_avg * TIER_WEIGHTS.tier2) +
                    (tier3_avg * TIER_WEIGHTS.tier3);

  return { tier1_avg, tier2_avg, tier3_avg, composite_score: composite };
}

/**
 * Evaluate a single meeting
 */
export async function evaluateMeeting(meetingId, options = {}) {
  const modelId = options.model || DEFAULT_MODEL;
  const db = options.db || initDatabase();
  const shouldCloseDb = !options.db;

  try {
    // Load meeting data
    const meeting = db.prepare(`
      SELECT id, topic, client_id, client_name, transcript_raw, duration_minutes, start_time, ai_extraction
      FROM meetings WHERE id = ?
    `).get(meetingId);

    if (!meeting) {
      throw new Error(`Meeting ${meetingId} not found`);
    }

    // Load metrics from Phase 15A
    const metrics = getMetrics(db, meetingId) || {};

    // Parse AI extraction
    let aiExtraction = {};
    try {
      aiExtraction = meeting.ai_extraction ? JSON.parse(meeting.ai_extraction) : {};
      if (Array.isArray(aiExtraction)) aiExtraction = aiExtraction[0] || {};
    } catch (e) { /* ignore parse errors */ }

    // Build prompt
    const prompt = buildEvaluationPrompt(meeting, metrics, aiExtraction, meeting.transcript_raw);

    // Call Gemini
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({ model: modelId });

    const startTime = Date.now();
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        topP: 0.8,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json'
      }
    });
    const latencyMs = Date.now() - startTime;

    const response = result.response;
    const text = response.text();
    const tokensIn = response.usageMetadata?.promptTokenCount || 0;
    const tokensOut = response.usageMetadata?.candidatesTokenCount || 0;

    // Parse JSON response
    let evaluation;
    try {
      evaluation = JSON.parse(text);
    } catch (e) {
      // Try to extract JSON from response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        evaluation = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('Failed to parse evaluation response as JSON');
      }
    }

    const scores = evaluation.scores || {};
    const composite = calculateComposite(scores);

    // Store in database
    db.prepare(`
      INSERT INTO session_evaluations (
        meeting_id, model_used,
        client_sentiment, accountability, relationship_health,
        meeting_structure, value_delivery, action_discipline, proactive_leadership,
        time_utilization, redundancy, client_confusion, meeting_momentum, save_rate,
        tier1_avg, tier2_avg, tier3_avg, composite_score,
        meeting_type, wins, improvements, coaching_notes, frustration_moments,
        tokens_in, tokens_out, latency_ms, computed_at
      ) VALUES (
        ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, datetime('now')
      )
      ON CONFLICT(meeting_id, model_used) DO UPDATE SET
        client_sentiment = excluded.client_sentiment,
        accountability = excluded.accountability,
        relationship_health = excluded.relationship_health,
        meeting_structure = excluded.meeting_structure,
        value_delivery = excluded.value_delivery,
        action_discipline = excluded.action_discipline,
        proactive_leadership = excluded.proactive_leadership,
        time_utilization = excluded.time_utilization,
        redundancy = excluded.redundancy,
        client_confusion = excluded.client_confusion,
        meeting_momentum = excluded.meeting_momentum,
        save_rate = excluded.save_rate,
        tier1_avg = excluded.tier1_avg,
        tier2_avg = excluded.tier2_avg,
        tier3_avg = excluded.tier3_avg,
        composite_score = excluded.composite_score,
        meeting_type = excluded.meeting_type,
        wins = excluded.wins,
        improvements = excluded.improvements,
        coaching_notes = excluded.coaching_notes,
        frustration_moments = excluded.frustration_moments,
        tokens_in = excluded.tokens_in,
        tokens_out = excluded.tokens_out,
        latency_ms = excluded.latency_ms,
        computed_at = datetime('now')
    `).run(
      meetingId, modelId,
      scores.client_sentiment, scores.accountability, scores.relationship_health,
      scores.meeting_structure, scores.value_delivery, scores.action_discipline, scores.proactive_leadership,
      scores.time_utilization, scores.redundancy, scores.client_confusion, scores.meeting_momentum, scores.save_rate,
      composite.tier1_avg, composite.tier2_avg, composite.tier3_avg, composite.composite_score,
      evaluation.meeting_type || 'regular',
      JSON.stringify(evaluation.wins || []),
      JSON.stringify(evaluation.improvements || []),
      evaluation.coaching_notes || '',
      JSON.stringify(evaluation.frustration_moments || []),
      tokensIn, tokensOut, latencyMs
    );

    return {
      meeting_id: meetingId,
      model_used: modelId,
      scores,
      ...composite,
      meeting_type: evaluation.meeting_type,
      wins: evaluation.wins,
      improvements: evaluation.improvements,
      coaching_notes: evaluation.coaching_notes,
      frustration_moments: evaluation.frustration_moments,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      latency_ms: latencyMs
    };
  } finally {
    if (shouldCloseDb) db.close();
  }
}

/**
 * Backfill all meetings
 */
export async function backfillAll(options = {}) {
  const modelId = options.model || DEFAULT_MODEL;
  const db = initDatabase();

  const meetings = db.prepare('SELECT id FROM meetings ORDER BY id').all();
  console.log(`[SessionEval] Backfilling ${meetings.length} meetings with model: ${modelId}`);

  let processed = 0, errors = 0;

  for (const { id } of meetings) {
    try {
      // Check if already evaluated with this model
      const existing = db.prepare('SELECT id FROM session_evaluations WHERE meeting_id = ? AND model_used = ?').get(id, modelId);
      if (existing && !options.force) {
        processed++;
        continue;
      }

      await evaluateMeeting(id, { model: modelId, db });
      processed++;

      if (processed % 5 === 0) {
        console.log(`[SessionEval] Processed ${processed}/${meetings.length}`);
      }

      // Rate limiting - 2 second delay
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.error(`[SessionEval] Error processing meeting ${id}:`, err.message);
      errors++;
    }
  }

  db.close();
  console.log(`[SessionEval] Backfill complete: ${processed} processed, ${errors} errors`);
  return { processed, errors, total: meetings.length };
}

/**
 * Get evaluation statistics
 */
export function getEvalStats(db) {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      AVG(composite_score) as avg_composite,
      AVG(tier1_avg) as avg_tier1,
      AVG(tier2_avg) as avg_tier2,
      AVG(tier3_avg) as avg_tier3,
      SUM(CASE WHEN composite_score >= 3.5 THEN 1 ELSE 0 END) as excellent,
      SUM(CASE WHEN composite_score >= 2.5 AND composite_score < 3.5 THEN 1 ELSE 0 END) as good,
      SUM(CASE WHEN composite_score >= 1.5 AND composite_score < 2.5 THEN 1 ELSE 0 END) as needs_improvement,
      SUM(CASE WHEN composite_score < 1.5 THEN 1 ELSE 0 END) as failing
    FROM session_evaluations
  `).get();

  return stats;
}

/**
 * Get evaluation for a meeting
 */
export function getEvaluation(db, meetingId, modelId = null) {
  if (modelId) {
    return db.prepare('SELECT * FROM session_evaluations WHERE meeting_id = ? AND model_used = ?').get(meetingId, modelId);
  }
  return db.prepare('SELECT * FROM session_evaluations WHERE meeting_id = ? ORDER BY computed_at DESC LIMIT 1').get(meetingId);
}

export default {
  initDatabase,
  evaluateMeeting,
  backfillAll,
  getEvalStats,
  getEvaluation,
  calculateComposite,
  DEFAULT_MODEL
};
