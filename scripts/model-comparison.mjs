#!/usr/bin/env node
/**
 * Model Comparison: Gemini 2.0 Flash vs 3 Flash Preview
 * Runs identical prompts against both models for Prosper Group data
 *
 * Usage: node scripts/model-comparison.mjs
 * Output: data/model-comparison-report.md + data/model-comparison-raw.json
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

// Models to compare
const MODELS = [
  { id: 'gemini-2.0-flash', label: '2.0 Flash (current)' },
  { id: 'gemini-3-flash-preview', label: '3.0 Flash Preview' }
];

const JUDGE_MODEL = 'gemini-2.0-flash'; // Using 2.0 Flash as judge (most stable)

// Load taxonomy
const taxonomy = JSON.parse(readFileSync(join(PROJECT_ROOT, 'src/config/task-taxonomy.json'), 'utf-8'));

// Database
const db = new Database(join(PROJECT_ROOT, 'data/zoom-action-items.db'));

// Gemini client
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

// Rate limiting
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Call Gemini with a specific model
 */
async function callGemini(modelId, prompt) {
  const model = genAI.getGenerativeModel({ model: modelId });
  const result = await model.generateContent(prompt);
  return {
    text: result.response.text().trim(),
    usage: result.response.usageMetadata
  };
}

/**
 * Parse JSON from response text
 */
function parseJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/**
 * Build taxonomy summary for prompts
 */
function buildTaxonomySummary() {
  const lines = ['Valid categories and task types:'];
  for (const cat of taxonomy.categories) {
    lines.push(`\n${cat.id} - ${cat.name}:`);
    for (const tt of cat.task_types) {
      lines.push(`  - ${tt.id}: ${tt.name}`);
    }
  }
  return lines.join('\n');
}

// ============================================================================
// TEST 1: Classification
// ============================================================================

function buildClassificationPrompt(actionItem, clientName) {
  return `You are classifying a client action item into a canonical task taxonomy.

CLIENT: ${clientName}
ACTION ITEM: "${actionItem.owner_name ? actionItem.owner_name + ' — ' : ''}${actionItem.title}"

${buildTaxonomySummary()}

Determine:
1. category: The most appropriate category id from the taxonomy
2. task_type: The most specific task_type id from that category
3. owner_side: 'b3x' if this is work B3X team does, 'client' if client is responsible
4. owner_name: The specific person assigned (or null)

Return ONLY valid JSON:
{
  "category": "category-id",
  "task_type": "task-type-id",
  "owner_side": "b3x or client",
  "owner_name": "name or null"
}`;
}

async function runClassificationTest(model, actionItems, clientName) {
  console.log(`\n📝 Running classification test with ${model.label}...`);
  const results = [];

  for (let i = 0; i < actionItems.length; i++) {
    const item = actionItems[i];
    const prompt = buildClassificationPrompt(item, clientName);
    const start = Date.now();

    try {
      const response = await callGemini(model.id, prompt);
      const elapsed = Date.now() - start;

      results.push({
        item_id: item.id,
        item_title: item.title,
        item_owner: item.owner_name,
        meeting_id: item.meeting_id,
        model: model.id,
        response: parseJSON(response.text),
        raw_response: response.text,
        latency_ms: elapsed,
        tokens_in: response.usage?.promptTokenCount,
        tokens_out: response.usage?.candidatesTokenCount
      });

      console.log(`  ✓ ${i + 1}/${actionItems.length}: ${item.title.substring(0, 40)}... (${elapsed}ms)`);
    } catch (err) {
      console.error(`  ✗ ${i + 1}/${actionItems.length}: Error - ${err.message}`);
      results.push({
        item_id: item.id,
        item_title: item.title,
        item_owner: item.owner_name,
        meeting_id: item.meeting_id,
        model: model.id,
        response: null,
        error: err.message,
        latency_ms: Date.now() - start
      });
    }

    await sleep(2000);
  }

  return results;
}

// ============================================================================
// TEST 2: Roadmap Processing
// ============================================================================

