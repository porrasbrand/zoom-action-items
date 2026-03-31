/**
 * Prep Generator
 * Uses Gemini to generate meeting prep document from collected data.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

// Rate limiting
const MIN_INTERVAL = 2000;
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
 * Format roadmap items for prompt
 */
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

/**
 * Format stale items for prompt
 */
function formatStaleItems(items) {
  if (!items || items.length === 0) return 'None';

  return items.map(item => ({
    title: item.title,
    category: item.category,
    owner_side: item.owner_side,
    owner_name: item.owner_name,
    created_at: item.created_at,
    meetings_silent_count: item.meetings_silent_count,
    status_history: item.status_history?.slice(-2) || []
  }));
}

/**
 * Format meeting summaries for prompt
 */
function formatMeetingSummaries(meetings) {
  if (!meetings || meetings.length === 0) return 'No recent meetings';

  return meetings.map(m => ({
    date: m.start_time,
    topic: m.topic,
    summary: m.ai_extraction?.summary || 'No summary available',
    key_topics: m.ai_extraction?.key_topics || []
  }));
}

/**
 * Generate meeting prep document from collected data.
 *
 * @param {Object} prepData - from collectPrepData()
 * @returns {Object} - { json: Object, raw_response: string }
 */
export async function generateMeetingPrep(prepData) {
  await rateLimitedDelay();

  const genAI = getGeminiClient();
  const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });

  const { client, roadmap, meetings, service_gaps, taxonomy } = prepData;

  // Build category labels from taxonomy
  const categoryLabels = {};
  for (const cat of taxonomy.categories || []) {
    categoryLabels[cat.id] = cat.name;
  }

  const prompt = `You are a digital marketing strategist preparing a meeting briefing for a B3X team member.

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
${JSON.stringify(formatStaleItems(roadmap.stale), null, 2)}

BLOCKED ITEMS:
${JSON.stringify(formatActiveItems(roadmap.blocked), null, 2)}

LAST 3 MEETING SUMMARIES:
${JSON.stringify(formatMeetingSummaries(meetings.recent), null, 2)}

SERVICE GAPS (available but not active):
${service_gaps.length > 0 ? service_gaps.map(s => `- ${s}: ${categoryLabels[s] || s}`).join('\n') : 'No gaps identified'}

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

SECTION 5 - PROJECTED ROADMAP (New items to propose to client):
- Based on completed work, service gaps, industry patterns, and meeting history, propose 3-5 SPECIFIC new roadmap items that B3X should pitch to the client in the next meeting.
- These are NOT items already on the roadmap. They are NEW proposals.
- Each item must be concrete enough that Phil can present it as: "Here's what we recommend we add to our plan."
- For each proposed item:
  - title: Clear, specific task name (not generic like "improve SEO")
  - why_now: Connect to a specific trigger — a completed prerequisite, a seasonal opportunity, a service gap, or something the client mentioned in recent meetings
  - category and task_type: From the taxonomy
  - effort_b3x: Estimated B3X hours (e.g., "4hrs setup", "8hrs/month ongoing")
  - effort_client: What the client needs to provide or approve
  - prerequisites: What must be done first (reference roadmap items by title if applicable), or "None — can start immediately"
  - impact: Expected outcome in plain language
  - priority: QUICK_WIN (small effort, fast result) | GROWTH (medium effort, scaling) | STRATEGIC (larger effort, long-term positioning)
- Prioritize: QUICK_WINs first, then GROWTH, then STRATEGIC
- Do NOT repeat items that are already active on the roadmap
- Ground every proposal in data from the roadmap, service gaps, or meeting context — no generic filler

SECTION 6 - TALKING POINTS:
For each item in sections 1-5 that Phil might discuss with the client, generate a short conversational one-liner — exactly what Phil should SAY to introduce the topic naturally.
Write as if Phil is speaking directly to the client in a warm, professional tone.

Examples of good talking points:
- For a completed item: "Great news — we got the Facebook Ads live for the 20th, and Richard optimized the spend mid-run"
- For a blocker: "Kurt, quick question — do you have a timeline for the dinner email copy? We need it to schedule the promo"
- For a stale item: "I want to flag something — the HubSpot permission tag has been on our list since March 3 but hasn't come up. Should we keep it or formally take it off the table?"
- For a proposal: "Something I want to put on your radar — now that the evergreen funnel is taking shape, a quick website audit could really boost the conversion on all the traffic we're driving"

Return as a JSON object keyed by item title.

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
  "estimated_meeting_length_minutes": 30,
  "projected_roadmap": [
    {
      "title": "...",
      "why_now": "...",
      "category": "...",
      "task_type": "...",
      "effort_b3x": "...",
      "effort_client": "...",
      "prerequisites": "...",
      "impact": "...",
      "priority": "QUICK_WIN | GROWTH | STRATEGIC"
    }
  ],
  "talking_points": {
    "Item Title Here": "Great news — we completed this ahead of schedule...",
    "Another Item Title": "Quick question — do you have a timeline for..."
  }
}`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('No JSON found in prep generation response');
      return {
        json: getDefaultPrep(prepData),
        raw_response: text
      };
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      json: {
        ...parsed,
        meta: {
          client_id: client.id,
          client_name: client.name,
          generated_at: new Date().toISOString(),
          b3x_lead: client.b3x_lead,
          last_meeting: meetings.last_date,
          days_since_last_meeting: client.days_since_last_meeting,
          meetings_analyzed: meetings.total,
          roadmap_stats: roadmap.stats
        }
      },
      raw_response: text
    };
  } catch (err) {
    console.error('Prep generation error:', err.message);
    return {
      json: getDefaultPrep(prepData),
      raw_response: err.message
    };
  }
}

