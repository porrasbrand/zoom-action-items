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
const B3X_MEMBERS = ['Dan', 'Philip', 'Phil', 'Joe', 'Richard'];

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

  return {
    meeting,
    metrics,
    evaluation,
    scores,
    thresholds,
    coaching,
    meeting_type: evaluation.meeting_type
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

export default {
  getScorecard,
  getClientTrend,
  getTeamStats,
  getAllTeamStats,
  getFlags,
  getBenchmarks,
  getWeeklyDigest
};
