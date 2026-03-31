/**
 * Phase 14 Architecture Review - Consult Gemini
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';

const architectureDoc = fs.readFileSync('/home/ubuntu/super-agent-shared/phase-14-architecture.md', 'utf-8');
const specDoc = fs.readFileSync('/home/ubuntu/super-agent-shared/phase-14-spec.md', 'utf-8');

const prompt = `You are a senior software architect reviewing a technical implementation spec. Provide a thorough, critical analysis.

## CONTEXT

This is Phase 14 of a Zoom meeting pipeline system. The feature being built is a "Meeting Cockpit" that helps Phil (a non-technical account manager) prepare for client calls. The system needs to reconcile two data sources:

1. **ProofHub tasks** — campaign-level tasks created manually (e.g., "March 20th Webinar")
2. **Roadmap items** — granular action items extracted from Zoom transcripts by AI (e.g., "Set up Facebook Ads for March 20th")

The relationship is one-to-many: one PH task can contain many roadmap items.

---

## ARCHITECTURE DOCUMENT

${architectureDoc}

---

## TECHNICAL IMPLEMENTATION SPEC

${specDoc}

---

## QUESTIONS TO ADDRESS

Please evaluate this architecture thoroughly:

### 1. Matching Strategy Soundness
Is the 4-layer matching strategy sound? Will it produce good matches given:
- PH tasks are campaign-level, roadmap items are action-level
- Keywords may be sparse or ambiguous
- Date windows could create false positives
- AI batch could hallucinate connections

What's your confidence that this will produce accurate parent-child links? What percentage of matches do you expect to be correct?

### 2. Database Schema & API Design Gaps
Review the three new tables (roadmap_ph_links, ph_task_cache, cockpit_selections) and the API endpoints. Are there any:
- Missing fields that will be needed later?
- Index gaps for common queries?
- Transaction safety concerns?
- Edge cases not handled (orphaned links, deleted items, etc.)?

### 3. Cockpit UI Practicality for Phil
Phil is a non-technical account manager scanning this before a client call. Evaluate:
- Is the information density appropriate?
- Will checkboxes + talking points + PH status overwhelm him?
- Is "Build My Agenda" the right UX for his workflow?
- What would you simplify or restructure?

### 4. Performance Concerns
Evaluate:
- Caching strategy: Is 1-hour PH cache staleness appropriate?
- API call volume: ProofHub has rate limits — is the sync strategy safe?
- Gemini call frequency: Layer 4 AI batch is one call per reconciliation. Is this efficient?
- Frontend responsiveness: Will the cockpit UI feel fast with all this data?

### 5. What Would You Change or Improve?
Given your expertise, what are the top 3-5 changes you would make to this architecture before implementation?

### 6. Edge Cases & Failure Modes Not Addressed
Identify scenarios the spec doesn't handle:
- What if ProofHub API is down?
- What if Gemini rate limits hit?
- What if a PH task is deleted after linking?
- What if Phil's selections conflict across devices?
- Other failure modes?

---

## OUTPUT FORMAT

Provide a structured review with clear sections for each question. Use markdown formatting. Be specific and constructive — this will be used to improve the spec before implementation.

At the end, provide an overall assessment: **READY TO IMPLEMENT**, **NEEDS REVISIONS**, or **REQUIRES RETHINK**, with a brief justification.
`;

async function main() {
  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  console.log('Sending to Gemini 2.0 Flash for review...');
  console.log('(This may take 30-60 seconds for a thorough review)');

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text();

    // Save to file
    const output = `# Phase 14 Architecture Review

**Reviewed by:** Gemini 2.0 Flash
**Date:** ${new Date().toISOString().split('T')[0]}

---

${text}
`;

    fs.writeFileSync('/home/ubuntu/super-agent-shared/phase-14-review.md', output);
    console.log('\n✅ Review saved to ~/super-agent-shared/phase-14-review.md');
    console.log('\n========== KEY FINDINGS ==========\n');

    // Extract key findings for the response
    console.log(text);

  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
