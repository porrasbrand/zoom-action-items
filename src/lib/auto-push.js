/**
 * Auto-Push to ProofHub Engine
 *
 * Automatically pushes meeting action items to ProofHub using a 4-filter decision logic:
 * 1. Owner Side: only push b3x items, create reminders for client items
 * 2. Confidence Tier: recap = auto-push, conversation = draft for review
 * 3. Negative Keywords: skip items that are observations, not tasks
 * 4. Duplicate Check: skip if similar task exists in PH
 *
 * Caps: max 5 items per meeting, max 20 per day
 */

import * as proofhub from './proofhub-client.js';
import { resolvePerson } from './people-resolver.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============ CONFIGURATION ============

const MAX_PER_MEETING = 5;
const MAX_PER_DAY = 20;

// B3X team names for owner_side classification
const B3X_TEAM_NAMES = [
  'phil', 'philip', 'mutrie', 'philip mutrie',
  'dan', 'kuschell', 'dan kuschell',
  'richard', 'osterude', 'richard osterude', 'richard o', 'richard bonn',
  'jacob', 'hastings', 'jacob hastings',
  'bill', 'soady', 'bill soady',
  'manuel', 'porras', 'manuel porras',
  'juan', 'joaco', 'malig',
  'tyler', 'ehab', 'kaden',
  'advanced team', 'traffic team', 'our team', 'b3x', 'we will', 'we need to',
  'vince', 'sarah', 'nicole', 'ray'
];

// Negative keywords - items containing these are observations, not tasks
const NEGATIVE_KEYWORDS = [
  'discussed', 'mentioned', 'talked about', 'noted that',
  'understanding', 'context', 'feedback', 'expressed',
  'feels like', 'seems like', 'might want to',
  'agreed that', 'acknowledged', 'recognized',
  'was happy', 'was satisfied', 'was frustrated',
  'positive focus', 'wins', 'rated it',
  'explained', 'shared that', 'indicated'
];

// Deadline days by category
const DEADLINE_DAYS = {
  'paid-ads': 5,
  'email-marketing': 5,
  'website': 7,
  'funnel-campaign': 7,
  'call-tracking': 5,
  'reporting': 5,
  'crm-automation': 7,
  'gbp': 5,
  'creative': 7,
  'client-ops': 5
};
const DEFAULT_DEADLINE_DAYS = 5;

// Category to task list keyword mapping
const CATEGORY_TO_TASKLIST = {
  'paid-ads': ['traffic', 'campaign', 'ads', 'reporting'],
  'reporting': ['traffic', 'campaign', 'reporting'],
  'email-marketing': ['email', 'campaign', 'marketing'],
  'website': ['tech', 'web', 'development'],
  'funnel-campaign': ['tech', 'web', 'campaign', 'funnel'],
  'creative': ['creative', 'content', 'campaign'],
  'crm-automation': ['tech', 'web', 'crm'],
  'call-tracking': ['tech', 'traffic'],
  'gbp': ['traffic', 'campaign', 'gbp'],
  'client-ops': ['admin', 'operations', 'general']
};

// ============ HELPER FUNCTIONS ============

/**
 * Load clients configuration
 */
function loadClients() {
  const configPath = join(__dirname, '../config/clients.json');
  const data = JSON.parse(readFileSync(configPath, 'utf8'));
  return data.clients;
}

/**
 * Tokenize text for Jaccard similarity
 */
function tokenize(title) {
  return (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);
}

/**
 * Compute Jaccard similarity between two token sets
 */
function jaccardSimilarity(tokensA, tokensB) {
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  const intersection = [...setA].filter(t => setB.has(t));
  const union = new Set([...setA, ...setB]);
  return union.size > 0 ? intersection.length / union.size : 0;
}

/**
 * Classify owner side (b3x, client, or unknown)
 */
function classifyOwnerSide(ownerName) {
  if (!ownerName) return 'unknown';
  const lower = ownerName.toLowerCase().trim();

  // Check if it's a B3X team member
  if (B3X_TEAM_NAMES.some(name => lower.includes(name))) {
    return 'b3x';
  }

  // Explicit client indicators
  if (lower === 'client' || lower === 'they' || lower === 'them' ||
      lower.includes('client will') || lower.includes('they will')) {
    return 'client';
  }

  // Unknown - could be client contact name or ambiguous
  return 'unknown';
}