function buildRoadmapPrompt(meeting, currentRoadmap, clientName, meetingNumber, totalMeetings) {
  const roadmapSummary = currentRoadmap.map(item => ({
    roadmap_item_id: item.id,
    title: item.title,
    category: item.category,
    task_type: item.task_type,
    owner_side: item.owner_side,
    owner_name: item.owner_name,
    status: item.status,
    due_date: item.due_date
  }));

  const actionItems = meeting.action_items || [];
  const actionItemsSummary = actionItems.map(ai => ({
    action: ai.title,
    assignee: ai.owner_name,
    due_date: ai.due_date
  }));

  return `You are analyzing a client meeting transcript and comparing it against an existing project roadmap.

CLIENT: ${clientName}
MEETING DATE: ${meeting.start_time}
MEETING NUMBER: ${meetingNumber} of ${totalMeetings} (chronological)

CURRENT ROADMAP (from previous meetings):
${JSON.stringify(roadmapSummary, null, 2)}

TASK TAXONOMY (valid categories and types):
${buildTaxonomySummary()}

MEETING TRANSCRIPT (first 15000 chars):
${(meeting.transcript_raw || '').substring(0, 15000)}

MEETING ACTION ITEMS (already extracted):
${JSON.stringify(actionItemsSummary, null, 2)}

INSTRUCTIONS:
1. For EACH existing roadmap item, determine:
   - was_discussed: true/false (was this topic mentioned or referenced in the transcript?)
   - new_status: 'unchanged' OR one of: 'in-progress', 'done', 'blocked', 'deferred' (only change if clear evidence)
   - status_evidence: quote or paraphrase from transcript supporting any status change (or null)
   - new_details: any updates like new due date, owner change, scope change (or null)

2. Identify NEW items from this meeting that are NOT already on the roadmap:
   - title: clear, canonical task name
   - category: from taxonomy (must be valid category id)
   - task_type: from taxonomy (must be valid task_type id within that category)
   - owner_side: 'b3x' or 'client'
   - owner_name: specific person if mentioned
   - due_date: if mentioned (ISO format or null)
   - description: brief context
   - transcript_evidence: relevant quote

Return ONLY valid JSON:
{
  "existing_items_update": [
    { "roadmap_item_id": 1, "was_discussed": true, "new_status": "in-progress", "status_evidence": "...", "new_details": null }
  ],
  "new_items": [
    { "title": "...", "category": "...", "task_type": "...", "owner_side": "b3x", "owner_name": "Phil", "due_date": null, "description": "...", "transcript_evidence": "..." }
  ]
}`;
}

async function runRoadmapTest(model, meeting41, roadmapAfterMeeting32, clientName) {
  console.log(`\n🗺️ Running roadmap test with ${model.label}...`);

  const prompt = buildRoadmapPrompt(meeting41, roadmapAfterMeeting32, clientName, 2, 2);
  const start = Date.now();

  try {
    const response = await callGemini(model.id, prompt);
    const elapsed = Date.now() - start;

    console.log(`  ✓ Completed in ${elapsed}ms`);

    return {
      model: model.id,
      response: parseJSON(response.text),
      raw_response: response.text,
      latency_ms: elapsed,
      tokens_in: response.usage?.promptTokenCount,
      tokens_out: response.usage?.candidatesTokenCount
    };
  } catch (err) {
    console.error(`  ✗ Error: ${err.message}`);
    return {
      model: model.id,
      response: null,
      error: err.message,
      latency_ms: Date.now() - start
    };
  }
}

// ============================================================================
// TEST 3: Meeting Prep
// ============================================================================

function formatActiveItems(items) {
  if (!items || items.length === 0) return 'None';
  return items.map(item => ({
    title: item.title,
    category: item.category,
    task_type: item.task_type,
    status: item.status,
    owner_side: item.owner_side,
    owner_name: item.owner_name,
    due_date: item.due_date,
    meetings_silent_count: item.meetings_silent_count,
    created_at: item.created_at
  }));
}

