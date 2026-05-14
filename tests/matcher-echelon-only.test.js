// tests/matcher-echelon-only.test.js — v1 pilot guard: matcher refuses any
// client slug other than echelon / echelon-services. Throws on direct call;
// CLI exits non-zero (covered by spec wording, not executed here to avoid
// spawning subprocesses).
import { runMatcherWorker, ALLOWED_CLIENTS, CLIENT_SLUG_TO_DB_ID } from '../src/lib/ai-ph-matcher.js';

let fails = 0;
function ok(c, label) { if (c) console.log(`PASS: ${label}`); else { console.error(`FAIL: ${label}`); fails++; } }

// ALLOWED_CLIENTS surface — exactly the v1 pilot pair.
ok(ALLOWED_CLIENTS.has('echelon'), '1a ALLOWED_CLIENTS includes echelon');
ok(ALLOWED_CLIENTS.has('echelon-services'), '1b ALLOWED_CLIENTS includes echelon-services');
ok(!ALLOWED_CLIENTS.has('wagner-chiro'), '1c ALLOWED_CLIENTS does NOT include wagner-chiro');
ok(!ALLOWED_CLIENTS.has('bec-cfo'), '1d ALLOWED_CLIENTS does NOT include bec-cfo');

// Slug→DB id bridge (per spec: JSON uses 'echelon-services'; DB uses 'echelon').
ok(CLIENT_SLUG_TO_DB_ID.echelon === 'echelon', '2a echelon slug → echelon db id');
ok(CLIENT_SLUG_TO_DB_ID['echelon-services'] === 'echelon', '2b echelon-services slug → echelon db id');

// runMatcherWorker throws on unknown slug.
const fakeDb = { prepare: () => ({ all: () => [], run: () => {}, get: () => null }) };
let threw = false;
try {
  await runMatcherWorker({
    db: fakeDb, clientSlug: 'wagner-chiro', phTasks: [],
    embedAi: async () => [0], embedPh: async () => [0],
  });
} catch (e) {
  threw = /not enabled in v1/.test(e.message);
}
ok(threw, '3 throws on non-echelon slug with clear v1 error message');

// Also throws on bec-cfo.
let threw2 = false;
try {
  await runMatcherWorker({
    db: fakeDb, clientSlug: 'bec-cfo', phTasks: [],
    embedAi: async () => [0], embedPh: async () => [0],
  });
} catch (e) { threw2 = /not enabled in v1/.test(e.message); }
ok(threw2, '4 throws on bec-cfo slug');

// Accepts echelon and echelon-services (does not throw on entry).
let accepted = true;
try {
  await runMatcherWorker({
    db: fakeDb, clientSlug: 'echelon', phTasks: [],
    embedAi: async () => [0], embedPh: async () => [0],
  });
} catch (e) {
  accepted = false;
  console.error('UNEXPECTED throw on echelon:', e.message);
}
ok(accepted, '5 echelon slug accepted (no throw)');

if (fails === 0) console.log('\nMATCHER-ECHELON-ONLY: all checks passed.');
else { console.error(`\nMATCHER-ECHELON-ONLY: ${fails} failures.`); process.exit(1); }
