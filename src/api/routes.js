/**
 * API Routes for the Zoom Dashboard.
 */

import { Router } from 'express';
import * as db from './db-queries.js';
import { getDatabase } from './db-queries.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as proofhub from '../lib/proofhub-client.js';
import { resolvePerson, getAllPeople } from '../lib/people-resolver.js';
import { scanTranscript } from '../lib/keyword-scanner.js';
import { calculateConfidence } from '../lib/confidence-calculator.js';
import { verifyExtraction } from '../lib/adversarial-verifier.js';
import { analyzeCoverage, classifyLines } from '../lib/coverage-analyzer.js';
import { extractMeetingData } from '../lib/ai-extractor.js';
import { parseVTT, extractSpeakers } from '../lib/vtt-parser.js';
import { detectSummary } from '../lib/summary-detector.js';
import { extractSummaryItems } from '../lib/summary-extractor.js';
import {
  getRoadmapForClient,
  getActiveRoadmapItems,
  getStaleItems,
  getSnapshot,
  getSnapshotsTimeline,
  getRoadmapItemById,
  updateRoadmapItem,
  appendStatusHistory
} from '../lib/roadmap-db.js';
import { getTaxonomy } from '../lib/roadmap-processor.js';
import { collectPrepData, collectCockpitData } from '../lib/prep-collector.js';
import { generateMeetingPrep } from '../lib/prep-generator.js';
import { formatAsMarkdown, formatForSlack, formatBrief } from '../lib/prep-formatter.js';
import {
  reconcileClient, refreshPHCache, getReconcileStatus,
  getAllPHLinksForClient, manualLink, removeLink
} from '../lib/ph-reconciler.js';
import { readdirSync, readFileSync as fsReadFileSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = Router();

// ============ MEETINGS ============

// GET /api/meetings - List meetings with filters
router.get('/meetings', (req, res) => {
  try {
    const { client_id, status, from, to, limit, offset, sort } = req.query;
    const result = db.getMeetings({
      client_id,
      status,
      from,
      to,
      limit: limit ? parseInt(limit) : 50,
      offset: offset ? parseInt(offset) : 0,
      sort,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/meetings/week-counts - Get meeting counts per week
// IMPORTANT: This must be before /meetings/:id to avoid route conflict
router.get('/meetings/week-counts', (req, res) => {
  try {
    const weeks = db.getMeetingCountsByWeek();
    res.json(weeks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/meetings/:id - Full meeting detail
router.get('/meetings/:id', (req, res) => {
  try {
    const result = db.getMeetingById(parseInt(req.params.id));
    if (!result) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/meetings/:id/transcript - Raw transcript
router.get('/meetings/:id/transcript', (req, res) => {
  try {
    const transcript = db.getMeetingTranscript(parseInt(req.params.id));
    if (transcript === null) {
      return res.status(404).json({ error: 'Transcript not found' });
    }
    res.type('text/plain').send(transcript);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/meetings/:id - Update meeting
router.put('/meetings/:id', (req, res) => {
  try {
    const updated = db.updateMeeting(parseInt(req.params.id), req.body);
    if (!updated) {
      return res.status(404).json({ error: 'Meeting not found or no changes' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ ACTION ITEMS ============

// GET /api/action-items - List action items with filters
router.get('/action-items', (req, res) => {
  try {
    const { client_id, status, owner_name, meeting_id, limit, offset } = req.query;
    const result = db.getActionItems({
      client_id,
      status,
      owner_name,
      meeting_id: meeting_id ? parseInt(meeting_id) : undefined,
      limit: limit ? parseInt(limit) : 50,
      offset: offset ? parseInt(offset) : 0,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/action-items/:id - Single action item
router.get('/action-items/:id', (req, res) => {
  try {
    const item = db.getActionItemById(parseInt(req.params.id));
    if (!item) {
      return res.status(404).json({ error: 'Action item not found' });
    }
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/action-items/:id - Update action item
router.put('/action-items/:id', (req, res) => {
  try {
    const updated = db.updateActionItem(parseInt(req.params.id), req.body);
    if (!updated) {
      return res.status(404).json({ error: 'Action item not found or no changes' });
    }
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/action-items/:id/complete - Mark as complete
router.post('/action-items/:id/complete', (req, res) => {
  try {
    const updated = db.setActionItemStatus(parseInt(req.params.id), 'complete');
    if (!updated) {
      return res.status(404).json({ error: 'Action item not found' });
    }
    res.json({ success: true, status: 'complete' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/action-items/:id/reject - Mark as rejected
router.post('/action-items/:id/reject', (req, res) => {
  try {
    const updated = db.setActionItemStatus(parseInt(req.params.id), 'rejected');
    if (!updated) {
      return res.status(404).json({ error: 'Action item not found' });
    }
    res.json({ success: true, status: 'rejected' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/action-items/:id/reopen - Reopen item
router.post('/action-items/:id/reopen', (req, res) => {
  try {
    const updated = db.setActionItemStatus(parseInt(req.params.id), 'open');
    if (!updated) {
      return res.status(404).json({ error: 'Action item not found' });
    }
    res.json({ success: true, status: 'open' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ OWNERS ============

// GET /api/owners - Distinct owner names
router.get('/owners', (req, res) => {
  try {
    const owners = db.getDistinctOwners();
    res.json({ owners });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ DECISIONS ============

// GET /api/decisions - List decisions
router.get('/decisions', (req, res) => {
  try {
    const { client_id, meeting_id, limit, offset } = req.query;
    const result = db.getDecisions({
      client_id,
      meeting_id: meeting_id ? parseInt(meeting_id) : undefined,
      limit: limit ? parseInt(limit) : 50,
      offset: offset ? parseInt(offset) : 0,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ CLIENTS ============

// GET /api/clients - List clients with stats
router.get('/clients', (req, res) => {
  try {
    // Load clients from config
    const configPath = join(__dirname, '..', 'config', 'clients.json');
    const configClients = JSON.parse(readFileSync(configPath, 'utf-8')).clients;

    // Get stats from database
    const dbStats = db.getClientsWithStats();
    const statsMap = new Map(dbStats.map(c => [c.id, c]));

    // Merge config with stats
    const clients = configClients.map(c => ({
      id: c.id,
      name: c.name,
      slack_channel_id: c.slack_channel_id || null,
      total_meetings: statsMap.get(c.id)?.total_meetings || 0,
      total_action_items: statsMap.get(c.id)?.total_action_items || 0,
      last_meeting_date: statsMap.get(c.id)?.last_meeting_date || null,
    }));

    // Sort by meeting count (descending)
    clients.sort((a, b) => b.total_meetings - a.total_meetings);

    res.json({ clients, total: clients.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ STATS ============

// GET /api/stats - Overview statistics
router.get('/stats', (req, res) => {
  try {
    const stats = db.getStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ HEALTH ============

// GET /api/health - Pipeline status
router.get('/health', async (req, res) => {
  try {
    const health = db.getHealth();

    // Try to get PM2 pipeline status
    let pipeline_status = 'unknown';
    try {
      const { execSync } = await import('child_process');
      const pm2Output = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf-8' });
      const pm2List = JSON.parse(pm2Output);
      const pipeline = pm2List.find(p => p.name === 'zoom-pipeline');
      if (pipeline) {
        pipeline_status = pipeline.pm2_env?.status || 'unknown';
      }
    } catch { /* ignore PM2 errors */ }

    res.json({
      ...health,
      pipeline_status,
      dashboard_status: 'online',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ PROOFHUB ============

// GET /api/proofhub/projects - List all ProofHub projects
router.get('/proofhub/projects', async (req, res) => {
  try {
    if (!proofhub.isProofhubConfigured()) {
      return res.status(503).json({ error: 'ProofHub not configured' });
    }
    const projects = await proofhub.getProjects();
    res.json({ projects });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/proofhub/projects/:id/task-lists - Task lists for a project
router.get('/proofhub/projects/:id/task-lists', async (req, res) => {
  try {
    if (!proofhub.isProofhubConfigured()) {
      return res.status(503).json({ error: 'ProofHub not configured' });
    }
    const taskLists = await proofhub.getTaskLists(req.params.id);
    res.json({ task_lists: taskLists });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/proofhub/people - List PH people with resolved names
router.get('/proofhub/people', (req, res) => {
  // Use people resolver (has real names) instead of raw PH API (returns 'no name')
  const people = getAllPeople();
  res.json({ people });
});

// GET /api/proofhub/resolve-owner/:name - Resolve an owner name to PH user
router.get('/proofhub/resolve-owner/:name', (req, res) => {
  try {
    const resolved = resolvePerson(req.params.name);
    if (!resolved) {
      return res.json({ resolved: false, name: req.params.name });
    }
    res.json({ resolved: true, ...resolved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/proofhub/client-project/:clientId - Get PH project for a client
router.get('/proofhub/client-project/:clientId', (req, res) => {
  try {
    const configPath = join(__dirname, '..', 'config', 'clients.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const client = config.clients.find(c => c.id === req.params.clientId);

    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    res.json({
      client_id: client.id,
      client_name: client.name,
      ph_project_id: client.ph_project_id || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/action-items/:id/push-ph - Push action item to ProofHub
router.post('/action-items/:id/push-ph', async (req, res) => {
  try {
    if (!proofhub.isProofhubConfigured()) {
      return res.status(503).json({ error: 'ProofHub not configured' });
    }

    const itemId = parseInt(req.params.id);
    const item = db.getActionItemById(itemId);
    if (!item) {
      return res.status(404).json({ error: 'Action item not found' });
    }

    const { ph_project_id, ph_task_list_id, ph_assignee_id, title, description } = req.body;

    if (!ph_project_id) {
      return res.status(400).json({ error: 'ph_project_id required' });
    }

    // Get task lists if not provided
    let taskListId = ph_task_list_id;
    if (!taskListId) {
      const taskLists = await proofhub.getTaskLists(ph_project_id);
      if (taskLists.length === 0) {
        return res.status(400).json({ error: 'No task lists found in project' });
      }
      taskListId = taskLists[0].id;
    }

    // Resolve assignee if not provided
    let assigneeId = ph_assignee_id;
    if (!assigneeId && item.owner_name) {
      const resolved = resolvePerson(item.owner_name);
      if (resolved?.ph_id) {
        assigneeId = resolved.ph_id;
      }
    }

    // Build task data
    const taskData = {
      title: title || item.title,
      description: description || item.description || ''
    };

    if (assigneeId) {
      taskData.assigned = [parseInt(assigneeId)];
    }

    if (item.due_date) {
      taskData.due_date = item.due_date.slice(0, 10);
    }

    // Create the task
    const task = await proofhub.createTask(ph_project_id, taskListId, taskData);

    // Update action item with PH info
    const phTaskUrl = `https://${process.env.PROOFHUB_COMPANY_URL}/#tasks/${task.id}/project-${ph_project_id}`;
    db.updateActionItem(itemId, {
      ph_task_id: task.id.toString(),
      ph_project_id: ph_project_id.toString(),
      ph_task_list_id: taskListId.toString(),
      ph_assignee_id: assigneeId?.toString() || null,
      status: 'pushed'
    });
    db.setPushedAt(itemId);

    res.json({
      success: true,
      ph_task_id: task.id,
      ph_task_url: phTaskUrl,
      task
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/meetings/:id/push-all-ph - Push all open items from meeting to ProofHub
router.post('/meetings/:id/push-all-ph', async (req, res) => {
  try {
    if (!proofhub.isProofhubConfigured()) {
      return res.status(503).json({ error: 'ProofHub not configured' });
    }

    const meetingId = parseInt(req.params.id);
    const meeting = db.getMeetingById(meetingId);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    const { ph_project_id, ph_task_list_id, tier } = req.body;

    if (!ph_project_id) {
      return res.status(400).json({ error: 'ph_project_id required' });
    }

    // Get task list
    let taskListId = ph_task_list_id;
    if (!taskListId) {
      const taskLists = await proofhub.getTaskLists(ph_project_id);
      if (taskLists.length === 0) {
        return res.status(400).json({ error: 'No task lists found in project' });
      }
      taskListId = taskLists[0].id;
    }

    // Get open action items for this meeting, optionally filtered by tier
    let openItems = meeting.action_items.filter(item => item.status === 'open' && !item.pushed_at);
    if (tier === 'recap') {
      openItems = openItems.filter(item => item.confidence_tier === 'recap');
    } else if (tier === 'conversation') {
      openItems = openItems.filter(item => item.confidence_tier !== 'recap');
    }

    if (openItems.length === 0) {
      return res.json({ success: true, pushed: 0, tasks: [], message: 'No open items to push' });
    }

    const results = [];
    for (const item of openItems) {
      try {
        // Resolve assignee
        let assigneeId = null;
        if (item.owner_name) {
          const resolved = resolvePerson(item.owner_name);
          if (resolved?.ph_id) {
            assigneeId = resolved.ph_id;
          }
        }

        // Build task data
        const taskData = {
          title: item.title,
          description: item.description || ''
        };

        if (assigneeId) {
          taskData.assigned = [parseInt(assigneeId)];
        }

        if (item.due_date) {
          taskData.due_date = item.due_date.slice(0, 10);
        }

        // Create task
        const task = await proofhub.createTask(ph_project_id, taskListId, taskData);

        // Update action item
        const phTaskUrl = `https://${process.env.PROOFHUB_COMPANY_URL}/#tasks/${task.id}/project-${ph_project_id}`;
        db.updateActionItem(item.id, {
          ph_task_id: task.id.toString(),
          ph_project_id: ph_project_id.toString(),
          ph_task_list_id: taskListId.toString(),
          ph_assignee_id: assigneeId?.toString() || null,
          status: 'pushed'
        });
        db.setPushedAt(item.id);

        results.push({
          item_id: item.id,
          ph_task_id: task.id,
          ph_task_url: phTaskUrl,
          success: true
        });
      } catch (err) {
        results.push({
          item_id: item.id,
          success: false,
          error: err.message
        });
      }
    }

    res.json({
      success: true,
      pushed: results.filter(r => r.success).length,
      tasks: results
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ VALIDATION ============

// POST /api/meetings/:id/validate - Validate a single meeting
router.post('/meetings/:id/validate', (req, res) => {
  try {
    const meetingId = parseInt(req.params.id);
    const meeting = db.getMeetingForValidation(meetingId);

    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    // Scan transcript for commitment phrases
    const scanResult = scanTranscript(meeting.transcript_raw);

    // Get action item count
    const actionItemCount = db.getActionItemCountForMeeting(meetingId);

    // Calculate confidence
    const confidence = calculateConfidence(
      scanResult,
      actionItemCount,
      meeting.transcript_raw,
      meeting.status
    );

    // Update meeting with validation results
    db.updateMeetingValidation(meetingId, {
      keywordCount: scanResult.totalPhrases,
      keywordRatio: confidence.ratio,
      confidenceSignal: confidence.signal,
      validationStatus: 'validated'
    });

    res.json({
      meeting_id: meetingId,
      signal: confidence.signal,
      ratio: confidence.ratio,
      reason: confidence.reason,
      keywordCount: scanResult.totalPhrases,
      itemCount: actionItemCount,
      categories: scanResult.categories,
      topPhrases: scanResult.commitmentPhrases.slice(0, 10)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/validate-all - Validate all pending meetings
router.post('/validate-all', (req, res) => {
  try {
    const pendingMeetings = db.getPendingValidationMeetings();
    let green = 0, yellow = 0, red = 0, errors = 0;

    for (const { id } of pendingMeetings) {
      try {
        const meeting = db.getMeetingForValidation(id);
        if (!meeting) continue;

        const scanResult = scanTranscript(meeting.transcript_raw);
        const actionItemCount = db.getActionItemCountForMeeting(id);
        const confidence = calculateConfidence(
          scanResult,
          actionItemCount,
          meeting.transcript_raw,
          meeting.status
        );

        db.updateMeetingValidation(id, {
          keywordCount: scanResult.totalPhrases,
          keywordRatio: confidence.ratio,
          confidenceSignal: confidence.signal,
          validationStatus: 'validated'
        });

        if (confidence.signal === 'green') green++;
        else if (confidence.signal === 'yellow') yellow++;
        else red++;
      } catch (err) {
        console.error(`Validation error for meeting ${id}:`, err.message);
        errors++;
      }
    }

    res.json({
      validated: pendingMeetings.length - errors,
      green,
      yellow,
      red,
      errors
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/validation-stats - Get validation statistics
router.get('/validation-stats', (req, res) => {
  try {
    const stats = db.getValidationStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ ADVERSARIAL VERIFICATION ============

// POST /api/meetings/:id/verify - Run adversarial verification
router.post('/meetings/:id/verify', async (req, res) => {
  try {
    const meetingId = parseInt(req.params.id);
    const data = db.getMeetingWithItems(meetingId);

    if (!data) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    const { meeting, items } = data;

    if (!meeting.transcript_raw || meeting.transcript_raw.length < 500) {
      return res.status(400).json({ error: 'Meeting has no transcript or transcript too short' });
    }

    console.log(`[Verify] Running adversarial verification for meeting ${meetingId}: "${meeting.topic}"`);

    // Run adversarial verification
    const result = await verifyExtraction(meeting.transcript_raw, items);

    // Determine new confidence signal
    let newSignal = meeting.confidence_signal || 'pending';
    if (result.missed_items && result.missed_items.length > 0) {
      // Downgrade to yellow if adversarial found items
      if (newSignal === 'green') newSignal = 'yellow';
    } else if (result.completeness_assessment === 'complete' && meeting.keyword_ratio <= 5) {
      // Upgrade to green if verified complete and keywords align
      newSignal = 'green';
    }

    // Store adversarial result
    db.updateMeetingAdversarial(meetingId, {
      adversarialResult: result,
      completenessAssessment: result.completeness_assessment,
      confidenceSignal: newSignal
    });

    // Create suggested action items for HIGH/MEDIUM confidence findings
    let suggestedCount = 0;
    for (const item of result.missed_items || []) {
      db.insertSuggestedItem(meetingId, meeting.client_id, item);
      suggestedCount++;
    }

    console.log(`[Verify] Found ${suggestedCount} suggested items, assessment: ${result.completeness_assessment}`);

    res.json({
      meeting_id: meetingId,
      missed_items: result.missed_items || [],
      completeness_assessment: result.completeness_assessment,
      verification_notes: result.verification_notes,
      suggested_count: suggestedCount,
      new_confidence_signal: newSignal,
      sections_with_possible_commitments: result.sections_with_possible_commitments || []
    });
  } catch (err) {
    console.error('[Verify] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/verify-all - Run verification on all unverified meetings
router.post('/verify-all', async (req, res) => {
  try {
    const meetings = db.getMeetingsForVerification();
    const limit = parseInt(req.query.limit) || meetings.length;
    const toProcess = meetings.slice(0, limit);

    let verified = 0, complete = 0, incomplete = 0, errors = 0, totalSuggested = 0;

    for (const { id } of toProcess) {
      try {
        const data = db.getMeetingWithItems(id);
        if (!data) continue;

        const { meeting, items } = data;
        const result = await verifyExtraction(meeting.transcript_raw, items);

        let newSignal = meeting.confidence_signal || 'pending';
        if (result.missed_items && result.missed_items.length > 0) {
          if (newSignal === 'green') newSignal = 'yellow';
        } else if (result.completeness_assessment === 'complete' && meeting.keyword_ratio <= 5) {
          newSignal = 'green';
        }

        db.updateMeetingAdversarial(id, {
          adversarialResult: result,
          completenessAssessment: result.completeness_assessment,
          confidenceSignal: newSignal
        });

        for (const item of result.missed_items || []) {
          db.insertSuggestedItem(id, meeting.client_id, item);
          totalSuggested++;
        }

        verified++;
        if (result.completeness_assessment === 'complete') complete++;
        else incomplete++;

        // Rate limit - 2 second delay
        await new Promise(r => setTimeout(r, 2000));
      } catch (err) {
        console.error(`[Verify-all] Error for meeting ${id}:`, err.message);
        errors++;
      }
    }

    res.json({
      verified,
      complete,
      incomplete,
      errors,
      total_suggested: totalSuggested
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/action-items/:id/accept - Accept a suggested item
router.post('/action-items/:id/accept', (req, res) => {
  try {
    const itemId = parseInt(req.params.id);
    const item = db.getActionItemById(itemId);

    if (!item) {
      return res.status(404).json({ error: 'Action item not found' });
    }

    if (item.status !== 'suggested') {
      return res.status(400).json({ error: 'Item is not in suggested status' });
    }

    db.setActionItemStatus(itemId, 'open');
    const updated = db.getActionItemById(itemId);

    res.json({
      success: true,
      message: 'Item accepted and moved to open status',
      item: updated
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/action-items/:id/dismiss - Dismiss a suggested item
router.post('/action-items/:id/dismiss', (req, res) => {
  try {
    const itemId = parseInt(req.params.id);
    const item = db.getActionItemById(itemId);

    if (!item) {
      return res.status(404).json({ error: 'Action item not found' });
    }

    if (item.status !== 'suggested') {
      return res.status(400).json({ error: 'Item is not in suggested status' });
    }

    db.setActionItemStatus(itemId, 'dismissed');
    const updated = db.getActionItemById(itemId);

    res.json({
      success: true,
      message: 'Item dismissed',
      item: updated
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ COVERAGE ANALYSIS ============

// ============ VALIDATION STATS ============

// GET /api/validation/stats - Get accuracy metrics
router.get('/validation/stats', (req, res) => {
  try {
    const period = req.query.period;
    let periodDays = null;
    let periodLabel = 'all_time';

    if (period === '7d') {
      periodDays = 7;
      periodLabel = 'last_7_days';
    } else if (period === '30d') {
      periodDays = 30;
      periodLabel = 'last_30_days';
    }

    const { meetingStats, itemStats } = db.getValidationStatsData(periodDays);

    // Calculate accuracy metrics
    const llmExtracted = itemStats.llm_extracted || 0;
    const rejected = itemStats.rejected_as_hallucination || 0;
    const adversarial = itemStats.adversarial_added || 0;
    const manual = itemStats.manual_added || 0;
    const total = itemStats.total || 0;
    const accepted = itemStats.accepted_suggestions || 0;
    const dismissed = itemStats.dismissed_suggestions || 0;

    const hallucinationRate = llmExtracted > 0 ? parseFloat((rejected / llmExtracted * 100).toFixed(1)) : 0;
    const missRate = total > 0 ? parseFloat(((adversarial + manual) / total * 100).toFixed(1)) : 0;
    const acceptRate = (accepted + dismissed) > 0 ? parseFloat((accepted / (accepted + dismissed) * 100).toFixed(1)) : 0;
    const avgItems = meetingStats.total > 0 ? parseFloat((total / meetingStats.total).toFixed(1)) : 0;

    const totalMeetings = meetingStats.total || 0;
    const greenPct = totalMeetings > 0 ? Math.round((meetingStats.green || 0) / totalMeetings * 100) : 0;
    const yellowPct = totalMeetings > 0 ? Math.round((meetingStats.yellow || 0) / totalMeetings * 100) : 0;
    const redPct = totalMeetings > 0 ? Math.round((meetingStats.red || 0) / totalMeetings * 100) : 0;

    res.json({
      period: periodLabel,
      meetings: {
        total: meetingStats.total || 0,
        validated: meetingStats.validated || 0,
        green: meetingStats.green || 0,
        yellow: meetingStats.yellow || 0,
        red: meetingStats.red || 0
      },
      action_items: {
        total,
        llm_extracted: llmExtracted,
        adversarial_added: adversarial,
        manual_added: manual,
        accepted_suggestions: accepted,
        dismissed_suggestions: dismissed,
        completed: itemStats.completed || 0,
        rejected_as_hallucination: rejected
      },
      accuracy: {
        hallucination_rate: hallucinationRate,
        miss_rate: missRate,
        suggestion_accept_rate: acceptRate,
        avg_items_per_meeting: avgItems,
        avg_keyword_ratio: parseFloat((meetingStats.avg_keyword_ratio || 0).toFixed(1))
      },
      confidence_distribution: {
        green: greenPct,
        yellow: yellowPct,
        red: redPct
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/validation/spot-check - Get meetings needing spot-check
router.get('/validation/spot-check', (req, res) => {
  try {
    const meetings = db.getSpotCheckMeetings();
    res.json({ meetings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/meetings/:id/spot-check - Mark meeting as spot-checked
router.post('/meetings/:id/spot-check', (req, res) => {
  try {
    const meetingId = parseInt(req.params.id);
    db.markSpotChecked(meetingId);
    res.json({ success: true, message: 'Marked as spot-checked' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/meetings/:id/action-items - Add manual action item
router.post('/meetings/:id/action-items', (req, res) => {
  try {
    const meetingId = parseInt(req.params.id);
    const meeting = db.getMeetingById(meetingId);

    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    const { title, owner_name, due_date, priority, description } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }

    const item = db.insertManualActionItem(meetingId, meeting.meeting?.client_id, {
      title,
      owner_name,
      due_date,
      priority,
      description
    });

    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/meetings/:id/coverage - Get coverage analysis
router.get('/meetings/:id/coverage', (req, res) => {
  try {
    const meetingId = parseInt(req.params.id);
    const data = db.getMeetingForCoverage(meetingId);

    if (!data) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    const { meeting, items } = data;

    // Check if we have cached analysis
    if (meeting.coverage_analysis && !req.query.refresh) {
      try {
        const cached = JSON.parse(meeting.coverage_analysis);
        return res.json(cached);
      } catch {}
    }

    if (!meeting.transcript_raw || meeting.transcript_raw.length < 100) {
      return res.status(400).json({ error: 'Meeting has no transcript' });
    }

    // Run keyword scan first
    const keywordResults = scanTranscript(meeting.transcript_raw);

    // Run coverage analysis
    const analysis = analyzeCoverage(meeting.transcript_raw, items, keywordResults);

    // Add line classifications for transcript highlighting
    analysis.lineClassifications = classifyLines(meeting.transcript_raw, items, keywordResults);

    // Cache the result
    db.updateMeetingCoverage(meetingId, analysis);

    res.json(analysis);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ REEXTRACT ============

// POST /api/meetings/:id/reextract - Re-run Gemini extraction for a meeting
router.post('/meetings/:id/reextract', async (req, res) => {
  try {
    const meetingId = parseInt(req.params.id);
    const meeting = db.getMeetingForReextract(meetingId);

    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    if (!meeting.transcript_raw || meeting.transcript_length < 5000) {
      return res.status(400).json({
        error: 'Transcript too short for reextraction',
        transcript_length: meeting.transcript_length || 0
      });
    }

    console.log(`[Reextract] Starting reextraction for meeting ${meetingId}: "${meeting.topic}"`);

    // Supersede existing adversarial suggestions
    const superseded = db.supersedeAdversarialItems(meetingId);
    console.log(`[Reextract] Superseded ${superseded.changes} adversarial suggestions`);

    // Extract speakers from transcript (assume raw text format, not VTT)
    const speakers = [];
    const speakerMatches = meeting.transcript_raw.match(/^([^:]+):/gm);
    if (speakerMatches) {
      const uniqueSpeakers = [...new Set(speakerMatches.map(s => s.replace(':', '').trim()))];
      speakers.push(...uniqueSpeakers.slice(0, 10)); // Limit to 10 speakers
    }

    // Run Gemini extraction
    console.log(`[Reextract] Running Gemini extraction (${meeting.transcript_length} chars, ${speakers.length} speakers)...`);
    const extraction = await extractMeetingData({
      transcript: meeting.transcript_raw,
      topic: meeting.topic,
      clientName: meeting.client_name,
      meetingDate: meeting.start_time,
      speakers,
    });

    // Unwrap array if Gemini returned [{...}] instead of {...}
    const result = Array.isArray(extraction) ? extraction[0] : extraction;

    const actionCount = result.action_items?.length || 0;
    const decisionCount = result.decisions?.length || 0;
    console.log(`[Reextract] Extracted: ${actionCount} action items, ${decisionCount} decisions`);

    // Insert new action items
    if (result.action_items?.length) {
      db.insertReextractedItems(meetingId, meeting.client_id, result.action_items);
    }

    // Insert new decisions
    if (result.decisions?.length) {
      db.insertReextractedDecisions(meetingId, meeting.client_id, result.decisions);
    }

    // Update meeting with new extraction
    db.updateMeetingReextract(meetingId, extraction);

    // Re-run keyword validation
    const scanResult = scanTranscript(meeting.transcript_raw);
    const confidence = calculateConfidence(
      scanResult,
      actionCount,
      meeting.transcript_raw,
      'completed'
    );

    db.updateMeetingValidation(meetingId, {
      keywordCount: scanResult.totalPhrases,
      keywordRatio: confidence.ratio,
      confidenceSignal: confidence.signal,
      validationStatus: 'validated'
    });

    console.log(`[Reextract] Complete. New confidence: ${confidence.signal}`);

    res.json({
      success: true,
      reextracted: true,
      action_items: actionCount,
      decisions: decisionCount,
      superseded_count: superseded.changes,
      confidence_signal: confidence.signal,
      keyword_ratio: confidence.ratio
    });
  } catch (err) {
    console.error('[Reextract] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ SUMMARY EXTRACTION ============

// POST /api/meetings/:id/extract-summary - Detect and extract items from recap section
router.post('/meetings/:id/extract-summary', async (req, res) => {
  try {
    const meetingId = parseInt(req.params.id);
    const meeting = db.getMeetingForReextract(meetingId);

    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    if (!meeting.transcript_raw) {
      return res.status(400).json({ error: 'No transcript available' });
    }

    console.log(`[Summary Extract] Starting for meeting ${meetingId}: "${meeting.topic}"`);

    // Detect summary section
    const detection = detectSummary(meeting.transcript_raw);

    if (!detection.detected) {
      // Update meeting to mark no recap detected
      db.updateMeetingRecap(meetingId, {
        detected: false,
        speaker: null,
        startLine: null,
        itemCount: 0
      });

      return res.json({
        detected: false,
        reason: detection.reason,
        meeting_id: meetingId
      });
    }

    console.log(`[Summary Extract] Detected recap at line ${detection.startLine}, speaker: ${detection.speaker}, confidence: ${detection.confidence}`);
    console.log(`[Summary Extract] Summary text length: ${detection.summaryText.length} chars`);

    // Clear any existing recap items
    const cleared = db.clearRecapItems(meetingId);
    if (cleared.changes > 0) {
      console.log(`[Summary Extract] Cleared ${cleared.changes} existing recap items`);
    }

    // Extract items from summary section
    const extraction = await extractSummaryItems(detection.summaryText, {
      topic: meeting.topic,
      clientName: meeting.client_name,
      speaker: detection.speaker
    });

    const itemCount = extraction.items?.length || 0;
    console.log(`[Summary Extract] Extracted ${itemCount} items from recap`);

    // Insert recap items
    if (extraction.items?.length) {
      db.insertRecapItems(meetingId, meeting.client_id, extraction.items);
    }

    // Update meeting with recap detection results
    db.updateMeetingRecap(meetingId, {
      detected: true,
      speaker: detection.speaker,
      startLine: detection.startLine,
      itemCount: itemCount
    });

    res.json({
      detected: true,
      speaker: detection.speaker,
      confidence: detection.confidence,
      start_line: detection.startLine,
      line_count: detection.lineCount,
      summary_length: detection.summaryText.length,
      count: itemCount,
      items: extraction.items,
      tokens_in: extraction.tokensIn,
      tokens_out: extraction.tokensOut,
      meeting_id: meetingId
    });
  } catch (err) {
    console.error('[Summary Extract] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/extract-summaries-all - Run summary extraction on all meetings
router.post('/extract-summaries-all', async (req, res) => {
  try {
    const meetings = db.getMeetingsForSummaryExtraction();
    console.log(`[Summary Extract All] Processing ${meetings.length} meetings`);

    const results = {
      total: meetings.length,
      detected: 0,
      not_detected: 0,
      items_extracted: 0,
      errors: 0,
      meetings: []
    };

    for (const meeting of meetings) {
      try {
        console.log(`[Summary Extract All] Processing meeting ${meeting.id}: "${meeting.topic}"`);

        // Detect summary
        const detection = detectSummary(meeting.transcript_raw);

        if (!detection.detected) {
          db.updateMeetingRecap(meeting.id, {
            detected: false,
            speaker: null,
            startLine: null,
            itemCount: 0
          });
          results.not_detected++;
          results.meetings.push({
            id: meeting.id,
            topic: meeting.topic,
            detected: false,
            reason: detection.reason
          });
          continue;
        }

        // Clear existing recap items
        db.clearRecapItems(meeting.id);

        // Extract from summary
        const extraction = await extractSummaryItems(detection.summaryText, {
          topic: meeting.topic,
          clientName: meeting.client_name,
          speaker: detection.speaker
        });

        const itemCount = extraction.items?.length || 0;

        // Insert items
        if (extraction.items?.length) {
          db.insertRecapItems(meeting.id, meeting.client_id, extraction.items);
        }

        // Update meeting
        db.updateMeetingRecap(meeting.id, {
          detected: true,
          speaker: detection.speaker,
          startLine: detection.startLine,
          itemCount: itemCount
        });

        results.detected++;
        results.items_extracted += itemCount;
        results.meetings.push({
          id: meeting.id,
          topic: meeting.topic,
          detected: true,
          speaker: detection.speaker,
          items: itemCount
        });

        // Delay between Gemini calls
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (err) {
        console.error(`[Summary Extract All] Error on meeting ${meeting.id}:`, err.message);
        results.errors++;
        results.meetings.push({
          id: meeting.id,
          topic: meeting.topic,
          error: err.message
        });
      }
    }

    console.log(`[Summary Extract All] Complete. Detected: ${results.detected}, Items: ${results.items_extracted}`);
    res.json(results);
  } catch (err) {
    console.error('[Summary Extract All] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ ROADMAP ============

// GET /api/roadmap/taxonomy - Get task taxonomy
router.get('/roadmap/taxonomy', (req, res) => {
  try {
    const taxonomy = getTaxonomy();
    res.json(taxonomy);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/roadmap/:clientId - Full roadmap for client
router.get('/roadmap/:clientId', (req, res) => {
  try {
    const items = getRoadmapForClient(getDatabase(), req.params.clientId);
    res.json({ client_id: req.params.clientId, items, total: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/roadmap/:clientId/active - Active roadmap items (not done/dropped)
router.get('/roadmap/:clientId/active', (req, res) => {
  try {
    const items = getActiveRoadmapItems(getDatabase(), req.params.clientId);
    res.json({ client_id: req.params.clientId, items, total: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/roadmap/:clientId/stale - Stale items (not discussed in N+ meetings)
router.get('/roadmap/:clientId/stale', (req, res) => {
  try {
    const threshold = parseInt(req.query.threshold) || 2;
    const items = getStaleItems(getDatabase(), req.params.clientId, threshold);
    res.json({ client_id: req.params.clientId, threshold, items, total: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/roadmap/:clientId/by-category - Roadmap grouped by category
router.get('/roadmap/:clientId/by-category', (req, res) => {
  try {
    const items = getRoadmapForClient(getDatabase(), req.params.clientId);
    const byCategory = {};
    for (const item of items) {
      if (!byCategory[item.category]) {
        byCategory[item.category] = [];
      }
      byCategory[item.category].push(item);
    }
    res.json({ client_id: req.params.clientId, categories: byCategory, total: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/roadmap/:clientId/snapshot/:meetingId - Snapshot at specific meeting
router.get('/roadmap/:clientId/snapshot/:meetingId', (req, res) => {
  try {
    const snapshot = getSnapshot(getDatabase(), req.params.clientId, parseInt(req.params.meetingId));
    if (!snapshot) {
      return res.status(404).json({ error: 'Snapshot not found' });
    }
    res.json(snapshot);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/roadmap/:clientId/timeline - Timeline of snapshots
router.get('/roadmap/:clientId/timeline', (req, res) => {
  try {
    const snapshots = getSnapshotsTimeline(getDatabase(), req.params.clientId);
    res.json({ client_id: req.params.clientId, snapshots, total: snapshots.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/roadmap/items/:id - Update roadmap item
router.put('/roadmap/items/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const item = getRoadmapItemById(getDatabase(), id);
    if (!item) {
      return res.status(404).json({ error: 'Roadmap item not found' });
    }

    const updated = updateRoadmapItem(getDatabase(), id, req.body);
    if (!updated) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const result = getRoadmapItemById(getDatabase(), id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/roadmap/items/:id/status - Update status with history
router.post('/roadmap/items/:id/status', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { status, notes, meeting_id } = req.body;

    if (!status) {
      return res.status(400).json({ error: 'status is required' });
    }

    const item = getRoadmapItemById(getDatabase(), id);
    if (!item) {
      return res.status(404).json({ error: 'Roadmap item not found' });
    }

    // Update status
    updateRoadmapItem(getDatabase(), id, { status, status_reason: notes });

    // Append to history
    appendStatusHistory(getDatabase(), id, {
      meeting_id: meeting_id || null,
      status,
      notes: notes || `Status changed to ${status}`
    });

    const result = getRoadmapItemById(getDatabase(), id);
    res.json({ success: true, item: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ MEETING PREP ============

// GET /api/prep/:clientId - Generate fresh prep (returns JSON)
router.get('/prep/:clientId', async (req, res) => {
  try {
    const prepData = await collectPrepData(getDatabase(), req.params.clientId);
    const result = await generateMeetingPrep(prepData);
    res.json(result.json);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prep/:clientId/markdown - Generate fresh prep (returns Markdown)
router.get('/prep/:clientId/markdown', async (req, res) => {
  try {
    const prepData = await collectPrepData(getDatabase(), req.params.clientId);
    const result = await generateMeetingPrep(prepData);
    const markdown = formatAsMarkdown(result.json);
    res.type('text/plain').send(markdown);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prep/:clientId/brief - Generate pre-huddle brief (returns text)
router.get('/prep/:clientId/brief', async (req, res) => {
  try {
    const prepData = await collectPrepData(getDatabase(), req.params.clientId);
    const result = await generateMeetingPrep(prepData);
    const brief = formatBrief(result.json);
    res.type('text/plain').send(brief);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prep/:clientId/slack - Generate and post to Slack
router.post('/prep/:clientId/slack', async (req, res) => {
  try {
    const clientId = req.params.clientId;

    // Load client config
    const configPath = join(__dirname, '..', 'config', 'clients.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const client = config.clients.find(c => c.id === clientId);

    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    if (!client.slack_channel_id) {
      return res.status(400).json({ error: 'No Slack channel configured for this client' });
    }

    const prepData = await collectPrepData(getDatabase(), clientId);
    const result = await generateMeetingPrep(prepData);
    const slackMarkdown = formatForSlack(result.json);

    // Post to Slack
    const slackToken = process.env.SLACK_BOT_TOKEN;
    if (!slackToken) {
      return res.status(503).json({ error: 'SLACK_BOT_TOKEN not configured' });
    }

    const slackResponse = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${slackToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        channel: client.slack_channel_id,
        text: `Meeting Prep: ${client.name}`,
        blocks: [{
          type: 'section',
          text: { type: 'mrkdwn', text: slackMarkdown.substring(0, 3000) }
        }]
      })
    });

    const slackResult = await slackResponse.json();
    if (!slackResult.ok) {
      return res.status(500).json({ error: `Slack error: ${slackResult.error}` });
    }

    res.json({
      success: true,
      channel: client.slack_channel_id,
      ts: slackResult.ts,
      prep: result.json
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prep/history/:clientId - List saved prep documents
router.get('/prep/history/:clientId', (req, res) => {
  try {
    const prepsDir = join(__dirname, '..', '..', 'data', 'preps');
    if (!existsSync(prepsDir)) {
      return res.json({ preps: [] });
    }

    const files = readdirSync(prepsDir);
    const clientPreps = files
      .filter(f => f.startsWith(req.params.clientId) && f.endsWith('.json'))
      .map(f => {
        const dateMatch = f.match(/(\d{4}-\d{2}-\d{2})/);
        return {
          filename: f,
          date: dateMatch ? dateMatch[1] : null,
          json_path: `/api/prep/saved/${f}`,
          md_path: `/api/prep/saved/${f.replace('.json', '.md')}`
        };
      })
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    res.json({ client_id: req.params.clientId, preps: clientPreps });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prep/saved/:filename - Retrieve a saved prep document
router.get('/prep/saved/:filename', (req, res) => {
  try {
    const prepsDir = join(__dirname, '..', '..', 'data', 'preps');
    const filePath = join(prepsDir, req.params.filename);

    // Security: ensure filename doesn't traverse directories
    if (req.params.filename.includes('..') || req.params.filename.includes('/')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    if (!existsSync(filePath)) {
      return res.status(404).json({ error: 'Prep document not found' });
    }

    const content = fsReadFileSync(filePath, 'utf-8');

    if (req.params.filename.endsWith('.json')) {
      res.json(JSON.parse(content));
    } else {
      res.type('text/plain').send(content);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ RECONCILIATION (Phase 14A) ============

// POST /api/reconcile/:clientId - Run PH reconciliation
router.post('/reconcile/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    const configPath = join(__dirname, '..', 'config', 'clients.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const client = config.clients.find(c => c.id === clientId);

    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }
    if (!client.ph_project_id) {
      return res.status(400).json({ error: 'Client has no ProofHub project configured' });
    }

    const database = getDatabase();
    const result = await reconcileClient(database, clientId, client.ph_project_id);
    res.json(result);
  } catch (err) {
    console.error('Reconciliation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reconcile/:clientId/status - Get reconciliation status
router.get('/reconcile/:clientId/status', (req, res) => {
  try {
    const database = getDatabase();
    const status = getReconcileStatus(database, req.params.clientId);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reconcile/:clientId/refresh - Refresh PH cache only
router.post('/reconcile/:clientId/refresh', async (req, res) => {
  try {
    const { clientId } = req.params;
    const configPath = join(__dirname, '..', 'config', 'clients.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const client = config.clients.find(c => c.id === clientId);

    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }
    if (!client.ph_project_id) {
      return res.status(400).json({ error: 'Client has no ProofHub project configured' });
    }

    const database = getDatabase();
    const count = await refreshPHCache(database, clientId, client.ph_project_id);
    res.json({ cached_tasks: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reconcile/:clientId/links - Get all PH links for client
router.get('/reconcile/:clientId/links', (req, res) => {
  try {
    const database = getDatabase();
    const links = getAllPHLinksForClient(database, req.params.clientId);
    res.json({ links });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reconcile/:clientId/link - Manual link
router.post('/reconcile/:clientId/link', (req, res) => {
  try {
    const { roadmap_item_id, ph_task_id, ph_task_title } = req.body;
    if (!roadmap_item_id || !ph_task_id) {
      return res.status(400).json({ error: 'roadmap_item_id and ph_task_id required' });
    }

    const database = getDatabase();
    manualLink(database, req.params.clientId, roadmap_item_id, ph_task_id, ph_task_title || '');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/reconcile/:clientId/link/:linkId - Remove link
router.delete('/reconcile/:clientId/link/:linkId', (req, res) => {
  try {
    const database = getDatabase();
    removeLink(database, parseInt(req.params.linkId));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ COCKPIT (Phase 14B) ============

// Cockpit cache: store generated prep per client, reuse until explicitly refreshed
const cockpitCache = new Map(); // clientId -> { data, generatedAt }
const COCKPIT_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

// GET /api/cockpit/:clientId - Get cockpit data (cached, no Gemini call on repeat visits)
router.get('/cockpit/:clientId', async (req, res) => {
  try {
    const clientId = req.params.clientId;
    const forceRefresh = req.query.refresh === 'true';
    const database = getDatabase();
    const cockpitData = await collectCockpitData(database, clientId);

    // Check cache
    const cached = cockpitCache.get(clientId);
    let prep, talkingPoints;

    if (cached && !forceRefresh && (Date.now() - cached.generatedAt) < COCKPIT_CACHE_TTL) {
      // Use cached prep and talking points
      prep = cached.prep;
      talkingPoints = cached.talkingPoints;
    } else {
      // Generate fresh (Gemini call)
      const result = await generateMeetingPrep(cockpitData);
      prep = result.json;
      talkingPoints = result.json.talking_points || {};

      // Cache it
      cockpitCache.set(clientId, {
        prep,
        talkingPoints,
        generatedAt: Date.now()
      });
    }

    res.json({
      ...cockpitData,
      prep,
      talking_points: talkingPoints,
      cached: !forceRefresh && cached && (Date.now() - cached.generatedAt) < COCKPIT_CACHE_TTL
    });
  } catch (err) {
    console.error('Cockpit error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/cockpit/:clientId/selection - Save checkbox state
router.put('/cockpit/:clientId/selection', (req, res) => {
  try {
    const { roadmap_item_id, selected } = req.body;
    if (roadmap_item_id === undefined || selected === undefined) {
      return res.status(400).json({ error: 'roadmap_item_id and selected required' });
    }

    const today = new Date().toISOString().split('T')[0];
    const database = getDatabase();

    database.prepare(`
      INSERT INTO cockpit_selections (client_id, roadmap_item_id, selected, selection_date, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(client_id, roadmap_item_id, selection_date)
      DO UPDATE SET selected = excluded.selected, updated_at = datetime('now')
    `).run(req.params.clientId, roadmap_item_id, selected ? 1 : 0, today);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cockpit/:clientId/agenda - Build personalized agenda from selections
router.post('/cockpit/:clientId/agenda', async (req, res) => {
  try {
    const database = getDatabase();
    const today = new Date().toISOString().split('T')[0];

    // Get selected items
    const selections = database.prepare(`
      SELECT cs.roadmap_item_id, ri.title, ri.status, ri.category
      FROM cockpit_selections cs
      JOIN roadmap_items ri ON cs.roadmap_item_id = ri.id
      WHERE cs.client_id = ? AND cs.selection_date = ? AND cs.selected = 1
    `).all(req.params.clientId, today);

    if (selections.length === 0) {
      return res.json({
        agenda: [],
        message: 'No items selected for agenda'
      });
    }

    // Group by type
    const wins = selections.filter(s => s.status === 'done');
    const blockers = selections.filter(s => s.status === 'blocked');
    const stale = selections.filter(s => s.status === 'agreed');
    const inProgress = selections.filter(s => s.status === 'in-progress');

    // Build agenda
    const agenda = [];

    if (wins.length > 0) {
      agenda.push({
        topic: 'Wins to Report',
        minutes: Math.min(wins.length * 2, 5),
        items: wins.map(w => w.title)
      });
    }

    if (inProgress.length > 0) {
      agenda.push({
        topic: 'In-Progress Updates',
        minutes: Math.min(inProgress.length * 2, 8),
        items: inProgress.map(i => i.title)
      });
    }

    if (blockers.length > 0) {
      agenda.push({
        topic: 'Blockers - Need Answers',
        minutes: Math.min(blockers.length * 3, 10),
        items: blockers.map(b => b.title)
      });
    }

    if (stale.length > 0) {
      agenda.push({
        topic: 'Stale Items - Must Address',
        minutes: Math.min(stale.length * 2, 6),
        items: stale.map(s => s.title)
      });
    }

    const totalMinutes = agenda.reduce((sum, a) => sum + a.minutes, 0);

    res.json({
      agenda,
      total_minutes: totalMinutes,
      items_count: selections.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
