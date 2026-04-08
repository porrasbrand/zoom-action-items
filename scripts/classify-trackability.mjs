#!/usr/bin/env node
/**
 * Classify all action items as trackable vs not_applicable using Gemini 2.0 Flash.
 * Inserts non-PPC items into ppc_task_tracking if missing, then updates trackability.
 *
 * Usage:
 *   node scripts/classify-trackability.mjs             # Run classification
 *   node scripts/classify-trackability.mjs --dry-run    # Preview without writing
 *   node scripts/classify-trackability.mjs --id 42      # Classify single task
 */

import Database from 'better-sqlite3';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
dotenv.config({ path: join(ROOT, '.env') });

const db = new Database(join(ROOT, 'data', 'zoom-action-items.db'));
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

const DRY_RUN = process.argv.includes('--dry-run');
const idArgIdx = process.argv.indexOf('--id');
const SINGLE_ID = idArgIdx !== -1 ? parseInt(process.argv[idArgIdx + 1]) : null;

// Run schema migration
try { db.exec('ALTER TABLE ppc_task_tracking ADD COLUMN category TEXT DEFAULT NULL'); } catch {}
try { db.exec('ALTER TABLE ppc_task_tracking ADD COLUMN trackable BOOLEAN DEFAULT NULL'); } catch {}
try { db.exec('ALTER TABLE ppc_task_tracking ADD COLUMN trackable_reason TEXT DEFAULT NULL'); } catch {}
try { db.exec('ALTER TABLE ppc_task_tracking ADD COLUMN embedding_score REAL DEFAULT NULL'); } catch {}
try { db.exec('ALTER TABLE ppc_task_tracking ADD COLUMN match_method TEXT DEFAULT NULL'); } catch {}

async function ensureAllItemsInTracker() {
  // Insert ALL action items into ppc_task_tracking if not already there
  const meetings = db.prepare(`
    SELECT id, ai_extraction, client_id, client_name, start_time
    FROM meetings
    WHERE ai_extraction IS NOT NULL AND status = 'completed'
  `).all();

  let inserted = 0;
  for (const meeting of meetings) {
    let extraction;
    try { extraction = JSON.parse(meeting.ai_extraction); } catch { continue; }

    const actionItems = extraction.action_items ||
      (Array.isArray(extraction) ? extraction[0]?.action_items : null) || [];

    for (let i = 0; i < actionItems.length; i++) {
      const item = actionItems[i];
      const existing = db.prepare(
        'SELECT id FROM ppc_task_tracking WHERE meeting_id = ? AND action_item_index = ?'
      ).get(meeting.id, i);

      if (!existing) {
        db.prepare(`
          INSERT OR IGNORE INTO ppc_task_tracking (
            meeting_id, action_item_index, task_title, task_description, client_id, client_name,
            platform, action_type, owner, meeting_date, ppc_confidence, category,
            proofhub_match, computed_at
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, NULL, datetime('now'))
        `).run(
          meeting.id, i,
          item.title || item.task || 'Untitled',
          item.description || null,
          meeting.client_id, meeting.client_name,
          item.owner || item.owner_name || null,
          meeting.start_time,
          item.category || null
        );
        inserted++;
      } else if (!existing.category) {
        // Update category for existing rows that don't have it
        db.prepare('UPDATE ppc_task_tracking SET category = ? WHERE meeting_id = ? AND action_item_index = ?')
          .run(item.category || null, meeting.id, i);
      }
    }
  }
  return inserted;
}

