/**
 * PPC Task Accountability Tracker — MVP
 *
 * Identifies PPC-related action items from meetings and verifies
 * whether they were tracked in ProofHub.
 *
 * Uses:
 * - Gemini 2.0 Flash for PPC classification (fast, cheap)
 * - GPT-5.4 for ProofHub semantic matching (best accuracy)
 */

import 'dotenv/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { callModel, parseJsonResponse } from './model-providers.js';
import * as proofhub from './proofhub-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============ DATABASE SETUP ============

/**
 * Initialize ppc_task_tracking table
 */
export function initPPCTrackingTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ppc_task_tracking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id INTEGER NOT NULL,
      action_item_index INTEGER NOT NULL,
      task_title TEXT NOT NULL,
      task_description TEXT,
      client_id TEXT NOT NULL,
      client_name TEXT,
      platform TEXT,
      action_type TEXT,
      owner TEXT,
      meeting_date TEXT NOT NULL,
      ppc_confidence TEXT,

      -- Checkpoint: ProofHub
      proofhub_match INTEGER DEFAULT NULL,
      proofhub_task_id TEXT,
      proofhub_task_title TEXT,
      proofhub_status TEXT,
      proofhub_created TEXT,
      proofhub_assignee TEXT,
      proofhub_confidence TEXT,
      proofhub_reasoning TEXT,

      -- Scoring
      completion_score REAL,
      days_to_proofhub INTEGER,

      -- Disposition
      disposition TEXT DEFAULT 'pending',
      disposition_reason TEXT,

      -- Metadata
      computed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_checked DATETIME,

      UNIQUE(meeting_id, action_item_index)
    );

    CREATE INDEX IF NOT EXISTS idx_ppc_client ON ppc_task_tracking(client_id);
    CREATE INDEX IF NOT EXISTS idx_ppc_meeting ON ppc_task_tracking(meeting_id);
    CREATE INDEX IF NOT EXISTS idx_ppc_proofhub_match ON ppc_task_tracking(proofhub_match);
  `);
}

// ============ CLIENT CONFIG ============

/**
 * Load clients configuration
 */
function loadClients() {
  const configPath = join(__dirname, '../config/clients.json');
  const data = JSON.parse(readFileSync(configPath, 'utf8'));
  return data.clients;
}

/**
 * Get ProofHub project ID for a client
 */
function getClientProjectId(clientId) {
  const clients = loadClients();
  const client = clients.find(c => c.id === clientId);
  return client?.ph_project_id || null;
}

// ============ PPC CLASSIFICATION ============

/**
 * Classify action items as PPC-related using Gemini 2.0 Flash
 * @param {Array} actionItems - Array of action items from meeting
 * @param {string} clientName - Client name for context
 * @returns {Array} Classifications with is_ppc, platform, action_type, confidence
 */
async function classifyPPCWithGemini(actionItems, clientName) {
  if (!actionItems || actionItems.length === 0) return [];

  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  // Build batch prompt
  const itemsList = actionItems.map((item, i) =>
    `${i + 1}. "${item.title || item.task}" — ${item.description || 'No description'}`
  ).join('\n');

  const prompt = `Classify each action item as PPC/paid advertising related or not.
Client: ${clientName}

Action items:
${itemsList}

PPC includes: Google Ads, Google LSA (Local Services Ads), Meta/Facebook Ads, Bing/Microsoft Ads, campaign management, bid adjustments, budget changes, ad copy changes, targeting/audience changes, conversion tracking, pixel setup, landing page changes for ads, call tracking for ads, reporting on ad performance.

