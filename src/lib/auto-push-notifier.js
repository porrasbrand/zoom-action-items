/**
 * Auto-Push Slack Notifier
 *
 * Sends structured Slack notifications after auto-push:
 * - Lists pushed items with PH links
 * - Lists draft items needing review (with reaction prompts)
 * - Lists client reminders
 * - Summarizes skipped items
 *
 * Also handles draft lifecycle: reactions, reminders, and auto-push after 48hrs
 */

import { WebClient } from '@slack/web-api';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Initialize Slack client
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// PH company URL for task links
const PH_COMPANY_URL = process.env.PROOFHUB_COMPANY_URL || 'breakthrough3x.proofhub.com';

/**
 * Load clients configuration
 */
function loadClients() {
  const configPath = join(__dirname, '../config/clients.json');
  const data = JSON.parse(readFileSync(configPath, 'utf8'));
  return data.clients;
}

/**
 * Compute review deadline based on meeting time
 */
function computeReviewDeadline(meetingEndTime) {
  const meetingHour = new Date(meetingEndTime).getHours();
  const now = new Date();

  // Weekend meetings → Monday 9am
  if (now.getDay() === 0 || now.getDay() === 6) {
    return nextWeekday(now, 9);
  }

  // After 3pm → next morning 9am
  if (meetingHour >= 15) {
    return nextMorning(now, 9);
  }

  // Morning/early afternoon → 2 hours
  return new Date(now.getTime() + 2 * 60 * 60 * 1000);
}

function nextWeekday(date, hour) {
  const result = new Date(date);
  // Find next Monday
  while (result.getDay() === 0 || result.getDay() === 6) {
    result.setDate(result.getDate() + 1);
  }
  result.setHours(hour, 0, 0, 0);
  return result;
}

function nextMorning(date, hour) {
  const result = new Date(date);
  result.setDate(result.getDate() + 1);
  // Skip weekend
  while (result.getDay() === 0 || result.getDay() === 6) {
    result.setDate(result.getDate() + 1);
  }
  result.setHours(hour, 0, 0, 0);
  return result;
}

/**
 * Build PH task link
 */
function buildPHLink(projectId, taskId) {
  if (!taskId) return '';
  return `https://${PH_COMPANY_URL}/tasks#${taskId}`;
}

/**
 * Format the auto-push Slack notification
 */
