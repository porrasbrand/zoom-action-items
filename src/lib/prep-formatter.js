/**
 * Prep Formatter
 * Converts AI-generated prep JSON to Markdown and other formats.
 */

/**
 * Format prep as Markdown for Slack/terminal output.
 *
 * @param {Object} prep - Prep JSON from generateMeetingPrep()
 * @returns {string} Markdown formatted document
 */
export function formatAsMarkdown(prep) {
  const { meta, status_report, accountability, strategic_direction, suggested_agenda, estimated_meeting_length_minutes } = prep;

  const lines = [];

  // Header
  lines.push('═══════════════════════════════════════════════════════');
  lines.push(`MEETING PREP: ${meta.client_name}`);
  lines.push(`Date: ${new Date().toISOString().split('T')[0]}`);
  lines.push(`Prepared for: ${meta.b3x_lead || 'B3X Team'}`);
  lines.push(`Last meeting: ${meta.last_meeting ? formatDate(meta.last_meeting) : 'N/A'} (${meta.days_since_last_meeting || '?'} days ago)`);
  lines.push(`Meetings analyzed: ${meta.meetings_analyzed}`);
  lines.push('═══════════════════════════════════════════════════════');
  lines.push('');

  // Section 1: Status Report
  lines.push('━━━ SECTION 1: STATUS REPORT (What to tell the client) ━━━');
  lines.push('');

  lines.push('COMPLETED SINCE LAST MEETING:');
  if (status_report.completed?.length > 0) {
    for (const item of status_report.completed) {
      lines.push(`  ✅ ${item.title} — ${item.date} [${item.category}]`);
    }
  } else {
    lines.push('  (none)');
  }
  lines.push('');

  lines.push('IN PROGRESS:');
  if (status_report.in_progress?.length > 0) {
    for (const item of status_report.in_progress) {
      const eta = item.eta ? `, ETA ${item.eta}` : '';
      lines.push(`  🔄 ${item.title} — ${item.owner || 'unassigned'}${eta} [${item.category}]`);
    }
  } else {
    lines.push('  (none)');
  }
  lines.push('');

  lines.push('NEEDS CLIENT ACTION:');
  if (status_report.needs_client_action?.length > 0) {
    for (const item of status_report.needs_client_action) {
      lines.push(`  ⚠️ ${item.title} — ${item.reason} (since ${item.since})`);
    }
  } else {
    lines.push('  (none)');
  }
  lines.push('');

  // Section 2: Accountability Check
  lines.push('━━━ SECTION 2: ACCOUNTABILITY CHECK ━━━');
  lines.push('');

  lines.push('STALE ITEMS (not discussed in 2+ meetings):');
  if (accountability.stale_items?.length > 0) {
    for (const item of accountability.stale_items) {
      lines.push(`  🔴 ${item.title} — agreed ${item.agreed_date}, silent for ${item.silent_meetings} meetings`);
    }
  } else {
    lines.push('  ✅ No stale items');
  }
  lines.push('');

  lines.push('B3X OVERDUE:');
  if (accountability.b3x_overdue?.length > 0) {
    for (const item of accountability.b3x_overdue) {
      lines.push(`  ❌ ${item.title} — assigned to ${item.owner}, since ${item.since}`);
    }
  } else {
    lines.push('  ✅ Nothing overdue');
  }
  lines.push('');

  lines.push('CLIENT OVERDUE:');
  if (accountability.client_overdue?.length > 0) {
    for (const item of accountability.client_overdue) {
      lines.push(`  ❌ ${item.title} — client should ${item.action_needed}, asked ${item.since}`);
    }
  } else {
    lines.push('  ✅ Nothing overdue');
  }
  lines.push('');

  // Section 3: Strategic Direction
  lines.push('━━━ SECTION 3: STRATEGIC DIRECTION (Where we\'re heading) ━━━');
  lines.push('');
  lines.push('RECOMMENDED NEXT STEPS:');
  lines.push('');

  if (strategic_direction?.length > 0) {
    for (let i = 0; i < strategic_direction.length; i++) {
      const rec = strategic_direction[i];
      lines.push(`  ${i + 1}. [${rec.priority}] ${rec.title}`);
      lines.push(`     Why: ${rec.reasoning}`);
      lines.push(`     Category: ${rec.category}/${rec.task_type || 'general'}`);
      lines.push('');
    }
  } else {
    lines.push('  (No recommendations generated)');
    lines.push('');
  }

  // Section 4: Suggested Agenda
  lines.push('━━━ SECTION 4: SUGGESTED AGENDA ━━━');
  lines.push('');

  if (suggested_agenda?.length > 0) {
    for (let i = 0; i < suggested_agenda.length; i++) {
      const item = suggested_agenda[i];
      lines.push(`  ${i + 1}. ${item.topic} (${item.minutes} min)`);
      if (item.notes) {
        lines.push(`     → ${item.notes}`);
      }
    }
    lines.push('');
    lines.push(`Estimated meeting length: ${estimated_meeting_length_minutes || sumMinutes(suggested_agenda)} minutes`);
  } else {
    lines.push('  (No agenda generated)');
  }
  lines.push('');

  // Section 5: Projected Roadmap
  lines.push('━━━ SECTION 5: PROJECTED ROADMAP (What to propose next) ━━━');
  lines.push('');

  const projected = prep.projected_roadmap || [];
  if (projected.length > 0) {
    for (let i = 0; i < projected.length; i++) {
      const p = projected[i];
      lines.push(`  ${i + 1}. [${p.priority}] ${p.title}`);
      lines.push(`     Why now: ${p.why_now}`);
      lines.push(`     B3X effort: ${p.effort_b3x}`);
      lines.push(`     Client needs: ${p.effort_client}`);
      lines.push(`     Prerequisites: ${p.prerequisites}`);
      lines.push(`     Impact: ${p.impact}`);
      lines.push(`     Category: ${p.category}/${p.task_type || 'general'}`);
      lines.push('');
    }
  } else {
    lines.push('  (No projected items generated)');
    lines.push('');
  }

  // Footer
  lines.push('═══════════════════════════════════════════════════════');
  lines.push(`Generated: ${new Date().toISOString()}`);
  if (meta.fallback) {
    lines.push('⚠️ Note: AI generation failed, using fallback data');
  }

  return lines.join('\n');
}