Respond with a JSON array of classifications:
[
  {
    "index": 1,
    "is_ppc": true/false,
    "platform": "google_ads" | "google_lsa" | "meta" | "bing" | "multiple" | "unknown" | null,
    "action_type": "create" | "modify" | "pause" | "enable" | "budget" | "targeting" | "reporting" | "other" | null,
    "confidence": "high" | "medium" | "low"
  }
]`;

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json'
    }
  });

  const text = result.response.text();
  return parseJsonResponse(text);
}

/**
 * Classify PPC tasks for a meeting
 * @param {number} meetingId - Meeting ID
 * @param {Database} db - Database connection
 * @returns {Array} PPC-classified action items
 */
export async function classifyPPCTasks(meetingId, db) {
  // Get meeting data
  const meeting = db.prepare(`
    SELECT ai_extraction, client_id, client_name, start_time
    FROM meetings WHERE id = ?
  `).get(meetingId);

  if (!meeting || !meeting.ai_extraction) {
    return [];
  }

  // Parse extraction
  let extraction;
  try {
    extraction = JSON.parse(meeting.ai_extraction);
  } catch {
    return [];
  }

  // Get action items (handle both array and object formats)
  const actionItems = extraction.action_items ||
    (Array.isArray(extraction) ? extraction[0]?.action_items : null) ||
    [];

  if (actionItems.length === 0) {
    return [];
  }

  // Classify with Gemini
  const classifications = await classifyPPCWithGemini(actionItems, meeting.client_name || 'Unknown');

  // Merge classifications with original items
  const results = [];
  for (let i = 0; i < actionItems.length; i++) {
    const item = actionItems[i];
    const classification = classifications.find(c => c.index === i + 1) ||
      { is_ppc: false, platform: null, action_type: null, confidence: 'low' };

    if (classification.is_ppc) {
      results.push({
        index: i,
        title: item.title || item.task || 'Untitled',
        description: item.description || '',
        owner: item.owner_name || item.owner || null,
        platform: classification.platform,
        action_type: classification.action_type,
        ppc_confidence: classification.confidence,
        client_id: meeting.client_id,
        client_name: meeting.client_name,
        meeting_date: meeting.start_time,
        transcript_excerpt: item.transcript_excerpt || null
      });
    }
  }

  return results;
}

// ============ PROOFHUB MATCHING ============

/**
 * Match a PPC task against ProofHub tasks using GPT-5.4
 * @param {Object} task - PPC task to match
 * @param {string} clientId - Client ID
 * @param {string} meetingDate - Meeting date
 * @param {Database} db - Database connection
 * @returns {Object} Match result with proofhub details
 */
export async function matchProofHub(task, clientId, meetingDate, db) {
  // Get ProofHub project ID
  const projectId = getClientProjectId(clientId);
  if (!projectId) {
    return { match_found: false, reason: 'no_proofhub_project' };
  }

  // Check if ProofHub is configured
  if (!proofhub.isProofhubConfigured()) {
    return { match_found: false, reason: 'proofhub_not_configured' };
  }

  // Fetch all tasks from ProofHub for this project
  let phTasks;
  try {
    phTasks = await proofhub.getAllProjectTasks(projectId);
  } catch (err) {
    return { match_found: false, reason: 'proofhub_api_error', error: err.message };
  }

  if (!phTasks || phTasks.length === 0) {
    return { match_found: false, reason: 'no_proofhub_tasks' };
  }

  // Filter to tasks created within 10 days of meeting
  const meetingDateObj = new Date(meetingDate);
  const windowStart = new Date(meetingDateObj);
  windowStart.setDate(windowStart.getDate() - 2); // 2 days before (may have been created earlier)
  const windowEnd = new Date(meetingDateObj);
  windowEnd.setDate(windowEnd.getDate() + 10); // 10 days after

  const candidateTasks = phTasks.filter(t => {
    if (!t.created_at) return false;
    const created = new Date(t.created_at);
    return created >= windowStart && created <= windowEnd;
  });

  if (candidateTasks.length === 0) {
    return { match_found: false, reason: 'no_tasks_in_window' };
  }

  // Build GPT prompt for semantic matching — include PH descriptions
  const taskListStr = candidateTasks.slice(0, 20).map((t, i) => {
    // Look up description from ph_task_cache
    const cached = db.prepare('SELECT description_text, scope_summary FROM ph_task_cache WHERE ph_task_id = ?')
      .get(parseInt(t.id));
    const desc = cached?.scope_summary || (cached?.description_text || '').replace(/<[^>]+>/g, '').slice(0, 200) || 'No description';
    return `${i + 1}. Title: "${t.title}"
   Description: "${desc}"
   Created: "${t.created_at?.split('T')[0] || 'unknown'}", Assignee: "${t.responsible_name || 'unassigned'}", Status: "${t.completed ? 'complete' : 'incomplete'}"`;
  }).join('\n');

  // Include transcript excerpt if available
  const transcriptLine = task.transcript_excerpt
    ? `\nTranscript context (what was said in the meeting):\n"${task.transcript_excerpt.slice(0, 500)}"\n`
    : '';

  const prompt = `MEETING ACTION ITEM (${meetingDate.split('T')[0]}):
