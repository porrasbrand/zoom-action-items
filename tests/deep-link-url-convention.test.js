// tests/deep-link-url-convention.test.js — dashboard URL deep-link spec tests.
//
// Spec: ~/awsc-new/awesome/cc-xprt-echelon/scratch/handoff/dashboard-url-convention.md
// Branch: feature/url-convention-deeplink (DO NOT merge to master / DO NOT restart pm2).
//
// These are static/contract tests against public/index.html. They verify:
//   - the DOM contract: id="ai-<id>" + data-action-item-id + parent data-meeting-id
//   - the JS deep-link handler exists + is wired into init()
//   - the CSS .action-item--focused animation exists
//   - graceful no-op behavior on malformed / unknown / missing inputs
//
// A separate manual smoke pass against the live page covers the dynamic
// scroll/highlight behavior (see the spec's acceptance-test section).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.resolve(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

let fails = 0;
function ok(c, label) { if (c) console.log(`PASS: ${label}`); else { console.error(`FAIL: ${label}`); fails++; } }

// ---- (a) URL with no focus= → current behavior unchanged ----
// Contract: handleDeepLink is a no-op when no `meeting` or `focus` params are
// present. The function early-returns on each branch.
{
  const m = html.match(/async function handleDeepLink\(\)[\s\S]+?\n    \}/);
  ok(!!m, 'a1 handleDeepLink function exists in index.html');
  ok(m && /params\.get\('meeting'\)/.test(m[0]), 'a2 reads meeting param');
  ok(m && /params\.get\('focus'\)/.test(m[0]), 'a3 reads focus param');
  // No focus → both `if (meetingParam ...)` and `if (focusParam ...)` branches
  // are guarded; no exception path. Confirm graceful degrade structure.
  ok(m && /catch \(e\)/.test(m[0]), 'a4 try/catch wraps body — failures never break page');
}

// ---- (b) URL with focus=ai:<id> where <id> exists → scroll + highlight ----
// Contract: handler matches `entity === 'ai'` + numeric id, then queries
// `[data-action-item-id="<id>"]`, calls scrollIntoView, and adds the
// focused class for 6s.
{
  const m = html.match(/async function handleDeepLink\(\)[\s\S]+?\n    \}/);
  ok(m && /entity !== 'ai'/.test(m[0]), 'b1 entity === ai branch (other entities no-op)');
  ok(m && /data-action-item-id="\$\{CSS\.escape\(id\)\}"/.test(m[0]),
     'b2 uses data-action-item-id selector with CSS.escape (resilient hook)');
  ok(m && /scrollIntoView\(\{ behavior: 'smooth', block: 'center' \}\)/.test(m[0]),
     'b3 scrollIntoView with smooth+center');
  ok(m && /classList\.add\('action-item--focused'\)/.test(m[0]),
     'b4 adds .action-item--focused class');
  ok(m && /setTimeout\([\s\S]{0,80}?6000\)/.test(m[0]),
     'b5 removes class after 6000ms (~6s pulse)');
}

// ---- (c) URL with meeting=<id> but no focus → expands meeting accordion ----
// In this SPA, "expand meeting accordion" = call loadMeetingDetail(id).
{
  const m = html.match(/async function handleDeepLink\(\)[\s\S]+?\n    \}/);
  ok(m && /loadMeetingDetail\(meetingId\)/.test(m[0]),
     'c1 meeting param triggers loadMeetingDetail()');
  ok(m && /\/\^\\d\+\$\/\.test\(meetingParam\)/.test(m[0]),
     'c2 meeting param validated as positive integer');
}

// ---- (d) Malformed focus= → graceful no-op, no JS error ----
// Cases per spec: focus=garbage, focus=ai:notanumber, focus=:1416.
{
  const m = html.match(/async function handleDeepLink\(\)[\s\S]+?\n    \}/);
  ok(m && /colonIdx < 1/.test(m[0]),
     'd1 focus=garbage (no colon) returns early — colonIdx < 1');
  ok(m && /!\/\^\\d\+\$\/\.test\(id\)/.test(m[0]),
     'd2 focus=ai:notanumber returns early — non-numeric id check');
  ok(m && /if \(!id\) return/.test(m[0]),
     'd3 focus=:1416 (empty entity) early-returns via colonIdx < 1 + empty-id guard');
}

// ---- (e) Unknown <id> (focus=ai:99999999) → graceful no-op, no error ----
{
  const m = html.match(/async function handleDeepLink\(\)[\s\S]+?\n    \}/);
  ok(m && /if \(!node\)/.test(m[0]),
     'e1 missing DOM node → early return (no error)');
  ok(m && /console\.debug.*focus target not in DOM/.test(m[0]),
     'e2 missing-target logs a debug message (not error, not toast)');
}

// ---- (f) Hash fragment #ai-<id> works WITHOUT JS (native browser anchor) ----
// Contract: the action-item DOM must have id="ai-<id>" so the browser's
// native fragment scroll resolves it. We grep the renderActionItem template
// for the literal `id="ai-${item.id}"` pattern.
{
  ok(/id="ai-\$\{item\.id\}"/.test(html),
     'f1 action-item DOM uses id="ai-<id>" — native fragment anchor works');
  ok(/data-action-item-id="\$\{item\.id\}"/.test(html),
     'f2 action-item DOM has data-action-item-id="<id>" — resilient JS hook');
}

// ---- Bonus: meeting-detail wrapper has data-meeting-id per spec ----
{
  ok(/<div class="meeting-detail" data-meeting-id="\$\{meeting\.id \|\| ''\}"/.test(html),
     'g1 meeting-detail wrapper has data-meeting-id (parent panel hook)');
}

// ---- Bonus: CSS animation exists ----
{
  ok(/\.action-item--focused\s*\{[\s\S]+?animation: ai-focus-pulse 6s/.test(html),
     'h1 .action-item--focused uses ai-focus-pulse 6s animation');
  ok(/@keyframes ai-focus-pulse\s*\{/.test(html),
     'h2 @keyframes ai-focus-pulse defined');
}

// ---- Bonus: init() wires handleDeepLink ----
{
  ok(/await handleDeepLink\(\);/.test(html),
     'i1 init() awaits handleDeepLink after page bootstrap');
}

if (fails === 0) console.log('\nDEEP-LINK-URL-CONVENTION: all checks passed.');
else { console.error(`\nDEEP-LINK-URL-CONVENTION: ${fails} failures.`); process.exit(1); }
