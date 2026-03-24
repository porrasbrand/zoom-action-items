/**
 * API Routes for the Zoom Dashboard.
 */

import { Router } from 'express';
import * as db from './db-queries.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as proofhub from '../lib/proofhub-client.js';
import { resolvePerson, getAllPeople } from '../lib/people-resolver.js';

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
  try {
    const people = getAllPeople();
    res.json({ people });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

    const { ph_project_id, ph_task_list_id } = req.body;

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

    // Get open action items for this meeting
    const openItems = meeting.action_items.filter(item => item.status === 'open');

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

export default router;
