/**
 * Session Intelligence Digest
 * Weekly digests, coaching cards, pattern alerts, and Slack formatting.
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { getWeeklyDigest, getScorecard, getClientTrend, getFlags } from './session-queries.js';
import { getBaselines } from './session-baselines.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../data/zoom-action-items.db');

// B3X team members
const B3X_MEMBERS = ['Dan', 'Philip', 'Phil', 'Joe', 'Richard'];

/**
 * Get database connection
 */
function getDb() {
  return new Database(DB_PATH, { readonly: true });
}

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
 * Generate weekly digest with enhanced pattern alerts
 */
export async function generateWeeklyDigest(weekStart = null) {
  const db = getDb();
  try {
    // Get base digest data
    const digest = getWeeklyDigest(db, weekStart);

    // Enhance with additional pattern alerts
    const additionalAlerts = detectPatternAlerts(4, db);
    digest.pattern_alerts = [...(digest.pattern_alerts || []), ...additionalAlerts];

    // Add flags summary
    const flagsData = getFlags(db, { limit: 20 });
    digest.flags_summary = flagsData.summary;
    digest.critical_flags = flagsData.flags.filter(f => f.severity === 'critical').slice(0, 5);
    digest.warning_flags = flagsData.flags.filter(f => f.severity === 'warning').slice(0, 5);

    return digest;
  } finally {
    db.close();
  }
}

/**
 * Generate per-meeting coaching card
 */
export async function generateMeetingCoaching(meetingId) {
  const db = getDb();
  try {
    const scorecard = getScorecard(db, meetingId);
    if (!scorecard || !scorecard.evaluation) {
      return null;
    }

    const { meeting, metrics, evaluation, scores, coaching } = scorecard;

    // Get baselines for threshold
    const baselines = getBaselines(db, 'agency');
    const p25 = baselines?.dimensions?.composite_score?.p25 || 2.0;
    const p50 = baselines?.dimensions?.composite_score?.p50 || 2.5;
    const p75 = baselines?.dimensions?.composite_score?.p75 || 3.0;

    let threshold = 'yellow';
    if (evaluation.composite_score >= p75) threshold = 'green';
    else if (evaluation.composite_score < p25) threshold = 'red';

    // Parse coaching data
    const wins = safeParseJson(evaluation.wins);
    const improvements = safeParseJson(evaluation.improvements);
    const frustrationMoments = safeParseJson(evaluation.frustration_moments);

    // Determine B3X lead from metrics
    const b3xLead = metrics?.dominant_speaker || 'Unknown';

    // Get stale items from metrics
    const staleItems = metrics?.b3x_stale_items || 0;

    // Build specific coaching text
    let specificCoaching = '';
    if (threshold === 'red') {
      specificCoaching = `This meeting scored below expectations. Focus on: `;
      if (evaluation.accountability < 2) specificCoaching += 'accountability (review prior commitments at start), ';
      if (evaluation.action_discipline < 2) specificCoaching += 'action discipline (ensure clear next steps), ';
      if (evaluation.value_delivery < 2) specificCoaching += 'value delivery (demonstrate concrete results).';
    } else if (threshold === 'yellow') {
      specificCoaching = `Room for improvement: `;
      const lowDims = [];
      if (evaluation.accountability < 3) lowDims.push('accountability');
      if (evaluation.action_discipline < 3) lowDims.push('action discipline');
      if (evaluation.proactive_leadership < 3) lowDims.push('proactive leadership');
      specificCoaching += lowDims.join(', ') || 'maintain consistency across all dimensions.';
    } else {
      specificCoaching = `Strong meeting. Continue emphasizing value delivery and proactive recommendations.`;
    }

    // Build prep for next meeting
    let prepForNext = '';
    if (staleItems > 0) {
      prepForNext = `Address ${staleItems} stale B3X-owned items from prior meetings. `;
    }
    if (improvements.length > 0 && improvements[0].suggestion) {
      prepForNext += improvements[0].suggestion;
    }

    return {
      meeting: {
        id: meeting.id,
        topic: meeting.topic,
        client_name: meeting.client_name,
        date: meeting.start_time,
        b3x_lead: b3xLead,
        duration_minutes: meeting.duration_minutes
      },
      composite_score: evaluation.composite_score,
      threshold,
      tier_scores: {
        tier1: evaluation.tier1_avg,
        tier2: evaluation.tier2_avg,
        tier3: evaluation.tier3_avg
      },
      dimension_scores: {
        client_sentiment: evaluation.client_sentiment,
        accountability: evaluation.accountability,
        relationship_health: evaluation.relationship_health,
        meeting_structure: evaluation.meeting_structure,
        value_delivery: evaluation.value_delivery,
        action_discipline: evaluation.action_discipline,
        proactive_leadership: evaluation.proactive_leadership,
        time_utilization: evaluation.time_utilization,
        redundancy: evaluation.redundancy,
        client_confusion: evaluation.client_confusion,
        meeting_momentum: evaluation.meeting_momentum,
        save_rate: evaluation.save_rate
      },
      top_wins: wins.slice(0, 2).map(w => ({
        description: w.description || w.moment || 'Win',
        quote: w.quote || w.transcript_quote || '',
        dimension: w.dimension || ''
      })),
      top_improvements: improvements.slice(0, 2).map(i => ({
        description: i.description || i.area || 'Improvement needed',
        quote: i.quote || i.transcript_quote || '',
        suggestion: i.suggestion || '',
        dimension: i.dimension || ''
      })),
      frustration_moments: frustrationMoments.slice(0, 2).map(f => ({
        speaker: f.speaker || 'Client',
        description: f.description || '',
        quote: f.quote || '',
        recovered: f.recovered
      })),
      specific_coaching: specificCoaching,
      prep_for_next: prepForNext || 'Review recent meeting notes and prepare status updates.',
      coaching_notes: evaluation.coaching_notes,
      metrics: {
        action_items: metrics?.action_item_count || 0,
        action_density: metrics?.action_density || 0,
        b3x_speaking_ratio: metrics?.speaker_ratio_b3x || 0,
        stale_items: staleItems
      }
    };
  } finally {
    db.close();
  }
}

