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
import { initDatabase as initMetricsDb, getMetrics, getStats as getMetricsStats, computeAllMetrics } from '../lib/session-metrics.js';
import { getAllBaselines, getBaselines, recalculateAll as recalculateBaselines, initBaselinesTable } from '../lib/session-baselines.js';
import { getScorecard, getClientTrend, getTeamStats, getAllTeamStats, getFlags, getBenchmarks, getWeeklyDigest, getCalibrationStatus, saveCalibrationScores, getCalibrationComparison, getCalibrationMeetingData } from '../lib/session-queries.js';
import { getPPCReport, trackPPCTasks, updateDisposition, initPPCTrackingTable, refreshPPCStatuses, refreshSingleTask } from '../lib/ppc-task-tracker.js';
import { readdirSync, readFileSync as fsReadFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';

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

// Helper: Get or generate prep (ONE Gemini call per day per client, shared across all buttons)
const prepsDir = join(__dirname, '..', '..', 'data', 'preps');

async function getOrGeneratePrep(clientId, forceRefresh = false) {
  const today = new Date().toISOString().split('T')[0];

  // Ensure preps directory exists
  if (!existsSync(prepsDir)) {
    mkdirSync(prepsDir, { recursive: true });
  }

  // Find existing prep for today
  const files = existsSync(prepsDir) ? readdirSync(prepsDir) : [];
  const todayFiles = files
    .filter(f => f.startsWith(`${clientId}-${today}`) && f.endsWith('.json'))
    .sort()
    .reverse(); // Latest version first

  // If exists and not forcing refresh, return cached
  if (!forceRefresh && todayFiles.length > 0) {
    const latestFile = todayFiles[0];
    const content = fsReadFileSync(join(prepsDir, latestFile), 'utf-8');
    const prep = JSON.parse(content);
    return { prep, fromCache: true, filename: latestFile };
  }

  // Generate fresh prep
  const database = getDatabase();
  const prepData = await collectPrepData(database, clientId);
  const result = await generateMeetingPrep(prepData);

  // Determine version number
  const existingVersions = todayFiles.map(f => {
    const match = f.match(/-v(\d+)\.json$/);
    return match ? parseInt(match[1]) : 1;
  });
  const nextVersion = existingVersions.length > 0 ? Math.max(...existingVersions) + 1 : 1;

  // Save to disk
  const filename = `${clientId}-${today}-v${nextVersion}.json`;
  const filepath = join(prepsDir, filename);
  writeFileSync(filepath, JSON.stringify(result.json, null, 2));

  // Also save markdown version
  const mdFilename = `${clientId}-${today}-v${nextVersion}.md`;
  const mdFilepath = join(prepsDir, mdFilename);
  writeFileSync(mdFilepath, formatAsMarkdown(result.json));

  return { prep: result.json, fromCache: false, filename, version: nextVersion };
}

// GET /api/prep/:clientId - Get prep (cached or generate)
router.get('/prep/:clientId', async (req, res) => {
  try {
    const { prep, fromCache, filename } = await getOrGeneratePrep(req.params.clientId, false);
    res.json({ ...prep, _cached: fromCache, _filename: filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prep/:clientId/markdown - Get prep as Markdown (uses cached prep)
router.get('/prep/:clientId/markdown', async (req, res) => {
  try {
    const { prep } = await getOrGeneratePrep(req.params.clientId, false);
    const markdown = formatAsMarkdown(prep);
    res.type('text/plain').send(markdown);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prep/:clientId/brief - Get pre-huddle brief (uses cached prep, instant)
router.get('/prep/:clientId/brief', async (req, res) => {
  try {
    const { prep } = await getOrGeneratePrep(req.params.clientId, false);
    const brief = formatBrief(prep);
    res.type('text/plain').send(brief);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prep/:clientId/regenerate - Force regenerate prep (new version)
router.get('/prep/:clientId/regenerate', async (req, res) => {
  try {
    const { prep, filename, version } = await getOrGeneratePrep(req.params.clientId, true);
    res.json({ ...prep, _regenerated: true, _filename: filename, _version: version });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prep/:clientId/slack - Post cached prep to Slack (uses cached, no Gemini call)
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

    // Use cached prep (or generate if none exists today)
    const { prep } = await getOrGeneratePrep(clientId, false);
    const slackMarkdown = formatForSlack(prep);

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
      prep
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

// GET /api/cockpit/:clientId - Get cockpit data (uses unified disk cache, instant after first gen)
router.get('/cockpit/:clientId', async (req, res) => {
  try {
    const clientId = req.params.clientId;
    const database = getDatabase();

    // Get cockpit data (roadmap, PH links, selections)
    const cockpitData = await collectCockpitData(database, clientId);

    // Get prep from unified disk cache (no Gemini call if already generated today)
    const { prep, fromCache } = await getOrGeneratePrep(clientId, false);

    res.json({
      ...cockpitData,
      prep,
      talking_points: prep.talking_points || {},
      _cached: fromCache
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
    const { selected_item_ids, selected_proposals } = req.body || {};

    let selections;

    if (selected_item_ids && selected_item_ids.length > 0) {
      // Use IDs sent from the UI (primary path)
      const placeholders = selected_item_ids.map(() => '?').join(',');
      selections = database.prepare(`
        SELECT id as roadmap_item_id, title, status, category, meetings_silent_count
        FROM roadmap_items
        WHERE id IN (${placeholders})
      `).all(...selected_item_ids);
    } else {
      // Fallback: read from cockpit_selections DB
      const today = new Date().toISOString().split('T')[0];
      selections = database.prepare(`
        SELECT cs.roadmap_item_id, ri.title, ri.status, ri.category, ri.meetings_silent_count
        FROM cockpit_selections cs
        JOIN roadmap_items ri ON cs.roadmap_item_id = ri.id
        WHERE cs.client_id = ? AND cs.selection_date = ? AND cs.selected = 1
      `).all(req.params.clientId, today);
    }

    if (selections.length === 0 && (!selected_proposals || selected_proposals.length === 0)) {
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

    // Add proposals if sent from UI
    if (selected_proposals && selected_proposals.length > 0) {
      agenda.push({
        topic: 'Strategic Proposals',
        minutes: Math.min(selected_proposals.length * 5, 15),
        items: selected_proposals
      });
    }

    // Always end with Next Steps
    agenda.push({
      topic: 'Next Steps & Action Items',
      minutes: 5,
      items: ['Confirm owners and deadlines for all discussed items']
    });

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

// ============ SESSION METRICS (Phase 15A) ============

// GET /api/session/:meetingId/metrics - Get session metrics for a meeting
router.get('/session/:meetingId/metrics', (req, res) => {
  try {
    const meetingId = parseInt(req.params.meetingId);
    const metricsDb = initMetricsDb();
    const metrics = getMetrics(metricsDb, meetingId);
    metricsDb.close();

    if (!metrics) {
      return res.status(404).json({ error: 'No metrics for this meeting' });
    }
    res.json(metrics);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/session/metrics/summary - Get aggregate metrics summary
router.get('/session/metrics/summary', (req, res) => {
  try {
    const metricsDb = initMetricsDb();
    const stats = getMetricsStats(metricsDb);
    metricsDb.close();

    res.json({
      total_meetings: stats.total_meetings,
      avg_action_items: parseFloat(stats.avg_action_items?.toFixed(1)) || 0,
      avg_action_density: parseFloat(stats.avg_action_density?.toFixed(3)) || 0,
      avg_due_date_rate: parseFloat(stats.avg_due_date_rate?.toFixed(0)) || 0,
      avg_owner_assignment_rate: parseFloat(stats.avg_owner_assignment_rate?.toFixed(0)) || 0,
      avg_b3x_speaking_ratio: parseFloat(stats.avg_b3x_speaking_ratio?.toFixed(0)) || 0,
      meetings_with_stale_b3x: stats.meetings_with_stale_b3x || 0,
      meeting_types: {
        regular: stats.type_regular || 0,
        internal: stats.type_internal || 0,
        kickoff: stats.type_kickoff || 0,
        'vip-session': stats.type_vip || 0
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/session/:meetingId/metrics/compute - Compute metrics for a specific meeting
router.post('/session/:meetingId/metrics/compute', (req, res) => {
  try {
    const meetingId = parseInt(req.params.meetingId);
    const metricsDb = initMetricsDb();
    const metrics = computeAllMetrics(metricsDb, meetingId);
    metricsDb.close();

    if (!metrics) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    res.json({ success: true, metrics });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ SESSION BASELINES (Phase 15C) ============

// GET /api/session/baselines - Get all baselines
router.get('/session/baselines', (req, res) => {
  try {
    const metricsDb = initMetricsDb();
    initBaselinesTable(metricsDb);
    const baselines = getAllBaselines(metricsDb);
    metricsDb.close();

    res.json(baselines);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/session/baselines/:scope - Get baselines for a specific scope
router.get('/session/baselines/:scope', (req, res) => {
  try {
    const scope = req.params.scope;
    const metricsDb = initMetricsDb();
    initBaselinesTable(metricsDb);
    const baselines = getBaselines(metricsDb, scope);
    metricsDb.close();

    if (!baselines) {
      return res.status(404).json({ error: `No baselines found for scope: ${scope}` });
    }
    res.json(baselines);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/session/baselines/recalculate - Recalculate all baselines
router.post('/session/baselines/recalculate', (req, res) => {
  try {
    const metricsDb = initMetricsDb();
    const result = recalculateBaselines(metricsDb);
    metricsDb.close();

    res.json({
      success: true,
      agency_meetings: result.agency?.sample_size || 0,
      clients_with_baselines: result.clients.length,
      members_with_baselines: result.members.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ SESSION INTELLIGENCE (Phase 15D) ============

// GET /api/session/:meetingId/scorecard - Complete scorecard for one meeting
router.get('/session/:meetingId/scorecard', (req, res) => {
  try {
    const meetingId = parseInt(req.params.meetingId);
    const metricsDb = initMetricsDb();
    initBaselinesTable(metricsDb);
    const scorecard = getScorecard(metricsDb, meetingId);
    metricsDb.close();

    if (!scorecard) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    res.json(scorecard);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/session/client/:clientId/trend - Score trend for a client
router.get('/session/client/:clientId/trend', (req, res) => {
  try {
    const clientId = req.params.clientId;
    const limit = parseInt(req.query.limit) || 20;
    const metricsDb = initMetricsDb();
    initBaselinesTable(metricsDb);
    const trend = getClientTrend(metricsDb, clientId, { limit });
    metricsDb.close();

    res.json(trend);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/session/team - Aggregate team stats for all B3X members
router.get('/session/team', (req, res) => {
  try {
    const metricsDb = initMetricsDb();
    const data = getAllTeamStats(metricsDb);
    metricsDb.close();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/session/evaluated-meetings - List meeting IDs that have evaluations
router.get('/session/evaluated-meetings', (req, res) => {
  try {
    const metricsDb = initMetricsDb();
    const rows = metricsDb.prepare('SELECT DISTINCT meeting_id FROM session_evaluations').all();
    metricsDb.close();
    res.json({ meeting_ids: rows.map(r => r.meeting_id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ CALIBRATION (Phase 17A) ============
// IMPORTANT: These routes must be BEFORE /session/:meetingId to avoid catch-all

// GET /api/session/calibration/status - Get calibration status for all 10 meetings
router.get('/session/calibration/status', (req, res) => {
  try {
    const metricsDb = initMetricsDb();
    const status = getCalibrationStatus(metricsDb);
    metricsDb.close();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/session/calibration/comparison - Get AI vs human comparison (only when all 10 scored)
router.get('/session/calibration/comparison', (req, res) => {
  try {
    const metricsDb = initMetricsDb();
    const comparison = getCalibrationComparison(metricsDb);
    metricsDb.close();
    res.json(comparison);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/session/calibration/:meetingId - Get meeting data for calibration form
router.get('/session/calibration/:meetingId', (req, res) => {
  try {
    const meetingId = parseInt(req.params.meetingId);
    const metricsDb = initMetricsDb();
    const data = getCalibrationMeetingData(metricsDb, meetingId);
    metricsDb.close();

    if (!data) {
      return res.status(404).json({ error: 'Meeting not found or not in calibration set' });
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/session/calibration/:meetingId - Save human calibration scores
router.post('/session/calibration/:meetingId', (req, res) => {
  try {
    const meetingId = parseInt(req.params.meetingId);
    const { scores, notes } = req.body;

    if (!scores) {
      return res.status(400).json({ error: 'scores object required' });
    }

    const metricsDb = initMetricsDb();
    const result = saveCalibrationScores(metricsDb, meetingId, scores, notes || '');
    metricsDb.close();

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/session/team/:memberName/stats - Team member stats
router.get('/session/team/:memberName/stats', (req, res) => {
  try {
    const memberName = req.params.memberName;
    const metricsDb = initMetricsDb();
    const stats = getTeamStats(metricsDb, memberName);
    metricsDb.close();

    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/session/flags - Flagged meetings
router.get('/session/flags', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const metricsDb = initMetricsDb();
    initBaselinesTable(metricsDb);
    const flags = getFlags(metricsDb, { limit });
    metricsDb.close();

    res.json(flags);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/session/benchmarks - Agency-wide benchmarks
router.get('/session/benchmarks', (req, res) => {
  try {
    const metricsDb = initMetricsDb();
    initBaselinesTable(metricsDb);
    const benchmarks = getBenchmarks(metricsDb);
    metricsDb.close();

    res.json(benchmarks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/session/digest/weekly - Weekly digest
router.get('/session/digest/weekly', (req, res) => {
  try {
    const weekStart = req.query.week || null;
    const metricsDb = initMetricsDb();
    initBaselinesTable(metricsDb);
    const digest = getWeeklyDigest(metricsDb, weekStart);
    metricsDb.close();

    res.json(digest);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ PPC TASK ACCOUNTABILITY (Phase 21A) ============

// GET /api/ppc/status - Agency-wide PPC tracking stats
router.get('/ppc/status', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const database = getDatabase();
    initPPCTrackingTable(database);
    const report = getPPCReport(database, { days });

    res.json({
      period_days: report.period_days,
      total_ppc_tasks: report.total_ppc_tasks,
      in_proofhub: report.in_proofhub,
      missing: report.missing,
      completion_rate: report.completion_rate,
      avg_score: report.avg_score,
      avg_days_to_proofhub: report.avg_days_to_proofhub,
      clients: Object.entries(report.by_client).map(([id, data]) => ({
        client_id: id,
        client_name: data.client_name,
        total: data.total,
        tracked: data.tracked,
        missing: data.missing,
        completion_rate: data.completion_rate
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ppc/client/:clientId - Per-client PPC task list + completion rates
router.get('/ppc/client/:clientId', (req, res) => {
  try {
    const clientId = req.params.clientId;
    const days = parseInt(req.query.days) || 30;
    const database = getDatabase();
    initPPCTrackingTable(database);
    const report = getPPCReport(database, { clientId, days });

    const clientData = report.by_client[clientId];
    if (!clientData) {
      return res.json({
        client_id: clientId,
        total: 0,
        tracked: 0,
        missing: 0,
        completion_rate: 0,
        tasks: []
      });
    }

    res.json({
      client_id: clientId,
      client_name: clientData.client_name,
      period_days: days,
      total: clientData.total,
      tracked: clientData.tracked,
      missing: clientData.missing,
      completion_rate: clientData.completion_rate,
      avg_score: clientData.avg_score,
      tasks: clientData.tasks
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ppc/meeting/:meetingId - PPC tasks from a specific meeting
router.get('/ppc/meeting/:meetingId', (req, res) => {
  try {
    const meetingId = parseInt(req.params.meetingId);
    const database = getDatabase();
    initPPCTrackingTable(database);

    const tasks = database.prepare(`
      SELECT * FROM ppc_task_tracking WHERE meeting_id = ?
      ORDER BY action_item_index
    `).all(meetingId);

    const tracked = tasks.filter(t => t.proofhub_match === 1).length;

    res.json({
      meeting_id: meetingId,
      total: tasks.length,
      tracked,
      missing: tasks.length - tracked,
      tasks
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ppc/at-risk - Tasks missing from ProofHub (needs attention)
router.get('/ppc/at-risk', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const database = getDatabase();
    initPPCTrackingTable(database);
    const report = getPPCReport(database, { days });

    // Enrich tasks with ai_extraction data
    const enrichedTasks = report.at_risk.map(t => {
      const task = {
        id: t.id,
        task_title: t.task_title,
        task_description: t.task_description,
        client_id: t.client_id,
        client_name: t.client_name,
        meeting_id: t.meeting_id,
        meeting_date: t.meeting_date,
        owner: t.owner,
        platform: t.platform,
        action_type: t.action_type,
        ppc_confidence: t.ppc_confidence,
        days_ago: Math.floor((Date.now() - new Date(t.meeting_date).getTime()) / (1000 * 60 * 60 * 24)),
        disposition: t.disposition,
        last_checked: t.last_checked || null,
        transcript_excerpt: null,
        priority: null,
        due_date: null
      };

      // Get ai_extraction from meeting
      const meeting = database.prepare('SELECT ai_extraction FROM meetings WHERE id = ?').get(t.meeting_id);
      if (meeting && meeting.ai_extraction) {
        try {
          const extraction = JSON.parse(meeting.ai_extraction);
          const items = extraction.action_items || (extraction[0]?.action_items) || [];
          const item = items[t.action_item_index];
          if (item) {
            task.transcript_excerpt = item.transcript_excerpt || null;
            task.priority = item.priority || null;
            task.due_date = item.due_date || null;
          }
        } catch (e) { /* ignore parse errors */ }
      }

      return task;
    });

    res.json({
      period_days: days,
      total_at_risk: enrichedTasks.length,
      tasks: enrichedTasks
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ppc/tracked - Tasks matched in ProofHub with links
router.get('/ppc/tracked', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const database = getDatabase();
    initPPCTrackingTable(database);

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const tasks = database.prepare(`
      SELECT p.id, p.task_title, p.task_description, p.client_id, p.client_name,
             p.meeting_id, p.meeting_date, p.owner, p.platform, p.action_type,
             p.action_item_index, p.ppc_confidence,
             p.proofhub_task_id, p.proofhub_task_title, p.proofhub_status,
             p.proofhub_created, p.proofhub_assignee, p.proofhub_confidence,
             p.proofhub_reasoning, p.completion_score, p.days_to_proofhub,
             p.last_checked,
             c.project_id AS ph_project_id, c.task_list_id AS ph_task_list_id,
             c.stage_name AS ph_stage_name
      FROM ppc_task_tracking p
      LEFT JOIN ph_task_cache c ON CAST(p.proofhub_task_id AS INTEGER) = c.ph_task_id
      WHERE p.proofhub_match = 1 AND p.meeting_date >= ?
      ORDER BY p.meeting_date DESC
    `).all(cutoffDate.toISOString());

    // Enrich with ai_extraction data
    const enrichedTasks = tasks.map(t => {
      const task = {
        ...t,
        ph_url: t.ph_project_id && t.ph_task_list_id
          ? `https://breakthrough3x.proofhub.com/bapplite/#app/todos/project-${t.ph_project_id}/list-${t.ph_task_list_id}/task-${t.proofhub_task_id}`
          : null,
        days_ago: Math.floor((Date.now() - new Date(t.meeting_date).getTime()) / (1000 * 60 * 60 * 24)),
        transcript_excerpt: null,
        priority: null,
        due_date: null
      };

      // Get ai_extraction from meeting
      const meeting = database.prepare('SELECT ai_extraction FROM meetings WHERE id = ?').get(t.meeting_id);
      if (meeting && meeting.ai_extraction) {
        try {
          const extraction = JSON.parse(meeting.ai_extraction);
          const items = extraction.action_items || (extraction[0]?.action_items) || [];
          const item = items[t.action_item_index];
          if (item) {
            task.transcript_excerpt = item.transcript_excerpt || null;
            task.priority = item.priority || null;
            task.due_date = item.due_date || null;
          }
        } catch (e) { /* ignore parse errors */ }
      }

      return task;
    });

    res.json({
      period_days: days,
      total_tracked: enrichedTasks.length,
      tasks: enrichedTasks
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// GET /api/ppc/task/:id/detail - Full task detail with transcript and PH enrichment
router.get('/ppc/task/:id/detail', (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    const database = getDatabase();
    initPPCTrackingTable(database);

    // Get task with PH cache enrichment
    const task = database.prepare(`
      SELECT p.*,
             c.project_id AS ph_project_id, c.task_list_id AS ph_task_list_id,
             c.stage_name AS ph_stage_name, c.task_list_name AS ph_task_list_name,
             c.comments_count AS ph_comments_count, c.assigned_names AS ph_assigned_names,
             c.due_date AS ph_due_date, c.scope_summary AS ph_scope_summary
      FROM ppc_task_tracking p
      LEFT JOIN ph_task_cache c ON CAST(p.proofhub_task_id AS INTEGER) = c.ph_task_id
      WHERE p.id = ?
    `).get(taskId);

    if (!task) {
      return res.status(404).json({ error: 'PPC task not found' });
    }

    // Get meeting's ai_extraction to find the specific action item
    const meeting = database.prepare('SELECT ai_extraction FROM meetings WHERE id = ?').get(task.meeting_id);
    let transcript_excerpt = null;
    let due_date = null;
    let priority = null;
    let category = null;

    if (meeting && meeting.ai_extraction) {
      try {
        const extraction = JSON.parse(meeting.ai_extraction);
        const items = extraction.action_items || (extraction[0]?.action_items) || [];
        const item = items[task.action_item_index];
        if (item) {
          transcript_excerpt = item.transcript_excerpt || null;
          due_date = item.due_date || null;
          priority = item.priority || null;
          category = item.category || null;
        }
      } catch (e) {
        console.error('[PPC Detail] Error parsing ai_extraction:', e.message);
      }
    }

    // Build ProofHub URL
    const ph_url = task.ph_project_id && task.ph_task_list_id
      ? `https://breakthrough3x.proofhub.com/bapplite/#app/todos/project-${task.ph_project_id}/list-${task.ph_task_list_id}/task-${task.proofhub_task_id}`
      : null;

    res.json({
      // Core task
      id: task.id,
      task_title: task.task_title,
      task_description: task.task_description,
      platform: task.platform,
      action_type: task.action_type,
      owner: task.owner,
      meeting_id: task.meeting_id,
      meeting_date: task.meeting_date,
      client_id: task.client_id,
      client_name: task.client_name,
      ppc_confidence: task.ppc_confidence,
      disposition: task.disposition,
      disposition_reason: task.disposition_reason,
      action_item_index: task.action_item_index,

      // From ai_extraction
      due_date,
      priority,
      category,
      transcript_excerpt,

      // ProofHub match
      proofhub_match: task.proofhub_match === 1,
      proofhub_task_id: task.proofhub_task_id,
      proofhub_task_title: task.proofhub_task_title,
      proofhub_status: task.proofhub_status,
      proofhub_created: task.proofhub_created,
      proofhub_assignee: task.proofhub_assignee,
      proofhub_confidence: task.proofhub_confidence,
      proofhub_reasoning: task.proofhub_reasoning,
      completion_score: task.completion_score,
      days_to_proofhub: task.days_to_proofhub,

      // PH cache enrichment
      ph_url,
      ph_stage_name: task.ph_stage_name,
      ph_task_list_name: task.ph_task_list_name,
      ph_comments_count: task.ph_comments_count,
      ph_assigned_names: (() => {
        // Resolve PH user IDs to names
        const idToName = {
          "12896349500": "Philip Mutrie",
          "13652696772": "Bill Soady",
          "12930841172": "Richard Bonn",
          "12953229550": "Joaco Malig",
          "13766931777": "Jacob Hastings",
          "14513930205": "Vince Lei",
          "12953338100": "Sarah Young",
          "12953283825": "Manuel Porras",
          "12953297394": "Ray Z",
          "13766918208": "Nicole",
          "12896335931": "Joe Boland"
        };
        try {
          const ids = JSON.parse(task.ph_assigned_names || "[]");
          return ids.map(id => idToName[String(id)] || String(id));
        } catch(e) {
          return task.ph_assigned_names;
        }
      })(),
      ph_due_date: task.ph_due_date,
      ph_scope_summary: task.ph_scope_summary
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ppc/refresh - Refresh all incomplete PPC task statuses from ProofHub
router.post('/ppc/refresh', async (req, res) => {
  try {
    const database = getDatabase();
    const result = await refreshPPCStatuses(database);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ppc/refresh/:taskId - Refresh single task status
router.post('/ppc/refresh/:taskId', async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);
    const database = getDatabase();
    const result = await refreshSingleTask(database, taskId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ppc/task/:id/disposition - Mark task as cancelled/deprioritized
router.post('/ppc/task/:id/disposition', (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    const { disposition, reason } = req.body;

    if (!disposition) {
      return res.status(400).json({ error: 'disposition required' });
    }

    const database = getDatabase();
    initPPCTrackingTable(database);
    updateDisposition(database, taskId, disposition, reason || null);

    res.json({ success: true, task_id: taskId, disposition });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