/**
 * Default prep structure for fallback
 */
function getDefaultPrep(prepData) {
  const { client, roadmap, meetings, service_gaps } = prepData;

  return {
    status_report: {
      completed: roadmap.recently_completed.map(i => ({
        title: i.title,
        date: i.updated_at?.split('T')[0] || 'unknown',
        category: i.category
      })),
      in_progress: roadmap.active.filter(i => i.status === 'in-progress').map(i => ({
        title: i.title,
        owner: i.owner_name || 'unassigned',
        category: i.category,
        eta: i.due_date || 'TBD'
      })),
      needs_client_action: roadmap.active.filter(i => i.owner_side === 'client' && i.status !== 'done').map(i => ({
        title: i.title,
        reason: 'Waiting on client',
        since: i.created_at?.split('T')[0] || 'unknown'
      }))
    },
    accountability: {
      stale_items: roadmap.stale.map(i => ({
        title: i.title,
        agreed_date: i.created_at?.split('T')[0] || 'unknown',
        silent_meetings: i.meetings_silent_count
      })),
      b3x_overdue: roadmap.active.filter(i => i.owner_side === 'b3x' && i.meetings_silent_count >= 1).map(i => ({
        title: i.title,
        owner: i.owner_name || 'B3X team',
        since: i.created_at?.split('T')[0] || 'unknown'
      })),
      client_overdue: roadmap.active.filter(i => i.owner_side === 'client' && i.meetings_silent_count >= 1).map(i => ({
        title: i.title,
        action_needed: i.title,
        since: i.created_at?.split('T')[0] || 'unknown'
      }))
    },
    strategic_direction: [{
      priority: 'HIGH',
      title: 'Review stale items and get commitments',
      reasoning: `${roadmap.stats.stale} items have gone stale. Need to address accountability.`,
      category: 'client-ops',
      task_type: 'offer-development'
    }],
    suggested_agenda: [
      { topic: 'Quick wins / completed items', minutes: 5, notes: `${roadmap.stats.done} items completed` },
      { topic: 'In-progress review', minutes: 10, notes: `${roadmap.stats.in_progress} items in progress` },
      { topic: 'Blocked items - get commitments', minutes: 10, notes: `${roadmap.stats.blocked} items blocked` },
      { topic: 'Next steps', minutes: 5, notes: 'Agree on priorities' }
    ],
    estimated_meeting_length_minutes: 30,
    projected_roadmap: (service_gaps || []).map(gap => ({
      title: `Activate ${gap} service`,
      why_now: `${gap} is available but not active for this client`,
      category: gap,
      task_type: 'general',
      effort_b3x: 'TBD',
      effort_client: 'Approval needed',
      prerequisites: 'None',
      impact: 'Expand marketing footprint',
      priority: 'GROWTH'
    })).slice(0, 3),
    meta: {
      client_id: client.id,
      client_name: client.name,
      generated_at: new Date().toISOString(),
      b3x_lead: client.b3x_lead,
      last_meeting: meetings.last_date,
      days_since_last_meeting: client.days_since_last_meeting,
      meetings_analyzed: meetings.total,
      roadmap_stats: roadmap.stats,
      fallback: true
    }
  };
}

export default {
  generateMeetingPrep
};