/**
 * Detect pattern alerts across recent meetings
 */
export function detectPatternAlerts(lookbackWeeks = 4, existingDb = null) {
  const db = existingDb || getDb();
  const shouldClose = !existingDb;

  try {
    const alerts = [];
    const lookbackDate = new Date();
    lookbackDate.setDate(lookbackDate.getDate() - (lookbackWeeks * 7));
    const lookbackStr = lookbackDate.toISOString();

    // 1. Declining clients (3+ meetings with decreasing composite)
    const clientScores = db.prepare(`
      SELECT m.client_id, m.client_name, m.id, se.composite_score, m.start_time
      FROM meetings m
      JOIN session_evaluations se ON se.meeting_id = m.id
      WHERE m.start_time >= ?
      ORDER BY m.client_id, m.start_time DESC
    `).all(lookbackStr);

    const byClient = {};
    for (const m of clientScores) {
      if (!byClient[m.client_id]) byClient[m.client_id] = [];
      byClient[m.client_id].push(m);
    }

    for (const [clientId, meetings] of Object.entries(byClient)) {
      if (meetings.length >= 3) {
        // Check if scores are declining (first 3 meetings in reverse chronological order)
        const recent3 = meetings.slice(0, 3);
        const declining = recent3[0].composite_score < recent3[1].composite_score &&
                          recent3[1].composite_score < recent3[2].composite_score;
        if (declining) {
          alerts.push({
            type: 'declining_client',
            severity: 'warning',
            client_id: clientId,
            client_name: meetings[0].client_name,
            detail: `3 consecutive meetings with declining scores: ${recent3.map(m => m.composite_score.toFixed(2)).join(' → ')}`
          });
        }
      }
    }

    // 2. Stale accountability (client with 5+ B3X-owned items silent 3+ meetings)
    const staleClients = db.prepare(`
      SELECT m.client_id, m.client_name, COUNT(*) as meetings_with_stale,
             MAX(sm.b3x_stale_items) as max_stale
      FROM meetings m
      JOIN session_metrics sm ON sm.meeting_id = m.id
      WHERE m.start_time >= ? AND sm.b3x_stale_items >= 5
      GROUP BY m.client_id
      HAVING meetings_with_stale >= 3
    `).all(lookbackStr);

    for (const client of staleClients) {
      alerts.push({
        type: 'stale_accountability',
        severity: 'warning',
        client_id: client.client_id,
        client_name: client.client_name,
        detail: `${client.meetings_with_stale} meetings with 5+ stale B3X items (max: ${client.max_stale})`
      });
    }

    // 3. Frustration spike (2+ frustration moments in recent meeting)
    const frustrationMeetings = db.prepare(`
      SELECT m.id, m.topic, m.client_name, se.frustration_moments
      FROM meetings m
      JOIN session_evaluations se ON se.meeting_id = m.id
      WHERE m.start_time >= ? AND se.frustration_moments IS NOT NULL
      ORDER BY m.start_time DESC
      LIMIT 20
    `).all(lookbackStr);

    for (const meeting of frustrationMeetings) {
      const moments = safeParseJson(meeting.frustration_moments);
      if (moments.length >= 2) {
        alerts.push({
          type: 'frustration_spike',
          severity: 'critical',
          meeting_id: meeting.id,
          topic: meeting.topic,
          client_name: meeting.client_name,
          detail: `${moments.length} frustration moments detected`
        });
      }
    }

    // 4. Engagement drop (client speaking ratio dropped below 30%)
    const engagementDrops = db.prepare(`
      SELECT m.client_id, m.client_name,
             AVG(CASE WHEN m.start_time < date('now', '-14 days') THEN sm.speaker_ratio_client END) as prev_ratio,
             AVG(CASE WHEN m.start_time >= date('now', '-14 days') THEN sm.speaker_ratio_client END) as recent_ratio
      FROM meetings m
      JOIN session_metrics sm ON sm.meeting_id = m.id
      WHERE m.start_time >= ?
      GROUP BY m.client_id
      HAVING prev_ratio > 0.4 AND recent_ratio < 0.3
    `).all(lookbackStr);

    for (const client of engagementDrops) {
      alerts.push({
        type: 'engagement_drop',
        severity: 'warning',
        client_id: client.client_id,
        client_name: client.client_name,
        detail: `Client speaking ratio dropped from ${(client.prev_ratio * 100).toFixed(0)}% to ${(client.recent_ratio * 100).toFixed(0)}%`
      });
    }

    // 5. Over-meeting (client with <3 action items for 3+ consecutive meetings)
    for (const [clientId, meetings] of Object.entries(byClient)) {
      if (meetings.length >= 3) {
        // Get action item counts for this client
        const actionCounts = db.prepare(`
          SELECT sm.action_item_count
          FROM session_metrics sm
          JOIN meetings m ON m.id = sm.meeting_id
          WHERE m.client_id = ?
          ORDER BY m.start_time DESC
          LIMIT 3
        `).all(clientId);

        if (actionCounts.length >= 3) {
          const allLowActions = actionCounts.every(m => m.action_item_count < 3);
          if (allLowActions) {
            alerts.push({
              type: 'over_meeting',
              severity: 'info',
              client_id: clientId,
              client_name: meetings[0].client_name,
              detail: `3+ consecutive meetings with <3 action items — consider reducing meeting frequency`
            });
          }
        }
      }
    }

    return alerts;
  } finally {
    if (shouldClose) db.close();
  }
}

