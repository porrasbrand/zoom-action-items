# Phase 12: Model Comparison — Gemini 2.0 Flash vs 3 Flash Preview

## Context

The zoom-action-items pipeline uses Gemini for 3 AI steps:
1. **Classification** — Assign category/task_type/owner_side to each action item
2. **Cross-Meeting Roadmap** — Compare meeting transcript against existing roadmap
3. **Meeting Prep** — Generate 4-section briefing document

Currently Steps 2-4 use `gemini-2.0-flash`. Step 1 (initial extraction) already uses `gemini-3-flash-preview`. This phase runs a **head-to-head comparison** of both models on identical inputs for Prosper Group to measure quality differences.

## Objective

Build and run a comparison script that:
1. Runs **all 3 prompt types** against **both models** with **identical inputs**
2. Captures outputs, timing, and token usage
3. Runs AI-as-judge evaluation comparing outputs
4. Produces a structured comparison report

## Test Data: Prosper Group

```
Client: prosper-group (Prosper Group)
Industry: coaching
Services active: paid-ads, email-marketing, funnel-campaign
Services available: paid-ads, email-marketing, funnel-campaign, website
B3X lead: Phil

Meeting #32: Mar 17, 2026 — 48min, 53,555 char transcript, 9 action items
Meeting #41: Mar 24, 2026 — 58min, 61,673 char transcript, 7 action items

16 total action items across both meetings
10 roadmap items from initial build (all status "agreed")
```

## Implementation

### Create `scripts/model-comparison.mjs`

```javascript
// Usage: node scripts/model-comparison.mjs
//
// Runs 3 prompt types × 2 models for Prosper Group
// Outputs: data/model-comparison-report.md + data/model-comparison-raw.json

import 'dotenv/config';
import Database from 'better-sqlite3';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
```

### Models to Compare

```javascript
const MODELS = [
  { id: 'gemini-2.0-flash', label: '2.0 Flash (current)' },
  { id: 'gemini-3-flash-preview', label: '3.0 Flash Preview' }
];
```

### Test Suite

#### TEST 1: Classification (16 action items × 2 models = 32 calls)

For each action item from both Prosper Group meetings, run the classification prompt:

```javascript
async function runClassificationTest(model, actionItems, clientName, taxonomy) {
  const results = [];

  for (const item of actionItems) {
    const prompt = buildClassificationPrompt(item, clientName, taxonomy);
    const start = Date.now();
    const response = await callGemini(model, prompt);
    const elapsed = Date.now() - start;

    results.push({
      item_id: item.id,
      item_title: item.title,
      item_owner: item.owner_name,
      model: model.id,
      response: parseJSON(response.text),
      latency_ms: elapsed,
      tokens_in: response.usage?.promptTokenCount,
      tokens_out: response.usage?.candidatesTokenCount
    });

    // Rate limit
    await sleep(2000);
  }

  return results;
}
```

**Measurement for Classification:**
- Agreement rate between models (do they pick same category? task_type? owner_side?)
- Compare against the existing roadmap_items classifications (ground truth from the original run)
- Taxonomy compliance (are outputs valid categories/types?)
- Latency and token usage per call

#### TEST 2: Cross-Meeting Roadmap (1 call × 2 models = 2 calls)

Use Meeting #41's transcript and process it against the roadmap state after Meeting #32 (9 initial items). This is the prompt that detects:
- Which existing items were discussed
- Status changes (agreed → in-progress, done, etc.)
- New items from the meeting

```javascript
async function runRoadmapTest(model, meeting41, roadmapAfterMeeting32, clientName, taxonomy) {
  const prompt = buildRoadmapPrompt(meeting41, roadmapAfterMeeting32, clientName, taxonomy, 2, 2);
  const start = Date.now();
  const response = await callGemini(model, prompt);
  const elapsed = Date.now() - start;

  return {
    model: model.id,
    response: parseJSON(response.text),
    raw_response: response.text,
    latency_ms: elapsed,
    tokens_in: response.usage?.promptTokenCount,
    tokens_out: response.usage?.candidatesTokenCount
  };
}
```

**Measurement for Roadmap:**
- How many existing items detected as `was_discussed: true` vs `false`
- Status changes detected (and evidence quality)
- New items found (and taxonomy compliance)
- Does the output make sense given what Meeting #41 actually discussed?