Title: "${task.title}"
Description: "${task.description || 'No description'}"
Owner: "${task.owner || 'unspecified'}"
Client: "${task.client_name}"
${transcriptLine}
CANDIDATE PROOFHUB TASKS (created within 10 days of meeting):
${taskListStr}

Does any ProofHub task track THE SAME SPECIFIC WORK as this meeting action item?

MATCHING RULES:
- A match means the PH task was created specifically to track this action item or describes the same concrete deliverable
- The PH task title or description must reference the same specific activity, not just the same general area
- Same client + same broad category (e.g., "ads") is NOT sufficient for a match
- A generic task like "UPDATES TO MAKE ON TRAFFIC" does NOT match a specific item like "Throttle sump pump campaigns"
- A broad strategy task does NOT match a specific tactical item unless the PH task description explicitly mentions that tactic

EXAMPLES OF NON-MATCHES:
- "Develop Facebook ad concepts" ≠ "Getting More Hardwood Leads" (different scope — one is FB creative, one is lead strategy)
- "Pull CTR and Conversion Rate data" ≠ "AC Ads and Expansion" (reporting task ≠ campaign management)
- "Throttle sump pump campaigns" ≠ "UPDATES TO MAKE ON TRAFFIC" (specific action ≠ generic bucket)

EXAMPLES OF VALID MATCHES:
- "Update Google Ads keywords for AC" ≈ "Jacob - Pearce HVAC - Google/Bing Ads For AC" (same specific work)
- "Launch March 21st webinar Facebook Ads" ≈ "Richard O - March 21st Webinar Facebook Ads" (same event + channel)

CONFIDENCE CALIBRATION:
- HIGH: PH task title/description explicitly describes this exact work (same platform, same action, same scope)
- MEDIUM: PH task is clearly related and likely tracks this work, but title is broader than the action item
- LOW: PH task is in the same area but match is speculative
- NO MATCH: Default. Only match if you are confident the PH task tracks this specific work