function buildPrepPrompt(prepData) {
  const { client, roadmap, meetings, service_gaps } = prepData;

  const categoryLabels = {};
  for (const cat of taxonomy.categories || []) {
    categoryLabels[cat.id] = cat.name;
  }

  return `You are a digital marketing strategist preparing a meeting briefing for a B3X team member.

CLIENT: ${client.name}
INDUSTRY: ${client.industry || 'unknown'}
B3X LEAD: ${client.b3x_lead || 'Not assigned'}
SERVICES ACTIVE: ${(client.services_active || []).join(', ') || 'None'}
SERVICES NOT YET ACTIVE (upsell opportunities): ${service_gaps.join(', ') || 'None available'}
MEETING CADENCE: ${client.meeting_cadence || 'unknown'}
LAST MEETING: ${meetings.last_date || 'No meetings'} (${client.days_since_last_meeting || '?'} days ago)
TOTAL MEETINGS ANALYZED: ${meetings.total}

CURRENT ROADMAP STATUS:
Total items: ${roadmap.stats.total} | Done: ${roadmap.stats.done} | In Progress: ${roadmap.stats.in_progress} | Blocked: ${roadmap.stats.blocked} | Agreed (pending start): ${roadmap.stats.agreed} | Stale: ${roadmap.stats.stale}

ACTIVE ROADMAP ITEMS:
${JSON.stringify(formatActiveItems(roadmap.active), null, 2)}

RECENTLY COMPLETED (last 30 days):
${JSON.stringify(formatActiveItems(roadmap.recently_completed), null, 2)}

STALE ITEMS (not discussed in 2+ meetings):
${JSON.stringify(formatActiveItems(roadmap.stale), null, 2)}

BLOCKED ITEMS:
${JSON.stringify(formatActiveItems(roadmap.blocked), null, 2)}

LAST 3 MEETING SUMMARIES:
${JSON.stringify(meetings.recent || [], null, 2)}

SERVICE GAPS (available but not active):
${service_gaps.length > 0 ? service_gaps.map(s => '- ' + s + ': ' + (categoryLabels[s] || s)).join('\n') : 'No gaps identified'}

INSTRUCTIONS:
Generate a meeting prep document with these 4 sections:

SECTION 1 - STATUS REPORT:
- List completed items since last meeting (with dates and categories)
- List in-progress items (with owner and ETA if known)
- List items needing client action (with context)

SECTION 2 - ACCOUNTABILITY CHECK:
- Flag stale items (agreed but not discussed for 2+ meetings) — these are CRITICAL
- Separate B3X overdue (owner_side='b3x') from client overdue (owner_side='client')
- Be specific about who owes what and since when

SECTION 3 - STRATEGIC DIRECTION:
- Based on the roadmap state, service gaps, and industry, recommend 2-4 next steps
- Each recommendation must have:
  - A clear title
  - WHY it makes sense NOW (connect to data: completed prerequisites, performance trends, industry patterns)
  - Which taxonomy category it falls under
- Prioritize: quick wins first, then growth opportunities, then long-term plays
- Consider industry seasonality (e.g., HVAC → summer AC push, winter heating)
- Consider service gaps as upsell opportunities

SECTION 4 - SUGGESTED AGENDA:
- Propose a meeting agenda with time allocations (in minutes)
- Put quick wins first (positive momentum)
- Put strategic proposal as main discussion topic
- End with clear next steps
- Estimate total meeting length

OUTPUT FORMAT: Return ONLY valid JSON matching this schema:
{
  "status_report": {
    "completed": [{"title": "...", "date": "...", "category": "..."}],
    "in_progress": [{"title": "...", "owner": "...", "category": "...", "eta": "..."}],
    "needs_client_action": [{"title": "...", "reason": "...", "since": "..."}]
  },
  "accountability": {
    "stale_items": [{"title": "...", "agreed_date": "...", "silent_meetings": 0}],
    "b3x_overdue": [{"title": "...", "owner": "...", "since": "..."}],
    "client_overdue": [{"title": "...", "action_needed": "...", "since": "..."}]
  },
  "strategic_direction": [
    {"priority": "HIGH", "title": "...", "reasoning": "...", "category": "...", "task_type": "..."}
  ],
  "suggested_agenda": [
    {"topic": "...", "minutes": 5, "notes": "..."}
  ],
  "estimated_meeting_length_minutes": 30
}`;
}

async function runPrepTest(model, prepData) {
  console.log(`\n📋 Running prep test with ${model.label}...`);

  const prompt = buildPrepPrompt(prepData);
  const start = Date.now();

  try {
    const response = await callGemini(model.id, prompt);
    const elapsed = Date.now() - start;

    console.log(`  ✓ Completed in ${elapsed}ms`);

    return {
      model: model.id,
      response: parseJSON(response.text),
      raw_response: response.text,
      latency_ms: elapsed,
      tokens_in: response.usage?.promptTokenCount,
      tokens_out: response.usage?.candidatesTokenCount
    };
  } catch (err) {
    console.error(`  ✗ Error: ${err.message}`);
    return {
      model: model.id,
      response: null,
      error: err.message,
      latency_ms: Date.now() - start
    };
  }
}