#### TEST 3: Meeting Prep (1 call × 2 models = 2 calls)

Generate a full meeting prep document from the current roadmap state.

```javascript
async function runPrepTest(model, prepData) {
  const prompt = buildPrepPrompt(prepData);
  const start = Date.now();
  const response = await callGemini(model, prompt);
  const elapsed = Date.now() - start;

  return {
    model: model.id,
    response: parseJSON(response.text),
    raw_response: response.text,
    latency_ms: elapsed,
    tokens_in: response.usage?.promptTokenCount,
    tokens_out: response.usage?.candidatesTokenCount
  };
}
```

**Measurement for Prep:**
- All 4 sections present and populated?
- Items referenced actually exist in roadmap? (hallucination check)
- Strategic recommendations grounded in data?
- Agenda time allocations reasonable?
- Overall usefulness

### AI-as-Judge Evaluation

After collecting all outputs, run a **judge prompt** using `gemini-2.5-flash-preview-05-20` (or the most capable available model) to compare outputs:

```javascript
async function judgeComparison(testName, inputContext, outputA, outputB) {
  const judgeModel = 'gemini-2.5-flash-preview-05-20'; // Use best available as judge

  const prompt = `You are evaluating two AI model outputs for the same task.
Both models received identical inputs. Evaluate which produced better results.

TASK: ${testName}

INPUT CONTEXT (ground truth):
${inputContext}

MODEL A OUTPUT (gemini-2.0-flash):
${JSON.stringify(outputA, null, 2)}

MODEL B OUTPUT (gemini-3-flash-preview):
${JSON.stringify(outputB, null, 2)}

Score each model 1-5 on these dimensions:

For Classification tasks:
1. ACCURACY: Correct category and task_type selection (1=wrong, 5=perfect)
2. OWNER_DETECTION: Correct b3x vs client and person identification (1=wrong, 5=correct)
3. SPECIFICITY: Uses the most specific task_type, not generic fallbacks (1=vague, 5=precise)

For Roadmap tasks:
1. DETECTION: Correctly identifies which items were discussed (1=missed many, 5=comprehensive)
2. STATUS_ACCURACY: Status changes backed by transcript evidence (1=hallucinated, 5=evidence-based)
3. NEW_ITEMS: Quality of newly discovered items (1=missed/hallucinated, 5=real and well-classified)
4. EVIDENCE: Quality of transcript_evidence quotes (1=vague, 5=exact quotes)

For Prep tasks:
1. COMPLETENESS: All sections populated with relevant data (1=empty, 5=thorough)
2. GROUNDEDNESS: Every claim traceable to roadmap data (1=hallucinated, 5=data-backed)
3. STRATEGIC_VALUE: Recommendations are specific and actionable (1=generic, 5=insightful)
4. ACTIONABILITY: Could Phil walk into a meeting with this and lead? (1=no, 5=absolutely)

Return JSON:
{
  "model_a_scores": { "dimension1": N, "dimension2": N, ... },
  "model_b_scores": { "dimension1": N, "dimension2": N, ... },
  "model_a_avg": N.N,
  "model_b_avg": N.N,
  "winner": "model_a" | "model_b" | "tie",
  "reasoning": "Brief explanation of why one is better",
  "specific_differences": ["difference 1", "difference 2", ...]
}`;

  const response = await callGemini({ id: judgeModel }, prompt);
  return parseJSON(response.text);
}
```

### Report Output

Generate `data/model-comparison-report.md`:

```markdown
# Model Comparison Report: Gemini 2.0 Flash vs 3 Flash Preview
Date: {date}
Client: Prosper Group
Total API calls: 36 (32 classification + 2 roadmap + 2 prep)

## Summary Table

| Test | 2.0 Flash | 3 Flash Preview | Winner | Delta |
|------|-----------|-----------------|--------|-------|
| Classification (avg) | X.X/5 | X.X/5 | ... | +X.X |
| Roadmap | X.X/5 | X.X/5 | ... | +X.X |
| Meeting Prep | X.X/5 | X.X/5 | ... | +X.X |
| **Overall** | **X.X** | **X.X** | **...** | **+X.X** |

## Performance

| Metric | 2.0 Flash | 3 Flash Preview |
|--------|-----------|-----------------|
| Avg latency (classification) | Xms | Xms |
| Avg latency (roadmap) | Xms | Xms |
| Avg latency (prep) | Xms | Xms |
| Total tokens in | X | X |
| Total tokens out | X | X |

## Classification Comparison (16 items)

| # | Action Item | 2.0 Flash Category | 3 FP Category | 2.0 Flash Type | 3 FP Type | Agree? |
|---|-------------|--------------------|--------------|--------------------|-----------|--------|
| 1 | Check video usage | creative | creative | video-editing | video-editing | ✅ |
| 2 | Provide EverWebinar login | ... | ... | ... | ... | ❌ |
...

Agreement rate: X/16 (X%)

## Roadmap Comparison

### Items Discussed Detection
| Item | 2.0 Flash | 3 Flash Preview |
|------|-----------|-----------------|
| Check video usage | discussed ✅ | discussed ✅ |
| Provide EverWebinar login | not discussed | discussed ✅ |
...

### Status Changes Detected
| Model | Status Changes | New Items Found |
|-------|---------------|-----------------|
| 2.0 Flash | X | X |
| 3 Flash Preview | X | X |

### Evidence Quality
{judge assessment}

## Meeting Prep Comparison

### Section Completeness
| Section | 2.0 Flash Items | 3 Flash Preview Items |
|---------|-----------------|----------------------|
| Completed | X | X |
| In Progress | X | X |
| Needs Client Action | X | X |
| Stale Items | X | X |
| Strategic Recs | X | X |
| Agenda Items | X | X |

### Judge Assessment
{detailed reasoning}

## Recommendation
Based on the comparison:
- **For Classification:** Use {model} because...
- **For Roadmap Processing:** Use {model} because...
- **For Meeting Prep:** Use {model} because...
```

Also save raw data to `data/model-comparison-raw.json` for inspection.

## Prompt Construction

**IMPORTANT:** The comparison script must use the **exact same prompts** currently in the codebase. Do NOT modify the prompts — copy them exactly from:
- `src/lib/roadmap-processor.js` → `classifyActionItem` prompt
- `src/lib/roadmap-processor.js` → `processAgainstRoadmap` prompt
- `src/lib/prep-generator.js` → `generateMeetingPrep` prompt

The only difference between runs is the model ID passed to `getGenerativeModel()`.

## Rate Limiting

- 2 seconds between each API call (matching existing codebase pattern)
- 36 total calls → ~72 seconds minimum runtime
- Budget: ~$0.05-0.10 total (Flash models are cheap)

## Files to Create

1. `scripts/model-comparison.mjs` — Main comparison script (~400-500 lines)
2. `data/model-comparison-report.md` — Generated report
3. `data/model-comparison-raw.json` — Raw outputs for inspection

## Files to Modify

None — this is a read-only evaluation phase.

## Do NOT Touch

- `src/lib/roadmap-processor.js` — Do not change any prompts
- `src/lib/prep-generator.js` — Do not change any prompts
- `public/index.html` — No dashboard changes
- `src/api/` — No API changes

## Acceptance Criteria

- [ ] Script runs both models on identical inputs
- [ ] All 16 action items classified by both models
- [ ] Roadmap processing run on Meeting #41 by both models
- [ ] Meeting prep generated by both models
- [ ] AI judge evaluates all 3 test types
- [ ] Classification agreement rate calculated
- [ ] Latency and token usage captured for all calls
- [ ] Report saved to `data/model-comparison-report.md`
- [ ] Raw data saved to `data/model-comparison-raw.json`
- [ ] Report includes clear winner recommendation per task

## Smoke Tests

```bash
cd ~/awsc-new/awesome/zoom-action-items

# Run comparison
node scripts/model-comparison.mjs

# Check report
test -f data/model-comparison-report.md && echo "Report exists"
grep "Winner" data/model-comparison-report.md

# Check raw data
test -f data/model-comparison-raw.json && echo "Raw data exists"
node -e "const d = JSON.parse(require('fs').readFileSync('data/model-comparison-raw.json')); console.log('classification results:', d.classification?.length); console.log('roadmap results:', d.roadmap?.length); console.log('prep results:', d.prep?.length);"
```

## Completion Instructions

1. Build the comparison script
2. Run it (takes ~2-3 minutes with rate limiting)
3. Review the generated report
4. Commit with prefix: `[zoom-pipeline-12]`
5. Include the summary table from the report in the commit message