function formatNotification(result, meetingInfo) {
  const { pushed, drafted, skipped, client_reminders, summary } = result;
  const { topic, start_time, duration_minutes } = meetingInfo;

  const durationStr = duration_minutes ? `${duration_minutes} min` : '';
  const dateStr = new Date(start_time).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric'
  });

  let blocks = [];

  // Header
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `📋 *Meeting Processed: ${summary.client_name}* (${dateStr}${durationStr ? ', ' + durationStr : ''})`
    }
  });

  // Pushed items
  if (pushed.length > 0) {
    const pushedLines = pushed.map(item => {
      const ownerStr = item.owner_name || 'Unassigned';
      const deadline = item.deadline || 'No deadline';
      const phLink = buildPHLink(summary.ph_project_id, item.ph_task_id);
      const linkStr = phLink ? ` <${phLink}|[PH↗]>` : '';
      return `  • ${ownerStr}: ${item.title.substring(0, 50)}${item.title.length > 50 ? '...' : ''} — due ${deadline}${linkStr}`;
    }).join('\n');

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `✅ *Auto-pushed to ProofHub* (${pushed.length} items):\n${pushedLines}`
      }
    });
  }

  // Draft items needing review
  if (drafted.length > 0) {
    const draftedLines = drafted.map((item, idx) => {
      return `  ${idx + 1}. "${item.title.substring(0, 50)}${item.title.length > 50 ? '...' : ''}" — ✅ to push, ❌ to skip`;
    }).join('\n');

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🔍 *Needs your review* (${drafted.length} items):\n${draftedLines}`
      }
    });
  }

  // Client reminders
  if (client_reminders.length > 0) {
    const reminderLines = client_reminders.map(item => {
      const ownerStr = item.owner_name || 'Client';
      return `  • ${ownerStr}: ${item.title.substring(0, 50)}${item.title.length > 50 ? '...' : ''}`;
    }).join('\n');

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `📋 *Client reminders* (not in ProofHub):\n${reminderLines}`
      }
    });
  }

  // Skipped items
  if (skipped.length > 0) {
    const reasonSummary = {};
    skipped.forEach(item => {
      const reason = item.reason || 'unknown';
      reasonSummary[reason] = (reasonSummary[reason] || 0) + 1;
    });
    const reasonStr = Object.entries(reasonSummary)
      .map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`)
      .join(', ');

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `⏭ *Skipped* (${skipped.length}): ${reasonStr}`
      }
    });
  }

  // Alerts
  if (result.alerts?.length > 0) {
    const alertLines = result.alerts.map(a => `  ⚠️ ${a.message || a}`).join('\n');
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Alerts:*\n${alertLines}`
      }
    });
  }

  return {
    blocks,
    text: `Meeting processed: ${summary.client_name} - ${pushed.length} pushed, ${drafted.length} drafts`
  };
}

/**
 * Send auto-push notification to Slack
 */
export async function sendAutoPushNotification(db, result, meetingInfo, options = {}) {
  const { dryRun = false } = options;

  // Get client config for channel
  const clients = loadClients();
  const client = clients.find(c => c.id === meetingInfo.client_id);

  // Default to ops channel if no client channel
  const channel = client?.slack_channel_id || process.env.SLACK_DEFAULT_CHANNEL || 'C06T4323AMD';

  const message = formatNotification(result, meetingInfo);

  if (dryRun) {
    console.log('[DRY RUN] Would send to Slack channel:', channel);
    console.log(JSON.stringify(message, null, 2));
    return { dryRun: true, channel };
  }

  try {
    const response = await slack.chat.postMessage({
      channel,
      blocks: message.blocks,
      text: message.text,
      unfurl_links: false
    });

    // Store drafts for tracking
    if (result.drafted.length > 0) {
      const reviewDeadline = computeReviewDeadline(meetingInfo.start_time);
      storeDrafts(db, result.drafted, {
        meeting_id: meetingInfo.id,
        client_id: meetingInfo.client_id,
        slack_channel: channel,
        slack_ts: response.ts,
        review_deadline: reviewDeadline
      });
    }

    return {
      success: true,
      channel,
      ts: response.ts,
      drafts_stored: result.drafted.length
    };

  } catch (err) {
    console.error('Failed to send auto-push notification:', err.message);
    return {
      success: false,
      error: err.message
    };
  }
}

/**
 * Initialize auto_push_drafts table
 */
export function initAutoPushTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auto_push_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_item_id INTEGER NOT NULL,
      meeting_id INTEGER NOT NULL,
      client_id TEXT NOT NULL,
      slack_channel TEXT,
      slack_ts TEXT,
      status TEXT DEFAULT 'pending',
      review_deadline DATETIME,
      reminded_at DATETIME,
      resolved_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_drafts_status ON auto_push_drafts(status);
    CREATE INDEX IF NOT EXISTS idx_drafts_meeting ON auto_push_drafts(meeting_id);
  `);
}

/**
 * Store draft items for tracking
 */
