/**
 * API Routes for the Zoom Dashboard.
 */

import { Router } from 'express';
import * as db from './db-queries.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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
    res.json({ success: true });
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

export default router;
