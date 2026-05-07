#!/usr/bin/env node
/**
 * One-shot: correct PH user 14533509859's first_name from 'Manual' to 'Manuel'.
 *
 * Committed for traceability. Re-running is idempotent (PUT will leave the
 * value at 'Manuel' regardless). After this lands, run pm2 restart
 * zoom-dashboard so the in-memory people cache rebuilds.
 *
 * Usage: node scripts/rename-manuel.mjs
 */

import 'dotenv/config';

const USER_ID = '14533509859';
const BASE = `https://${process.env.PROOFHUB_COMPANY_URL || 'breakthrough3x.proofhub.com'}/api/v3`;
const HEADERS = {
  'X-API-KEY': process.env.PROOFHUB_API_KEY,
  'Content-Type': 'application/json',
  'User-Agent': 'ZoomPipeline/1.0 (porrasbrand@gmail.com)',
};

if (!process.env.PROOFHUB_API_KEY) { console.error('Missing PROOFHUB_API_KEY'); process.exit(1); }

async function getPerson() {
  const r = await fetch(`${BASE}/people/${USER_ID}`, { headers: HEADERS });
  if (!r.ok) throw new Error(`GET people/${USER_ID} → HTTP ${r.status} ${await r.text()}`);
  return r.json();
}

async function renamePerson(firstName) {
  const r = await fetch(`${BASE}/people/${USER_ID}`, {
    method: 'PUT',
    headers: HEADERS,
    body: JSON.stringify({ first_name: firstName }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`PUT people/${USER_ID} → HTTP ${r.status} ${text}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

console.log('=== BEFORE ===');
const before = await getPerson();
console.log(JSON.stringify(before, null, 2));

console.log('\n=== Sending PUT first_name=Manuel ===');
const updated = await renamePerson('Manuel');
console.log(JSON.stringify(updated, null, 2));

console.log('\n=== AFTER (re-fetch) ===');
const after = await getPerson();
console.log(JSON.stringify(after, null, 2));

console.log('\nfirst_name went:', before.first_name, '→', after.first_name);