async function classifyBatch(items) {
  const itemsList = items.map((item, i) =>
    `${i + 1}. "${item.task_title}" — ${item.task_description || 'No description'} — Category: ${item.category || 'unknown'}`
  ).join('\n');

  const prompt = `Classify each action item as either "trackable" or "not_applicable":

- trackable: Should have a corresponding task in project management. Concrete deliverables, client work, campaigns, technical tasks, content creation, design work, development tasks.
- not_applicable: Meta-tasks, verbal agreements, internal discussions, one-time events, decisions already made, things that don't need a project management task.

Examples of not_applicable:
- "Evaluate 90-day execution plan" (decision, not a deliverable)
- "Register for Profit Scaling Intensive event" (personal action, not client work)
- "Discuss budget with Dan" (verbal discussion, not a task)
- "Follow up verbally with client" (informal, no deliverable)
- "Client will send us their login credentials" (client's action, not ours)

Examples of trackable:
- "Create webinar banner and social posts" (deliverable)
- "Update Google Ads keywords for AC" (campaign work)
- "Rewrite profile descriptions" (content task)
- "Set up Facebook Ads for March 20th" (campaign launch)
- "Build landing page for spring promotion" (dev/design task)

ACTION ITEMS:
${itemsList}

Respond with JSON array:
[{"index": 1, "trackable": true, "reason": "brief explanation"}, ...]`;

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json'
    }
  });

  const text = result.response.text();
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Failed to parse Gemini response');
  }
}

async function main() {
  console.log(`[Classify Trackability] ${DRY_RUN ? 'DRY RUN — ' : ''}Starting...`);

  // Ensure all items are in the tracker table
  const inserted = await ensureAllItemsInTracker();
  console.log(`[Classify] Inserted ${inserted} new items into tracker`);

  // Get items to classify
  let items;
  if (SINGLE_ID) {
    items = db.prepare('SELECT * FROM ppc_task_tracking WHERE id = ?').all(SINGLE_ID);
  } else {
    items = db.prepare('SELECT * FROM ppc_task_tracking WHERE trackable IS NULL').all();
  }

  console.log(`[Classify] ${items.length} items need classification\n`);

  if (items.length === 0) {
    console.log('Nothing to classify!');
    // Print stats
    const stats = db.prepare('SELECT trackable, COUNT(*) as c FROM ppc_task_tracking GROUP BY trackable').all();
    console.log('Current stats:', stats);
    process.exit(0);
  }

  let totalTrackable = 0, totalNA = 0, errors = 0;

  // Process in batches of 50
  for (let i = 0; i < items.length; i += 50) {
    const batch = items.slice(i, i + 50);
    console.log(`Batch ${Math.floor(i / 50) + 1}/${Math.ceil(items.length / 50)} (${batch.length} items)...`);

    try {
      const classifications = await classifyBatch(batch);

      for (const cls of classifications) {
        const idx = cls.index - 1;
        if (idx < 0 || idx >= batch.length) continue;

        const item = batch[idx];
        const isTrackable = cls.trackable === true;

        if (isTrackable) totalTrackable++;
        else totalNA++;

        if (!DRY_RUN) {
          db.prepare('UPDATE ppc_task_tracking SET trackable = ?, trackable_reason = ? WHERE id = ?')
            .run(isTrackable ? 1 : 0, cls.reason || null, item.id);
        }
      }
    } catch (err) {
      console.error(`  Error on batch: ${err.message}`);
      errors++;
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 2000));
  }

  // Update category for existing PPC items that don't have it yet
  if (!DRY_RUN) {
    db.prepare("UPDATE ppc_task_tracking SET category = 'ads' WHERE category IS NULL AND platform IS NOT NULL").run();
  }

  const total = db.prepare('SELECT COUNT(*) as c FROM ppc_task_tracking').get();

  console.log(`\n[Classify Trackability] Done!`);
  console.log(`  Total items in tracker: ${total.c}`);
  console.log(`  Classified this run: ${totalTrackable + totalNA}`);
  console.log(`  Trackable: ${totalTrackable}`);
  console.log(`  Not applicable: ${totalNA}`);
  if (errors) console.log(`  Errors: ${errors}`);
  if (DRY_RUN) console.log(`  (DRY RUN — no changes written)`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