// ============================================================================
// AI-as-Judge Evaluation
// ============================================================================

async function judgeClassification(items2Flash, items3Flash) {
  console.log('\n⚖️ Running AI judge for classification...');

  const prompt = `You are evaluating two AI model outputs for action item classification.
Both models classified the same 16 action items. Compare their outputs.

MODEL A (gemini-2.0-flash) results:
${JSON.stringify(items2Flash.map(i => ({ title: i.item_title, ...i.response })), null, 2)}

MODEL B (gemini-3-flash-preview) results:
${JSON.stringify(items3Flash.map(i => ({ title: i.item_title, ...i.response })), null, 2)}

Score each model 1-5 on these dimensions:
1. ACCURACY: Correct category and task_type selection (1=wrong, 5=perfect)
2. OWNER_DETECTION: Correct b3x vs client and person identification (1=wrong, 5=correct)
3. SPECIFICITY: Uses the most specific task_type, not generic fallbacks (1=vague, 5=precise)

Return JSON:
{
  "model_a_scores": { "accuracy": N, "owner_detection": N, "specificity": N },
  "model_b_scores": { "accuracy": N, "owner_detection": N, "specificity": N },
  "model_a_avg": N.N,
  "model_b_avg": N.N,
  "winner": "model_a" | "model_b" | "tie",
  "reasoning": "Brief explanation of why one is better",
  "agreement_count": N,
  "specific_differences": ["difference 1", "difference 2", ...]
}`;

  await sleep(2000);
  const response = await callGemini(JUDGE_MODEL, prompt);
  return parseJSON(response.text);
}

async function judgeRoadmap(result2Flash, result3Flash, roadmapItems) {
  console.log('\n⚖️ Running AI judge for roadmap processing...');

  const prompt = `You are evaluating two AI model outputs for cross-meeting roadmap processing.
Both models analyzed the same meeting transcript against the same roadmap state.

EXISTING ROADMAP ITEMS (ground truth):
${JSON.stringify(roadmapItems.map(r => ({ id: r.id, title: r.title, status: r.status })), null, 2)}

MODEL A (gemini-2.0-flash) output:
${JSON.stringify(result2Flash.response, null, 2)}

MODEL B (gemini-3-flash-preview) output:
${JSON.stringify(result3Flash.response, null, 2)}

Score each model 1-5 on these dimensions:
1. DETECTION: Correctly identifies which items were discussed (1=missed many, 5=comprehensive)
2. STATUS_ACCURACY: Status changes backed by transcript evidence (1=hallucinated, 5=evidence-based)
3. NEW_ITEMS: Quality of newly discovered items (1=missed/hallucinated, 5=real and well-classified)
4. EVIDENCE: Quality of transcript_evidence quotes (1=vague, 5=exact quotes)

Return JSON:
{
  "model_a_scores": { "detection": N, "status_accuracy": N, "new_items": N, "evidence": N },
  "model_b_scores": { "detection": N, "status_accuracy": N, "new_items": N, "evidence": N },
  "model_a_avg": N.N,
  "model_b_avg": N.N,
  "winner": "model_a" | "model_b" | "tie",
  "reasoning": "Brief explanation of why one is better",
  "specific_differences": ["difference 1", "difference 2", ...]
}`;

  await sleep(2000);
  const response = await callGemini(JUDGE_MODEL, prompt);
  return parseJSON(response.text);
}

