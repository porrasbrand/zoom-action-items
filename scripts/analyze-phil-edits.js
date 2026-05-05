#!/usr/bin/env node
/**
 * One-shot analysis: classify Phil's last N post-push edits as structural vs tonal.
 *
 * Read-only — does NOT modify production data.
 * Usage: node scripts/analyze-phil-edits.js [--limit 30]
 *
 * Outputs:
 *   ~/super-agent-shared/phil-edits-analysis.json   (raw structured data)
 *   ~/super-agent-shared/phil-edits-analysis.md     (human-readable report)
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import * as proofhub from '../src/lib/proofhub-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'zoom-action-items.db');
const OUT_DIR = join(process.env.HOME || '/home/ubuntu', 'super-agent-shared');
const OUT_JSON = join(OUT_DIR, 'phil-edits-analysis.json');
const OUT_MD   = join(OUT_DIR, 'phil-edits-analysis.md');

// ─── CLI args ───
const argv = process.argv.slice(2);
let limit = 30;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--limit' && argv[i + 1]) limit = parseInt(argv[++i], 10) || 30;
}

// ─── Levenshtein (small standalone implementation, no new deps) ───
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b ? b.length : 0;
  if (!b) return a.length;
  const al = a.length, bl = b.length;
  if (Math.abs(al - bl) > Math.max(al, bl) * 0.8) return Math.max(al, bl); // fast bail
  let v0 = new Array(bl + 1);
  let v1 = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) v0[j] = j;
  for (let i = 0; i < al; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < bl; j++) {
      const cost = a.charCodeAt(i) === b.charCodeAt(j) ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    [v0, v1] = [v1, v0];
  }
  return v0[bl];
}

// ─── Sleep helper for rate-limit backoff ───
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Strip HTML for description comparisons (PH stores rich-text HTML, sometimes HTML-entity-encoded) ───
function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}
function stripHtml(s) {
  if (!s) return '';
  // PH returns descriptions with HTML entities encoded (&lt; etc.) — decode first.
  let t = decodeEntities(String(s));
  // Decode TWICE in case it was double-encoded (we've seen this in PH responses).
  if (t.includes('&lt;') || t.includes('&amp;')) t = decodeEntities(t);
  return t
    .replace(/<phmention[^>]*>([^<]*)<\/phmention>/gi, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── URL extraction for resource-added detection ───
const URL_RE = /https?:\/\/[^\s<>"]+/gi;
function extractUrls(s) {
  if (!s) return [];
  return Array.from(String(s).matchAll(URL_RE)).map(m => m[0]);
}
function hostnameOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; }
}

// ─── Classifiers ───
function classifyTitleEdit(oldT, newT) {
  if (!oldT || !newT) return 'structural';
  const lo = oldT.length, ln = newT.length;
  const ratio = lo > 0 ? Math.abs(lo - ln) / Math.max(lo, ln) : 1;
  const dist = levenshtein(oldT.toLowerCase(), newT.toLowerCase());
  const distRatio = dist / Math.max(lo, ln, 1);
  if (ratio < 0.3 && distRatio < 0.3) return 'tonal';
  return 'structural';
}

function classifyDescriptionEdit(oldD, newD, assigneeName) {
  const oldClean = stripHtml(oldD);
  const newClean = stripHtml(newD);
  if (!oldClean && newClean) return { class: 'structural', reason: 'missing-desc-filled' };
  if (oldClean && !newClean) return { class: 'structural', reason: 'description-deleted' };
  const oldUrls = new Set(extractUrls(oldClean));
  const newUrls = extractUrls(newClean);
  const addedUrls = newUrls.filter(u => !oldUrls.has(u));
  // Direct-address opening: Phil's signature voice patterns.
  // Expanded heuristic (Phase 4D rerun): catches 'Hey <Name>', 'Happy <Weekday>',
  // 'Just posting this', 'For this proof of task' phrasings.
  let opened = false;
  let openerReason = 'style-rewrite-direct-address';
  const head = newClean.slice(0, 200);
  const headLower = head.toLowerCase();
  // (a/b) "<First> - " — assignee-tight match first
  if (assigneeName) {
    const first = assigneeName.split(/\s+/)[0] || '';
    if (first) {
      const opener = new RegExp('^\\s*' + first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s+[A-Z][a-z]+)?\\s*[-–—]', 'i');
      if (opener.test(newClean)) opened = true;
    }
  }
  // (a/b) generic '<First> [Last] - ' opener
  if (!opened && /^\s*[A-Z][a-z]{2,}(\s+[A-Z][a-z]+)?\s*[-–—]/.test(newClean)) opened = true;
  // (c) 'Hey <FirstName>' / 'Hey <FirstName>,' / 'Hey <FirstName> -' (case-insensitive)
  if (!opened && /^\s*hey\s+[A-Za-z][A-Za-z'-]{1,}\b/i.test(head)) {
    opened = true;
    openerReason = 'style-rewrite-hey-greeting';
  }
  // (d) 'Happy <Weekday>' anywhere in first 100 chars
  if (!opened && /\bhappy\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(head.slice(0, 100))) {
    opened = true;
    openerReason = 'style-rewrite-happy-weekday';
  }
  // (e) Phil-template phrasings: 'Just posting this' / 'For this proof of task'
  if (!opened && /\b(just\s+posting\s+this|for\s+this\s+proof\s+of\s+task)\b/i.test(headLower)) {
    opened = true;
    openerReason = 'style-rewrite-phil-phrasing';
  }
  if (opened) {
    const out = { class: 'tonal', reason: openerReason };
    if (addedUrls.length > 0) { out.addedUrls = addedUrls; out.reason = openerReason + '+resource-added'; }
    return out;
  }
  if (addedUrls.length > 0) return { class: 'structural', reason: 'resource-added', addedUrls };
  return { class: 'unknown', reason: 'no-rule-matched' };
}

// ─── Main ───
async function main() {
  console.log(`[analyze] DB: ${DB_PATH}`);
  console.log(`[analyze] limit: ${limit}`);
  const db = new Database(DB_PATH, { readonly: true });

  const items = db.prepare(`
    SELECT a.id, a.title, a.description, a.owner_name,
           a.ph_task_id, a.ph_project_id, a.ph_task_list_id, a.ph_assignee_id,
           a.pushed_at, m.id as meeting_id, m.topic as meeting_topic
    FROM action_items a
    LEFT JOIN meetings m ON a.meeting_id = m.id
    WHERE a.ph_task_id IS NOT NULL
    ORDER BY a.pushed_at DESC
    LIMIT ?
  `).all(limit);

  console.log(`[analyze] fetched ${items.length} pushed items`);

  // Cache PH people once
  let people = [];
  try {
    people = await proofhub.getPeople();
    console.log(`[analyze] cached ${people.length} PH people`);
  } catch (e) {
    console.warn('[analyze] getPeople failed:', e.message);
  }
  const peopleById = new Map(people.map(p => [String(p.id), p]));

  const stats = {
    items_checked: 0,
    any_edit: 0,
    title_changed: { total: 0, structural: 0, tonal: 0 },
    description_changed: { total: 0, structural: 0, tonal: 0, unknown: 0 },
    assignee_changed: 0,
    url_added: 0,
    thanks_closer: 0,
    separator_used: 0,
    deleted_in_ph: 0,
    fetch_errors: 0,
  };
  const phraseOpenerCounts = new Map();
  const resourceDomainCounts = new Map();
  const resultItems = [];

  let progress = 0;
  for (const it of items) {
    progress++;
    let phTask = null;
    try {
      phTask = await proofhub.getTask(it.ph_project_id, it.ph_task_list_id, it.ph_task_id);
    } catch (err) {
      const msg = String(err.message || err);
      if (msg.includes('404')) {
        stats.deleted_in_ph++;
        console.log(`[${progress}/${items.length}] ${it.id} → deleted in PH`);
        resultItems.push({
          action_item_id: it.id,
          meeting_topic: it.meeting_topic,
          pushed_at: it.pushed_at,
          ph_task_id: it.ph_task_id,
          deleted_in_ph: true,
          diffs: [],
        });
        continue;
      }
      stats.fetch_errors++;
      console.warn(`[${progress}/${items.length}] fetch error for action_item ${it.id}:`, msg);
      // Backoff for rate-limit-like errors
      if (msg.toLowerCase().includes('rate') || msg.includes('429')) await sleep(2000);
      continue;
    }
    stats.items_checked++;

    const dbTitle = it.title || '';
    const dbDesc  = it.description || '';
    const phTitle = phTask.title || '';
    const phDesc  = phTask.description || '';
    // PH getTask returns assignees in the `assigned` field — array of numeric ids.
    const phAssignees = Array.isArray(phTask.assigned)
      ? phTask.assigned.map(a => String(a))
      : (Array.isArray(phTask.assignees) ? phTask.assignees.map(a => String(a.id || a)) : []);
    const dbAssignee = it.ph_assignee_id ? String(it.ph_assignee_id) : null;
    // Treat assignee as "changed" if the original is no longer in the current set,
    // OR a different person is now first/primary.
    const dbAssigneeStillThere = dbAssignee ? phAssignees.includes(dbAssignee) : false;
    const phAssignee = phAssignees[0] || null;
    const phAssigneeName = phAssignee ? (peopleById.get(phAssignee) ? `${peopleById.get(phAssignee).first_name || ''} ${peopleById.get(phAssignee).last_name || ''}`.trim() : null) : null;

    const diffs = [];
    let any = false;

    if (dbTitle !== phTitle) {
      any = true;
      const cls = classifyTitleEdit(dbTitle, phTitle);
      stats.title_changed.total++;
      stats.title_changed[cls]++;
      diffs.push({ field: 'title', old: dbTitle, new: phTitle, classification: cls });
    }

    const dbDescClean = stripHtml(dbDesc);
    const phDescClean = stripHtml(phDesc);
    if (dbDescClean !== phDescClean) {
      any = true;
      const cls = classifyDescriptionEdit(dbDesc, phDesc, phAssigneeName || it.owner_name);
      stats.description_changed.total++;
      stats.description_changed[cls.class]++;
      if (cls.addedUrls && cls.addedUrls.length) {
        stats.url_added += cls.addedUrls.length;
        for (const u of cls.addedUrls) {
          const h = hostnameOf(u);
          if (h) resourceDomainCounts.set(h, (resourceDomainCounts.get(h) || 0) + 1);
        }
      }
      // Phil's voice fingerprint
      if (/thanks\.\.\.|thanks…|thanks\.\s/i.test(phDescClean)) stats.thanks_closer++;
      if (/\*{3,}/.test(phDesc)) stats.separator_used++;
      // Track common phrase-openers (first 60 chars of stripped desc)
      const opener = phDescClean.slice(0, 60).split(/[.\n]/)[0].trim();
      if (opener) phraseOpenerCounts.set(opener, (phraseOpenerCounts.get(opener) || 0) + 1);
      diffs.push({
        field: 'description',
        old: dbDesc || null,
        new: phDesc,
        classification: cls.class,
        reason: cls.reason,
        added_urls: cls.addedUrls || [],
      });
    }

    // Assignee changed = original DB assignee no longer in PH's current `assigned` array,
    // OR PH has assignees that DB didn't track.
    if (dbAssignee && phAssignees.length > 0 && !dbAssigneeStillThere) {
      any = true;
      stats.assignee_changed++;
      diffs.push({
        field: 'assignee',
        old: dbAssignee,
        old_name: peopleById.get(dbAssignee) ? `${peopleById.get(dbAssignee).first_name || ''} ${peopleById.get(dbAssignee).last_name || ''}`.trim() : null,
        new: phAssignees.join(','),
        new_name: phAssignees.map(id => {
          const p = peopleById.get(id);
          return p ? `${p.first_name || ''} ${p.last_name || ''}`.trim() : id;
        }).join(', '),
        classification: 'structural',
        reason: 'assignee-correction',
      });
    } else if (dbAssignee && phAssignees.length > 1 && dbAssigneeStillThere) {
      // Multiple assignees including original — Phil ADDED someone, didn't replace.
      any = true;
      stats.assignee_changed++;
      diffs.push({
        field: 'assignee',
        old: dbAssignee,
        old_name: peopleById.get(dbAssignee) ? `${peopleById.get(dbAssignee).first_name || ''} ${peopleById.get(dbAssignee).last_name || ''}`.trim() : null,
        new: phAssignees.join(','),
        new_name: phAssignees.map(id => {
          const p = peopleById.get(id);
          return p ? `${p.first_name || ''} ${p.last_name || ''}`.trim() : id;
        }).join(', '),
        classification: 'structural',
        reason: 'assignee-added',
      });
    }

    if (any) stats.any_edit++;
    const phUrl = `https://${process.env.PROOFHUB_COMPANY_URL || 'breakthrough3x.proofhub.com'}/#tasks/${it.ph_task_id}/project-${it.ph_project_id}`;
    resultItems.push({
      action_item_id: it.id,
      meeting_topic: it.meeting_topic,
      pushed_at: it.pushed_at,
      ph_task_url: phUrl,
      original_owner: it.owner_name,
      diffs,
    });
    console.log(`[${progress}/${items.length}] ${it.id} → ${diffs.length} edit${diffs.length === 1 ? '' : 's'}`);
    await sleep(150); // gentle throttle
  }

  // ─── Patterns ───
  const top_phil_openers = [...phraseOpenerCounts.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([phrase, count]) => ({ phrase, count }));
  const top_resource_domains = [...resourceDomainCounts.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([domain, count]) => ({ domain, count }));

  const out = {
    generated_at: new Date().toISOString(),
    items_requested: limit,
    items_checked: stats.items_checked,
    items_deleted_in_ph: stats.deleted_in_ph,
    items_fetch_errors: stats.fetch_errors,
    stats,
    patterns: { top_phil_openers, top_resource_domains },
    items: resultItems,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  console.log(`[analyze] wrote ${OUT_JSON} (${stats.items_checked} items)`);

  // ─── Markdown report ───
  const total = stats.items_checked || 1;
  const titlePct = (n) => `${n}/${total} (${Math.round(n/total*100)}%)`;
  const totalEdits = stats.title_changed.total + stats.description_changed.total + stats.assignee_changed;
  const structuralEdits = stats.title_changed.structural + stats.description_changed.structural + stats.assignee_changed;
  const tonalEdits = stats.title_changed.tonal + stats.description_changed.tonal;
  const unknownEdits = stats.description_changed.unknown;
  const pctStructural = totalEdits > 0 ? Math.round(structuralEdits/totalEdits*100) : 0;
  const pctTonal = totalEdits > 0 ? Math.round(tonalEdits/totalEdits*100) : 0;
  let recommendation;
  if (pctStructural >= pctTonal + 15) recommendation = 'structural';
  else if (pctTonal >= pctStructural + 15) recommendation = 'voice';
  else recommendation = 'both';

  const md = `# Phil Edit Analysis — Last ${stats.items_checked} Pushes

**Generated:** ${out.generated_at}
**Items analyzed:** ${stats.items_checked}${stats.deleted_in_ph ? ` (${stats.deleted_in_ph} deleted in PH, excluded)` : ''}${stats.fetch_errors ? ` (${stats.fetch_errors} fetch errors, excluded)` : ''}
**Items with at least one edit:** ${stats.any_edit} (${Math.round(stats.any_edit/total*100)}%)

## Verdict (one line)
> ${pctStructural}% of edits are structural-correctness; ${pctTonal}% are tonal/voice; ${unknownEdits ? unknownEdits + ' unknown. ' : ''}→ recommend prioritizing **${recommendation}**.

## Per-field breakdown

| Field        | Changed                | Structural | Tonal | Unknown |
|--------------|-----------------------:|-----------:|------:|--------:|
| Title        | ${titlePct(stats.title_changed.total)}        | ${stats.title_changed.structural} | ${stats.title_changed.tonal} | — |
| Description  | ${titlePct(stats.description_changed.total)}  | ${stats.description_changed.structural} | ${stats.description_changed.tonal} | ${stats.description_changed.unknown} |
| Assignee     | ${titlePct(stats.assignee_changed)}             | ${stats.assignee_changed} | — | — |

## Phil's voice fingerprint
- "Thanks..." closer: ${stats.thanks_closer}/${total} (${Math.round(stats.thanks_closer/total*100)}%)
- "****" separator: ${stats.separator_used}/${total} (${Math.round(stats.separator_used/total*100)}%)
- URLs added (resources): ${stats.url_added}
- Top resource domains: ${top_resource_domains.map(d => `${d.domain} (${d.count})`).join(', ') || '—'}
- Top phrase-openers (after rewrite):
${top_phil_openers.map((p, i) => `  ${i+1}. \`${p.phrase}\` — ${p.count}`).join('\n') || '  (none)'}

## Top 5 example diffs
${pickIllustrativeDiffs(resultItems, 5).map((d, i) => formatDiffMd(i+1, d)).join('\n\n')}

## Recommendations (data-driven)
- Confidence gate worth implementing? **${stats.assignee_changed >= Math.max(2, total*0.1) ? 'YES' : 'NO'}** (assignee-correction rate ${stats.assignee_changed}/${total} = ${Math.round(stats.assignee_changed/total*100)}%${stats.assignee_changed >= Math.max(2, total*0.1) ? ' — above 10% threshold' : ' — below 10% threshold'})
- Voice template worth implementing? **${tonalEdits >= Math.max(3, total*0.3) ? 'YES' : 'NO'}** (tonal rewrites ${tonalEdits}/${total} = ${Math.round(tonalEdits/total*100)}%${tonalEdits >= Math.max(3, total*0.3) ? ' — significant pattern' : ' — below 30% threshold'})
- Highest-leverage single fix: ${highestLeverageFix(stats)}
`;
  writeFileSync(OUT_MD, md);
  console.log(`[analyze] wrote ${OUT_MD}`);
  console.log(`\n=== VERDICT ===\n${pctStructural}% structural, ${pctTonal}% tonal → ${recommendation}`);

  db.close();
}

function pickIllustrativeDiffs(items, n) {
  // Prefer items with multiple diffs, else any item with at least one diff. Truncate to n.
  return items
    .filter(it => it.diffs && it.diffs.length > 0)
    .sort((a, b) => b.diffs.length - a.diffs.length)
    .slice(0, n);
}

function formatDiffMd(i, item) {
  const header = `### ${i}. action_item ${item.action_item_id} — ${item.meeting_topic || '(no meeting)'}`;
  const lines = [header, `[PH task](${item.ph_task_url})`];
  for (const d of item.diffs) {
    if (d.field === 'title') {
      lines.push(`- **title** [${d.classification}]\n  - old: \`${(d.old || '').slice(0, 80)}\`\n  - new: \`${(d.new || '').slice(0, 80)}\``);
    } else if (d.field === 'description') {
      const oldS = (stripHtmlInline(d.old) || '(empty)').slice(0, 100);
      const newS = (stripHtmlInline(d.new) || '(empty)').slice(0, 100);
      lines.push(`- **description** [${d.classification}: ${d.reason || ''}]\n  - old: \`${oldS}\`\n  - new: \`${newS}\``);
    } else if (d.field === 'assignee') {
      lines.push(`- **assignee** [${d.classification}: ${d.reason}]\n  - old: ${d.old_name || d.old}\n  - new: ${d.new_name || d.new}`);
    }
  }
  return lines.join('\n');
}

function stripHtmlInline(s) {
  if (!s) return '';
  let t = decodeEntities(String(s));
  if (t.includes('&lt;') || t.includes('&amp;')) t = decodeEntities(t);
  return t
    .replace(/<phmention[^>]*>([^<]*)<\/phmention>/gi, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function highestLeverageFix(stats) {
  const candidates = [
    { name: '@-mention auto-comment fix (real PH mentions)', score: stats.description_changed.unknown + Math.floor(stats.thanks_closer / 2) },
    { name: 'assignee confidence gate', score: stats.assignee_changed * 3 },
    { name: 'description voice template (Phil-style direct address)', score: stats.description_changed.tonal },
    { name: 'required-field UI for description on push', score: stats.description_changed.structural },
  ];
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].name;
}

main().then(() => process.exit(0)).catch(e => {
  console.error('FATAL', e.stack || e.message);
  process.exit(2);
});
