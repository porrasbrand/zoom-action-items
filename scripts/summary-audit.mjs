#!/usr/bin/env node
/**
 * Transcript Summary Audit
 * Analyzes all meetings to determine:
 * 1. Is Dan present in the transcript?
 * 2. Is there an end-of-call summary/recap section?
 * 3. Who delivers the summary?
 * 4. Compare Dan-present vs Dan-absent meetings
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

const AUDIT_PROMPT = `You are analyzing a Zoom meeting transcript to determine if there is a structured summary or action item recap section, typically delivered near the end of the call.

TRANSCRIPT (last 30% of meeting):
{transcript}

Analyze and return JSON:
{
  "has_summary": true/false,
  "summary_speaker": "name of person who delivers the summary, or null",
  "summary_starts_at": "timestamp where summary begins, or null",
  "summary_position_percent": 85-100 (how far through the meeting),
  "summary_style": "numbered_list / verbal_recap / no_summary",
  "action_items_in_summary": ["item 1", "item 2", ...],
  "action_items_count_in_summary": 0,
  "other_speakers_respond": ["Phil: confirmed", "Richard: acknowledged"],
  "confidence": 0.0-1.0,
  "notes": "any observations about the summary pattern"
}

Look for phrases like: "action steps", "recap", "summary", "number one", "here's what we need", "implementation items", "tasks from this session". The summary is typically a structured listing of who needs to do what, delivered by the meeting leader.`;

async function analyzeMeeting(meeting) {
  const transcript = meeting.transcript_raw;
  if (!transcript || transcript.length < 500) return null;

  // Get last 30% of transcript
  const lines = transcript.split('\n');
  const startLine = Math.floor(lines.length * 0.7);
  const lastSection = lines.slice(startLine).join('\n');

  // Check which speakers are present
  const speakerCounts = {};
  for (const line of lines) {
    const match = line.match(/\]\s*([^:]+):/);
    if (match) {
      const speaker = match[1].trim();
      speakerCounts[speaker] = (speakerCounts[speaker] || 0) + 1;
    }
  }

  const hasDan = Object.keys(speakerCounts).some(s =>
    s.toLowerCase().includes('dan') && s.toLowerCase().includes('kuschell')
  );

  const prompt = AUDIT_PROMPT.replace('{transcript}', lastSection.slice(0, 50000));

  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash', // Use 2.0 for speed on bulk analysis
      generationConfig: { responseMimeType: 'application/json' }
    });

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    let parsed = JSON.parse(text);
    if (Array.isArray(parsed)) parsed = parsed[0];

    return {
      meetingId: meeting.id,
      topic: meeting.topic,
      client: meeting.client_name || 'Unmatched',
      duration: meeting.duration_minutes,
      danPresent: hasDan,
      speakers: speakerCounts,
      totalLines: lines.length,
      ...parsed
    };
  } catch (e) {
    return {
      meetingId: meeting.id,
      topic: meeting.topic,
      client: meeting.client_name || 'Unmatched',
      duration: meeting.duration_minutes,
      danPresent: hasDan,
      speakers: speakerCounts,
      totalLines: lines.length,
      has_summary: null,
      error: e.message
    };
  }
}

async function main() {
  const meetings = db.prepare(`
    SELECT id, topic, client_name, duration_minutes, transcript_raw,
           length(transcript_raw) as t_len
    FROM meetings
    WHERE length(transcript_raw) > 500
    ORDER BY start_time ASC
  `).all();

  console.log(`\n${'='.repeat(90)}`);
  console.log(`TRANSCRIPT SUMMARY AUDIT — ${meetings.length} meetings with transcripts`);
  console.log(`${'='.repeat(90)}\n`);

  const results = [];

  for (const m of meetings) {
    process.stdout.write(`Analyzing: ${m.topic.substring(0, 50).padEnd(50)} `);
    const result = await analyzeMeeting(m);
    if (result) {
      results.push(result);
      const icon = result.has_summary ? '✅' : '❌';
      const dan = result.danPresent ? '👤 Dan' : '      ';
      console.log(`${icon} ${dan} | ${result.summary_style || 'n/a'} | ${result.action_items_count_in_summary || 0} items`);
    } else {
      console.log('⬜ skipped (short transcript)');
    }
    await new Promise(r => setTimeout(r, 1500)); // Rate limit
  }

  // === ANALYSIS ===
  const withSummary = results.filter(r => r.has_summary);
  const withoutSummary = results.filter(r => r.has_summary === false);

  const danPresent = results.filter(r => r.danPresent);
  const danAbsent = results.filter(r => !r.danPresent);

  const danWithSummary = danPresent.filter(r => r.has_summary);
  const danWithoutSummary = danPresent.filter(r => !r.has_summary);
  const noDanWithSummary = danAbsent.filter(r => r.has_summary);
  const noDanWithoutSummary = danAbsent.filter(r => !r.has_summary);

  console.log(`\n${'='.repeat(90)}`);
  console.log('RESULTS');
  console.log(`${'='.repeat(90)}\n`);

  console.log(`Total meetings analyzed: ${results.length}`);
  console.log(`With end-of-call summary: ${withSummary.length} (${Math.round(withSummary.length/results.length*100)}%)`);
  console.log(`Without summary: ${withoutSummary.length} (${Math.round(withoutSummary.length/results.length*100)}%)`);

  console.log(`\n--- DAN PRESENT (${danPresent.length} meetings) ---`);
  console.log(`  With summary: ${danWithSummary.length}/${danPresent.length} (${danPresent.length ? Math.round(danWithSummary.length/danPresent.length*100) : 0}%)`);
  console.log(`  Without summary: ${danWithoutSummary.length}/${danPresent.length}`);
  if (danWithSummary.length > 0) {
    console.log(`  Summary delivered by:`);
    const summaryBy = {};
    danWithSummary.forEach(r => { summaryBy[r.summary_speaker || 'unknown'] = (summaryBy[r.summary_speaker || 'unknown'] || 0) + 1; });
    Object.entries(summaryBy).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => console.log(`    ${k}: ${v} times`));
    console.log(`  Avg action items in summary: ${(danWithSummary.reduce((s,r) => s + (r.action_items_count_in_summary||0), 0) / danWithSummary.length).toFixed(1)}`);
  }

  console.log(`\n--- DAN ABSENT (${danAbsent.length} meetings) ---`);
  console.log(`  With summary: ${noDanWithSummary.length}/${danAbsent.length} (${danAbsent.length ? Math.round(noDanWithSummary.length/danAbsent.length*100) : 0}%)`);
  console.log(`  Without summary: ${noDanWithoutSummary.length}/${danAbsent.length}`);
  if (noDanWithSummary.length > 0) {
    console.log(`  Summary delivered by:`);
    const summaryBy = {};
    noDanWithSummary.forEach(r => { summaryBy[r.summary_speaker || 'unknown'] = (summaryBy[r.summary_speaker || 'unknown'] || 0) + 1; });
    Object.entries(summaryBy).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => console.log(`    ${k}: ${v} times`));
  }

  console.log(`\n--- DETAILED BREAKDOWN ---\n`);
  console.log('DAN PRESENT:');
  console.log(`${'Meeting'.padEnd(45)} ${'Duration'.padEnd(8)} ${'Summary?'.padEnd(10)} ${'Style'.padEnd(15)} ${'Items'.padEnd(6)} Summary Speaker`);
  console.log('-'.repeat(110));
  danPresent.forEach(r => {
    const sum = r.has_summary ? '✅ Yes' : '❌ No';
    console.log(`${(r.topic||'?').substring(0,44).padEnd(45)} ${(r.duration+'min').padEnd(8)} ${sum.padEnd(10)} ${(r.summary_style||'n/a').padEnd(15)} ${String(r.action_items_count_in_summary||0).padEnd(6)} ${r.summary_speaker||'—'}`);
  });

  console.log('\nDAN ABSENT:');
  console.log(`${'Meeting'.padEnd(45)} ${'Duration'.padEnd(8)} ${'Summary?'.padEnd(10)} ${'Style'.padEnd(15)} ${'Items'.padEnd(6)} Summary Speaker`);
  console.log('-'.repeat(110));
  danAbsent.forEach(r => {
    const sum = r.has_summary ? '✅ Yes' : '❌ No';
    console.log(`${(r.topic||'?').substring(0,44).padEnd(45)} ${(r.duration+'min').padEnd(8)} ${sum.padEnd(10)} ${(r.summary_style||'n/a').padEnd(15)} ${String(r.action_items_count_in_summary||0).padEnd(6)} ${r.summary_speaker||'—'}`);
  });

  // Save results to file
  const outputPath = join(ROOT, 'data', 'summary-audit-results.json');
  const fs = await import('fs');
  fs.writeFileSync(outputPath, JSON.stringify({ results, analysis: { danPresent: danPresent.length, danAbsent: danAbsent.length, danWithSummary: danWithSummary.length, noDanWithSummary: noDanWithSummary.length } }, null, 2));
  console.log(`\nResults saved to ${outputPath}`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
