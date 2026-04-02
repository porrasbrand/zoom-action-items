import { autoPushMeeting } from '../src/lib/auto-push.js';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, '../data/zoom-action-items.db'));
const pilotClients = ['prosper-group', 'pearce-hvac', 'echelon', 'gs-home-services', 'london-flooring'];

console.log('=== DRY RUN PILOT TEST ===\n');

const results = [];

for (const clientId of pilotClients) {
  // Get most recent meeting for this client
  const meeting = db.prepare('SELECT id, topic, start_time FROM meetings WHERE client_id = ? ORDER BY start_time DESC LIMIT 1').get(clientId);

  if (!meeting) {
    console.log(`${clientId}: NO MEETINGS FOUND\n`);
    results.push({ clientId, found: false });
    continue;
  }

  const result = await autoPushMeeting(db, meeting.id, { dryRun: true });

  console.log(`${clientId}:`);
  console.log(`  Meeting: ${meeting.topic.substring(0,50)} (${meeting.start_time.substring(0,10)})`);

  if (!result.summary) {
    console.log(`  ERROR: No summary - alerts: ${JSON.stringify(result.alerts)}`);
    results.push({ clientId, found: true, meetingId: meeting.id, error: true, alerts: result.alerts });
    console.log('');
    continue;
  }

  console.log(`  Total items: ${result.summary.total_items}`);
  console.log(`  AUTO_PUSH: ${result.summary.pushed}`);
  console.log(`  DRAFT: ${result.summary.drafted}`);
  console.log(`  SKIPPED: ${result.summary.skipped}`);
  console.log(`  CLIENT_REMINDERS: ${result.summary.client_reminders}`);

  if (result.pushed.length > 0) {
    console.log(`  Would push:`);
    result.pushed.forEach(p => console.log(`    - ${p.title.substring(0,50)}... (${p.owner_name}, deadline: ${p.deadline})`));
  }

  if (result.alerts?.length > 0) {
    console.log(`  ALERTS: ${result.alerts.map(a => a.message || a.type).join(', ')}`);
  }
  console.log('');

  results.push({
    clientId,
    found: true,
    meetingId: meeting.id,
    total: result.summary.total_items,
    autoPush: result.summary.pushed,
    draft: result.summary.drafted,
    skipped: result.summary.skipped,
    clientReminders: result.summary.client_reminders,
    alerts: result.alerts
  });
}

console.log('\n=== SUMMARY ===');
console.log(JSON.stringify(results, null, 2));
