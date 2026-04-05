# Phase 06B: Transcript Excerpts in Action Items

## Context
Phase 06A added `transcript_excerpt` column to action_items. The Gemini extraction prompt currently asks for action items with title, owner, due_date, priority, category, description. But it doesn't ask for the transcript excerpt — the specific lines from the conversation where the action item was discussed.

The AI extractor is at `src/lib/ai-extractor.js`. It uses `gemini-3-flash-preview` with a structured JSON prompt. Transcripts are speaker-labeled text like:
```
Philip Mutrie: So the main thing we need to do is get those ad campaigns updated
Dan Kuschell: Yeah, can you handle that by Friday?
Philip Mutrie: Absolutely, I'll get the new creatives up by end of day Friday
```

## Objective
Enhance the Gemini prompt to return a `transcript_excerpt` field per action item — the 2-4 lines from the transcript where this task was discussed. Store in the DB. Show in the dashboard as collapsible context below each action item.

## Implementation Steps

1. **Update the extraction prompt in `src/lib/ai-extractor.js`:**
   Add `transcript_excerpt` to the action_items JSON schema in the prompt:
   ```
   "action_items": [
     {
       "title": "task description",
       "owner": "person name",
       "due_date": "YYYY-MM-DD or null",
       "priority": "high/medium/low",
       "category": "follow-up/deliverable/decision/other",
       "description": "additional context",
       "transcript_excerpt": "The 2-4 lines from the transcript where this action item was discussed, including speaker names. Copy verbatim from the transcript."
     }
   ]
   ```

2. **Update the DB insert in `src/poll.js`** (or wherever action items are inserted):
   - Include `transcript_excerpt` when inserting action items
   - The insert statement in `src/lib/database.js` `insertActionItems()` needs to accept and store transcript_excerpt

3. **Update `src/lib/database.js` `insertActionItems()`:**
   - Add transcript_excerpt parameter to the INSERT statement

4. **Update the dashboard `public/index.html`:**
   - Below each action item card, add a collapsible "View context" link
   - When clicked, shows the transcript excerpt in a styled blockquote
   - Grey background, smaller font, speaker names in bold
   - Collapsed by default (saves space)

5. **Reprocess existing meetings** to populate transcript_excerpt:
   - Create a small script or use the batch processor with a flag
   - OR just reprocess via the existing batch-process.mjs (it will update existing records)
   - Need to modify batch-process.mjs to UPDATE existing meetings rather than skip them

## Files to Modify
- `src/lib/ai-extractor.js` — Enhanced prompt with transcript_excerpt
- `src/lib/database.js` — insertActionItems includes transcript_excerpt
- `src/poll.js` — Pass transcript_excerpt through
- `public/index.html` — Collapsible transcript context per action item
- `scripts/batch-process.mjs` — Add --reprocess flag to update existing meetings

## Do NOT Touch
- `src/api/routes.js` — Already serves transcript_excerpt via SELECT *
- `src/lib/proofhub-client.js` — Phase 06C
- `src/lib/people-resolver.js` — Phase 06C

## Acceptance Criteria
- [ ] Gemini prompt asks for transcript_excerpt per action item
- [ ] New action items have transcript_excerpt populated in DB
- [ ] Dashboard shows "View context" link per action item
- [ ] Clicking link reveals transcript excerpt in a blockquote
- [ ] Excerpt includes speaker names and is verbatim from transcript
- [ ] batch-process.mjs --reprocess updates existing meetings

## Smoke Tests
```bash
# Test 1: New extraction includes transcript_excerpt
# Run a test extraction on a known meeting
node -e "
import { extractActionItems } from './src/lib/ai-extractor.js';
import Database from 'better-sqlite3';
const db = new Database('data/zoom-action-items.db');
const m = db.prepare('SELECT transcript_raw FROM meetings WHERE id = 2').get();
const result = await extractActionItems(m.transcript_raw.slice(0, 50000));
console.log('Has excerpt:', !!result.action_items?.[0]?.transcript_excerpt);
console.log('Sample:', result.action_items?.[0]?.transcript_excerpt?.substring(0, 100));
"
→ expect: Has excerpt: true, with actual transcript lines

# Test 2: Frontend has context toggle
curl -s http://localhost:3875/zoom/ | grep -c 'transcript-excerpt\|view-context\|toggle.*context'
→ expect: at least 2

# Test 3: API returns transcript_excerpt
curl -s http://localhost:3875/zoom/api/action-items?limit=1 | python3 -c "import sys,json; i=json.load(sys.stdin)['items'][0]; print('excerpt:', (i.get('transcript_excerpt') or 'NONE')[:80])"
→ expect: excerpt with actual content (after reprocessing)
```

## Completion Instructions
1. Run smoke tests
2. Write result to `.planning/phases/06B-transcript-excerpts/result.md`
3. Commit with prefix `[zoom-pipeline-06B]`