/**
 * Check if item is an observation (not an actionable task)
 */
function isObservation(title, description) {
  const text = (title + ' ' + (description || '')).toLowerCase();
  return NEGATIVE_KEYWORDS.some(kw => text.includes(kw));
}

/**
 * Check if item is a duplicate of existing PH task
 */
function isDuplicate(db, clientId, newTitle) {
  const existing = db.prepare(
    'SELECT title FROM ph_task_cache WHERE client_id = ?'
  ).all(clientId);

  const newTokens = tokenize(newTitle);
  for (const task of existing) {
    const similarity = jaccardSimilarity(newTokens, tokenize(task.title));
    if (similarity > 0.7) return true;
  }
  return false;
}

/**
 * Compute deadline based on category (business days)
 */
function computeDeadline(item) {
  // If AI extracted a specific deadline, use it (handle "null" string from DB)
  if (item.due_date && item.due_date !== 'null') return item.due_date;

  // Otherwise use category default
  const days = DEADLINE_DAYS[item.category] || DEFAULT_DEADLINE_DAYS;
  const deadline = new Date();

  // Add business days (skip weekends)
  let added = 0;
  while (added < days) {
    deadline.setDate(deadline.getDate() + 1);
    if (deadline.getDay() !== 0 && deadline.getDay() !== 6) added++;
  }

  return deadline.toISOString().split('T')[0];
}

/**
 * Select appropriate task list based on category
 */
async function selectTaskList(projectId, category) {
  const taskLists = await proofhub.getTaskLists(projectId);
  const keywords = CATEGORY_TO_TASKLIST[category] || ['general'];

  for (const kw of keywords) {
    const match = taskLists.find(tl =>
      tl.title.toLowerCase().includes(kw)
    );
    if (match) return match.id;
  }

  // Fallback: first task list
  return taskLists[0]?.id || null;
}

/**
 * Get today's push count for daily cap
 */
function getTodayPushCount(db) {
  const today = new Date().toISOString().split('T')[0];
  const row = db.prepare(
    "SELECT COUNT(*) as c FROM action_items WHERE pushed_at LIKE ? || '%'"
  ).get(today);
  return row?.c || 0;
}

/**
 * Classify an action item using 4-filter logic
 */
function classifyItem(item, db) {
  // Filter 3: Negative keywords (check first - quick filter)
  if (isObservation(item.title, item.description)) {
    return { action: 'skip', reason: 'observation_not_task' };
  }

  // Filter 1: Owner side
  const ownerSide = classifyOwnerSide(item.owner_name);

  if (ownerSide === 'client') {
    return { action: 'client_reminder', reason: 'client_action', ownerSide };
  }

  // Filter 4: Duplicate check
  if (isDuplicate(db, item.client_id, item.title)) {
    return { action: 'skip', reason: 'duplicate', ownerSide };
  }

  // Filter 2: Confidence tier
  if (ownerSide === 'b3x' && item.confidence_tier === 'recap') {
    return { action: 'auto_push', reason: 'high_confidence_b3x', ownerSide };
  }

  if (ownerSide === 'b3x' && item.confidence_tier === 'conversation') {
    return { action: 'draft', reason: 'medium_confidence_needs_review', ownerSide };
  }

  // Unknown owner or low confidence → draft for review
  return { action: 'draft', reason: `uncertain_${ownerSide}`, ownerSide };
}

// ============ MAIN FUNCTION ============

/**
 * Auto-push meeting action items to ProofHub
 *
 * @param {Database} db - better-sqlite3 instance
 * @param {number} meetingId - meeting just processed
 * @param {Object} options - { dryRun, pilotClients }
 * @returns {Object} { pushed: [], drafted: [], skipped: [], client_reminders: [], alerts: [] }
 */