Respond in JSON:
{
  "match_found": true/false,
  "matched_index": 1-N or null,
  "confidence": "high" | "medium" | "low",
  "match_reasoning": "one sentence: what specific evidence links these two tasks"
}`;

  // Call GPT-5.4 for matching
  const response = await callModel('gpt-5.4', prompt, { temperature: 0.1 });
  const matchResult = parseJsonResponse(response.text);

  if (matchResult.match_found && matchResult.matched_index) {
    const matchedTask = candidateTasks[matchResult.matched_index - 1];
    if (matchedTask) {
      // Calculate days to ProofHub
      const taskCreated = new Date(matchedTask.created_at);
      const daysDiff = Math.floor((taskCreated - meetingDateObj) / (1000 * 60 * 60 * 24));

      return {
        match_found: true,
        proofhub_task_id: matchedTask.id?.toString(),
        proofhub_task_title: matchedTask.title,
        proofhub_status: matchedTask.completed ? 'complete' : 'incomplete',
        proofhub_created: matchedTask.created_at?.split('T')[0],
        proofhub_assignee: matchedTask.responsible_name || null,
        proofhub_confidence: matchResult.confidence,
        proofhub_reasoning: matchResult.match_reasoning,
        days_to_proofhub: daysDiff >= 0 ? daysDiff : 0
      };
    }
  }

  return {
    match_found: false,
    proofhub_confidence: matchResult.confidence || 'low',
    proofhub_reasoning: matchResult.match_reasoning || 'No matching task found'
  };
}

// ============ MAIN TRACKING FUNCTION ============

/**
 * Track PPC tasks for a meeting - full pipeline
 * @param {number} meetingId - Meeting ID
 * @param {Database} db - Database connection
 * @returns {Object} Tracking summary
 */
export async function trackPPCTasks(meetingId, db) {
  // Ensure table exists
  initPPCTrackingTable(db);

  // Classify PPC tasks
  const ppcTasks = await classifyPPCTasks(meetingId, db);

  if (ppcTasks.length === 0) {
    return {
      meeting_id: meetingId,
      ppc_tasks: 0,
      tracked: 0,
      missing: 0,
      tasks: []
    };
  }

  const results = [];

  for (const task of ppcTasks) {
    // Check ProofHub
    const phMatch = await matchProofHub(task, task.client_id, task.meeting_date, db);

    // Calculate completion score
    // 60% for ProofHub match, 40% for timeline (< 3 days = full, 3-7 = half, >7 = 0)
    let score = 0;
    if (phMatch.match_found) {
      score += 60;
      const days = phMatch.days_to_proofhub || 0;
      if (days <= 3) score += 40;
      else if (days <= 7) score += 20;
    }

    const trackingRecord = {
      meeting_id: meetingId,
      action_item_index: task.index,
      task_title: task.title,
      task_description: task.description,
      client_id: task.client_id,
      client_name: task.client_name,
      platform: task.platform,
      action_type: task.action_type,
      owner: task.owner,
      meeting_date: task.meeting_date,
      ppc_confidence: task.ppc_confidence,
      proofhub_match: phMatch.match_found ? 1 : 0,
      proofhub_task_id: phMatch.proofhub_task_id || null,
      proofhub_task_title: phMatch.proofhub_task_title || null,
      proofhub_status: phMatch.proofhub_status || null,
      proofhub_created: phMatch.proofhub_created || null,
      proofhub_assignee: phMatch.proofhub_assignee || null,
      proofhub_confidence: phMatch.proofhub_confidence || null,
      proofhub_reasoning: phMatch.proofhub_reasoning || null,
      completion_score: score,
      days_to_proofhub: phMatch.days_to_proofhub || null
    };

    // Upsert into database
    db.prepare(`
      INSERT INTO ppc_task_tracking (
        meeting_id, action_item_index, task_title, task_description, client_id, client_name,
        platform, action_type, owner, meeting_date, ppc_confidence,
        proofhub_match, proofhub_task_id, proofhub_task_title, proofhub_status,
        proofhub_created, proofhub_assignee, proofhub_confidence, proofhub_reasoning,
        completion_score, days_to_proofhub, computed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(meeting_id, action_item_index) DO UPDATE SET
        proofhub_match = excluded.proofhub_match,
        proofhub_task_id = excluded.proofhub_task_id,
        proofhub_task_title = excluded.proofhub_task_title,
        proofhub_status = excluded.proofhub_status,
        proofhub_created = excluded.proofhub_created,
        proofhub_assignee = excluded.proofhub_assignee,
        proofhub_confidence = excluded.proofhub_confidence,
        proofhub_reasoning = excluded.proofhub_reasoning,
        completion_score = excluded.completion_score,
        days_to_proofhub = excluded.days_to_proofhub,
        last_checked = datetime('now')
    `).run(
      trackingRecord.meeting_id,
      trackingRecord.action_item_index,
      trackingRecord.task_title,
      trackingRecord.task_description,
      trackingRecord.client_id,
      trackingRecord.client_name,
      trackingRecord.platform,
      trackingRecord.action_type,
      trackingRecord.owner,
      trackingRecord.meeting_date,
      trackingRecord.ppc_confidence,
      trackingRecord.proofhub_match,
      trackingRecord.proofhub_task_id,
      trackingRecord.proofhub_task_title,
      trackingRecord.proofhub_status,
      trackingRecord.proofhub_created,
      trackingRecord.proofhub_assignee,
      trackingRecord.proofhub_confidence,
      trackingRecord.proofhub_reasoning,
      trackingRecord.completion_score,
      trackingRecord.days_to_proofhub
    );

    results.push(trackingRecord);

    // Rate limit ProofHub API calls
    await new Promise(r => setTimeout(r, 1000));
  }

  const tracked = results.filter(r => r.proofhub_match === 1).length;

  return {
    meeting_id: meetingId,
    ppc_tasks: results.length,
    tracked,
    missing: results.length - tracked,
    avg_score: results.length > 0 ? Math.round(results.reduce((s, r) => s + r.completion_score, 0) / results.length) : 0,
    tasks: results
  };
}

// ============ BACKFILL ============

/**
 * Backfill PPC tracking for all meetings with action items
 * @param {Database} db - Database connection
 * @returns {Object} Backfill summary
 */
export async function backfillPPCTracking(db) {
  initPPCTrackingTable(db);

  // Get all meetings with action items that haven't been tracked yet
  const meetings = db.prepare(`
    SELECT DISTINCT m.id, m.topic, m.client_id, m.client_name, m.start_time
    FROM meetings m
    WHERE m.ai_extraction IS NOT NULL
      AND m.status = 'completed'
      AND m.id NOT IN (SELECT DISTINCT meeting_id FROM ppc_task_tracking)
    ORDER BY m.start_time DESC
  `).all();

  console.log(`[PPC Backfill] Found ${meetings.length} meetings to process`);

  const results = {
    total_meetings: meetings.length,
    processed: 0,
    ppc_tasks_found: 0,
    tracked_in_proofhub: 0,
    errors: 0,
    by_client: {}
  };

  for (const meeting of meetings) {
    try {
      console.log(`[PPC Backfill] Processing meeting ${meeting.id}: "${meeting.topic}"`);
      const trackResult = await trackPPCTasks(meeting.id, db);

      results.processed++;
      results.ppc_tasks_found += trackResult.ppc_tasks;
      results.tracked_in_proofhub += trackResult.tracked;

      // Aggregate by client
      if (!results.by_client[meeting.client_id]) {
        results.by_client[meeting.client_id] = {
          client_name: meeting.client_name,
          meetings: 0,
          ppc_tasks: 0,
          tracked: 0
        };
      }
      results.by_client[meeting.client_id].meetings++;
      results.by_client[meeting.client_id].ppc_tasks += trackResult.ppc_tasks;
      results.by_client[meeting.client_id].tracked += trackResult.tracked;

      // Delay between meetings
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error(`[PPC Backfill] Error on meeting ${meeting.id}: ${err.message}`);
      results.errors++;
    }
  }

  return results;
}

// ============ REPORTING ============

/**
 * Get PPC tracking report
 * @param {Database} db - Database connection
 * @param {Object} options - { clientId, days, includeCompleted }
 * @returns {Object} Report data
 */
export function getPPCReport(db, options = {}) {
  initPPCTrackingTable(db);

  const { clientId = null, days = 30, includeCompleted = true } = options;

  // Build date filter
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const dateStr = cutoffDate.toISOString();

  let whereClause = `WHERE meeting_date >= ?`;
  const params = [dateStr];

  if (clientId) {
    whereClause += ` AND client_id = ?`;
    params.push(clientId);
  }

  if (!includeCompleted) {
    whereClause += ` AND disposition = 'pending'`;
  }

  // Get all PPC tasks
  const tasks = db.prepare(`
    SELECT * FROM ppc_task_tracking ${whereClause}
    ORDER BY meeting_date DESC, meeting_id, action_item_index
  `).all(...params);

  // Calculate stats
  const total = tasks.length;
  const tracked = tasks.filter(t => t.proofhub_match === 1).length;
  const missing = total - tracked;
  const avgScore = total > 0 ? Math.round(tasks.reduce((s, t) => s + (t.completion_score || 0), 0) / total) : 0;
  const avgDays = tracked > 0 ?
    (tasks.filter(t => t.days_to_proofhub !== null).reduce((s, t) => s + t.days_to_proofhub, 0) / tracked).toFixed(1) :
    null;

  // Group by client
  const byClient = {};
  for (const task of tasks) {
    if (!byClient[task.client_id]) {
      byClient[task.client_id] = {
        client_name: task.client_name,
        total: 0,
        tracked: 0,
        missing: 0,
        avg_score: 0,
        tasks: []
      };
    }
    byClient[task.client_id].total++;
    if (task.proofhub_match === 1) byClient[task.client_id].tracked++;
    else byClient[task.client_id].missing++;
    byClient[task.client_id].tasks.push(task);
  }

  // Calculate per-client averages
  for (const cid of Object.keys(byClient)) {
    const clientTasks = byClient[cid].tasks;
    byClient[cid].avg_score = clientTasks.length > 0 ?
      Math.round(clientTasks.reduce((s, t) => s + (t.completion_score || 0), 0) / clientTasks.length) : 0;
    byClient[cid].completion_rate = byClient[cid].total > 0 ?
      Math.round((byClient[cid].tracked / byClient[cid].total) * 100) : 0;
  }

  // Get at-risk tasks (missing from ProofHub, pending disposition)
  const atRisk = tasks.filter(t => t.proofhub_match !== 1 && t.disposition === 'pending');

  return {
    period_days: days,
    total_ppc_tasks: total,
    in_proofhub: tracked,
    missing: missing,
    completion_rate: total > 0 ? Math.round((tracked / total) * 100) : 0,
    avg_score: avgScore,
    avg_days_to_proofhub: avgDays,
    by_client: byClient,
    at_risk: atRisk,
    all_tasks: tasks
  };
}

/**
 * Update task disposition
 * @param {Database} db - Database connection
 * @param {number} taskId - PPC task tracking ID
 * @param {string} disposition - cancelled, deprioritized, blocked, completed
 * @param {string} reason - Reason for disposition
 */
export function updateDisposition(db, taskId, disposition, reason = null) {
  initPPCTrackingTable(db);

  const validDispositions = ['pending', 'completed', 'cancelled', 'deprioritized', 'blocked'];
  if (!validDispositions.includes(disposition)) {
    throw new Error(`Invalid disposition: ${disposition}`);
  }

  db.prepare(`
    UPDATE ppc_task_tracking
    SET disposition = ?, disposition_reason = ?, last_checked = datetime('now')
    WHERE id = ?
  `).run(disposition, reason, taskId);
}

// ============ ON-DEMAND PROOFHUB STATUS SYNC ============

let refreshInProgress = null;
let lastRefreshTime = null;
const REFRESH_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/**
 * Refresh ProofHub statuses for all incomplete matched PPC tasks.
 * In-memory lock prevents concurrent refreshes; 1-hour cooldown prevents over-polling.
 */
export async function refreshPPCStatuses(db) {
  if (lastRefreshTime && (Date.now() - lastRefreshTime) < REFRESH_COOLDOWN_MS) {
    return { skipped: true, reason: 'cooldown', last_refresh: new Date(lastRefreshTime).toISOString() };
  }

  if (refreshInProgress) {
    return refreshInProgress;
  }

  refreshInProgress = _doRefresh(db);
  try {
    const result = await refreshInProgress;
    lastRefreshTime = Date.now();
    return result;
  } finally {
    refreshInProgress = null;
  }
}

async function _doRefresh(db) {
  const tasks = db.prepare(`
    SELECT id, proofhub_task_id, proofhub_status, proofhub_task_title,
           client_name, task_title, meeting_date
    FROM ppc_task_tracking
    WHERE proofhub_match = 1 AND proofhub_status != 'complete'
  `).all();

  const updated = [];
  let apiCalls = 0;

  for (const task of tasks) {
    // Step A: Check ph_task_cache first (free — no API call)
    const cached = db.prepare(`
      SELECT completed, completed_at, stage_name
      FROM ph_task_cache WHERE ph_task_id = ?
    `).get(parseInt(task.proofhub_task_id));

    if (cached && cached.completed === 1) {
      db.prepare(`
        UPDATE ppc_task_tracking
        SET proofhub_status = 'complete', last_checked = datetime('now')
        WHERE id = ?
      `).run(task.id);
      const change = {
        task_id: task.id,
        task_title: task.task_title,
        client_name: task.client_name,
        old_status: 'incomplete',
        new_status: 'complete',
        source: 'cache'
      };
      updated.push(change);
      _notifySlack(task);
      continue;
    }

    // Step B: Hit ProofHub API directly
    try {
      const cacheInfo = db.prepare(`
        SELECT project_id, task_list_id FROM ph_task_cache WHERE ph_task_id = ?
      `).get(parseInt(task.proofhub_task_id));

      if (!cacheInfo) continue;

      const url = `https://breakthrough3x.proofhub.com/api/v3/projects/${cacheInfo.project_id}/todolists/${cacheInfo.task_list_id}/tasks/${task.proofhub_task_id}`;

      const response = await fetch(url, {
        headers: {
          'X-API-KEY': process.env.PROOFHUB_API_KEY,
          'User-Agent': 'zoom-action-items'
        }
      });

      if (response.ok) {
        const phTask = await response.json();
        apiCalls++;

        const isComplete = phTask.completed === true || phTask.completed === 1;
        db.prepare(`
          UPDATE ph_task_cache
          SET completed = ?, completed_at = ?, stage_name = ?, last_synced_at = datetime('now')
          WHERE ph_task_id = ?
        `).run(
          isComplete ? 1 : 0,
          phTask.completed_on || null,
          phTask.stage?.name || phTask.workflow_status?.name || null,
          parseInt(task.proofhub_task_id)
        );

        if (isComplete && task.proofhub_status !== 'complete') {
          db.prepare(`
            UPDATE ppc_task_tracking
            SET proofhub_status = 'complete', last_checked = datetime('now')
            WHERE id = ?
          `).run(task.id);
          updated.push({
            task_id: task.id,
            task_title: task.task_title,
            client_name: task.client_name,
            old_status: 'incomplete',
            new_status: 'complete',
            source: 'api'
          });
          _notifySlack(task);
        } else {
          db.prepare(`
            UPDATE ppc_task_tracking SET last_checked = datetime('now') WHERE id = ?
          `).run(task.id);
        }
      }

      // Rate limit: 1 second between API calls
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.error(`[PPC Sync] Error checking task ${task.id}:`, err.message);
    }
  }

  return {
    skipped: false,
    checked: tasks.length,
    api_calls: apiCalls,
    updated,
    timestamp: new Date().toISOString()
  };
}