/**
 * Format digest for Slack Block Kit
 */
export function formatForSlack(digest) {
  const blocks = [];

  // Header
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: '📊 Session Intelligence — Weekly Digest', emoji: true }
  });

  // Week summary
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Week of ${digest.week}*\n${digest.meetings_scored} meetings scored | Avg: ${digest.avg_composite?.toFixed(2) || 'N/A'}`
    }
  });

  // Flags summary
  if (digest.flags_summary) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*🚩 Flags Summary*\n🔴 Critical: ${digest.flags_summary.critical} | 🟡 Warning: ${digest.flags_summary.warning}`
      }
    });
  }

  // Critical flags
  if (digest.critical_flags?.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Critical Meetings:*\n' + digest.critical_flags.map(f =>
          `• *${f.client_name}* — ${f.topic} (${f.composite.toFixed(2)})\n  ${f.reasons.join(', ')}`
        ).join('\n')
      }
    });
  }

  // Pattern alerts
  if (digest.pattern_alerts?.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*⚠️ Pattern Alerts*\n' + digest.pattern_alerts.map(a =>
          `• *${a.type.replace(/_/g, ' ')}* — ${a.client_name || a.topic || ''}: ${a.detail}`
        ).join('\n')
      }
    });
  }

  // Win of the week
  if (digest.win_of_the_week) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*🏆 Win of the Week*\n*${digest.win_of_the_week.client_name}* — ${digest.win_of_the_week.topic}\nScore: ${digest.win_of_the_week.composite.toFixed(2)}\n${digest.win_of_the_week.highlight || ''}`
      }
    });
  }

  // Team snapshot
  if (digest.team_snapshot?.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*👥 Team Snapshot*\n' + digest.team_snapshot.map(t =>
          `• *${t.member}*: ${t.meetings} meetings, avg ${t.avg.toFixed(2)}`
        ).join('\n')
      }
    });
  }

  // Footer
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `Generated ${new Date().toISOString().split('T')[0]} | Session Intelligence v1.0`
    }]
  });

  return { blocks };
}

/**
 * Format digest as Markdown
 */
export function formatForMarkdown(digest) {
  let md = `# Session Intelligence — Weekly Digest\n\n`;
  md += `**Week of ${digest.week}**\n`;
  md += `${digest.meetings_scored} meetings scored | Average: ${digest.avg_composite?.toFixed(2) || 'N/A'}\n\n`;

  // Flags summary
  if (digest.flags_summary) {
    md += `## Flags Summary\n`;
    md += `- 🔴 Critical: ${digest.flags_summary.critical}\n`;
    md += `- 🟡 Warning: ${digest.flags_summary.warning}\n\n`;
  }

  // Flagged meetings
  if (digest.flagged_meetings?.length > 0) {
    md += `## Flagged Meetings\n\n`;
    for (const f of digest.flagged_meetings) {
      md += `### ${f.client_name} — ${f.topic}\n`;
      md += `Score: ${f.composite.toFixed(2)}\n`;
      md += `Reasons: ${f.reasons.join(', ')}\n\n`;
    }
  }

  // Critical flags
  if (digest.critical_flags?.length > 0) {
    md += `## Critical Flags\n\n`;
    for (const f of digest.critical_flags) {
      md += `- **${f.client_name}** — ${f.topic} (${f.composite.toFixed(2)}): ${f.reasons.join(', ')}\n`;
    }
    md += '\n';
  }

  // Pattern alerts
  if (digest.pattern_alerts?.length > 0) {
    md += `## Pattern Alerts\n\n`;
    for (const a of digest.pattern_alerts) {
      md += `- **${a.type.replace(/_/g, ' ')}** — ${a.client_name || a.topic || ''}: ${a.detail}\n`;
    }
    md += '\n';
  }

  // Win of the week
  if (digest.win_of_the_week) {
    md += `## 🏆 Win of the Week\n\n`;
    md += `**${digest.win_of_the_week.client_name}** — ${digest.win_of_the_week.topic}\n`;
    md += `Score: ${digest.win_of_the_week.composite.toFixed(2)}\n`;
    if (digest.win_of_the_week.highlight) {
      md += `Highlight: ${digest.win_of_the_week.highlight}\n`;
    }
    md += '\n';
  }

  // Team snapshot
  if (digest.team_snapshot?.length > 0) {
    md += `## Team Snapshot\n\n`;
    md += `| Member | Meetings | Avg Score |\n`;
    md += `|--------|----------|----------|\n`;
    for (const t of digest.team_snapshot) {
      md += `| ${t.member} | ${t.meetings} | ${t.avg.toFixed(2)} |\n`;
    }
    md += '\n';
  }

  md += `---\n`;
  md += `*Generated ${new Date().toISOString().split('T')[0]} | Session Intelligence v1.0*\n`;

  return md;
}

