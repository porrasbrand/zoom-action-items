/**
 * Dump all ProofHub tasks across client projects
 * Run on production server: node scripts/dump-proofhub-tasks.mjs
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
      'User-Agent': 'TaskDump/1.0 (admin@example.com)',
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
  { id: 'gamma-group', name: 'Gamma Group', ph: '1000000029' },
  { id: 'delta-pro', name: 'Delta Pro', ph: '1000000019' },
  { id: 'epsilon-service', name: 'Epsilon Service', ph: '1000000025' },
  { id: 'zeta-coaching', name: 'Zeta Coaching', ph: '1000000020' },
  { id: 'theta', name: 'Theta Systems', ph: '1000000021' },
  { id: 'taylor-brooks', name: 'Taylor Brooks', ph: '1000000031' },
  { id: 'casey-lowe', name: 'Casey Lowe / Kappa Security', ph: '1000000027' },
  { id: 'acme-hvac', name: 'Acme HVAC', ph: '1000000028' },
  { id: 'pi-marketing', name: 'Jesse Pike / Pi Marketing', ph: '1000000036' },
  { id: 'rho-home-services', name: 'Rho Home Services', ph: '1000000023' },
  { id: 'rowan-pryce', name: 'Rowan Pryce', ph: '1000000024' },
  { id: 'tau-home', name: 'Tau Home', ph: '1000000022' },
  { id: 'upsilon-flooring', name: 'Upsilon Flooring', ph: '1000000030' },
  { id: 'phi-flooring', name: 'Phi Flooring', ph: '1000000032' },
  { id: 'chi-flooring', name: 'Chi Flooring', ph: '1000000026' },
  { id: 'agency-internal', name: 'Agency Internal', ph: '1000000033' },
  { id: 'ledger-cfo', name: 'Ledger CFO', ph: '1000000037' },
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