/**
 * Refresh a single PPC task's ProofHub status. No cooldown, no lock.
 */
export async function refreshSingleTask(db, taskId) {
  const task = db.prepare(`
    SELECT id, proofhub_task_id, proofhub_status, proofhub_task_title,
           client_name, task_title, meeting_date
    FROM ppc_task_tracking WHERE id = ?
  `).get(taskId);

  if (!task) return { error: 'task_not_found' };
  if (!task.proofhub_task_id) return { error: 'no_proofhub_match', updated: false };

  // Check cache first
  const cached = db.prepare(`
    SELECT completed, project_id, task_list_id FROM ph_task_cache WHERE ph_task_id = ?
  `).get(parseInt(task.proofhub_task_id));

  let isComplete = false;
  let source = 'cache';

  if (cached && cached.completed === 1) {
    isComplete = true;
  } else if (cached) {
    // Hit API
    try {
      const url = `https://breakthrough3x.proofhub.com/api/v3/projects/${cached.project_id}/todolists/${cached.task_list_id}/tasks/${task.proofhub_task_id}`;
      const response = await fetch(url, {
        headers: {
          'X-API-KEY': process.env.PROOFHUB_API_KEY,
          'User-Agent': 'zoom-action-items'
        }
      });

      if (response.ok) {
        const phTask = await response.json();
        isComplete = phTask.completed === true || phTask.completed === 1;
        source = 'api';

        db.prepare(`
          UPDATE ph_task_cache
          SET completed = ?, completed_at = ?, stage_name = ?, last_synced_at = datetime('now')
          WHERE ph_task_id = ?
        `).run(
          isComplete ? 1 : 0,
          phTask.completed_on || null,
          phTask.stage?.name || phTask.workflow_status?.name || null,
          parseInt(task.proofhub_task_id)
        );
      }
    } catch (err) {
      console.error(`[PPC Sync] Error checking single task ${taskId}:`, err.message);
      db.prepare(`UPDATE ppc_task_tracking SET last_checked = datetime('now') WHERE id = ?`).run(taskId);
      return { updated: false, error: err.message };
    }
  } else {
    // No cache entry at all
    db.prepare(`UPDATE ppc_task_tracking SET last_checked = datetime('now') WHERE id = ?`).run(taskId);
    return { updated: false, reason: 'no_cache_entry' };
  }

  const oldStatus = task.proofhub_status;
  const newStatus = isComplete ? 'complete' : 'incomplete';

  db.prepare(`
    UPDATE ppc_task_tracking
    SET proofhub_status = ?, last_checked = datetime('now')
    WHERE id = ?
  `).run(newStatus, taskId);

  if (isComplete && oldStatus !== 'complete') {
    _notifySlack(task);
  }

  return {
    updated: newStatus !== oldStatus,
    old_status: oldStatus,
    new_status: newStatus,
    source
  };
}

/**
 * Best-effort Slack notification when a PPC task completes in ProofHub
 */
async function _notifySlack(task) {
  try {
    const { WebClient } = await import('@slack/web-api');
    const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
    const alertChannel = process.env.SLACK_ALERT_CHANNEL || '#zoom-pipeline-alerts';

    await slack.chat.postMessage({
      channel: alertChannel,
      text: `✅ PPC task completed in ProofHub\n*${task.task_title}*\nClient: ${task.client_name} | Meeting: ${task.meeting_date?.split('T')[0]}\nPH: ${task.proofhub_task_title}`
    });
  } catch (slackErr) {
    console.error('[PPC Sync] Slack notification failed:', slackErr.message);
  }
}

export default {
  initPPCTrackingTable,
  classifyPPCTasks,
  matchProofHub,
  trackPPCTasks,
  backfillPPCTracking,
  getPPCReport,
  updateDisposition,
  refreshPPCStatuses,
  refreshSingleTask
};