/**
 * Format coaching card for Slack
 */
export function formatCoachingForSlack(coaching) {
  if (!coaching) return { blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'No coaching data available' } }] };

  const blocks = [];
  const thresholdEmoji = coaching.threshold === 'green' ? '🟢' : coaching.threshold === 'yellow' ? '🟡' : '🔴';

  // Header
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `📋 Coaching Card — ${coaching.meeting.topic}`, emoji: true }
  });

  // Meeting info
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Client:* ${coaching.meeting.client_name}\n*Date:* ${new Date(coaching.meeting.date).toLocaleDateString()}\n*Lead:* ${coaching.meeting.b3x_lead}\n*Score:* ${thresholdEmoji} ${coaching.composite_score.toFixed(2)}`
    }
  });

  // Wins
  if (coaching.top_wins?.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*✅ Wins*\n' + coaching.top_wins.map(w =>
          `• ${w.description}${w.quote ? `\n  _"${w.quote.slice(0, 100)}..."_` : ''}`
        ).join('\n')
      }
    });
  }

  // Improvements
  if (coaching.top_improvements?.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*📈 Areas for Improvement*\n' + coaching.top_improvements.map(i =>
          `• ${i.description}${i.suggestion ? `\n  💡 ${i.suggestion}` : ''}`
        ).join('\n')
      }
    });
  }

  // Specific coaching
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*🎯 Coaching Focus*\n${coaching.specific_coaching}` }
  });

  // Prep for next
  if (coaching.prep_for_next) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*📝 Prep for Next Meeting*\n${coaching.prep_for_next}` }
    });
  }

  return { blocks };
}

export default {
  generateWeeklyDigest,
  generateMeetingCoaching,
  detectPatternAlerts,
  formatForSlack,
  formatForMarkdown,
  formatCoachingForSlack
};
