/**
 * Format and post meeting summaries to Slack.
 */

import { WebClient } from '@slack/web-api';

let slackClient = null;

function getClient() {
  if (!slackClient) {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) throw new Error('Missing SLACK_BOT_TOKEN');
    slackClient = new WebClient(token);
  }
  return slackClient;
}

/**
 * Format extraction data into a Slack message.
 */
export function formatSlackMessage({ topic, clientName, meetingDate, extraction }) {
  const { summary, attendees = [], action_items = [], decisions = [], next_meeting_notes } = extraction;

  const date = meetingDate ? new Date(meetingDate).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  }) : 'Unknown date';

  const lines = [];

  // Header
  lines.push(`*:clipboard: Meeting Notes: ${clientName} — ${topic} (${date})*`);
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
 * Post meeting summary to a Slack channel.
 * @returns {{ ts: string, channel: string }} Message timestamp and channel
 */
export async function postToSlack({ channelId, topic, clientName, meetingDate, extraction }) {
  const client = getClient();
  const text = formatSlackMessage({ topic, clientName, meetingDate, extraction });

  const result = await client.chat.postMessage({
    channel: channelId,
    text,
    unfurl_links: false,
    unfurl_media: false,
  });

  return { ts: result.ts, channel: result.channel };
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