export async function autoPushMeeting(db, meetingId, options = {}) {
  const { dryRun = false, pilotClients = null } = options;

  const results = {
    pushed: [],
    drafted: [],
    skipped: [],
    client_reminders: [],
    alerts: [],
    meeting_id: meetingId,
    dry_run: dryRun
  };

  // 1. Get meeting info
  const meeting = db.prepare(
    'SELECT id, client_id, topic, start_time FROM meetings WHERE id = ?'
  ).get(meetingId);

  if (!meeting) {
    results.alerts.push({ type: 'error', message: `Meeting ${meetingId} not found` });
    return results;
  }

  // 2. Get client config
  const clients = loadClients();
  const client = clients.find(c => c.id === meeting.client_id);

  if (!client) {
    results.alerts.push({
      type: 'warning',
      message: `Client ${meeting.client_id} not found in clients.json`
    });
    return results;
  }

  // 3. Check if client has ph_project_id
  if (!client.ph_project_id) {
    results.alerts.push({
      type: 'missing_ph_project',
      message: `Client ${client.name} has no ProofHub project configured`,
      client_id: client.id
    });
    return results;
  }

  // 4. Check pilot client filter
  if (pilotClients && !pilotClients.includes(client.id)) {
    results.alerts.push({
      type: 'info',
      message: `Client ${client.name} not in pilot list, skipping`
    });
    return results;
  }

  // 5. Check daily cap
  const todayCount = getTodayPushCount(db);
  if (todayCount >= MAX_PER_DAY && !dryRun) {
    results.alerts.push({
      type: 'daily_cap_reached',
      message: `Daily push limit (${MAX_PER_DAY}) reached`
    });
    return results;
  }

  // 6. Get action items for this meeting
  const items = db.prepare(
    'SELECT * FROM action_items WHERE meeting_id = ? ORDER BY id'
  ).all(meetingId);

  if (items.length === 0) {
    results.alerts.push({
      type: 'info',
      message: 'No action items found for this meeting'
    });
    return results;
  }

  let pushCount = 0;

  // 7. Process each item
  for (const item of items) {
    // Classify using 4-filter logic
    const classification = classifyItem(item, db);

    const itemResult = {
      id: item.id,
      title: item.title,
      owner_name: item.owner_name,
      confidence_tier: item.confidence_tier,
      category: item.category,
      ...classification
    };

    switch (classification.action) {
      case 'skip':
        results.skipped.push(itemResult);
        break;

      case 'client_reminder':
        results.client_reminders.push(itemResult);
        break;

      case 'draft':
        results.drafted.push(itemResult);
        break;

      case 'auto_push':
        // Check per-meeting cap
        if (pushCount >= MAX_PER_MEETING) {
          itemResult.capped = true;
          itemResult.reason = 'meeting_cap_reached';
          results.drafted.push(itemResult); // Overflow goes to drafts
          break;
        }

        // Check daily cap
        if (todayCount + pushCount >= MAX_PER_DAY) {
          itemResult.capped = true;
          itemResult.reason = 'daily_cap_reached';
          results.drafted.push(itemResult);
          break;
        }

        // Compute deadline and task list
        const deadline = computeDeadline(item);
        itemResult.deadline = deadline;

        if (!dryRun) {
          try {
            // Select task list
            const taskListId = await selectTaskList(client.ph_project_id, item.category);

            if (!taskListId) {
              itemResult.error = 'No task list found';
              results.drafted.push(itemResult);
              break;
            }

            // Resolve assignee
            const person = resolvePerson(item.owner_name);
            const assigneeId = person?.ph_id || null;

            // Create PH task
            const taskData = {
              title: item.title,
              description: item.description || '',
              due_date: deadline,
              assigned_to: assigneeId ? [parseInt(assigneeId)] : []
            };

            const createdTask = await proofhub.createTask(
              client.ph_project_id,
              taskListId,
              taskData
            );

            // Store ph_task_id back on action_items
            db.prepare(
              "UPDATE action_items SET ph_task_id = ?, pushed_at = datetime('now') WHERE id = ?"
            ).run(createdTask.id, item.id);

            itemResult.ph_task_id = createdTask.id;
            itemResult.task_list_id = taskListId;
            itemResult.assignee_id = assigneeId;

          } catch (err) {
            itemResult.error = err.message;
            results.drafted.push(itemResult); // Failed push goes to drafts
            break;
          }
        } else {
          // Dry run - just show what would happen
          itemResult.would_push = true;
        }

        results.pushed.push(itemResult);
        pushCount++;
        break;
    }
  }

  // Summary
  results.summary = {
    total_items: items.length,
    pushed: results.pushed.length,
    drafted: results.drafted.length,
    skipped: results.skipped.length,
    client_reminders: results.client_reminders.length,
    client_name: client.name,
    ph_project_id: client.ph_project_id
  };

  return results;
}

export default {
  autoPushMeeting,
  classifyOwnerSide,
  classifyItem,
  isObservation,
  isDuplicate,
  computeDeadline
};
