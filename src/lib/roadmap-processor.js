/**
 * Roadmap AI Processor
 * Cross-references meetings against existing roadmap using Gemini
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load taxonomy
const taxonomyPath = join(__dirname, '..', 'config', 'task-taxonomy.json');
let taxonomy = null;

function loadTaxonomy() {
  if (!taxonomy) {
    taxonomy = JSON.parse(readFileSync(taxonomyPath, 'utf-8'));
  }
  return taxonomy;
}

// Rate limiting
const MIN_INTERVAL = 2000; // 2 seconds between calls
let lastCallTime = 0;

async function rateLimitedDelay() {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < MIN_INTERVAL) {
    await new Promise(r => setTimeout(r, MIN_INTERVAL - elapsed));
  }
  lastCallTime = Date.now();
}

/**
 * Get Gemini client
 */
function getGeminiClient() {
  if (!process.env.GOOGLE_API_KEY) {
    throw new Error('GOOGLE_API_KEY environment variable not set');
  }
  return new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
}

/**
 * Build taxonomy summary for prompt
 */
function buildTaxonomySummary() {
  const tax = loadTaxonomy();
  const lines = ['Valid categories and task types:'];

  for (const cat of tax.categories) {
    lines.push(`\n${cat.id} - ${cat.name}:`);
    for (const tt of cat.task_types) {
      lines.push(`  - ${tt.id}: ${tt.name}`);
    }
  }

  return lines.join('\n');
}

/**
 * Validate category and task_type against taxonomy
 */
export function validateTaxonomy(category, taskType) {
  const tax = loadTaxonomy();
  const cat = tax.categories.find(c => c.id === category);
  if (!cat) return { valid: false, error: `Invalid category: ${category}` };

  const tt = cat.task_types.find(t => t.id === taskType);
  if (!tt) return { valid: false, error: `Invalid task_type '${taskType}' for category '${category}'` };

  return { valid: true };
}

/**
 * Classify a single action item using Gemini
 */
export async function classifyActionItem(actionItem, clientName) {
  await rateLimitedDelay();

  const genAI = getGeminiClient();
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  const prompt = `You are classifying a client action item into a canonical task taxonomy.

CLIENT: ${clientName}
ACTION ITEM: "${actionItem.assignee ? actionItem.assignee + ' — ' : ''}${actionItem.action}"

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

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('No JSON found in classification response');
      return getDefaultClassification(actionItem);
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate taxonomy
    const validation = validateTaxonomy(parsed.category, parsed.task_type);
    if (!validation.valid) {
      console.warn(`Classification validation failed: ${validation.error}`);
      return getDefaultClassification(actionItem);
    }

    return {
      category: parsed.category,
      task_type: parsed.task_type,
      owner_side: parsed.owner_side || 'b3x',
      owner_name: parsed.owner_name || actionItem.assignee || null
    };
  } catch (err) {
    console.error('Classification error:', err.message);
    return getDefaultClassification(actionItem);
  }
}

/**
 * Default classification for fallback
 */
function getDefaultClassification(actionItem) {
  return {
    category: 'client-ops',
    task_type: 'offer-development',
    owner_side: 'b3x',
    owner_name: actionItem?.assignee || null
  };
}

/**
 * Process a meeting against the current roadmap state
 */
export async function processAgainstRoadmap(meeting, currentRoadmap, clientName, meetingNumber, totalMeetings) {
  await rateLimitedDelay();

  const genAI = getGeminiClient();
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  // Format current roadmap for prompt
  const roadmapSummary = currentRoadmap.map((item, idx) => ({
    roadmap_item_id: item.id,
    title: item.title,
    category: item.category,
    task_type: item.task_type,
    owner_side: item.owner_side,
    owner_name: item.owner_name,
    status: item.status,
    due_date: item.due_date
  }));

  // Get action items if available
  const actionItems = meeting.action_items || [];
  const actionItemsSummary = actionItems.map(ai => ({
    action: ai.action,
    assignee: ai.assignee,
    due_date: ai.due_date
  }));

  const prompt = `You are analyzing a client meeting transcript and comparing it against an existing project roadmap.

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

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('No JSON found in roadmap processing response');
      return { existing_items_update: [], new_items: [] };
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate new items have valid taxonomy
    if (parsed.new_items) {
      parsed.new_items = parsed.new_items.filter(item => {
        const validation = validateTaxonomy(item.category, item.task_type);
        if (!validation.valid) {
          console.warn(`Skipping new item with invalid taxonomy: ${item.title} - ${validation.error}`);
          return false;
        }
        return true;
      });
    }

    return {
      existing_items_update: parsed.existing_items_update || [],
      new_items: parsed.new_items || []
    };
  } catch (err) {
    console.error('Roadmap processing error:', err.message);
    return { existing_items_update: [], new_items: [] };
  }
}

/**
 * Get taxonomy for external use
 */
export function getTaxonomy() {
  return loadTaxonomy();
}

export default {
  classifyActionItem,
  processAgainstRoadmap,
  validateTaxonomy,
  getTaxonomy
};
