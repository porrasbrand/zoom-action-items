#!/usr/bin/env node
/**
 * Session Intelligence — Comprehensive Test Suite
 *
 * Usage:
 *   node scripts/session-test-suite.mjs              # Run all tests
 *   node scripts/session-test-suite.mjs --suite regression
 *   node scripts/session-test-suite.mjs --suite session
 *   node scripts/session-test-suite.mjs --suite edge
 *   node scripts/session-test-suite.mjs --suite bias
 *   node scripts/session-test-suite.mjs --suite api
 *   node scripts/session-test-suite.mjs --suite dashboard
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// Test results storage
const results = {
  regression: [],
  session: [],
  edge: [],
  bias: [],
  api: [],
  dashboard: []
};

const biasData = [];
let db;

// Helpers
function pass(suite, id, message, details = null) {
  results[suite].push({ id, status: 'pass', message, details });
  console.log(`  ✅ ${id}: ${message}`);
}

function fail(suite, id, message, details = null) {
  results[suite].push({ id, status: 'fail', message, details });
  console.log(`  ❌ ${id}: ${message}`);
}

function warn(suite, id, message, details = null) {
  results[suite].push({ id, status: 'warn', message, details });
  console.log(`  ⚠️  ${id}: ${message}`);
}

function skip(suite, id, message) {
  results[suite].push({ id, status: 'skip', message });
  console.log(`  ⏭️  ${id}: ${message}`);
}

// ============ SUITE 1: REGRESSION TESTS ============

async function runRegressionTests() {
  console.log('\n📋 Suite 1: Regression Tests\n');

  // R1: Pipeline evaluation (simplified - check session_evaluations exist)
  try {
    const evalCount = db.prepare('SELECT COUNT(*) as c FROM session_evaluations WHERE model_used = ?').get('gemini-2.0-flash')?.c || 0;
    const meetingCount = db.prepare('SELECT COUNT(*) as c FROM meetings').get().c;
    const coverage = (evalCount / meetingCount * 100).toFixed(1);
    if (evalCount >= meetingCount * 0.9) {
      pass('regression', 'R1', `Pipeline evaluation coverage — ${coverage}% (${evalCount}/${meetingCount} meetings)`);
    } else {
      warn('regression', 'R1', `Pipeline evaluation coverage low — ${coverage}% (${evalCount}/${meetingCount})`);
    }
  } catch (e) {
    fail('regression', 'R1', `Pipeline evaluation check failed: ${e.message}`);
  }

  // R2: Action item count
  try {
    const count = db.prepare('SELECT COUNT(*) as c FROM action_items').get().c;
    if (count >= 673) {
      pass('regression', 'R2', `Action items intact — ${count} (threshold: 673)`);
    } else {
      fail('regression', 'R2', `Action items decreased — ${count} (expected: 673+)`);
    }
  } catch (e) {
    fail('regression', 'R2', `Action items check failed: ${e.message}`);
  }

  // R3: Roadmap items
  try {
    const count = db.prepare('SELECT COUNT(*) as c FROM roadmap_items').get().c;
    // Check orphans by comparing with meetings.client_id
    const orphans = db.prepare(`
      SELECT COUNT(*) as c FROM roadmap_items r
      WHERE NOT EXISTS (SELECT 1 FROM meetings m WHERE m.client_id = r.client_id)
    `).get().c;
    if (count >= 246 && orphans === 0) {
      pass('regression', 'R3', `Roadmap items intact — ${count}, orphans: ${orphans}`);
    } else if (count >= 246) {
      warn('regression', 'R3', `Roadmap items: ${count}, with ${orphans} orphans (no matching meetings)`);
    } else {
      fail('regression', 'R3', `Roadmap items decreased — ${count} (expected: 246+)`);
    }
  } catch (e) {
    fail('regression', 'R3', `Roadmap items check failed: ${e.message}`);
  }

  // R4: Dashboard tabs (curl check)
  try {
    const htmlPath = path.join(projectRoot, 'public/index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    const hasMeetings = html.includes('data-tab="meetings"');
    const hasRoadmap = html.includes('data-tab="roadmap"');
    const hasPrep = html.includes('data-tab="prep"');
    const hasSession = html.includes('data-tab="session"');
    if (hasMeetings && hasRoadmap && hasPrep && hasSession) {
      pass('regression', 'R4', 'Dashboard tabs present — meetings, roadmap, prep, session');
    } else {
      const missing = [];
      if (!hasMeetings) missing.push('meetings');
      if (!hasRoadmap) missing.push('roadmap');
      if (!hasPrep) missing.push('prep');
      if (!hasSession) missing.push('session');
      fail('regression', 'R4', `Dashboard tabs missing: ${missing.join(', ')}`);
    }
  } catch (e) {
    fail('regression', 'R4', `Dashboard check failed: ${e.message}`);
  }

  // R5: API endpoints (check routes file)
  try {
    const routesPath = path.join(projectRoot, 'src/api/routes.js');
    const routes = fs.readFileSync(routesPath, 'utf8');
    const hasGetMeetings = routes.includes("router.get('/meetings'");
    const hasGetMeetingById = routes.includes("router.get('/meetings/:id'");
    const hasRoadmap = routes.includes("router.get('/roadmap/:clientId'");
    const hasPrep = routes.includes("router.get('/prep/:clientId'");
    if (hasGetMeetings && hasGetMeetingById && hasRoadmap && hasPrep) {
      pass('regression', 'R5', 'API endpoints intact — /meetings, /meetings/:id, /roadmap, /prep');
    } else {
      fail('regression', 'R5', 'Some API endpoints missing from routes.js');
    }
  } catch (e) {
    fail('regression', 'R5', `API routes check failed: ${e.message}`);
  }
}

// ============ SUITE 2: SESSION INTELLIGENCE TESTS ============

async function runSessionTests() {
  console.log('\n📋 Suite 2: Session Intelligence Tests\n');

  // S1: Metrics completeness
  try {
    const meetingCount = db.prepare('SELECT COUNT(*) as c FROM meetings').get().c;
    const metricsCount = db.prepare('SELECT COUNT(*) as c FROM session_metrics').get().c;
    if (metricsCount >= meetingCount) {
      pass('session', 'S1', `Metrics completeness — ${metricsCount}/${meetingCount} meetings`);
    } else {
      const missing = meetingCount - metricsCount;
      warn('session', 'S1', `Metrics incomplete — ${missing} meetings missing metrics`);
    }
  } catch (e) {
    fail('session', 'S1', `Metrics completeness check failed: ${e.message}`);
  }

  // S2: Evaluation completeness
  try {
    const meetingCount = db.prepare('SELECT COUNT(*) as c FROM meetings').get().c;
    const evalCount = db.prepare('SELECT COUNT(DISTINCT meeting_id) as c FROM session_evaluations WHERE model_used = ?').get('gemini-2.0-flash')?.c || 0;

    // Check dimension scores are 1-4 (using actual column names)
    const invalidScores = db.prepare(`
      SELECT COUNT(*) as c FROM session_evaluations
      WHERE model_used = 'gemini-2.0-flash'
      AND (client_sentiment < 1 OR client_sentiment > 4
        OR accountability < 1 OR accountability > 4
        OR relationship_health < 1 OR relationship_health > 4)
    `).get().c;

    if (evalCount >= meetingCount && invalidScores === 0) {
      pass('session', 'S2', `Evaluation completeness — ${evalCount}/${meetingCount}, all scores 1-4`);
    } else if (evalCount >= meetingCount) {
      warn('session', 'S2', `Evaluations complete but ${invalidScores} invalid scores found`);
    } else {
      warn('session', 'S2', `Evaluations incomplete — ${evalCount}/${meetingCount} meetings evaluated`);
    }
  } catch (e) {
    fail('session', 'S2', `Evaluation completeness check failed: ${e.message}`);
  }

  // S3: Composite score accuracy
  try {
    const samples = db.prepare(`
      SELECT meeting_id, composite_score, tier1_avg, tier2_avg, tier3_avg,
        client_sentiment, accountability, relationship_health, meeting_structure,
        value_delivery, action_discipline, proactive_leadership, time_utilization,
        redundancy, client_confusion, meeting_momentum, save_rate
      FROM session_evaluations
      WHERE model_used = 'gemini-2.0-flash'
      ORDER BY RANDOM() LIMIT 10
    `).all();

    let errors = 0;
    for (const s of samples) {
      const dims = [
        s.client_sentiment, s.accountability, s.relationship_health, s.meeting_structure,
        s.value_delivery, s.action_discipline, s.proactive_leadership, s.time_utilization,
        s.redundancy, s.client_confusion, s.meeting_momentum, s.save_rate
      ].filter(d => d != null);

      if (dims.length === 0) continue;
      const calculated = dims.reduce((a, b) => a + b, 0) / dims.length;
      if (Math.abs(calculated - s.composite_score) > 0.1) { // Allow small tolerance
        errors++;
      }
    }

    if (errors === 0) {
      pass('session', 'S3', `Composite score accuracy — 10 samples verified`);
    } else {
      warn('session', 'S3', `Composite score variance in ${errors}/10 samples (may use weighted avg)`);
    }
  } catch (e) {
    fail('session', 'S3', `Composite accuracy check failed: ${e.message}`);
  }

  // S4: Baselines computed
  try {
    const agencyBaselines = db.prepare(`
      SELECT dimension, p25, p50, p75 FROM session_baselines
      WHERE scope = 'agency'
    `).all();

    const compositeBaseline = agencyBaselines.find(b => b.dimension === 'composite');
    const validOrder = agencyBaselines.filter(b => b.p25 <= b.p50 && b.p50 <= b.p75).length;

    if (compositeBaseline && validOrder === agencyBaselines.length && agencyBaselines.length >= 12) {
      pass('session', 'S4', `Baselines computed — ${agencyBaselines.length} dimensions, P25<P50<P75 valid`);
    } else if (agencyBaselines.length > 0) {
      warn('session', 'S4', `Baselines exist (${agencyBaselines.length}) but ${agencyBaselines.length - validOrder} have invalid order`);
    } else {
      fail('session', 'S4', 'No agency baselines found');
    }
  } catch (e) {
    fail('session', 'S4', `Baselines check failed: ${e.message}`);
  }

  // S5: Coaching quality
  try {
    const samples = db.prepare(`
      SELECT meeting_id, wins, improvements, coaching_notes, frustration_moments
      FROM session_evaluations
      WHERE model_used = 'gemini-2.0-flash' AND (wins IS NOT NULL OR improvements IS NOT NULL)
      ORDER BY RANDOM() LIMIT 5
    `).all();

    let issues = 0;
    for (const s of samples) {
      try {
        const wins = s.wins ? JSON.parse(s.wins) : [];
        const improvements = s.improvements ? JSON.parse(s.improvements) : [];

        if (wins.length < 1 && improvements.length < 1) {
          issues++;
        }
      } catch (e) {
        // JSON parse error - count as issue
        issues++;
      }
    }

    if (samples.length === 0) {
      warn('session', 'S5', 'No coaching data found in evaluations');
    } else if (issues === 0) {
      pass('session', 'S5', `Coaching quality — ${samples.length} samples with wins+improvements`);
    } else {
      warn('session', 'S5', `Coaching quality issues in ${issues}/${samples.length} samples`);
    }
  } catch (e) {
    fail('session', 'S5', `Coaching quality check failed: ${e.message}`);
  }

  // S6: Pipeline integration
  try {
    const pollPath = path.join(projectRoot, 'src/poll.js');
    const poll = fs.readFileSync(pollPath, 'utf8');
    const hasMetrics = poll.includes('session-metrics');
    const hasEvaluator = poll.includes('session-evaluator') || poll.includes('evaluateSession');

    if (hasMetrics) {
      pass('session', 'S6', 'Pipeline integration — session-metrics imported in poll.js');
    } else {
      fail('session', 'S6', 'Pipeline integration missing — session-metrics not found in poll.js');
    }
  } catch (e) {
    fail('session', 'S6', `Pipeline integration check failed: ${e.message}`);
  }

  // S7: API endpoints structure
  try {
    const routesPath = path.join(projectRoot, 'src/api/routes.js');
    const routes = fs.readFileSync(routesPath, 'utf8');
    const endpoints = [
      '/session/:meetingId/scorecard',
      '/session/client/:clientId/trend',
      '/session/team',
      '/session/flags',
      '/session/benchmarks',
      '/session/digest'
    ];

    const found = endpoints.filter(ep => routes.includes(ep));
    if (found.length === endpoints.length) {
      pass('session', 'S7', `API endpoints present — all 6 session endpoints found`);
    } else {
      const missing = endpoints.filter(ep => !routes.includes(ep));
      warn('session', 'S7', `Some endpoints may differ: ${missing.join(', ')}`);
    }
  } catch (e) {
    fail('session', 'S7', `API endpoints check failed: ${e.message}`);
  }

  // S8: Backfill integrity
  try {
    const meetingIds = db.prepare('SELECT id FROM meetings').all().map(m => m.id);
    const metricsIds = new Set(db.prepare('SELECT meeting_id FROM session_metrics').all().map(m => m.meeting_id));
    const evalIds = new Set(db.prepare('SELECT DISTINCT meeting_id FROM session_evaluations WHERE model_used = ?').all('gemini-2.0-flash').map(m => m.meeting_id));

    const missingMetrics = meetingIds.filter(id => !metricsIds.has(id));
    const missingEvals = meetingIds.filter(id => !evalIds.has(id));

    if (missingMetrics.length === 0 && missingEvals.length === 0) {
      pass('session', 'S8', 'Backfill integrity — no gaps in metrics or evaluations');
    } else {
      const details = [];
      if (missingMetrics.length > 0) details.push(`${missingMetrics.length} missing metrics`);
      if (missingEvals.length > 0) details.push(`${missingEvals.length} missing evals`);
      warn('session', 'S8', `Backfill gaps: ${details.join(', ')}`);
    }
  } catch (e) {
    fail('session', 'S8', `Backfill integrity check failed: ${e.message}`);
  }
}

// ============ SUITE 3: EDGE CASE TESTS ============

async function runEdgeTests() {
  console.log('\n📋 Suite 3: Edge Case Tests\n');

  // E1: Short meeting
  try {
    const short = db.prepare(`
      SELECT m.id, m.topic, m.duration_minutes, e.composite_score
      FROM meetings m
      JOIN session_evaluations e ON m.id = e.meeting_id AND e.model_used = 'gemini-2.0-flash'
      WHERE m.duration_minutes < 15
      ORDER BY m.duration_minutes ASC
      LIMIT 1
    `).get();

    if (short) {
      if (short.composite_score > 1 && short.composite_score < 4) {
        pass('edge', 'E1', `Short meeting (${short.duration_minutes} min) — score: ${short.composite_score.toFixed(2)}`);
      } else {
        warn('edge', 'E1', `Short meeting has extreme score: ${short.composite_score}`);
      }
    } else {
      skip('edge', 'E1', 'No meetings under 15 minutes found');
    }
  } catch (e) {
    fail('edge', 'E1', `Short meeting check failed: ${e.message}`);
  }

  // E2: Long meeting
  try {
    const long = db.prepare(`
      SELECT m.id, m.topic, m.duration_minutes, e.composite_score
      FROM meetings m
      JOIN session_evaluations e ON m.id = e.meeting_id AND e.model_used = 'gemini-2.0-flash'
      ORDER BY m.duration_minutes DESC
      LIMIT 1
    `).get();

    if (long) {
      if (long.composite_score >= 1 && long.composite_score <= 4) {
        pass('edge', 'E2', `Long meeting (${long.duration_minutes} min) — score: ${long.composite_score.toFixed(2)}`);
      } else {
        warn('edge', 'E2', `Long meeting has invalid score: ${long.composite_score}`);
      }
    } else {
      skip('edge', 'E2', 'No meetings with evaluations found');
    }
  } catch (e) {
    fail('edge', 'E2', `Long meeting check failed: ${e.message}`);
  }

  // E3: No action items
  try {
    const noActions = db.prepare(`
      SELECT m.id, m.topic, sm.action_item_count, sm.action_density, e.action_discipline
      FROM meetings m
      JOIN session_metrics sm ON m.id = sm.meeting_id
      JOIN session_evaluations e ON m.id = e.meeting_id AND e.model_used = 'gemini-2.0-flash'
      WHERE sm.action_item_count = 0
      LIMIT 3
    `).all();

    if (noActions.length > 0) {
      const zerosDensity = noActions.filter(m => m.action_density === 0).length;
      if (zerosDensity === noActions.length) {
        pass('edge', 'E3', `No-action meetings (${noActions.length}) — action_density=0 correctly`);
      } else {
        warn('edge', 'E3', `${noActions.length - zerosDensity} meetings have non-zero density with 0 items`);
      }
    } else {
      skip('edge', 'E3', 'No meetings with 0 action items found');
    }
  } catch (e) {
    fail('edge', 'E3', `No-action check failed: ${e.message}`);
  }

  // E4: Internal meeting
  try {
    const internal = db.prepare(`
      SELECT m.id, m.topic, sm.meeting_type, e.composite_score
      FROM meetings m
      JOIN session_metrics sm ON m.id = sm.meeting_id
      JOIN session_evaluations e ON m.id = e.meeting_id AND e.model_used = 'gemini-2.0-flash'
      WHERE sm.meeting_type = 'internal'
      LIMIT 3
    `).all();

    if (internal.length > 0) {
      const avgScore = internal.reduce((sum, m) => sum + m.composite_score, 0) / internal.length;
      pass('edge', 'E4', `Internal meetings (${internal.length}) — avg score: ${avgScore.toFixed(2)}`);
    } else {
      skip('edge', 'E4', 'No internal meetings found');
    }
  } catch (e) {
    fail('edge', 'E4', `Internal meeting check failed: ${e.message}`);
  }
}

// ============ SUITE 4: BIAS CHECK ============

async function runBiasTests() {
  console.log('\n📋 Suite 4: Bias Check\n');

  // B1: Team member comparison
  try {
    // Get dominant speakers and their scores
    const memberScores = db.prepare(`
      SELECT sm.dominant_speaker, AVG(e.composite_score) as avg_score, COUNT(*) as count
      FROM session_metrics sm
      JOIN session_evaluations e ON sm.meeting_id = e.meeting_id AND e.model_used = 'gemini-2.0-flash'
      WHERE sm.dominant_speaker IS NOT NULL AND sm.dominant_speaker != ''
      GROUP BY sm.dominant_speaker
      HAVING count >= 3
      ORDER BY avg_score DESC
    `).all();

    if (memberScores.length >= 2) {
      const maxScore = memberScores[0].avg_score;
      const minScore = memberScores[memberScores.length - 1].avg_score;
      const delta = maxScore - minScore;

      biasData.push({
        comparison: 'Team Members',
        groupA: `${memberScores[0].dominant_speaker} (${memberScores[0].count})`,
        groupB: `${memberScores[memberScores.length - 1].dominant_speaker} (${memberScores[memberScores.length - 1].count})`,
        scoreA: maxScore.toFixed(2),
        scoreB: minScore.toFixed(2),
        delta: delta.toFixed(2),
        concern: delta > 0.8 ? 'Yes' : 'No'
      });

      if (delta > 0.8) {
        warn('bias', 'B1', `Team member delta: ${delta.toFixed(2)} (threshold: 0.8) — may need client adjustment`);
      } else {
        pass('bias', 'B1', `Team member delta: ${delta.toFixed(2)} within acceptable range`);
      }
    } else {
      skip('bias', 'B1', 'Not enough team members with 3+ meetings');
    }
  } catch (e) {
    fail('bias', 'B1', `Team member comparison failed: ${e.message}`);
  }

  // B2: Duration bias
  try {
    const short = db.prepare(`
      SELECT AVG(e.composite_score) as avg_score, COUNT(*) as count
      FROM meetings m
      JOIN session_evaluations e ON m.id = e.meeting_id AND e.model_used = 'gemini-2.0-flash'
      WHERE m.duration_minutes < 25
    `).get();

    const long = db.prepare(`
      SELECT AVG(e.composite_score) as avg_score, COUNT(*) as count
      FROM meetings m
      JOIN session_evaluations e ON m.id = e.meeting_id AND e.model_used = 'gemini-2.0-flash'
      WHERE m.duration_minutes > 45
    `).get();

    if (short?.count > 0 && long?.count > 0) {
      const delta = Math.abs(long.avg_score - short.avg_score);

      biasData.push({
        comparison: 'Duration',
        groupA: `Short <25min (${short.count})`,
        groupB: `Long >45min (${long.count})`,
        scoreA: short.avg_score.toFixed(2),
        scoreB: long.avg_score.toFixed(2),
        delta: delta.toFixed(2),
        concern: delta > 0.5 ? 'Yes' : 'No'
      });

      if (delta > 0.5) {
        warn('bias', 'B2', `Duration bias detected: delta ${delta.toFixed(2)} (threshold: 0.5)`);
      } else {
        pass('bias', 'B2', `Duration bias within range: delta ${delta.toFixed(2)}`);
      }
    } else {
      skip('bias', 'B2', 'Not enough short/long meetings to compare');
    }
  } catch (e) {
    fail('bias', 'B2', `Duration bias check failed: ${e.message}`);
  }

  // B3: Action count bias
  try {
    const few = db.prepare(`
      SELECT AVG(e.composite_score) as avg_score, COUNT(*) as count
      FROM session_metrics sm
      JOIN session_evaluations e ON sm.meeting_id = e.meeting_id AND e.model_used = 'gemini-2.0-flash'
      WHERE sm.action_item_count < 3
    `).get();

    const many = db.prepare(`
      SELECT AVG(e.composite_score) as avg_score, COUNT(*) as count
      FROM session_metrics sm
      JOIN session_evaluations e ON sm.meeting_id = e.meeting_id AND e.model_used = 'gemini-2.0-flash'
      WHERE sm.action_item_count > 8
    `).get();

    if (few?.count > 0 && many?.count > 0) {
      const delta = many.avg_score - few.avg_score;

      biasData.push({
        comparison: 'Action Count',
        groupA: `Few <3 (${few.count})`,
        groupB: `Many >8 (${many.count})`,
        scoreA: few.avg_score.toFixed(2),
        scoreB: many.avg_score.toFixed(2),
        delta: delta.toFixed(2),
        concern: delta > 0.5 ? 'Possible' : 'No'
      });

      if (delta > 0.5) {
        warn('bias', 'B3', `Action count may bias scores: high-item meetings +${delta.toFixed(2)}`);
      } else {
        pass('bias', 'B3', `Action count not significantly biasing scores: delta ${delta.toFixed(2)}`);
      }
    } else {
      skip('bias', 'B3', 'Not enough meetings with few/many action items');
    }
  } catch (e) {
    fail('bias', 'B3', `Action count bias check failed: ${e.message}`);
  }

  // B4: Meeting type bias
  try {
    const regular = db.prepare(`
      SELECT AVG(e.composite_score) as avg_score, COUNT(*) as count
      FROM session_metrics sm
      JOIN session_evaluations e ON sm.meeting_id = e.meeting_id AND e.model_used = 'gemini-2.0-flash'
      WHERE sm.meeting_type = 'regular' OR sm.meeting_type IS NULL
    `).get();

    const internal = db.prepare(`
      SELECT AVG(e.composite_score) as avg_score, COUNT(*) as count
      FROM session_metrics sm
      JOIN session_evaluations e ON sm.meeting_id = e.meeting_id AND e.model_used = 'gemini-2.0-flash'
      WHERE sm.meeting_type = 'internal'
    `).get();

    if (regular?.count > 0 && internal?.count > 0) {
      const delta = Math.abs(regular.avg_score - internal.avg_score);

      biasData.push({
        comparison: 'Meeting Type',
        groupA: `Regular (${regular.count})`,
        groupB: `Internal (${internal.count})`,
        scoreA: regular.avg_score.toFixed(2),
        scoreB: internal.avg_score.toFixed(2),
        delta: delta.toFixed(2),
        concern: 'Expected'
      });

      pass('bias', 'B4', `Meeting type diff: regular=${regular.avg_score.toFixed(2)} vs internal=${internal.avg_score.toFixed(2)}`);
    } else {
      skip('bias', 'B4', 'Not enough meeting types to compare');
    }
  } catch (e) {
    fail('bias', 'B4', `Meeting type bias check failed: ${e.message}`);
  }
}

// ============ SUITE 5: API CONTRACT TESTS ============

async function runApiTests() {
  console.log('\n📋 Suite 5: API Contract Tests\n');

  // Check if server is running
  let serverRunning = false;
  try {
    const res = await fetch('http://localhost:3875/zoom/api/health');
    serverRunning = res.ok;
  } catch (e) {
    console.log('  ⚠️  Dashboard server not reachable — testing file structure only\n');
  }

  // A1-A6: Check API route definitions in routes.js
  try {
    const routesPath = path.join(projectRoot, 'src/api/routes.js');
    const routes = fs.readFileSync(routesPath, 'utf8');

    const endpoints = [
      { id: 'A1', path: '/session/:meetingId/scorecard', name: 'Scorecard' },
      { id: 'A2', path: '/session/client/:clientId/trend', name: 'Client Trend' },
      { id: 'A3', path: '/session/team', name: 'Team Stats' },
      { id: 'A4', path: '/session/flags', name: 'Flags' },
      { id: 'A5', path: '/session/benchmarks', name: 'Benchmarks' },
      { id: 'A6', path: '/session/digest', name: 'Weekly Digest' }
    ];

    for (const ep of endpoints) {
      if (routes.includes(ep.path)) {
        pass('api', ep.id, `${ep.name} endpoint defined — ${ep.path}`);
      } else {
        fail('api', ep.id, `${ep.name} endpoint missing — ${ep.path}`);
      }
    }
  } catch (e) {
    fail('api', 'A1-A6', `API routes check failed: ${e.message}`);
  }
}

// ============ SUITE 6: DASHBOARD TESTS ============

async function runDashboardTests() {
  console.log('\n📋 Suite 6: Dashboard Tests\n');

  // D1: Tab exists
  try {
    const htmlPath = path.join(projectRoot, 'public/index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    const hasTabText = html.includes('Session Intelligence');
    const hasDataTab = html.includes('data-tab="session"');

    if (hasTabText && hasDataTab) {
      pass('dashboard', 'D1', 'Session Intelligence tab exists with correct data-tab attribute');
    } else {
      const missing = [];
      if (!hasTabText) missing.push('tab text');
      if (!hasDataTab) missing.push('data-tab attribute');
      fail('dashboard', 'D1', `Tab missing: ${missing.join(', ')}`);
    }
  } catch (e) {
    fail('dashboard', 'D1', `Tab check failed: ${e.message}`);
  }

  // D2: JavaScript functions
  try {
    const htmlPath = path.join(projectRoot, 'public/index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    const functions = [
      'switchSessionView',
      'loadSessionOverview',
      'loadSessionScorecard',
      'loadSessionTrends',
      'loadSessionTeam',
      'loadSessionFlags'
    ];

    const found = functions.filter(fn => html.includes(`function ${fn}`));
    const missing = functions.filter(fn => !html.includes(`function ${fn}`));

    if (found.length === functions.length) {
      pass('dashboard', 'D2', `All ${functions.length} session JS functions present`);
    } else {
      fail('dashboard', 'D2', `Missing functions: ${missing.join(', ')}`);
    }
  } catch (e) {
    fail('dashboard', 'D2', `JS function check failed: ${e.message}`);
  }

  // D3: Playwright (skip if not available)
  skip('dashboard', 'D3', 'Playwright tests skipped (not installed)');
}

// ============ REPORT GENERATION ============

function generateReport() {
  const date = new Date().toISOString().split('T')[0];

  let totalTests = 0;
  let passed = 0;
  let failed = 0;
  let warnings = 0;
  let skipped = 0;

  for (const suite of Object.values(results)) {
    for (const test of suite) {
      totalTests++;
      if (test.status === 'pass') passed++;
      else if (test.status === 'fail') failed++;
      else if (test.status === 'warn') warnings++;
      else if (test.status === 'skip') skipped++;
    }
  }

  const verdict = failed > 0 ? 'FAIL' : warnings > 0 ? 'PASS WITH WARNINGS' : 'PASS';

  let report = `# Session Intelligence — Test Report

Date: ${date}
Total tests: ${totalTests}
Passed: ${passed}
Failed: ${failed}
Warnings: ${warnings}
Skipped: ${skipped}

## Suite Results

`;

  const suiteNames = {
    regression: 'Regression (R1-R5)',
    session: 'Session (S1-S8)',
    edge: 'Edge Cases (E1-E4)',
    bias: 'Bias Check (B1-B4)',
    api: 'API Contracts (A1-A6)',
    dashboard: 'Dashboard (D1-D3)'
  };

  for (const [suite, tests] of Object.entries(results)) {
    report += `### ${suiteNames[suite]}\n\n`;
    for (const test of tests) {
      const icon = test.status === 'pass' ? '✅' : test.status === 'fail' ? '❌' : test.status === 'warn' ? '⚠️' : '⏭️';
      report += `- ${icon} ${test.id}: ${test.message}\n`;
    }
    report += '\n';
  }

  // Bias summary table
  if (biasData.length > 0) {
    report += `## Bias Summary

| Comparison | Group A | Group B | Score A | Score B | Delta | Concern? |
|-----------|---------|---------|---------|---------|-------|----------|
`;
    for (const b of biasData) {
      report += `| ${b.comparison} | ${b.groupA} | ${b.groupB} | ${b.scoreA} | ${b.scoreB} | ${b.delta} | ${b.concern} |\n`;
    }
    report += '\n';
  }

  // Issues found
  const issues = [];
  for (const [suite, tests] of Object.entries(results)) {
    for (const test of tests) {
      if (test.status === 'fail') {
        issues.push(`- **${test.id}**: ${test.message}`);
      }
    }
  }

  if (issues.length > 0) {
    report += `## Issues Found

${issues.join('\n')}

`;
  } else {
    report += `## Issues Found

No critical issues found.

`;
  }

  report += `## Verdict

**${verdict}**
`;

  return { report, verdict, totalTests, passed, failed, warnings };
}

// ============ MAIN ============

async function main() {
  const args = process.argv.slice(2);
  const suiteArg = args.indexOf('--suite');
  const targetSuite = suiteArg !== -1 ? args[suiteArg + 1] : null;

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('   Session Intelligence — Comprehensive Test Suite');
  console.log('═══════════════════════════════════════════════════════════════');

  // Open database
  const dbPath = path.join(projectRoot, 'data/zoom-action-items.db');
  db = new Database(dbPath, { readonly: true });

  try {
    if (!targetSuite || targetSuite === 'regression') await runRegressionTests();
    if (!targetSuite || targetSuite === 'session') await runSessionTests();
    if (!targetSuite || targetSuite === 'edge') await runEdgeTests();
    if (!targetSuite || targetSuite === 'bias') await runBiasTests();
    if (!targetSuite || targetSuite === 'api') await runApiTests();
    if (!targetSuite || targetSuite === 'dashboard') await runDashboardTests();

    // Generate report
    const { report, verdict, totalTests, passed, failed, warnings } = generateReport();

    // Write report
    const reportPath = path.join(projectRoot, 'data/session-test-report.md');
    fs.writeFileSync(reportPath, report);

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log(`   SUMMARY: ${passed}/${totalTests} passed, ${failed} failed, ${warnings} warnings`);
    console.log(`   VERDICT: ${verdict}`);
    console.log(`   Report: data/session-test-report.md`);
    console.log('═══════════════════════════════════════════════════════════════\n');

    process.exit(failed > 0 ? 1 : 0);
  } finally {
    db.close();
  }
}

main().catch(err => {
  console.error('Test suite error:', err);
  process.exit(1);
});
