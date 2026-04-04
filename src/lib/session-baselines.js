/**
 * Session Baselines
 * Computes P25/P50/P75 percentile baselines for scoring thresholds.
 */

import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', '..', 'data', 'zoom-action-items.db');

// All evaluation dimensions
const DIMENSIONS = [
  'composite_score', 'tier1_avg', 'tier2_avg', 'tier3_avg',
  'client_sentiment', 'accountability', 'relationship_health',
  'meeting_structure', 'value_delivery', 'action_discipline', 'proactive_leadership',
  'time_utilization', 'redundancy', 'client_confusion', 'meeting_momentum', 'save_rate'
];

// Minimum meetings required to compute baselines
const MIN_SAMPLE_SIZE = 3;

/**
 * Initialize database and create session_baselines table
 */
export function initBaselinesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_baselines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      dimension TEXT NOT NULL,
      p25 REAL,
      p50 REAL,
      p75 REAL,
      mean REAL,
      sample_size INTEGER,
      computed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(scope, dimension)
    );
  `);
}

/**
 * Calculate percentiles for an array of values
 */
function calculatePercentiles(values) {
  if (values.length === 0) return { p25: null, p50: null, p75: null, mean: null };

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;

  const percentile = (p) => {
    const idx = (p / 100) * (n - 1);
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (idx - lower) * (sorted[upper] - sorted[lower]);
  };

  const mean = values.reduce((a, b) => a + b, 0) / n;

  return {
    p25: percentile(25),
    p50: percentile(50),
    p75: percentile(75),
    mean
  };
}

/**
 * Compute baselines for a specific scope
 * @param {Database} db - Database connection
 * @param {string} scope - 'agency', 'client:id', or 'member:name'
 * @returns {Object} - Baselines by dimension
 */
export function computeBaselines(db, scope) {
  initBaselinesTable(db);

  let whereClause = '';
  let params = [];

  if (scope === 'agency') {
    // Agency-wide: all meetings
    whereClause = '1=1';
  } else if (scope.startsWith('client:')) {
    const clientId = scope.split(':')[1];
    whereClause = 'm.client_id = ?';
    params = [clientId];
  } else if (scope.startsWith('member:')) {
    const memberName = scope.split(':')[1];
    // Match by attendee name in ai_extraction
    whereClause = `m.ai_extraction LIKE ?`;
    params = [`%${memberName}%`];
  }

  // Get evaluations for this scope
  const query = `
    SELECT se.*
    FROM session_evaluations se
    JOIN meetings m ON m.id = se.meeting_id
    WHERE ${whereClause}
    ORDER BY se.computed_at DESC
  `;

  const evaluations = db.prepare(query).all(...params);

  if (evaluations.length < MIN_SAMPLE_SIZE) {
    return { scope, sample_size: evaluations.length, insufficient: true };
  }

  const baselines = { scope, sample_size: evaluations.length, dimensions: {} };

  // Compute percentiles for each dimension
  for (const dim of DIMENSIONS) {
    const values = evaluations.map(e => e[dim]).filter(v => v != null);
    if (values.length >= MIN_SAMPLE_SIZE) {
      const stats = calculatePercentiles(values);
      baselines.dimensions[dim] = stats;

      // Upsert to database
      db.prepare(`
        INSERT INTO session_baselines (scope, dimension, p25, p50, p75, mean, sample_size, computed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(scope, dimension) DO UPDATE SET
          p25 = excluded.p25,
          p50 = excluded.p50,
          p75 = excluded.p75,
          mean = excluded.mean,
          sample_size = excluded.sample_size,
          computed_at = datetime('now')
      `).run(scope, dim, stats.p25, stats.p50, stats.p75, stats.mean, values.length);
    }
  }

  return baselines;
}

/**
 * Compute agency-wide baselines
 */
export function computeAgencyBaselines(db) {
  return computeBaselines(db, 'agency');
}

/**
 * Compute baselines for a specific client
 */
export function computeClientBaselines(db, clientId) {
  return computeBaselines(db, `client:${clientId}`);
}

/**
 * Compute baselines for a specific B3X team member
 */
export function computeTeamMemberBaselines(db, memberName) {
  return computeBaselines(db, `member:${memberName}`);
}

/**
 * Get threshold signal (green/yellow/red) for a score
 * @param {number} score - The score to evaluate
 * @param {Object} baselines - Baselines object with p25, p50, p75
 * @returns {string} - 'green', 'yellow', or 'red'
 */
export function getThreshold(score, baselines) {
  if (!baselines || baselines.p25 == null || baselines.p75 == null) {
    return 'unknown';
  }

  if (score >= baselines.p75) return 'green';
  if (score >= baselines.p25) return 'yellow';
  return 'red';
}

/**
 * Get baselines from database for a scope
 */
export function getBaselines(db, scope) {
  initBaselinesTable(db);

  const rows = db.prepare(`
    SELECT dimension, p25, p50, p75, mean, sample_size, computed_at
    FROM session_baselines
    WHERE scope = ?
  `).all(scope);

  if (rows.length === 0) return null;

  const baselines = { scope, dimensions: {} };
  for (const row of rows) {
    baselines.dimensions[row.dimension] = {
      p25: row.p25,
      p50: row.p50,
      p75: row.p75,
      mean: row.mean,
      sample_size: row.sample_size,
      computed_at: row.computed_at
    };
  }

  return baselines;
}

/**
 * Get all baselines from database
 */
export function getAllBaselines(db) {
  initBaselinesTable(db);

  const rows = db.prepare(`
    SELECT scope, dimension, p25, p50, p75, mean, sample_size, computed_at
    FROM session_baselines
    ORDER BY scope, dimension
  `).all();

  const grouped = {};
  for (const row of rows) {
    if (!grouped[row.scope]) {
      grouped[row.scope] = { scope: row.scope, dimensions: {} };
    }
    grouped[row.scope].dimensions[row.dimension] = {
      p25: row.p25,
      p50: row.p50,
      p75: row.p75,
      mean: row.mean,
      sample_size: row.sample_size,
      computed_at: row.computed_at
    };
  }

  return grouped;
}

/**
 * Recalculate all baselines (agency + per-client + per-member)
 */
export function recalculateAll(dbOrPath = DB_PATH) {
  const db = typeof dbOrPath === 'string' ? new Database(dbOrPath) : dbOrPath;
  const shouldClose = typeof dbOrPath === 'string';

  try {
    initBaselinesTable(db);

    const results = { agency: null, clients: [], members: [] };

    // Agency-wide
    console.log('  Computing agency-wide baselines...');
    results.agency = computeAgencyBaselines(db);

    // Per-client
    const clients = db.prepare(`
      SELECT DISTINCT client_id FROM meetings WHERE client_id IS NOT NULL AND client_id != 'unmatched'
    `).all();

    for (const { client_id } of clients) {
      console.log(`  Computing baselines for client: ${client_id}...`);
      const clientBaselines = computeClientBaselines(db, client_id);
      if (!clientBaselines.insufficient) {
        results.clients.push(clientBaselines);
      }
    }

    // Per-member (B3X team)
    const b3xMembers = ['Dan', 'Philip', 'Phil', 'Joe', 'Richard'];
    for (const member of b3xMembers) {
      console.log(`  Computing baselines for member: ${member}...`);
      const memberBaselines = computeTeamMemberBaselines(db, member);
      if (!memberBaselines.insufficient) {
        results.members.push(memberBaselines);
      }
    }

    return results;
  } finally {
    if (shouldClose) db.close();
  }
}

export default {
  initBaselinesTable,
  computeBaselines,
  computeAgencyBaselines,
  computeClientBaselines,
  computeTeamMemberBaselines,
  getThreshold,
  getBaselines,
  getAllBaselines,
  recalculateAll
};
