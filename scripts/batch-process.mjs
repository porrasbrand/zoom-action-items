#!/usr/bin/env node
/**
 * Batch processor: Process all unprocessed Zoom meetings with transcripts
 * Runs as standalone script, logs to stdout (PM2 captures logs)
 */
import Database from 'better-sqlite3';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import { getAccessToken } from '../src/lib/zoom-client.js';
import { parseVTT } from '../src/lib/vtt-parser.js';
import { matchClient } from '../src/lib/client-matcher.js';

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const db = new Database(join(__dirname, '..', 'data', 'zoom-action-items.db'));
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

const PROMPT = `You are an expert meeting analyst. Analyze this Zoom meeting transcript and extract structured information.

Return JSON with this exact structure:
{
  "summary": "2-3 sentence summary of the meeting",
  "action_items": [
    {
      "title": "task description",
      "owner": "person name",
      "due_date": "YYYY-MM-DD or null",
      "priority": "high/medium/low",
      "category": "follow-up/deliverable/decision/other",
      "description": "additional context",
      "transcript_excerpt": "The 2-4 lines from the transcript where this action item was discussed. Copy VERBATIM including speaker names."
    }
  ],
  "decisions": [
    { "decision": "what was decided", "context": "why/how" }
  ],
  "follow_ups": ["item 1", "item 2"],
  "next_meeting": "description of next meeting or null"
}

Be thorough — capture ALL action items, even implied ones. Include the specific person responsible.
If a due date is mentioned or implied, include it. If priority is discussed (urgent, ASAP, etc.), reflect it.
transcript_excerpt MUST be the exact verbatim lines from the transcript where this task was discussed.

TRANSCRIPT:
`;

async function fetchTranscript(token, downloadUrl) {
  const res = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  return await res.text();
}

