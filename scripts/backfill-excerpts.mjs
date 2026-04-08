#!/usr/bin/env node
/**
 * Backfill transcript_excerpt for action items that are missing them.
 *
 * Uses Gemini 2.0 Flash to find the relevant transcript excerpt (2-6 lines)
 * for each action item from the meeting's transcript_raw.
 *
 * Usage:
 *   node scripts/backfill-excerpts.mjs            # Run backfill
 *   node scripts/backfill-excerpts.mjs --dry-run   # Preview without writing
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

async function findMeetingsNeedingBackfill() {
  const meetings = db.prepare(`
    SELECT id, topic, ai_extraction, transcript_raw
    FROM meetings
    WHERE ai_extraction IS NOT NULL
      AND transcript_raw IS NOT NULL
      AND status = 'completed'
    ORDER BY start_time DESC
  `).all();

  const needsBackfill = [];

  for (const meeting of meetings) {
    let extraction;
    try {
      extraction = JSON.parse(meeting.ai_extraction);
    } catch {
      continue;
    }

    const actionItems = extraction.action_items ||
      (Array.isArray(extraction) ? extraction[0]?.action_items : null) || [];

    if (actionItems.length === 0) continue;

    const missingExcerpts = actionItems.filter(item => !item.transcript_excerpt);
    if (missingExcerpts.length > 0) {
      needsBackfill.push({
        id: meeting.id,
        topic: meeting.topic,
        transcript_raw: meeting.transcript_raw,
        extraction,
        actionItems,
        missingCount: missingExcerpts.length,
        totalCount: actionItems.length
      });
    }
  }

  return needsBackfill;
}

async function backfillMeeting(meeting) {
  const itemsList = meeting.actionItems.map((item, i) =>
    `${i}. "${item.title || item.task}" — ${item.description || 'No description'}`
  ).join('\n');

  const prompt = `Given this meeting transcript and these action items, find the relevant transcript excerpt (2-6 lines with speaker names) for each action item. The excerpt should show where this task was discussed, assigned, or decided.

TRANSCRIPT:
${meeting.transcript_raw}

ACTION ITEMS:
${itemsList}

For each action item, respond with JSON array:
[{"index": 0, "transcript_excerpt": "Speaker: text\\nSpeaker2: response"}, ...]
Use null for transcript_excerpt if the item cannot be found in the transcript.`;

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json'
    }
  });

  const text = result.response.text();
  let excerpts;
  try {
    excerpts = JSON.parse(text);
  } catch {
    // Try extracting JSON from markdown code blocks
    const match = text.match(/\[[\s\S]*\]/);
    if (match) excerpts = JSON.parse(match[0]);
    else throw new Error('Failed to parse Gemini response');
  }

  return excerpts;
}

async function main() {
  console.log(`[Backfill Excerpts] ${DRY_RUN ? 'DRY RUN — ' : ''}Starting...`);

  const meetings = await findMeetingsNeedingBackfill();
  console.log(`[Backfill Excerpts] Found ${meetings.length} meetings needing backfill\n`);

  if (meetings.length === 0) {
    console.log('Nothing to backfill!');
    process.exit(0);
  }

  let totalUpdated = 0;
  let totalErrors = 0;

  for (const meeting of meetings) {
    console.log(`Meeting ${meeting.id}: "${meeting.topic}" — ${meeting.missingCount}/${meeting.totalCount} items missing excerpts`);

    if (DRY_RUN) {
      totalUpdated += meeting.missingCount;
      continue;
    }

    try {
      const excerpts = await backfillMeeting(meeting);

      let updated = 0;
      for (const excerpt of excerpts) {
        if (excerpt.transcript_excerpt && excerpt.index >= 0 && excerpt.index < meeting.actionItems.length) {
          // Only add transcript_excerpt if it's missing
          if (!meeting.actionItems[excerpt.index].transcript_excerpt) {
            meeting.actionItems[excerpt.index].transcript_excerpt = excerpt.transcript_excerpt;
            updated++;
          }
        }
      }

      if (updated > 0) {
        // Write back to extraction — preserve structure exactly
        if (meeting.extraction.action_items) {
          meeting.extraction.action_items = meeting.actionItems;
        } else if (Array.isArray(meeting.extraction) && meeting.extraction[0]?.action_items) {
          meeting.extraction[0].action_items = meeting.actionItems;
        }

        db.prepare('UPDATE meetings SET ai_extraction = ? WHERE id = ?')
          .run(JSON.stringify(meeting.extraction), meeting.id);

        console.log(`  ✅ Updated ${updated} items`);
        totalUpdated += updated;
      } else {
        console.log(`  — No excerpts found`);
      }

      // Rate limit: 2 second delay between meetings
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.error(`  ❌ Error: ${err.message}`);
      totalErrors++;
    }
  }

  console.log(`\n[Backfill Excerpts] Done!`);
  console.log(`  Meetings processed: ${meetings.length}`);
  console.log(`  Items updated: ${totalUpdated}`);
  if (totalErrors > 0) console.log(`  Errors: ${totalErrors}`);
  if (DRY_RUN) console.log(`  (DRY RUN — no changes written)`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