async function judgePrep(result2Flash, result3Flash) {
  console.log('\n⚖️ Running AI judge for meeting prep...');

  const prompt = `You are evaluating two AI model outputs for meeting prep generation.
Both models generated a meeting prep document from the same roadmap data.

MODEL A (gemini-2.0-flash) output:
${JSON.stringify(result2Flash.response, null, 2)}

MODEL B (gemini-3-flash-preview) output:
${JSON.stringify(result3Flash.response, null, 2)}

Score each model 1-5 on these dimensions:
1. COMPLETENESS: All sections populated with relevant data (1=empty, 5=thorough)
2. GROUNDEDNESS: Every claim traceable to roadmap data (1=hallucinated, 5=data-backed)
3. STRATEGIC_VALUE: Recommendations are specific and actionable (1=generic, 5=insightful)
4. ACTIONABILITY: Could Phil walk into a meeting with this and lead? (1=no, 5=absolutely)

Return JSON:
{
  "model_a_scores": { "completeness": N, "groundedness": N, "strategic_value": N, "actionability": N },
  "model_b_scores": { "completeness": N, "groundedness": N, "strategic_value": N, "actionability": N },
  "model_a_avg": N.N,
  "model_b_avg": N.N,
  "winner": "model_a" | "model_b" | "tie",
  "reasoning": "Brief explanation of why one is better",
  "specific_differences": ["difference 1", "difference 2", ...]
}`;

  await sleep(2000);
  const response = await callGemini(JUDGE_MODEL, prompt);
  return parseJSON(response.text);
}

// ============================================================================
// Report Generation
// ============================================================================

