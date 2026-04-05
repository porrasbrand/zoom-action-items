/**
 * Session Intelligence Queries
 * Comprehensive queries for scorecards, trends, team stats, flags, and digests.
 */

import { getBaselines, getThreshold } from './session-baselines.js';

// All evaluation dimensions
const TIER1_DIMS = ['client_sentiment', 'accountability', 'relationship_health'];
const TIER2_DIMS = ['meeting_structure', 'value_delivery', 'action_discipline', 'proactive_leadership'];
const TIER3_DIMS = ['time_utilization', 'redundancy', 'client_confusion', 'meeting_momentum', 'save_rate'];
const ALL_DIMS = [...TIER1_DIMS, ...TIER2_DIMS, ...TIER3_DIMS];

// B3X team members
const B3X_MEMBERS = ['Dan', 'Phil', 'Joe', 'Richard'];

/**
 * Parse JSON safely
 */
function safeParseJson(str) {
  try {
    const parsed = JSON.parse(str || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Get thresholds for all dimensions based on baselines
 */
function getThresholds(db, scores, clientId = null) {
  // Try client-specific baselines first, then agency
  let baselines = clientId ? getBaselines(db, `client:${clientId}`) : null;
  if (!baselines) {
    baselines = getBaselines(db, 'agency');
  }

  const thresholds = {};
  if (!baselines || !baselines.dimensions) return thresholds;

  for (const dim of [...ALL_DIMS, 'composite_score', 'tier1_avg', 'tier2_avg', 'tier3_avg']) {
    const scoreKey = dim === 'composite_score' ? 'composite' : dim;
    const score = scores[scoreKey] ?? scores[dim];
    const baseline = baselines.dimensions[dim];
    if (baseline && score != null) {
      thresholds[dim] = getThreshold(score, baseline);
    }
  }

  return thresholds;
}

/**
 * 1. getScorecard - Complete scorecard for one meeting
 */
export function getScorecard(db, meetingId) {
  // Get meeting data
  const meeting = db.prepare(`
    SELECT id, topic, client_id, client_name, start_time, duration_minutes
    FROM meetings WHERE id = ?
  `).get(meetingId);

  if (!meeting) return null;

  // Get metrics
  const metrics = db.prepare(`
    SELECT * FROM session_metrics WHERE meeting_id = ?
  `).get(meetingId);

  // Get evaluation
  const evaluation = db.prepare(`
    SELECT * FROM session_evaluations WHERE meeting_id = ? ORDER BY computed_at DESC LIMIT 1
  `).get(meetingId);

  if (!evaluation) {
    return { meeting, metrics, evaluation: null, scores: null, thresholds: null, coaching: null };
  }

  // Build scores object
  const scores = {
    tier1: {
      client_sentiment: evaluation.client_sentiment,
      accountability: evaluation.accountability,
      relationship_health: evaluation.relationship_health,
      avg: evaluation.tier1_avg
    },
    tier2: {
      meeting_structure: evaluation.meeting_structure,
      value_delivery: evaluation.value_delivery,
      action_discipline: evaluation.action_discipline,
      proactive_leadership: evaluation.proactive_leadership,
      avg: evaluation.tier2_avg
    },
    tier3: {
      time_utilization: evaluation.time_utilization,
      redundancy: evaluation.redundancy,
      client_confusion: evaluation.client_confusion,
      meeting_momentum: evaluation.meeting_momentum,
      save_rate: evaluation.save_rate,
      avg: evaluation.tier3_avg
    },
    composite: evaluation.composite_score
  };

  // Get thresholds based on baselines
  const flatScores = { ...scores.tier1, ...scores.tier2, ...scores.tier3, composite: scores.composite };
  const thresholds = getThresholds(db, flatScores, meeting.client_id);

  // Parse coaching data
  const coaching = {
    wins: safeParseJson(evaluation.wins),
    improvements: safeParseJson(evaluation.improvements),
    frustration_moments: safeParseJson(evaluation.frustration_moments),
    coaching_notes: evaluation.coaching_notes
  };

  // Get context averages for comparison
  const clientAvg = meeting.client_id ? db.prepare(`
    SELECT AVG(se.composite_score) as avg
    FROM session_evaluations se
    JOIN meetings m ON m.id = se.meeting_id
    WHERE m.client_id = ? AND se.model_used = 'gpt-5.4'
  `).get(meeting.client_id)?.avg : null;

  const agencyAvg = db.prepare(`
    SELECT AVG(composite_score) as avg
    FROM session_evaluations
    WHERE model_used = 'gpt-5.4'
  `).get()?.avg;

  // FEATURE 1: Prev/Next navigation for same client
  let navigation = { prev: null, next: null, position: null, total: null };
  if (meeting.client_id) {
    // Previous meeting (earlier date, with evaluation)
    const prevMeeting = db.prepare(`
      SELECT m.id, m.start_time FROM meetings m
      WHERE m.client_id = ? AND m.start_time < ?
        AND m.id IN (SELECT DISTINCT meeting_id FROM session_evaluations WHERE model_used = 'gpt-5.4')
      ORDER BY m.start_time DESC LIMIT 1
    `).get(meeting.client_id, meeting.start_time);

    // Next meeting (later date, with evaluation)
    const nextMeeting = db.prepare(`
      SELECT m.id, m.start_time FROM meetings m
      WHERE m.client_id = ? AND m.start_time > ?
        AND m.id IN (SELECT DISTINCT meeting_id FROM session_evaluations WHERE model_used = 'gpt-5.4')
      ORDER BY m.start_time ASC LIMIT 1
    `).get(meeting.client_id, meeting.start_time);

    // Get total count and position
    const totalMeetings = db.prepare(`
      SELECT COUNT(*) as count FROM meetings m
      WHERE m.client_id = ?
        AND m.id IN (SELECT DISTINCT meeting_id FROM session_evaluations WHERE model_used = 'gpt-5.4')
    `).get(meeting.client_id)?.count || 0;

    const position = db.prepare(`
      SELECT COUNT(*) as pos FROM meetings m
      WHERE m.client_id = ? AND m.start_time <= ?
        AND m.id IN (SELECT DISTINCT meeting_id FROM session_evaluations WHERE model_used = 'gpt-5.4')
    `).get(meeting.client_id, meeting.start_time)?.pos || 1;

    navigation = {
      prev: prevMeeting ? { id: prevMeeting.id, date: prevMeeting.start_time } : null,
      next: nextMeeting ? { id: nextMeeting.id, date: nextMeeting.start_time } : null,
      position,
      total: totalMeetings
    };
  }

  // FEATURE 2 & 5: Get previous meeting's evaluation for delta and biggest movers
  let prevComposite = null;
  let biggestMovers = [];
  if (navigation.prev) {
    const prevEval = db.prepare(`
      SELECT * FROM session_evaluations WHERE meeting_id = ? AND model_used = 'gpt-5.4'
    `).get(navigation.prev.id);

    if (prevEval) {
      prevComposite = prevEval.composite_score;

      // FEATURE 5: Compute biggest movers
      const dimensions = [
        'client_sentiment', 'accountability', 'relationship_health',
        'meeting_structure', 'value_delivery', 'action_discipline', 'proactive_leadership',
        'time_utilization', 'redundancy', 'client_confusion', 'meeting_momentum', 'save_rate'
      ];

      const movers = dimensions
        .map(d => ({ dimension: d, delta: (evaluation[d] || 0) - (prevEval[d] || 0) }))
        .filter(m => m.delta !== 0)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
        .slice(0, 3);

      biggestMovers = movers;
    }
  }

  return {
    meeting,
    metrics,
    evaluation,
    scores,
    thresholds,
    coaching,
    meeting_type: evaluation.meeting_type,
    navigation,
    context: {
      client_avg: clientAvg,
      agency_avg: agencyAvg,
      prev_composite: prevComposite,
      biggest_movers: biggestMovers
    }
  };
}

/**
 * Determine trend direction from scores
 */
function getTrendDirection(scores) {
  if (scores.length < 6) return 'insufficient_data';

  const recent3 = scores.slice(0, 3);
  const prev3 = scores.slice(3, 6);

  const recentAvg = recent3.reduce((sum, s) => sum + s.composite, 0) / 3;
  const prevAvg = prev3.reduce((sum, s) => sum + s.composite, 0) / 3;

  const diff = recentAvg - prevAvg;
  if (diff > 0.3) return 'improving';
  if (diff < -0.3) return 'declining';
  return 'stable';
}

/**
 * 2. getClientTrend - Score trend over time for a client
 */
export function getClientTrend(db, clientId, options = {}) {
  const limit = options.limit || 20;

  // Get client name
  const clientInfo = db.prepare(`
    SELECT client_name FROM meetings WHERE client_id = ? LIMIT 1
  `).get(clientId);

  // Get meetings with evaluations for this client
  const meetings = db.prepare(`
    SELECT m.id as meeting_id, m.topic, m.start_time as date,
           se.composite_score as composite, se.tier1_avg, se.tier2_avg, se.tier3_avg,
           se.client_sentiment, se.accountability, se.relationship_health,
           se.meeting_structure, se.value_delivery, se.action_discipline, se.proactive_leadership
    FROM meetings m
    JOIN session_evaluations se ON se.meeting_id = m.id
    WHERE m.client_id = ?
    ORDER BY m.start_time DESC
    LIMIT ?
  `).all(clientId, limit);

  if (meetings.length === 0) {
    return { client_id: clientId, client_name: clientInfo?.client_name, meeting_count: 0, trend: [] };
  }

  // Get baselines
  const baselines = getBaselines(db, `client:${clientId}`) || getBaselines(db, 'agency');
  const baselineComposite = baselines?.dimensions?.composite_score || null;

  // Calculate trend direction
  const trendDirection = getTrendDirection(meetings);

  // Calculate average composite
  const avgComposite = meetings.reduce((sum, m) => sum + m.composite, 0) / meetings.length;

  return {
    client_id: clientId,
    client_name: clientInfo?.client_name || clientId,
    meeting_count: meetings.length,
    trend: meetings.reverse(), // Chronological order
    baselines: baselineComposite,
    trend_direction: trendDirection,
    avg_composite: avgComposite
  };
}

/**
 * Calculate client difficulty tier
 */
function getClientDifficulty(db, clientId) {
  // Get client metrics
  const stats = db.prepare(`
    SELECT
      COUNT(*) as meeting_count,
      AVG(se.composite_score) as avg_composite,
      AVG(se.composite_score * se.composite_score) - AVG(se.composite_score) * AVG(se.composite_score) as score_variance
    FROM meetings m
    JOIN session_evaluations se ON se.meeting_id = m.id
    WHERE m.client_id = ?
  `).get(clientId);

  // Simple heuristic: high meeting count + high variance = difficult
  const meetingFrequency = stats.meeting_count > 10 ? 'high' : stats.meeting_count > 5 ? 'medium' : 'low';
  const variance = Math.sqrt(stats.score_variance || 0);

  if (meetingFrequency === 'high' && variance > 0.5) return 'high';
  if (meetingFrequency === 'low' && variance < 0.3) return 'low';
  return 'medium';
}

/**
 * 3. getTeamStats - Aggregate stats for a B3X team member
 */
export function getTeamStats(db, memberName) {
  // Normalize member name (Phil/Philip)
  const searchName = memberName.toLowerCase() === 'phil' ? '%Phil%' : `%${memberName}%`;

  // Get meetings where this member participated
  const meetings = db.prepare(`
    SELECT m.id, m.topic, m.client_id, m.start_time,
           se.composite_score, se.client_sentiment, se.accountability, se.relationship_health,
           se.meeting_structure, se.value_delivery, se.action_discipline, se.proactive_leadership,
           se.time_utilization, se.redundancy, se.client_confusion, se.meeting_momentum, se.save_rate
    FROM meetings m
    JOIN session_evaluations se ON se.meeting_id = m.id
    WHERE m.ai_extraction LIKE ?
    ORDER BY m.start_time DESC
  `).all(searchName);

  if (meetings.length === 0) {
    return { member: memberName, meetings_led: 0 };
  }

  // Calculate averages
  const avgComposite = meetings.reduce((sum, m) => sum + m.composite_score, 0) / meetings.length;

  const avgByDimension = {};
  for (const dim of ALL_DIMS) {
    const values = meetings.map(m => m[dim]).filter(v => v != null);
    avgByDimension[dim] = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
  }

  // Best and worst meetings
  const sorted = [...meetings].sort((a, b) => b.composite_score - a.composite_score);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];

  // Calculate difficulty-adjusted average
  const clientIds = [...new Set(meetings.map(m => m.client_id))];
  const difficultClients = clientIds.filter(cid => getClientDifficulty(db, cid) === 'high');

  // Compare against agency average for same clients
  let difficultyAdjusted = avgComposite;
  if (difficultClients.length > 0) {
    // Member handles difficult clients, give credit
    difficultyAdjusted = avgComposite + (difficultClients.length * 0.1);
  }

  // Last 10 trend
  const trendLast10 = meetings.slice(0, 10).map(m => ({
    meeting_id: m.id,
    date: m.start_time,
    composite: m.composite_score
  }));

  return {
    member: memberName,
    meetings_led: meetings.length,
    avg_composite: avgComposite,
    avg_by_dimension: avgByDimension,
    best_meeting: best ? { id: best.id, topic: best.topic, composite: best.composite_score, date: best.start_time } : null,
    worst_meeting: worst ? { id: worst.id, topic: worst.topic, composite: worst.composite_score, date: worst.start_time } : null,
    client_difficulty_adjustment: {
      raw_avg: avgComposite,
      difficulty_adjusted_avg: difficultyAdjusted,
      difficult_clients: difficultClients.length,
      note: difficultClients.length > 0
        ? `${memberName} handles ${difficultClients.length} high-difficulty clients`
        : 'No difficulty adjustment needed'
    },
    trend_last_10: trendLast10
  };
}

/**
 * 4. getFlags - Flagged meetings requiring attention
 */
export function getFlags(db, options = {}) {
  const limit = options.limit || 50;

  // Get agency baselines for thresholds
  const baselines = getBaselines(db, 'agency');
  const p25 = baselines?.dimensions?.composite_score?.p25 || 2.0;
  const p50 = baselines?.dimensions?.composite_score?.p50 || 2.5;

  // Get all meetings with evaluations
  const meetings = db.prepare(`
    SELECT m.id as meeting_id, m.topic, m.client_id, m.client_name, m.start_time as date,
           se.composite_score, se.tier1_avg, se.tier2_avg, se.tier3_avg,
           se.client_sentiment, se.accountability, se.relationship_health,
           se.frustration_moments, sm.b3x_stale_items
    FROM meetings m
    JOIN session_evaluations se ON se.meeting_id = m.id
    LEFT JOIN session_metrics sm ON sm.meeting_id = m.id
    ORDER BY m.start_time DESC
    LIMIT ?
  `).all(limit);

  const flags = [];
  let critical = 0, warning = 0;

  for (const m of meetings) {
    const reasons = [];
    let severity = null;

    const frustrations = safeParseJson(m.frustration_moments);

    // Critical flags
    if (m.composite_score < p25) {
      reasons.push(`Composite score ${m.composite_score.toFixed(2)} below P25 (${p25.toFixed(2)})`);
      severity = 'critical';
    }
    if (m.client_sentiment === 1) {
      reasons.push('Client sentiment scored 1 (frustration detected)');
      severity = 'critical';
    }
    if (frustrations.length > 2) {
      reasons.push(`${frustrations.length} frustration moments detected`);
      severity = 'critical';
    }

    // Warning flags (if not already critical)
    if (!severity) {
      if (m.composite_score < p50) {
        reasons.push(`Composite score ${m.composite_score.toFixed(2)} below P50 (${p50.toFixed(2)})`);
        severity = 'warning';
      }
      if (m.accountability === 1 || m.relationship_health === 1) {
        reasons.push('Tier 1 dimension scored 1');
        severity = 'warning';
      }
      if (m.b3x_stale_items > 2) {
        reasons.push(`${m.b3x_stale_items} B3X-owned stale items ignored`);
        severity = severity || 'warning';
      }
    }

    if (severity) {
      flags.push({
        meeting_id: m.meeting_id,
        topic: m.topic,
        client_id: m.client_id,
        client_name: m.client_name,
        date: m.date,
        composite: m.composite_score,
        severity,
        reasons,
        frustration_moments: frustrations
      });

      if (severity === 'critical') critical++;
      else warning++;
    }
  }

  // Sort by severity then date
  flags.sort((a, b) => {
    if (a.severity === 'critical' && b.severity !== 'critical') return -1;
    if (b.severity === 'critical' && a.severity !== 'critical') return 1;
    return new Date(b.date) - new Date(a.date);
  });

  return {
    flags: flags.slice(0, limit),
    summary: {
      critical,
      warning,
      total_meetings: meetings.length
    }
  };
}

/**
 * 5. getBenchmarks - Agency-wide benchmarks
 */
export function getBenchmarks(db) {
  // Agency stats
  const agencyStats = db.prepare(`
    SELECT
      COUNT(*) as meetings_scored,
      AVG(composite_score) as avg_composite
    FROM session_evaluations
  `).get();

  // Get dimension stats from baselines
  const baselines = getBaselines(db, 'agency');
  const dimensions = baselines?.dimensions || {};

  // By client
  const byClient = db.prepare(`
    SELECT
      m.client_id, m.client_name,
      COUNT(*) as meetings,
      AVG(se.composite_score) as avg_composite
    FROM meetings m
    JOIN session_evaluations se ON se.meeting_id = m.id
    WHERE m.client_id != 'unmatched'
    GROUP BY m.client_id
    ORDER BY meetings DESC
  `).all();

  // Add trend direction for each client
  for (const client of byClient) {
    const trend = getClientTrend(db, client.client_id, { limit: 6 });
    client.trend = trend.trend_direction;
  }

  // By member
  const byMember = [];
  for (const member of B3X_MEMBERS) {
    const stats = getTeamStats(db, member);
    if (stats.meetings_led > 0) {
      byMember.push({
        member: stats.member,
        meetings: stats.meetings_led,
        avg_composite: stats.avg_composite,
        difficulty_adjusted: stats.client_difficulty_adjustment.difficulty_adjusted_avg
      });
    }
  }
  byMember.sort((a, b) => b.meetings - a.meetings);

  // Top and bottom meetings
  const topMeetings = db.prepare(`
    SELECT m.id, m.topic, m.client_name, m.start_time as date, se.composite_score as composite
    FROM meetings m
    JOIN session_evaluations se ON se.meeting_id = m.id
    ORDER BY se.composite_score DESC
    LIMIT 5
  `).all();

  const bottomMeetings = db.prepare(`
    SELECT m.id, m.topic, m.client_name, m.start_time as date, se.composite_score as composite
    FROM meetings m
    JOIN session_evaluations se ON se.meeting_id = m.id
    ORDER BY se.composite_score ASC
    LIMIT 5
  `).all();

  return {
    agency: {
      meetings_scored: agencyStats.meetings_scored,
      avg_composite: agencyStats.avg_composite,
      dimensions
    },
    by_client: byClient,
    by_member: byMember,
    top_meetings: topMeetings,
    bottom_meetings: bottomMeetings
  };
}

/**
 * 6. getWeeklyDigest - Weekly digest data
 */
export function getWeeklyDigest(db, weekStart = null) {
  // Calculate week boundaries
  let startDate, endDate;
  if (weekStart) {
    startDate = new Date(weekStart);
  } else {
    // Current week (Monday start)
    const now = new Date();
    const day = now.getDay();
    const diff = day === 0 ? 6 : day - 1;
    startDate = new Date(now);
    startDate.setDate(now.getDate() - diff);
  }
  startDate.setHours(0, 0, 0, 0);
  endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + 7);

  const startStr = startDate.toISOString();
  const endStr = endDate.toISOString();

  // Get meetings in this week
  const meetings = db.prepare(`
    SELECT m.id, m.topic, m.client_id, m.client_name, m.start_time,
           se.composite_score, se.wins, se.improvements, se.coaching_notes,
           se.client_sentiment, se.frustration_moments
    FROM meetings m
    JOIN session_evaluations se ON se.meeting_id = m.id
    WHERE m.start_time >= ? AND m.start_time < ?
    ORDER BY se.composite_score DESC
  `).all(startStr, endStr);

  if (meetings.length === 0) {
    return {
      week: startDate.toISOString().split('T')[0],
      meetings_scored: 0,
      flagged_meetings: [],
      pattern_alerts: [],
      win_of_the_week: null,
      team_snapshot: []
    };
  }

  // Average composite
  const avgComposite = meetings.reduce((sum, m) => sum + m.composite_score, 0) / meetings.length;

  // Flagged meetings (below P50)
  const baselines = getBaselines(db, 'agency');
  const p50 = baselines?.dimensions?.composite_score?.p50 || 2.5;

  const flaggedMeetings = meetings
    .filter(m => m.composite_score < p50)
    .map(m => ({
      meeting_id: m.id,
      topic: m.topic,
      client_name: m.client_name,
      composite: m.composite_score,
      reasons: m.composite_score < p50 ? [`Below P50 (${p50.toFixed(2)})`] : []
    }));

  // Pattern alerts
  const patternAlerts = [];

  // Check for declining clients
  const clientTrends = {};
  for (const m of meetings) {
    if (!clientTrends[m.client_id]) {
      const trend = getClientTrend(db, m.client_id, { limit: 6 });
      clientTrends[m.client_id] = trend;
      if (trend.trend_direction === 'declining') {
        patternAlerts.push({
          type: 'declining_client',
          client: m.client_name,
          detail: `Composite declining over recent meetings (${trend.avg_composite.toFixed(2)} avg)`
        });
      }
    }
  }

  // Win of the week
  const winOfTheWeek = meetings[0]; // Already sorted by composite DESC
  const wins = safeParseJson(winOfTheWeek?.wins);

  // Team snapshot
  const teamSnapshot = [];
  for (const member of B3X_MEMBERS) {
    const searchName = member.toLowerCase() === 'phil' ? '%Phil%' : `%${member}%`;
    const memberMeetings = meetings.filter(m => {
      // Simple check - would be better to check ai_extraction
      return m.topic?.toLowerCase().includes(member.toLowerCase());
    });

    // Actually check ai_extraction for proper attribution
    const memberMeetingsFromDb = db.prepare(`
      SELECT m.id, se.composite_score
      FROM meetings m
      JOIN session_evaluations se ON se.meeting_id = m.id
      WHERE m.start_time >= ? AND m.start_time < ?
      AND m.ai_extraction LIKE ?
    `).all(startStr, endStr, searchName);

    if (memberMeetingsFromDb.length > 0) {
      const avg = memberMeetingsFromDb.reduce((sum, m) => sum + m.composite_score, 0) / memberMeetingsFromDb.length;
      teamSnapshot.push({
        member,
        meetings: memberMeetingsFromDb.length,
        avg
      });
    }
  }
  teamSnapshot.sort((a, b) => b.meetings - a.meetings);

  return {
    week: startDate.toISOString().split('T')[0],
    meetings_scored: meetings.length,
    avg_composite: avgComposite,
    flagged_meetings: flaggedMeetings,
    pattern_alerts: patternAlerts,
    win_of_the_week: winOfTheWeek ? {
      meeting_id: winOfTheWeek.id,
      topic: winOfTheWeek.topic,
      client_name: winOfTheWeek.client_name,
      composite: winOfTheWeek.composite_score,
      highlight: wins[0]?.description || winOfTheWeek.coaching_notes?.slice(0, 100)
    } : null,
    team_snapshot: teamSnapshot
  };
}

/**
 * 7. getAllTeamStats - Aggregate stats for all B3X team members
 */
export function getAllTeamStats(db) {
  const members = [];
  for (const name of B3X_MEMBERS) {
    try {
      const stats = getTeamStats(db, name);
      if (stats && stats.meetings_led > 0) {
        members.push({
          member_name: name,
          member_id: name.toLowerCase(),
          meeting_count: stats.meetings_led,
          raw_avg: stats.avg_composite,
          adjusted_avg: stats.client_difficulty_adjustment?.difficulty_adjusted_avg || stats.avg_composite,
          difficult_clients: stats.client_difficulty_adjustment?.difficult_clients || 0,
          trend_last_10: stats.trend_last_10 || []
        });
      }
    } catch (e) { /* skip member if error */ }
  }
  return { members, adjustment_note: 'Scores adjusted for client difficulty tier' };
}

// ============ CALIBRATION (Phase 17A) ============

// The 10 calibration meeting IDs
const CALIBRATION_MEETING_IDS = [70, 23, 63, 71, 102, 82, 2, 5, 26, 20];

/**
 * 8. getCalibrationStatus - Returns 10 calibration meetings with scored/unscored status
 */
export function getCalibrationStatus(db) {
  const placeholders = CALIBRATION_MEETING_IDS.map(() => '?').join(',');

  // Get meetings with their human calibration status
  const meetings = db.prepare(`
    SELECT m.id, m.topic, m.client_name, m.start_time, m.duration_minutes,
           CASE WHEN se.id IS NOT NULL THEN 1 ELSE 0 END as scored
    FROM meetings m
    LEFT JOIN session_evaluations se ON se.meeting_id = m.id AND se.model_used = 'human-calibration'
    WHERE m.id IN (${placeholders})
    ORDER BY m.id
  `).all(...CALIBRATION_MEETING_IDS);

  const scoredCount = meetings.filter(m => m.scored).length;

  return {
    meetings,
    scored_count: scoredCount,
    total: CALIBRATION_MEETING_IDS.length,
    ready_for_comparison: scoredCount === CALIBRATION_MEETING_IDS.length
  };
}

/**
 * 9. saveCalibrationScores - Validates and saves human calibration scores
 */
export function saveCalibrationScores(db, meetingId, scores, notes = '') {
  // Validate meeting is in calibration set
  if (!CALIBRATION_MEETING_IDS.includes(meetingId)) {
    throw new Error(`Meeting ${meetingId} is not in the calibration set`);
  }

  // Validate all 12 dimensions are present and valid (1-4)
  const requiredDims = [...TIER1_DIMS, ...TIER2_DIMS, ...TIER3_DIMS];
  for (const dim of requiredDims) {
    const score = scores[dim];
    if (score === undefined || score === null) {
      throw new Error(`Missing score for dimension: ${dim}`);
    }
    if (score < 1 || score > 4 || !Number.isInteger(score)) {
      throw new Error(`Invalid score for ${dim}: must be integer 1-4`);
    }
  }

  // Calculate tier averages and composite
  const tier1Scores = TIER1_DIMS.map(d => scores[d]);
  const tier2Scores = TIER2_DIMS.map(d => scores[d]);
  const tier3Scores = TIER3_DIMS.map(d => scores[d]);

  const tier1_avg = tier1Scores.reduce((a, b) => a + b, 0) / tier1Scores.length;
  const tier2_avg = tier2Scores.reduce((a, b) => a + b, 0) / tier2Scores.length;
  const tier3_avg = tier3Scores.reduce((a, b) => a + b, 0) / tier3Scores.length;

  // Composite formula: (tier1 * 0.40) + (tier2 * 0.35) + (tier3 * 0.25)
  const composite_score = (tier1_avg * 0.40) + (tier2_avg * 0.35) + (tier3_avg * 0.25);

  // Insert or replace
  db.prepare(`
    INSERT INTO session_evaluations (
      meeting_id, model_used,
      client_sentiment, accountability, relationship_health,
      meeting_structure, value_delivery, action_discipline, proactive_leadership,
      time_utilization, redundancy, client_confusion, meeting_momentum, save_rate,
      tier1_avg, tier2_avg, tier3_avg, composite_score,
      meeting_type, coaching_notes, computed_at
    ) VALUES (
      ?, 'human-calibration',
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      'calibration', ?, datetime('now')
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
      coaching_notes = excluded.coaching_notes,
      computed_at = datetime('now')
  `).run(
    meetingId,
    scores.client_sentiment, scores.accountability, scores.relationship_health,
    scores.meeting_structure, scores.value_delivery, scores.action_discipline, scores.proactive_leadership,
    scores.time_utilization, scores.redundancy, scores.client_confusion, scores.meeting_momentum, scores.save_rate,
    tier1_avg, tier2_avg, tier3_avg, composite_score,
    notes
  );

  return {
    meeting_id: meetingId,
    scores,
    tier1_avg,
    tier2_avg,
    tier3_avg,
    composite_score,
    notes
  };
}

/**
 * 10. getCalibrationComparison - Computes MAE + Pearson correlation for each AI model vs baseline
 * Uses human-calibration if available, otherwise falls back to consensus-average
 */
export function getCalibrationComparison(db) {
  const placeholders = CALIBRATION_MEETING_IDS.map(() => '?').join(',');
  const dims = [...TIER1_DIMS, ...TIER2_DIMS, ...TIER3_DIMS];

  // Check for human scores first
  const humanScores = db.prepare(`
    SELECT meeting_id, ${dims.join(', ')}, composite_score
    FROM session_evaluations
    WHERE meeting_id IN (${placeholders}) AND model_used = 'human-calibration'
  `).all(...CALIBRATION_MEETING_IDS);

  // Check for consensus scores as fallback
  const consensusScores = db.prepare(`
    SELECT meeting_id, ${dims.join(', ')}, composite_score
    FROM session_evaluations
    WHERE meeting_id IN (${placeholders}) AND model_used = 'consensus-average'
  `).all(...CALIBRATION_MEETING_IDS);

  // Determine which baseline to use
  let baselineScores = humanScores;
  let baselineType = 'human-calibration';

  if (humanScores.length < CALIBRATION_MEETING_IDS.length) {
    // Not all human scores available, check consensus
    if (consensusScores.length === CALIBRATION_MEETING_IDS.length) {
      baselineScores = consensusScores;
      baselineType = 'consensus-average';
    } else if (humanScores.length === 0 && consensusScores.length === 0) {
      // No baseline available
      return {
        ready: false,
        scored: 0,
        remaining: CALIBRATION_MEETING_IDS.length,
        message: 'No baseline scores available. Run consensus calibration script or score meetings manually.'
      };
    } else {
      // Partial human scores, no full consensus
      return {
        ready: false,
        scored: humanScores.length,
        remaining: CALIBRATION_MEETING_IDS.length - humanScores.length,
        message: `Score ${CALIBRATION_MEETING_IDS.length - humanScores.length} more meetings to unlock comparison`
      };
    }
  }

  // Get all AI model evaluations for these meetings (excluding baseline types)
  const aiModels = db.prepare(`
    SELECT DISTINCT model_used FROM session_evaluations
    WHERE meeting_id IN (${placeholders})
    AND model_used NOT IN ('human-calibration', 'consensus-average')
  `).all(...CALIBRATION_MEETING_IDS).map(r => r.model_used);

  const results = [];

  for (const modelId of aiModels) {
    const aiScores = db.prepare(`
      SELECT meeting_id, ${dims.join(', ')}, composite_score
      FROM session_evaluations
      WHERE meeting_id IN (${placeholders}) AND model_used = ?
    `).all(...CALIBRATION_MEETING_IDS, modelId);

    // Create lookup for AI scores by meeting_id
    const aiByMeeting = {};
    for (const ai of aiScores) {
      aiByMeeting[ai.meeting_id] = ai;
    }

    // Calculate MAE and collect data for Pearson correlation
    let totalAbsError = 0;
    let dataPoints = 0;
    const baselineVec = [];
    const aiVec = [];
    const perDimMAE = {};
    dims.forEach(d => perDimMAE[d] = { total: 0, count: 0 });

    // Per-meeting breakdown for heatmap
    const perMeeting = [];

    for (const baseline of baselineScores) {
      const ai = aiByMeeting[baseline.meeting_id];
      if (!ai) continue;

      const meetingDiffs = {};
      for (const dim of dims) {
        const baselineVal = baseline[dim];
        const aiVal = ai[dim];
        if (baselineVal != null && aiVal != null) {
          const diff = Math.abs(baselineVal - aiVal);
          totalAbsError += diff;
          dataPoints++;
          baselineVec.push(baselineVal);
          aiVec.push(aiVal);
          perDimMAE[dim].total += diff;
          perDimMAE[dim].count++;
          meetingDiffs[dim] = { human: baselineVal, ai: aiVal, diff };
        }
      }

      perMeeting.push({
        meeting_id: baseline.meeting_id,
        human_composite: baseline.composite_score,
        ai_composite: ai.composite_score,
        dimensions: meetingDiffs
      });
    }

    // MAE
    const mae = dataPoints > 0 ? totalAbsError / dataPoints : null;

    // Pearson correlation
    let correlation = null;
    if (baselineVec.length > 1) {
      const n = baselineVec.length;
      const sumX = baselineVec.reduce((a, b) => a + b, 0);
      const sumY = aiVec.reduce((a, b) => a + b, 0);
      const sumXY = baselineVec.reduce((acc, x, i) => acc + x * aiVec[i], 0);
      const sumX2 = baselineVec.reduce((acc, x) => acc + x * x, 0);
      const sumY2 = aiVec.reduce((acc, y) => acc + y * y, 0);

      const numerator = n * sumXY - sumX * sumY;
      const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
      correlation = denominator !== 0 ? numerator / denominator : 0;
    }

    // Per-dimension MAE
    const dimensionMAE = {};
    let closestDims = [];
    let furthestDims = [];

    for (const dim of dims) {
      const d = perDimMAE[dim];
      dimensionMAE[dim] = d.count > 0 ? d.total / d.count : null;
    }

    // Find closest and furthest dimensions
    const sortedDims = dims
      .filter(d => dimensionMAE[d] !== null)
      .sort((a, b) => dimensionMAE[a] - dimensionMAE[b]);

    closestDims = sortedDims.slice(0, 3);
    furthestDims = sortedDims.slice(-3).reverse();

    results.push({
      model: modelId,
      mae,
      correlation,
      data_points: dataPoints,
      closest_dims: closestDims,
      furthest_dims: furthestDims,
      dimension_mae: dimensionMAE,
      per_meeting: perMeeting
    });
  }

  // Sort by MAE (lowest = best)
  results.sort((a, b) => (a.mae || 999) - (b.mae || 999));

  // Determine winner
  const winner = results[0];
  const baselineLabel = baselineType === 'human-calibration' ? 'human judgment' : 'consensus (avg of 4 models)';

  return {
    ready: true,
    baseline_type: baselineType,
    models: results,
    winner: winner ? {
      model: winner.model,
      mae: winner.mae,
      correlation: winner.correlation,
      verdict: `${winner.model} most closely matches ${baselineLabel} with MAE of ${winner.mae?.toFixed(3)} and correlation of ${winner.correlation?.toFixed(3)}`
    } : null,
    baseline_scores: baselineScores
  };
}

/**
 * 11. getCalibrationMeetingData - Get meeting data for calibration form
 */
export function getCalibrationMeetingData(db, meetingId) {
  if (!CALIBRATION_MEETING_IDS.includes(meetingId)) {
    return null;
  }

  const meeting = db.prepare(`
    SELECT id, topic, client_name, start_time, duration_minutes, transcript_raw, ai_extraction
    FROM meetings WHERE id = ?
  `).get(meetingId);

  if (!meeting) return null;

  // Get existing human calibration scores if any
  const existingScores = db.prepare(`
    SELECT * FROM session_evaluations
    WHERE meeting_id = ? AND model_used = 'human-calibration'
  `).get(meetingId);

  // Parse ai_extraction for summary and action items
  let summary = '';
  let actionItems = [];
  try {
    const extraction = JSON.parse(meeting.ai_extraction || '{}');
    const data = Array.isArray(extraction) ? extraction[0] : extraction;
    summary = data.summary || '';
    actionItems = (data.action_items || []).slice(0, 15).map(ai => ({
      title: ai.title,
      owner: ai.owner_name || ai.owner,
      priority: ai.priority
    }));
  } catch (e) { /* ignore parse errors */ }

  return {
    meeting: {
      id: meeting.id,
      topic: meeting.topic,
      client_name: meeting.client_name,
      start_time: meeting.start_time,
      duration_minutes: meeting.duration_minutes
    },
    summary,
    action_items: actionItems,
    transcript: meeting.transcript_raw || '',
    existing_scores: existingScores ? {
      client_sentiment: existingScores.client_sentiment,
      accountability: existingScores.accountability,
      relationship_health: existingScores.relationship_health,
      meeting_structure: existingScores.meeting_structure,
      value_delivery: existingScores.value_delivery,
      action_discipline: existingScores.action_discipline,
      proactive_leadership: existingScores.proactive_leadership,
      time_utilization: existingScores.time_utilization,
      redundancy: existingScores.redundancy,
      client_confusion: existingScores.client_confusion,
      meeting_momentum: existingScores.meeting_momentum,
      save_rate: existingScores.save_rate,
      notes: existingScores.coaching_notes
    } : null
  };
}

export default {
  getScorecard,
  getClientTrend,
  getTeamStats,
  getAllTeamStats,
  getFlags,
  getBenchmarks,
  getWeeklyDigest,
  getCalibrationStatus,
  saveCalibrationScores,
  getCalibrationComparison,
  getCalibrationMeetingData,
  CALIBRATION_MEETING_IDS
};