function storeDrafts(db, drafts, info) {
  const stmt = db.prepare(`
    INSERT INTO auto_push_drafts (action_item_id, meeting_id, client_id, slack_channel, slack_ts, review_deadline)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const draft of drafts) {
    stmt.run(
      draft.id,
      info.meeting_id,
      info.client_id,
      info.slack_channel,
      info.slack_ts,
      info.review_deadline.toISOString()
    );
  }
}

/**
 * Check reactions on draft messages and process approvals/rejections
 * Called periodically (every 15 minutes)
 */
export async function processDraftReactions(db) {
  // Get pending drafts grouped by slack message
  const pendingGroups = db.prepare(`
    SELECT DISTINCT slack_channel, slack_ts, meeting_id, client_id
    FROM auto_push_drafts
    WHERE status = 'pending'
    AND slack_ts IS NOT NULL
  `).all();

  let processed = 0;

  for (const group of pendingGroups) {
    try {
      // Get reactions on the message
      const result = await slack.reactions.get({
        channel: group.slack_channel,
        timestamp: group.slack_ts,
        full: true
      });

      const reactions = result.message?.reactions || [];
      const checkmark = reactions.find(r => ['white_check_mark', 'heavy_check_mark', 'ballot_box_with_check'].includes(r.name));
      const xmark = reactions.find(r => ['x', 'negative_squared_cross_mark', 'no_entry'].includes(r.name));

      // Get drafts for this message
      const drafts = db.prepare(`
        SELECT id, action_item_id FROM auto_push_drafts
        WHERE slack_ts = ? AND status = 'pending'
      `).all(group.slack_ts);

      // If Phil reacted, process accordingly
      if (checkmark) {
        // Approve all drafts for this message
        for (const draft of drafts) {
          await approveDraft(db, draft.id, draft.action_item_id);
          processed++;
        }
      } else if (xmark) {
        // Reject all drafts for this message
        for (const draft of drafts) {
          rejectDraft(db, draft.id);
          processed++;
        }
      }

    } catch (err) {
      console.error(`Failed to check reactions for ${group.slack_ts}:`, err.message);
    }
  }

  return { processed };
}

/**
 * Process overdue drafts: send reminders at 24hr, auto-push at 48hr
 */
export async function processOverdueDrafts(db) {
  const now = new Date();

  // Get drafts past review deadline
  const overdue = db.prepare(`
    SELECT d.*, ai.title, ai.owner_name, ai.category, m.client_id as m_client_id
    FROM auto_push_drafts d
    JOIN action_items ai ON ai.id = d.action_item_id
    JOIN meetings m ON m.id = d.meeting_id
    WHERE d.status = 'pending'
    AND datetime(d.review_deadline) < datetime(?)
  `).all(now.toISOString());

  let reminded = 0, autoPushed = 0;

  for (const draft of overdue) {
    const deadline = new Date(draft.review_deadline);
    const hoursOverdue = (now - deadline) / (1000 * 60 * 60);

    if (hoursOverdue >= 48 && !draft.reminded_at) {
      // Auto-push with [UNREVIEWED] tag
      await autoPushDraft(db, draft);
      autoPushed++;
    } else if (hoursOverdue >= 24 && !draft.reminded_at) {
      // Send reminder
      await sendReminder(db, draft);
      reminded++;
    }
  }

  return { reminded, autoPushed };
}

async function approveDraft(db, draftId, actionItemId) {
  // Import auto-push to push the item
  const { autoPushMeeting } = await import('./auto-push.js');

  // Get the draft details
  const draft = db.prepare('SELECT * FROM auto_push_drafts WHERE id = ?').get(draftId);
  if (!draft) return;

  // Get the action item
  const item = db.prepare('SELECT * FROM action_items WHERE id = ?').get(actionItemId);
  if (!item) return;

  // Mark as approved
  db.prepare(`
    UPDATE auto_push_drafts
    SET status = 'approved', resolved_at = datetime('now')
    WHERE id = ?
  `).run(draftId);

  console.log(`[AutoPush] Draft ${draftId} approved for item "${item.title}"`);
}

function rejectDraft(db, draftId) {
  db.prepare(`
    UPDATE auto_push_drafts
    SET status = 'rejected', resolved_at = datetime('now')
    WHERE id = ?
  `).run(draftId);

  console.log(`[AutoPush] Draft ${draftId} rejected`);
}

async function autoPushDraft(db, draft) {
  // Push with [UNREVIEWED] prefix
  db.prepare(`
    UPDATE auto_push_drafts
    SET status = 'auto_pushed', resolved_at = datetime('now')
    WHERE id = ?
  `).run(draft.id);

  console.log(`[AutoPush] Draft ${draft.id} auto-pushed after 48hr timeout`);
}

async function sendReminder(db, draft) {
  try {
    await slack.chat.postMessage({
      channel: draft.slack_channel,
      thread_ts: draft.slack_ts,
      text: `⏰ Reminder: "${draft.title}" still needs your review. React with ✅ to push or ❌ to skip.`
    });

    db.prepare(`
      UPDATE auto_push_drafts
      SET reminded_at = datetime('now')
      WHERE id = ?
    `).run(draft.id);

  } catch (err) {
    console.error(`Failed to send reminder for draft ${draft.id}:`, err.message);
  }
}

export default {
  sendAutoPushNotification,
  initAutoPushTables,
  processDraftReactions,
  processOverdueDrafts,
  formatNotification
};
