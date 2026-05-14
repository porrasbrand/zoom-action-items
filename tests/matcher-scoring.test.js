// tests/matcher-scoring.test.js — unit tests for the matcher scoring +
// 3-outcome-band classifier per the spec. No DB / no embedding model — we
// construct vectors that produce known cosine values.
import {
  cosineSimilarity, extractTopicTags, intersectionSize,
  datesWithinDays, scorePair, classifyOutcome,
  AUTO_LINK_THRESHOLD, CANDIDATE_THRESHOLD, DATE_PROXIMITY_BOOST,
  _resetTagCache,
} from '../src/lib/ai-ph-matcher.js';

_resetTagCache();

let fails = 0;
function ok(c, label) { if (c) console.log(`PASS: ${label}`); else { console.error(`FAIL: ${label}`); fails++; } }
function approx(a, b, eps = 1e-6) { return Math.abs(a - b) < eps; }

// ---- cosineSimilarity ----
ok(approx(cosineSimilarity([1, 0], [1, 0]), 1), '1a cosine identical vectors = 1');
ok(approx(cosineSimilarity([1, 0], [0, 1]), 0), '1b cosine orthogonal = 0');
ok(approx(cosineSimilarity([1, 1], [1, 1]), 1), '1c cosine same direction = 1');
ok(cosineSimilarity([], [1]) === 0, '1d length mismatch returns 0');
ok(cosineSimilarity(null, [1, 2]) === 0, '1e null returns 0');

// ---- topic tags / overlap ----
const aiTags = extractTopicTags('Update Echelon LSA mailer for hiring HVAC technician.', 'echelon');
ok(aiTags.includes('lsa'), '2a extracts lsa tag');
ok(aiTags.includes('mailer'), '2b extracts mailer tag');
ok(aiTags.includes('hvac technician'), '2c extracts hvac technician tag');
const phTags = extractTopicTags('LSA hiring email — Andrew', 'echelon');
ok(intersectionSize(aiTags, phTags) >= 1, '2d AI vs PH share ≥1 tag (lsa)');
ok(intersectionSize(extractTopicTags('Replace coffee', 'echelon'), aiTags) === 0,
   '2e unrelated text shares 0 tags');

// ---- date proximity ----
ok(datesWithinDays('2026-05-01', '2026-05-10', 21), '3a within 21 days = true');
ok(!datesWithinDays('2026-01-01', '2026-05-01', 21), '3b > 21 days = false');
ok(!datesWithinDays(null, '2026-05-01', 21), '3c missing date = false');

// ---- scorePair + classifyOutcome (3 bands) ----
// Build identical-direction vectors → cosine 1.0; AI/PH texts share LSA tag.
const v1 = [1, 0, 0];
const ai1 = { title: 'Echelon LSA mailer update', description: '', meeting_start_time: '2026-05-01' };
const ph1 = { title: 'LSA hiring email', description: '', created_at: '2026-05-05' };
const s1 = scorePair(ai1, ph1, { ai: v1, ph: v1 }, { clientDbId: 'echelon' });
ok(approx(s1.sim, 1), '4a sim=1.0 for identical vectors');
ok(s1.overlap >= 1, '4b overlap ≥ 1 on shared lsa tag');
ok(s1.dateBoost === DATE_PROXIMITY_BOOST, '4c date boost applied (within 21d)');
ok(s1.score >= AUTO_LINK_THRESHOLD, '4d score above auto-link threshold');
ok(classifyOutcome(s1) === 'auto-link', '4e classified auto-link');

// Score above auto-link threshold but overlap=0 → candidate (not auto-link).
const ai2 = { title: 'Unrelated topic text', description: '', meeting_start_time: '2026-05-01' };
const ph2 = { title: 'Different unrelated work', description: '', created_at: '2026-05-05' };
const s2 = scorePair(ai2, ph2, { ai: v1, ph: v1 }, { clientDbId: 'echelon' });
ok(s2.overlap === 0, '5a overlap=0 when no shared tags');
ok(classifyOutcome(s2) === 'candidate', '5b high score + zero overlap → candidate');

// Mid-band score (cosine ~0.7, no overlap) → candidate.
const v3a = [1, 0, 0];
const v3b = [0.7, 0.7, 0]; // cosine ~ 0.7 / sqrt(0.98) ≈ 0.707
const ai3 = { title: 'topic X', description: '', meeting_start_time: '2026-01-01' };
const ph3 = { title: 'topic Y', description: '', created_at: '2026-05-01' };
const s3 = scorePair(ai3, ph3, { ai: v3a, ph: v3b }, { clientDbId: 'echelon' });
ok(s3.score >= CANDIDATE_THRESHOLD && s3.score < AUTO_LINK_THRESHOLD,
   `6a mid-band score (got ${s3.score.toFixed(3)})`);
ok(classifyOutcome(s3) === 'candidate', '6b mid-band → candidate');

// Below 0.60 → no-match.
const v4 = [0.1, 0.99, 0];
const s4 = scorePair(
  { title: '', description: '', meeting_start_time: null },
  { title: '', description: '', created_at: null },
  { ai: [1, 0, 0], ph: v4 },
  { clientDbId: 'echelon' },
);
ok(s4.score < CANDIDATE_THRESHOLD, `7a below candidate threshold (got ${s4.score.toFixed(3)})`);
ok(classifyOutcome(s4) === 'no-match', '7b → no-match');

if (fails === 0) console.log('\nMATCHER-SCORING: all checks passed.');
else { console.error(`\nMATCHER-SCORING: ${fails} failures.`); process.exit(1); }