function generateReport(results) {
  const { classification, roadmap, prep, judges } = results;

  // Calculate classification stats
  const class2Flash = classification.filter(r => r.model === 'gemini-2.0-flash');
  const class3Flash = classification.filter(r => r.model === 'gemini-3-flash-preview');

  let agreementCount = 0;
  const classificationTable = [];
  for (let i = 0; i < class2Flash.length; i++) {
    const a = class2Flash[i];
    const b = class3Flash[i];
    const agree = a.response?.category === b.response?.category &&
                  a.response?.task_type === b.response?.task_type;
    if (agree) agreementCount++;
    classificationTable.push({
      num: i + 1,
      title: a.item_title.substring(0, 40),
      cat_a: a.response?.category || 'ERROR',
      cat_b: b.response?.category || 'ERROR',
      type_a: a.response?.task_type || 'ERROR',
      type_b: b.response?.task_type || 'ERROR',
      agree: agree ? '✅' : '❌'
    });
  }

  // Calculate latency stats
  const avgLatencyClass2 = Math.round(class2Flash.reduce((s, r) => s + r.latency_ms, 0) / class2Flash.length);
  const avgLatencyClass3 = Math.round(class3Flash.reduce((s, r) => s + r.latency_ms, 0) / class3Flash.length);

  const road2 = roadmap.find(r => r.model === 'gemini-2.0-flash');
  const road3 = roadmap.find(r => r.model === 'gemini-3-flash-preview');

  const prep2 = prep.find(r => r.model === 'gemini-2.0-flash');
  const prep3 = prep.find(r => r.model === 'gemini-3-flash-preview');

  // Calculate token totals
  const tokensIn2 = classification.filter(r => r.model === 'gemini-2.0-flash').reduce((s, r) => s + (r.tokens_in || 0), 0) +
                    (road2?.tokens_in || 0) + (prep2?.tokens_in || 0);
  const tokensIn3 = classification.filter(r => r.model === 'gemini-3-flash-preview').reduce((s, r) => s + (r.tokens_in || 0), 0) +
                    (road3?.tokens_in || 0) + (prep3?.tokens_in || 0);
  const tokensOut2 = classification.filter(r => r.model === 'gemini-2.0-flash').reduce((s, r) => s + (r.tokens_out || 0), 0) +
                     (road2?.tokens_out || 0) + (prep2?.tokens_out || 0);
  const tokensOut3 = classification.filter(r => r.model === 'gemini-3-flash-preview').reduce((s, r) => s + (r.tokens_out || 0), 0) +
                     (road3?.tokens_out || 0) + (prep3?.tokens_out || 0);

  // Overall scores
  const overall2 = ((judges.classification?.model_a_avg || 0) + (judges.roadmap?.model_a_avg || 0) + (judges.prep?.model_a_avg || 0)) / 3;
  const overall3 = ((judges.classification?.model_b_avg || 0) + (judges.roadmap?.model_b_avg || 0) + (judges.prep?.model_b_avg || 0)) / 3;

  const report = `# Model Comparison Report: Gemini 2.0 Flash vs 3 Flash Preview

Date: ${new Date().toISOString().split('T')[0]}
Client: Prosper Group
Total API calls: 36 (32 classification + 2 roadmap + 2 prep)

## Summary Table

| Test | 2.0 Flash | 3 Flash Preview | Winner | Delta |
|------|-----------|-----------------|--------|-------|
| Classification (avg) | ${judges.classification?.model_a_avg?.toFixed(1) || 'N/A'}/5 | ${judges.classification?.model_b_avg?.toFixed(1) || 'N/A'}/5 | ${judges.classification?.winner?.replace('model_a', '2.0 Flash').replace('model_b', '3 Flash') || 'N/A'} | ${judges.classification ? `+${Math.abs(judges.classification.model_b_avg - judges.classification.model_a_avg).toFixed(1)}` : 'N/A'} |
| Roadmap | ${judges.roadmap?.model_a_avg?.toFixed(1) || 'N/A'}/5 | ${judges.roadmap?.model_b_avg?.toFixed(1) || 'N/A'}/5 | ${judges.roadmap?.winner?.replace('model_a', '2.0 Flash').replace('model_b', '3 Flash') || 'N/A'} | ${judges.roadmap ? `+${Math.abs(judges.roadmap.model_b_avg - judges.roadmap.model_a_avg).toFixed(1)}` : 'N/A'} |
| Meeting Prep | ${judges.prep?.model_a_avg?.toFixed(1) || 'N/A'}/5 | ${judges.prep?.model_b_avg?.toFixed(1) || 'N/A'}/5 | ${judges.prep?.winner?.replace('model_a', '2.0 Flash').replace('model_b', '3 Flash') || 'N/A'} | ${judges.prep ? `+${Math.abs(judges.prep.model_b_avg - judges.prep.model_a_avg).toFixed(1)}` : 'N/A'} |
| **Overall** | **${overall2.toFixed(1)}** | **${overall3.toFixed(1)}** | **${overall2 > overall3 ? '2.0 Flash' : overall3 > overall2 ? '3 Flash' : 'Tie'}** | **+${Math.abs(overall3 - overall2).toFixed(1)}** |

## Performance

| Metric | 2.0 Flash | 3 Flash Preview |
|--------|-----------|-----------------|
| Avg latency (classification) | ${avgLatencyClass2}ms | ${avgLatencyClass3}ms |
| Avg latency (roadmap) | ${road2?.latency_ms || 'N/A'}ms | ${road3?.latency_ms || 'N/A'}ms |
| Avg latency (prep) | ${prep2?.latency_ms || 'N/A'}ms | ${prep3?.latency_ms || 'N/A'}ms |
| Total tokens in | ${tokensIn2.toLocaleString()} | ${tokensIn3.toLocaleString()} |
| Total tokens out | ${tokensOut2.toLocaleString()} | ${tokensOut3.toLocaleString()} |

## Classification Comparison (16 items)

| # | Action Item | 2.0 Flash Cat | 3 FP Cat | 2.0 Flash Type | 3 FP Type | Agree? |
|---|-------------|---------------|----------|----------------|-----------|--------|
${classificationTable.map(r => `| ${r.num} | ${r.title} | ${r.cat_a} | ${r.cat_b} | ${r.type_a} | ${r.type_b} | ${r.agree} |`).join('\n')}

**Agreement rate: ${agreementCount}/16 (${Math.round(agreementCount / 16 * 100)}%)**

### Classification Judge Assessment
${judges.classification?.reasoning || 'No assessment available'}

**Specific differences:**
${(judges.classification?.specific_differences || []).map(d => `- ${d}`).join('\n') || '- None noted'}

## Roadmap Comparison

### Items Discussed Detection

| Model | Items Discussed | Status Changes | New Items Found |
|-------|-----------------|----------------|-----------------|
| 2.0 Flash | ${road2?.response?.existing_items_update?.filter(i => i.was_discussed)?.length || 0} | ${road2?.response?.existing_items_update?.filter(i => i.new_status !== 'unchanged')?.length || 0} | ${road3?.response?.new_items?.length || 0} |
| 3 Flash Preview | ${road3?.response?.existing_items_update?.filter(i => i.was_discussed)?.length || 0} | ${road3?.response?.existing_items_update?.filter(i => i.new_status !== 'unchanged')?.length || 0} | ${road3?.response?.new_items?.length || 0} |

### Roadmap Judge Assessment
${judges.roadmap?.reasoning || 'No assessment available'}

**Specific differences:**
${(judges.roadmap?.specific_differences || []).map(d => `- ${d}`).join('\n') || '- None noted'}

## Meeting Prep Comparison

### Section Completeness

| Section | 2.0 Flash Items | 3 Flash Preview Items |
|---------|-----------------|----------------------|
| Completed | ${prep2?.response?.status_report?.completed?.length || 0} | ${prep3?.response?.status_report?.completed?.length || 0} |
| In Progress | ${prep2?.response?.status_report?.in_progress?.length || 0} | ${prep3?.response?.status_report?.in_progress?.length || 0} |
| Needs Client Action | ${prep2?.response?.status_report?.needs_client_action?.length || 0} | ${prep3?.response?.status_report?.needs_client_action?.length || 0} |
| Stale Items | ${prep2?.response?.accountability?.stale_items?.length || 0} | ${prep3?.response?.accountability?.stale_items?.length || 0} |
| Strategic Recs | ${prep2?.response?.strategic_direction?.length || 0} | ${prep3?.response?.strategic_direction?.length || 0} |
| Agenda Items | ${prep2?.response?.suggested_agenda?.length || 0} | ${prep3?.response?.suggested_agenda?.length || 0} |
| Est. Meeting Length | ${prep2?.response?.estimated_meeting_length_minutes || 'N/A'}min | ${prep3?.response?.estimated_meeting_length_minutes || 'N/A'}min |

### Prep Judge Assessment
${judges.prep?.reasoning || 'No assessment available'}

**Specific differences:**
${(judges.prep?.specific_differences || []).map(d => `- ${d}`).join('\n') || '- None noted'}

## Recommendation

Based on the comparison:

- **For Classification:** Use ${judges.classification?.winner === 'model_a' ? '2.0 Flash' : judges.classification?.winner === 'model_b' ? '3 Flash Preview' : 'either (tie)'} - ${judges.classification?.reasoning || 'comparable performance'}

- **For Roadmap Processing:** Use ${judges.roadmap?.winner === 'model_a' ? '2.0 Flash' : judges.roadmap?.winner === 'model_b' ? '3 Flash Preview' : 'either (tie)'} - ${judges.roadmap?.reasoning || 'comparable performance'}

- **For Meeting Prep:** Use ${judges.prep?.winner === 'model_a' ? '2.0 Flash' : judges.prep?.winner === 'model_b' ? '3 Flash Preview' : 'either (tie)'} - ${judges.prep?.reasoning || 'comparable performance'}

**Overall Winner: ${overall2 > overall3 ? 'Gemini 2.0 Flash' : overall3 > overall2 ? 'Gemini 3 Flash Preview' : 'Tie'}** (${overall2.toFixed(1)} vs ${overall3.toFixed(1)})
`;

  return report;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('🔬 Model Comparison: Gemini 2.0 Flash vs 3 Flash Preview');
  console.log('='.repeat(60));

  // Load data
  console.log('\n📂 Loading Prosper Group data...');

  const actionItems = db.prepare(`
    SELECT id, meeting_id, title, owner_name, category, status
    FROM action_items
    WHERE meeting_id IN (32, 41)
    ORDER BY meeting_id, id
  `).all();
  console.log(`  Found ${actionItems.length} action items`);

  const meeting41 = db.prepare(`
    SELECT id, topic, start_time, transcript_raw
    FROM meetings WHERE id = 41
  `).get();

  // Get action items for meeting 41
  const meeting41ActionItems = db.prepare(`
    SELECT id, title, owner_name, due_date FROM action_items WHERE meeting_id = 41
  `).all();
  meeting41.action_items = meeting41ActionItems;

  const roadmapItems = db.prepare(`
    SELECT * FROM roadmap_items WHERE client_id = 'prosper-group' ORDER BY id
  `).all();
  console.log(`  Found ${roadmapItems.length} roadmap items`);

  // For roadmap test, use roadmap state after meeting 32 (first 9 items)
  const roadmapAfterMeeting32 = roadmapItems.filter(r => r.created_meeting_id === 32);
  console.log(`  Roadmap state after meeting 32: ${roadmapAfterMeeting32.length} items`);

  // Prepare prep data
  const prepData = {
    client: {
      id: 'prosper-group',
      name: 'Prosper Group',
      industry: 'coaching',
      b3x_lead: 'Phil',
      services_active: ['paid-ads', 'email-marketing', 'funnel-campaign'],
      meeting_cadence: 'weekly',
      days_since_last_meeting: 7
    },
    roadmap: {
      stats: {
        total: roadmapItems.length,
        done: roadmapItems.filter(r => r.status === 'done').length,
        in_progress: roadmapItems.filter(r => r.status === 'in-progress').length,
        blocked: roadmapItems.filter(r => r.status === 'blocked').length,
        agreed: roadmapItems.filter(r => r.status === 'agreed').length,
        stale: roadmapItems.filter(r => r.meetings_silent_count >= 2).length
      },
      active: roadmapItems.filter(r => r.status !== 'done'),
      recently_completed: roadmapItems.filter(r => r.status === 'done'),
      stale: roadmapItems.filter(r => r.meetings_silent_count >= 2),
      blocked: roadmapItems.filter(r => r.status === 'blocked')
    },
    meetings: {
      total: 2,
      last_date: '2026-03-24',
      recent: []
    },
    service_gaps: ['website'],
    taxonomy
  };

  // Run tests
  const results = {
    classification: [],
    roadmap: [],
    prep: [],
    judges: {}
  };

  // Classification tests (16 items × 2 models = 32 calls)
  for (const model of MODELS) {
    const classResults = await runClassificationTest(model, actionItems, 'Prosper Group');
    results.classification.push(...classResults);
  }

  // Roadmap tests (2 calls)
  for (const model of MODELS) {
    const roadResult = await runRoadmapTest(model, meeting41, roadmapAfterMeeting32, 'Prosper Group');
    results.roadmap.push(roadResult);
    await sleep(2000);
  }

  // Prep tests (2 calls)
  for (const model of MODELS) {
    const prepResult = await runPrepTest(model, prepData);
    results.prep.push(prepResult);
    await sleep(2000);
  }

  // AI Judge evaluations
  const class2Flash = results.classification.filter(r => r.model === 'gemini-2.0-flash');
  const class3Flash = results.classification.filter(r => r.model === 'gemini-3-flash-preview');
  results.judges.classification = await judgeClassification(class2Flash, class3Flash);

  const road2 = results.roadmap.find(r => r.model === 'gemini-2.0-flash');
  const road3 = results.roadmap.find(r => r.model === 'gemini-3-flash-preview');
  results.judges.roadmap = await judgeRoadmap(road2, road3, roadmapItems);

  const prep2 = results.prep.find(r => r.model === 'gemini-2.0-flash');
  const prep3 = results.prep.find(r => r.model === 'gemini-3-flash-preview');
  results.judges.prep = await judgePrep(prep2, prep3);

  // Generate report
  console.log('\n📝 Generating report...');
  const report = generateReport(results);

  // Ensure data directory exists
  const dataDir = join(PROJECT_ROOT, 'data');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  // Save outputs
  writeFileSync(join(dataDir, 'model-comparison-report.md'), report);
  writeFileSync(join(dataDir, 'model-comparison-raw.json'), JSON.stringify(results, null, 2));

  console.log('\n' + '='.repeat(60));
  console.log('✅ Comparison complete!');
  console.log(`   Report: data/model-comparison-report.md`);
  console.log(`   Raw data: data/model-comparison-raw.json`);

  // Print summary
  const overall2 = ((results.judges.classification?.model_a_avg || 0) +
                    (results.judges.roadmap?.model_a_avg || 0) +
                    (results.judges.prep?.model_a_avg || 0)) / 3;
  const overall3 = ((results.judges.classification?.model_b_avg || 0) +
                    (results.judges.roadmap?.model_b_avg || 0) +
                    (results.judges.prep?.model_b_avg || 0)) / 3;

  console.log('\n📊 Summary:');
  console.log(`   2.0 Flash overall: ${overall2.toFixed(1)}/5`);
  console.log(`   3 Flash Preview overall: ${overall3.toFixed(1)}/5`);
  console.log(`   Winner: ${overall2 > overall3 ? 'Gemini 2.0 Flash' : overall3 > overall2 ? 'Gemini 3 Flash Preview' : 'Tie'}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
