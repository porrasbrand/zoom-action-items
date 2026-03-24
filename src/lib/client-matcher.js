/**
 * Match a Zoom meeting topic to a client using keyword rules.
 * Adapted from B3X Zoom2DriveMin N8N workflow.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = join(__dirname, '..', 'config', 'clients.json');

let clientsCache = null;

function loadClients() {
  if (!clientsCache) {
    clientsCache = JSON.parse(readFileSync(configPath, 'utf-8')).clients;
  }
  return clientsCache;
}

/**
 * Normalize text for matching: lowercase, remove accents, replace non-alphanumeric with space.
 */
function normalize(text) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if all tokens of a keyword appear as whole words in the topic.
 */
function keywordMatches(normalizedTopic, keyword) {
  const tokens = normalize(keyword).split(' ').filter(Boolean);
  return tokens.every(token => {
    const rx = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    return rx.test(normalizedTopic);
  });
}

// Keywords that indicate an internal B3X meeting (not a client meeting)
const INTERNAL_KEYWORDS = [
  'huddle',
  'b3x',
  'internal',
  'standup',
  'stand-up',
  'team meeting',
  'weekly sync',
  'weekly meeting',
  'team sync',
  'all hands',
  'company meeting',
];

/**
 * Check if a meeting topic indicates an internal B3X meeting.
 * @param {string} topic - Zoom meeting topic
 * @returns {boolean}
 */
export function isInternalMeeting(topic) {
  if (!topic) return false;
  const normalizedTopic = normalize(topic);

  for (const keyword of INTERNAL_KEYWORDS) {
    if (keywordMatches(normalizedTopic, keyword)) {
      return true;
    }
  }
  return false;
}

/**
 * Match a meeting topic to a client.
 * @param {string} topic - Zoom meeting topic
 * @returns {{ id: string, name: string, slack_channel_id: string, slack_channel_name: string, ph_project_id: string, internal: boolean } | null}
 */
export function matchClient(topic) {
  if (!topic) return null;

  const clients = loadClients();
  const normalizedTopic = normalize(topic);

  for (const client of clients) {
    for (const keyword of client.keywords) {
      if (keywordMatches(normalizedTopic, keyword)) {
        return {
          id: client.id,
          name: client.name,
          slack_channel_id: client.slack_channel_id || '',
          slack_channel_name: client.slack_channel_name || '',
          ph_project_id: client.ph_project_id || '',
          internal: client.internal || false,
        };
      }
    }
  }

  // Check if it's an internal meeting (not a client match)
  if (isInternalMeeting(topic)) {
    return {
      id: 'internal',
      name: 'B3X Internal',
      slack_channel_id: '',
      slack_channel_name: 'zoom-internal',
      ph_project_id: '',
      internal: true,
    };
  }

  return null;
}

/**
 * Get all configured clients.
 */
export function getAllClients() {
  return loadClients();
}
