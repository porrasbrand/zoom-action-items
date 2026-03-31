/**
 * Dump all ProofHub tasks across client projects
 * Run on Hetzner: node scripts/dump-proofhub-tasks.mjs
 * Output: data/proofhub-task-dump.json
 */

import 'dotenv/config';
import { writeFileSync } from 'fs';

const API_KEY = process.env.PROOFHUB_API_KEY;
const COMPANY_URL = process.env.PROOFHUB_COMPANY_URL;
const BASE_URL = `https://${COMPANY_URL}/api/v3`;
const MIN_INTERVAL = 450; // slightly above rate limit

let lastReq = 0;

async function apiGet(path) {
  const now = Date.now();
  const wait = MIN_INTERVAL - (now - lastReq);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastReq = Date.now();

  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      'X-API-KEY': API_KEY,
      'User-Agent': 'TaskDump/1.0 (porrasbrand@gmail.com)',
      'Content-Type': 'application/json'
    }
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`API ${path}: ${res.status} ${txt}`);
  }
  return res.json();
}

// Client projects with ProofHub IDs
const CLIENT_PROJECTS = [
  { id: 'prosper-group', name: 'Prosper Group', ph: '9066064282' },
  { id: '1st-choice', name: '1st Choice', ph: '8703304705' },
  { id: 'legendary-service', name: 'Legendary Service', ph: '8750225319' },
  { id: 'bearcat', name: 'Bearcat', ph: '8149674025' },
  { id: 'echelon', name: 'Echelon', ph: '9104911511' },
  { id: 'tom-ruwitch', name: 'Tom Ruwitch', ph: '8586749449' },
  { id: 'mike-mcvety', name: 'Mike McVety / Red Fortress', ph: '8316677760' },
  { id: 'pearce-hvac', name: 'Pearce HVAC', ph: '9353273257' },
  { id: 'conner-marketing', name: 'Jay Conner / Conner Marketing', ph: '9369677832' },
  { id: 'gs-home-services', name: 'GS Home Services', ph: '9330152168' },
  { id: 'jerry-levinson', name: 'Jerry Levinson', ph: '9330179305' },
  { id: 'empower', name: 'Empower', ph: '9330165736' },
  { id: 'raider-flooring', name: 'Raider Flooring', ph: '9385295423' },
  { id: 'vision-flooring', name: 'Vision Flooring AZ', ph: '9353286826' },
  { id: 'london-flooring', name: 'London Flooring', ph: '9431293364' },
  { id: 'b3x-internal', name: 'B3X Internal', ph: '8173459981' },
  { id: 'bec-cfo', name: 'BEC CFO', ph: '9544836365' },
];

async function main() {
  console.log(`ProofHub Task Dump - ${CLIENT_PROJECTS.length} projects`);
  console.log(`API: ${BASE_URL}\n`);

  const allData = {
    timestamp: new Date().toISOString(),
    projects: [],
    summary: { total_projects: 0, total_task_lists: 0, total_tasks: 0 }
  };

  for (const client of CLIENT_PROJECTS) {
    console.log(`\n--- ${client.name} (${client.ph}) ---`);

    try {
      // Get task lists for this project
      const taskLists = await apiGet(`/projects/${client.ph}/todolists`);
      const lists = Array.isArray(taskLists) ? taskLists : [];
      console.log(`  ${lists.length} task lists`);

      const projectData = {
        client_id: client.id,
        client_name: client.name,
        ph_project_id: client.ph,
        task_lists: []
      };

      for (const list of lists) {
        const listId = list.id;
        const listTitle = list.title || 'Untitled';
        console.log(`    List: "${listTitle}" (${listId})`);

        try {
          const tasks = await apiGet(`/projects/${client.ph}/todolists/${listId}/tasks`);
          const taskArr = Array.isArray(tasks) ? tasks : [];
          console.log(`      ${taskArr.length} tasks`);

          const taskListData = {
            list_id: listId,
            list_title: listTitle,
            tasks: taskArr.map(t => ({
              id: t.id,
              title: t.title || '',
              description: t.description || '',
              completed: t.completed || false,
              assigned: t.assigned || [],
              due_date: t.due_date || null,
              start_date: t.start_date || null,
              priority: t.priority || null,
              labels: t.labels || [],
              created_at: t.created_at || null,
              updated_at: t.updated_at || null
            }))
          };

          projectData.task_lists.push(taskListData);
          allData.summary.total_tasks += taskArr.length;
        } catch (err) {
          console.error(`      ERROR fetching tasks: ${err.message}`);
        }
      }

      allData.projects.push(projectData);
      allData.summary.total_task_lists += lists.length;
      allData.summary.total_projects++;

    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
    }
  }

  console.log(`\n\n=== SUMMARY ===`);
  console.log(`Projects: ${allData.summary.total_projects}`);
  console.log(`Task Lists: ${allData.summary.total_task_lists}`);
  console.log(`Tasks: ${allData.summary.total_tasks}`);

  const outPath = 'data/proofhub-task-dump.json';
  writeFileSync(outPath, JSON.stringify(allData, null, 2));
  console.log(`\nWritten to ${outPath}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
