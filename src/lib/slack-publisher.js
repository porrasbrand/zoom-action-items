/**
 * Format and post meeting summaries to Slack with channel routing.
 */

import { WebClient } from '@slack/web-api';

let slackClient = null;

// Triage channel names (will try by name if ID not configured)
const CHANNEL_UNMATCHED = process.env.SLACK_CHANNEL_UNMATCHED || 'zoom-unmatched';
const CHANNEL_INTERNAL = process.env.SLACK_CHANNEL_INTERNAL || 'zoom-internal';
const CHANNEL_FALLBACK = process.env.SLACK_DEFAULT_CHANNEL || 'zoom-meeting-notes';

export function getClient() {
  if (!slackClient) {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) throw new Error('Missing SLACK_BOT_TOKEN');
    slackClient = new WebClient(token);
  }
  return slackClient;
}

/**
 * Determine which channel to post to based on client match.
 * @param {object} client - Matched client object (or null)
 * @param {boolean} isInternal - Whether it's an internal meeting
 * @returns {{ channelId: string, channelName: string, routing: string }}
 */
export function resolveChannel(client, isInternal = false) {
  // Internal B3X meeting → zoom-internal
  if (isInternal || client?.internal) {
    return {
      channelId: '',
      channelName: CHANNEL_INTERNAL,
      routing: 'internal',
    };
  }

  // Matched client with configured channel
  if (client?.slack_channel_id) {
    return {
      channelId: client.slack_channel_id,
      channelName: client.slack_channel_name || '',
      routing: 'client',
    };
  }

  // Matched client without configured channel → fallback
  if (client) {
    return {
      channelId: '',
      channelName: CHANNEL_FALLBACK,
      routing: 'client-no-channel',
    };
  }

  // Unmatched meeting → zoom-unmatched
  return {
    channelId: '',
    channelName: CHANNEL_UNMATCHED,
    routing: 'unmatched',
  };
}

/**
 * Format extraction data into a Slack message.
 */
export function formatSlackMessage({ topic, clientName, meetingDate, extraction, isInternal = false }) {
  const { summary, attendees = [], action_items = [], decisions = [], next_meeting_notes } = extraction;

  const date = meetingDate ? new Date(meetingDate).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  }) : 'Unknown date';

  const lines = [];

  // Header - different format for internal meetings
  if (isInternal) {
    lines.push(`*:house: Internal Meeting: ${topic} (${date})*`);
  } else {
    lines.push(`*:clipboard: Meeting Notes: ${clientName} — ${topic} (${date})*`);
  }

  if (attendees.length) {
    lines.push(`:busts_in_silhouette: ${attendees.join(', ')}`);
  }
  lines.push('');

  // Summary
  if (summary) {
    lines.push('*SUMMARY*');
    lines.push(summary);
    lines.push('');
  }

  // Action Items
  if (action_items.length) {
    lines.push('*:white_check_mark: ACTION ITEMS*');
    for (const item of action_items) {
      const priority = item.priority === 'high' ? ' :red_circle:' : item.priority === 'medium' ? ' :large_orange_circle:' : '';
      const due = item.due_date ? ` (due: ${new Date(item.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})` : '';
      const owner = item.owner || 'TBD';
      lines.push(`• *${owner}* — ${item.title}${due}${priority}`);
    }
    lines.push('');
  }

  // Decisions
  if (decisions.length) {
    lines.push('*:pushpin: DECISIONS*');
    for (const d of decisions) {
      lines.push(`• ${d.decision}`);
    }
    lines.push('');
  }

  // Next meeting notes
  if (next_meeting_notes) {
    lines.push('*:spiral_notepad: NEXT MEETING*');
    lines.push(next_meeting_notes);
  }

  return lines.join('\n');
}

/**
 * Try to post to a channel, with fallback on failure.
 * @returns {{ ts: string, channel: string, actualChannel: string, usedFallback: boolean }}
 */
async function tryPostWithFallback(client, targetChannel, text, fallbackChannel) {
  try {
    const result = await client.chat.postMessage({
      channel: targetChannel,
      text,
      unfurl_links: false,
      unfurl_media: false,
    });
    return { ts: result.ts, channel: result.channel, actualChannel: targetChannel, usedFallback: false };
  } catch (err) {
    // If target failed, try fallback
    if (fallbackChannel && fallbackChannel !== targetChannel) {
      console.warn(`Channel ${targetChannel} failed (${err.data?.error}), trying fallback: ${fallbackChannel}`);
      try {
        const result = await client.chat.postMessage({
          channel: fallbackChannel,
          text: text + `\n\n_:warning: Originally targeted: ${targetChannel}_`,
          unfurl_links: false,
          unfurl_media: false,
        });
        return { ts: result.ts, channel: result.channel, actualChannel: fallbackChannel, usedFallback: true };
      } catch (fallbackErr) {
        throw new Error(`Both ${targetChannel} and fallback ${fallbackChannel} failed: ${fallbackErr.data?.error || fallbackErr.message}`);
      }
    }
    throw err;
  }
}

/**
 * Post meeting summary to a Slack channel with routing and fallback.
 * @returns {{ ts: string, channel: string, routing: string, usedFallback: boolean }}
 */
export async function postToSlack({ channelId, topic, clientName, meetingDate, extraction, client, isInternal = false }) {
  const slackClient = getClient();

  // Resolve channel based on client match
  const { channelId: resolvedId, channelName, routing } = resolveChannel(client, isInternal);

  // Use provided channelId, or resolved ID, or resolved name
  const targetChannel = channelId || resolvedId || channelName;

  const text = formatSlackMessage({ topic, clientName, meetingDate, extraction, isInternal });

  const result = await tryPostWithFallback(slackClient, targetChannel, text, CHANNEL_FALLBACK);

  return {
    ts: result.ts,
    channel: result.channel,
    routing,
    usedFallback: result.usedFallback,
  };
}

/**
 * Post an error/alert message to the alerts channel.
 */
export async function postAlert(message) {
  const client = getClient();
  const channel = process.env.SLACK_ALERT_CHANNEL || 'zoom-pipeline-alerts';

  try {
    await client.chat.postMessage({
      channel,
      text: `:warning: *Zoom Pipeline Alert*\n${message}`,
    });
  } catch (err) {
    console.error('Failed to post alert to Slack:', err.message);
  }
}

/**
 * Verify bot has access to a channel.
 * @returns {{ accessible: boolean, error?: string }}
 */
export async function verifyChannelAccess(channelId) {
  const client = getClient();

  try {
    // Try to get conversation info
    await client.conversations.info({ channel: channelId });
    return { accessible: true };
  } catch (err) {
    return { accessible: false, error: err.data?.error || err.message };
  }
}

/**
 * Test Slack API connectivity.
 * @returns {{ ok: boolean, user: string, team: string }}
 */
export async function testSlackConnection() {
  const client = getClient();
  const result = await client.auth.test();
  return { ok: result.ok, user: result.user, team: result.team };
}