/**
 * Format prep as Slack blocks (mrkdwn).
 *
 * @param {Object} prep
 * @returns {string} Slack-compatible markdown
 */
export function formatForSlack(prep) {
  // Slack uses a subset of markdown - adjust formatting
  let md = formatAsMarkdown(prep);

  // Slack prefers *bold* over **bold**
  md = md.replace(/\*\*/g, '*');

  // Ensure lines aren't too long for Slack
  const lines = md.split('\n');
  const formatted = lines.map(line => {
    if (line.length > 150) {
      return line.substring(0, 147) + '...';
    }
    return line;
  });

  return formatted.join('\n');
}

/**
 * Format date string for display
 */
function formatDate(dateStr) {
  if (!dateStr) return 'N/A';
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

/**
 * Sum minutes from agenda items
 */
function sumMinutes(agenda) {
  if (!agenda?.length) return 30;
  return agenda.reduce((sum, item) => sum + (item.minutes || 0), 0);
}

/**
 * Format prep as pre-huddle brief (short cheat sheet).
 *
 * @param {Object} prep - Prep JSON from generateMeetingPrep()
 * @returns {string} Pre-huddle brief text
 */
export function formatBrief(prep) {
  const meta = prep.meta || {};
  const sr = prep.status_report || {};
  const acc = prep.accountability || {};
  const proj = prep.projected_roadmap || [];
  const agenda = prep.suggested_agenda || [];

  const lines = [];

  // Header
  lines.push(`${meta.client_name || 'Client'} — Pre-Huddle Brief`);
  lines.push(`Date: ${new Date().toISOString().split('T')[0]}`);
  lines.push(`Days since last meeting: ${meta.days_since_last_meeting || '?'}`);
  lines.push('');

  // Wins
  const wins = sr.completed || [];
  lines.push(`WINS TO REPORT: ${wins.length}`);
  wins.forEach(w => lines.push(`  + ${w.title}`));
  lines.push('');

  // Blockers
  const blockers = [...(sr.needs_client_action || [])];
  lines.push(`BLOCKERS TO RAISE: ${blockers.length}`);
  blockers.forEach(b => lines.push(`  ! ${b.title} (${b.reason})`));
  lines.push('');

  // Stale
  const stale = acc.stale_items || [];
  lines.push(`STALE — MUST ADDRESS: ${stale.length}`);
  stale.forEach(s => lines.push(`  !! ${s.title} (silent ${s.silent_meetings} meetings)`));
  lines.push('');

  // B3X Overdue
  const b3xOverdue = acc.b3x_overdue || [];
  if (b3xOverdue.length > 0) {
    lines.push(`B3X OVERDUE: ${b3xOverdue.length}`);
    b3xOverdue.forEach(o => lines.push(`  > ${o.title} — ${o.owner}`));
    lines.push('');
  }

  // Projected proposals (top 3)
  const topProposals = proj.slice(0, 3);
  if (topProposals.length > 0) {
    lines.push(`PHIL'S PITCH:`);
    topProposals.forEach(p => lines.push(`  >> [${p.priority}] ${p.title}`));
    lines.push('');
  }

  // One-liner agenda summary
  if (agenda.length > 0) {
    const totalMin = prep.estimated_meeting_length_minutes || agenda.reduce((s, a) => s + (a.minutes || 0), 0);
    lines.push(`AGENDA: ${agenda.length} items, ${totalMin} min`);
    agenda.forEach(a => lines.push(`  ${a.minutes}m — ${a.topic}`));
  }

  return lines.join('\n');
}

export default {
  formatAsMarkdown,
  formatForSlack,
  formatBrief
};