async function reprocessMeeting(meetingId) {
  const meeting = db.prepare("SELECT * FROM meetings WHERE id = ?").get(meetingId);
  if (!meeting) {
    console.log(`Meeting ${meetingId} not found`);
    return false;
  }

  if (!meeting.transcript_raw || meeting.transcript_raw.length < 100) {
    console.log(`Meeting ${meetingId} has no valid transcript`);
    return false;
  }

  console.log(`Reprocessing: "${meeting.topic}"`);

  const model = genAI.getGenerativeModel({
    model: 'gemini-3-flash-preview',
    generationConfig: { responseMimeType: 'application/json' }
  });

  const result = await model.generateContent(PROMPT + meeting.transcript_raw.slice(0, 100000));
  const text = result.response.text();
  const usage = result.response.usageMetadata;
  const extraction = JSON.parse(text);

  // Update meeting
  db.prepare(`
    UPDATE meetings SET ai_extraction = ?, updated_at = datetime('now') WHERE id = ?
  `).run(JSON.stringify(extraction), meetingId);

  // Delete old action items and decisions
  db.prepare("DELETE FROM action_items WHERE meeting_id = ?").run(meetingId);
  db.prepare("DELETE FROM decisions WHERE meeting_id = ?").run(meetingId);

  // Insert new action items with transcript_excerpt
  const insertItem = db.prepare(`
    INSERT INTO action_items (meeting_id, client_id, title, description, owner_name, due_date, priority, category, transcript_excerpt, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
  `);
  for (const a of (extraction.action_items || [])) {
    insertItem.run(meetingId, meeting.client_id, a.title, a.description || null, a.owner || null, a.due_date || null, a.priority || 'medium', a.category || 'other', a.transcript_excerpt || null);
  }

  // Insert decisions
  const insertDecision = db.prepare(`
    INSERT INTO decisions (meeting_id, client_id, decision, context) VALUES (?, ?, ?, ?)
  `);
  for (const d of (extraction.decisions || [])) {
    insertDecision.run(meetingId, meeting.client_id, d.decision, d.context || null);
  }

  console.log(`  ✅ ${extraction.action_items?.length || 0} items, ${extraction.decisions?.length || 0} decisions | ${usage?.promptTokenCount}/${usage?.candidatesTokenCount} tokens`);
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const reprocessFlag = args.includes('--reprocess');
  const reprocessAll = args.includes('--reprocess-all');
  const meetingIdArg = args.find(a => a.startsWith('--meeting='));
  const meetingId = meetingIdArg ? parseInt(meetingIdArg.split('=')[1]) : null;

  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] === BATCH PROCESSOR START ===`);

  // Handle reprocess modes
  if (reprocessAll) {
    console.log('Reprocessing ALL meetings...');
    const meetings = db.prepare("SELECT id FROM meetings WHERE status = 'completed' ORDER BY id").all();
    let success = 0, errors = 0;
    for (const m of meetings) {
      try {
        await reprocessMeeting(m.id);
        success++;
        await new Promise(r => setTimeout(r, 2000)); // Rate limit
      } catch (err) {
        console.log(`  ❌ Error: ${err.message}`);
        errors++;
      }
    }
    console.log(`\nReprocessed: ${success} | Errors: ${errors}`);
    return;
  }

  if (reprocessFlag && meetingId) {
    await reprocessMeeting(meetingId);
    return;
  }

  if (reprocessFlag) {
    console.log('Usage: --reprocess --meeting=<id> or --reprocess-all');
    return;
  }

  const token = await getAccessToken();
  const processed = new Set(db.prepare("SELECT zoom_meeting_uuid FROM meetings").all().map(r => r.zoom_meeting_uuid));

  // Scan last 7 days
  const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const to = new Date().toISOString().split("T")[0];

  const usersRes = await fetch("https://api.zoom.us/v2/users?page_size=100", {
    headers: { Authorization: "Bearer " + token }
  });
  const users = (await usersRes.json()).users || [];

  // Collect all new meetings with transcripts
  let newMeetings = [];
  for (const user of users) {
    const res = await fetch(`https://api.zoom.us/v2/users/${user.id}/recordings?from=${from}&to=${to}&page_size=100`, {
      headers: { Authorization: "Bearer " + token }
    });
    const data = await res.json();
    for (const m of (data.meetings || [])) {
      if (processed.has(m.uuid)) continue;
      const transcriptFile = (m.recording_files || []).find(f => f.file_type === 'TRANSCRIPT');
      if (!transcriptFile) continue;
      newMeetings.push({ ...m, transcriptFile });
    }
  }

  console.log(`Found ${newMeetings.length} new meetings to process\n`);

  let success = 0, errors = 0, skipped = 0;

  for (const m of newMeetings) {
    const topic = m.topic || 'Unknown';
    console.log(`[${new Date().toISOString()}] Processing: "${topic}"`);

    try {
      // Download transcript
      const vttText = await fetchTranscript(token, m.transcriptFile.download_url + '?access_token=' + token);
      const transcriptText = parseVTT(vttText);

      if (!transcriptText || transcriptText.length < 100) {
        console.log(`  Skipped: transcript too short (${transcriptText?.length || 0} chars)`);
        skipped++;
        continue;
      }

      // Match client
      const client = matchClient(topic);
      const clientId = client?.id || null;
      const clientName = client?.name || 'Unmatched';

      // Insert meeting record
      const meetingId = db.prepare(`
        INSERT INTO meetings (zoom_meeting_uuid, topic, client_id, client_name, start_time, duration_minutes, transcript_raw, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'processing')
      `).run(m.uuid, topic, clientId, clientName, m.start_time, m.duration || null, transcriptText).lastInsertRowid;

      // Run Gemini extraction
      const model = genAI.getGenerativeModel({
        model: 'gemini-3-flash-preview',
        generationConfig: { responseMimeType: 'application/json' }
      });

      const result = await model.generateContent(PROMPT + transcriptText.slice(0, 100000));
      const text = result.response.text();
      const usage = result.response.usageMetadata;
      const extraction = JSON.parse(text);

      // Update meeting
      db.prepare(`
        UPDATE meetings SET ai_extraction = ?, status = 'completed', updated_at = datetime('now') WHERE id = ?
      `).run(JSON.stringify(extraction), meetingId);

      // Insert action items
      const insertItem = db.prepare(`
        INSERT INTO action_items (meeting_id, client_id, title, description, owner_name, due_date, priority, category, transcript_excerpt, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
      `);
      for (const a of (extraction.action_items || [])) {
        insertItem.run(meetingId, clientId, a.title, a.description || null, a.owner || null, a.due_date || null, a.priority || 'medium', a.category || 'other', a.transcript_excerpt || null);
      }

      // Insert decisions
      const insertDecision = db.prepare(`
        INSERT INTO decisions (meeting_id, client_id, decision, context) VALUES (?, ?, ?, ?)
      `);
      for (const d of (extraction.decisions || [])) {
        insertDecision.run(meetingId, clientId, d.decision, d.context || null);
      }

      const items = extraction.action_items?.length || 0;
      const decisions = extraction.decisions?.length || 0;
      console.log(`  ✅ ${clientName} | ${items} items, ${decisions} decisions | ${usage?.promptTokenCount}/${usage?.candidatesTokenCount} tokens`);
      success++;

      // Rate limit: small delay between API calls
      await new Promise(r => setTimeout(r, 2000));

    } catch (err) {
      console.log(`  ❌ Error: ${err.message}`);
      errors++;
    }
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n[${new Date().toISOString()}] === BATCH COMPLETE ===`);
  console.log(`Processed: ${success} | Skipped: ${skipped} | Errors: ${errors} | Time: ${elapsed}s`);

  const stats = db.prepare("SELECT COUNT(*) as m FROM meetings").get();
  const itemStats = db.prepare("SELECT COUNT(*) as i FROM action_items").get();
  console.log(`DB totals: ${stats.m} meetings, ${itemStats.i} action items`);
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
