/**
 * Prep Data Collector
 * Gathers all inputs needed for AI to generate meeting prep document.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  getRoadmapForClient,
  getActiveRoadmapItems,
  getStaleItems
} from './roadmap-db.js';
import { getTaxonomy } from './roadmap-processor.js';
import { getAllPHLinksForClient, refreshPHCache } from './ph-reconciler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Load client config from clients.json
 */
function getClientConfig(clientId) {
  const configPath = join(__dirname, '..', 'config', 'clients.json');
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  return config.clients.find(c => c.id === clientId) || null;
}

/**
 * Get recently completed roadmap items (last N days)
 */
function getRecentlyCompleted(db, clientId, days = 30) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString();

  const items = db.prepare(`
    SELECT * FROM roadmap_items
    WHERE client_id = ? AND status = 'done'
      AND updated_at >= ?
    ORDER BY updated_at DESC
  `).all(clientId, cutoffStr);

  return items.map(parseRoadmapItem);
}

/**
 * Get blocked roadmap items
 */
function getBlockedItems(db, clientId) {
  const items = db.prepare(`
    SELECT * FROM roadmap_items
    WHERE client_id = ? AND status = 'blocked'
    ORDER BY created_at ASC
  `).all(clientId);

  return items.map(parseRoadmapItem);
}

/**
 * Get roadmap items grouped by category
 */
function getRoadmapByCategory(db, clientId) {
  const items = getRoadmapForClient(db, clientId);
  const byCategory = {};
  for (const item of items) {
    if (!byCategory[item.category]) {
      byCategory[item.category] = [];
    }
    byCategory[item.category].push(item);
  }
  return byCategory;
}

/**
 * Get roadmap statistics
 */
function getRoadmapStats(db, clientId) {
  const items = getRoadmapForClient(db, clientId);
  return {
    total: items.length,
    done: items.filter(i => i.status === 'done').length,
    in_progress: items.filter(i => i.status === 'in-progress').length,
    blocked: items.filter(i => i.status === 'blocked').length,
    agreed: items.filter(i => i.status === 'agreed').length,
    stale: items.filter(i => i.meetings_silent_count >= 2 && i.status !== 'done').length
  };
}

/**
 * Get recent meetings with summaries
 */
function getRecentMeetings(db, clientId, limit = 3) {
  return db.prepare(`
    SELECT id, topic, start_time, duration_minutes, ai_extraction
    FROM meetings
    WHERE client_id = ?
    ORDER BY start_time DESC
    LIMIT ?
  `).all(clientId, limit).map(m => ({
    ...m,
    ai_extraction: m.ai_extraction ? JSON.parse(m.ai_extraction) : null
  }));
}

/**
 * Get total meeting count for client
 */
function getMeetingCount(db, clientId) {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM meetings WHERE client_id = ?').get(clientId);
  return row?.cnt || 0;
}

/**
 * Get date of last meeting
 */
function getLastMeetingDate(db, clientId) {
  const row = db.prepare(`
    SELECT start_time FROM meetings
    WHERE client_id = ?
    ORDER BY start_time DESC
    LIMIT 1
  `).get(clientId);
  return row?.start_time || null;
}

/**
 * Compute service gaps (available but not active)
 */
function computeServiceGaps(clientId) {
  const client = getClientConfig(clientId);
  if (!client) return [];

  const active = new Set(client.services_active || []);
  const available = client.services_available || [];
  return available.filter(s => !active.has(s));
}

/**
 * Parse JSON fields in roadmap item
 */
function parseRoadmapItem(item) {
  return {
    ...item,
    meetings_discussed: JSON.parse(item.meetings_discussed || '[]'),
    status_history: JSON.parse(item.status_history || '[]')
  };
}

/**
 * Collect all data needed for meeting prep.
 *
 * @param {Database} db - better-sqlite3 database instance
 * @param {string} clientId
 * @returns {Object} prepData
 */
export async function collectPrepData(db, clientId) {
  const client = getClientConfig(clientId);

  if (!client) {
    throw new Error(`Client not found: ${clientId}`);
  }

  const lastDate = getLastMeetingDate(db, clientId);
  const daysSinceLastMeeting = lastDate
    ? Math.floor((Date.now() - new Date(lastDate).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  return {
    client: {
      ...client,
      days_since_last_meeting: daysSinceLastMeeting
    },
    roadmap: {
      active: getActiveRoadmapItems(db, clientId),
      stale: getStaleItems(db, clientId, 2),
      recently_completed: getRecentlyCompleted(db, clientId, 30),
      blocked: getBlockedItems(db, clientId),
      by_category: getRoadmapByCategory(db, clientId),
      stats: getRoadmapStats(db, clientId)
    },
    meetings: {
      recent: getRecentMeetings(db, clientId, 3),
      total: getMeetingCount(db, clientId),
      last_date: lastDate
    },
    service_gaps: computeServiceGaps(clientId),
    taxonomy: getTaxonomy()
  };
}

/**
 * Collect cockpit data (prep + PH links + selections).
 * Used for the interactive Meeting Cockpit UI.
 *
 * @param {Database} db - better-sqlite3 database instance
 * @param {string} clientId
 * @returns {Object} cockpitData
 */
export async function collectCockpitData(db, clientId) {
  const prepData = await collectPrepData(db, clientId);

  // Get PH links for all roadmap items
  const phLinks = getAllPHLinksForClient(db, clientId);

  // Check if PH cache is stale (>1 hour) and refresh if needed
  const client = getClientConfig(clientId);
  if (client?.ph_project_id) {
    const cacheAge = db.prepare(`
      SELECT MIN((julianday('now') - julianday(last_synced_at)) * 24) as hours_old
      FROM ph_task_cache WHERE client_id = ?
    `).get(clientId);

    if (!cacheAge?.hours_old || cacheAge.hours_old > 1) {
      try {
        await refreshPHCache(db, clientId, client.ph_project_id);
      } catch (err) {
        console.warn('[CockpitData] Failed to refresh PH cache:', err.message);
      }
    }
  }

  // Get today's selections
  const today = new Date().toISOString().split('T')[0];
  const selections = db.prepare(`
    SELECT roadmap_item_id, selected
    FROM cockpit_selections
    WHERE client_id = ? AND selection_date = ?
  `).all(clientId, today);

  const selectionMap = {};
  selections.forEach(s => { selectionMap[s.roadmap_item_id] = s.selected; });

  // Create a map of PH links keyed by roadmap_item_id
  const phLinkMap = {};
  for (const link of phLinks) {
    phLinkMap[link.roadmap_item_id] = {
      ph_task_id: link.ph_task_id,
      ph_task_title: link.ph_task_title,
      ph_completed: link.ph_completed,
      ph_stage: link.ph_stage,
      ph_progress: link.ph_progress,
      ph_project_id: link.ph_project_id || null,
      match_method: link.match_method,
      match_confidence: link.match_confidence
    };
  }

  return {
    ...prepData,
    ph_links: phLinkMap,
    selections: selectionMap,
    cockpit_generated_at: new Date().toISOString()
  };
}

export default {
  collectPrepData,
  collectCockpitData,
  getClientConfig,
  computeServiceGaps
};
