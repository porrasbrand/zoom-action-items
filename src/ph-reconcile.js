#!/usr/bin/env node
/**
 * ProofHub Reconciliation CLI
 *
 * Usage:
 *   node src/ph-reconcile.js --client prosper-group
 *   node src/ph-reconcile.js --client prosper-group --refresh  (re-pull PH tasks only)
 *   node src/ph-reconcile.js --status prosper-group            (show status only)
 */

import 'dotenv/config';
import { getDatabase } from './api/db-queries.js';
import { reconcileClient, refreshPHCache, getReconcileStatus } from './lib/ph-reconciler.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load clients config
function loadClientsConfig() {
  const configPath = path.join(__dirname, 'config/clients.json');
  if (!fs.existsSync(configPath)) {
    console.error('Error: src/config/clients.json not found');
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  return config.clients || config;
}

function getClientConfig(clientId) {
  const clients = loadClientsConfig();
  return clients.find(c => c.id === clientId);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log(`
ProofHub Reconciliation CLI

Usage:
  node src/ph-reconcile.js --client <client-id>              Run reconciliation
  node src/ph-reconcile.js --client <client-id> --deep       Run with deep sync (descriptions + comments + AI scope summaries)
  node src/ph-reconcile.js --client <client-id> --refresh    Refresh PH cache only
  node src/ph-reconcile.js --status <client-id>              Show reconciliation status

Examples:
  node src/ph-reconcile.js --client prosper-group
  node src/ph-reconcile.js --client prosper-group --deep
  node src/ph-reconcile.js --status prosper-group
`);
    process.exit(0);
  }

  const db = getDatabase();

  // Status mode
  if (args.includes('--status')) {
    const clientId = args[args.indexOf('--status') + 1];
    if (!clientId) {
      console.error('Error: --status requires a client ID');
      process.exit(1);
    }

    const status = getReconcileStatus(db, clientId);
    console.log(`\n📊 Reconciliation Status: ${clientId}\n`);
    console.log(`  Roadmap items:   ${status.total_roadmap_items}`);
    console.log(`  Linked to PH:    ${status.linked_items}`);
    console.log(`  Unlinked:        ${status.unlinked_items}`);
    console.log(`  Cached PH tasks: ${status.cached_ph_tasks}`);
    console.log(`  Last PH sync:    ${status.last_ph_sync || 'never'}\n`);
    process.exit(0);
  }

  // Client mode
  const clientIdx = args.indexOf('--client');
  if (clientIdx === -1) {
    console.error('Error: --client required');
    process.exit(1);
  }

  const clientId = args[clientIdx + 1];
  if (!clientId) {
    console.error('Error: --client requires a client ID');
    process.exit(1);
  }

  const client = getClientConfig(clientId);
  if (!client) {
    console.error(`Error: Client '${clientId}' not found in config/clients.json`);
    process.exit(1);
  }

  if (!client.ph_project_id) {
    console.error(`Error: Client '${clientId}' has no ph_project_id configured`);
    process.exit(1);
  }

  console.log(`\n🔗 ProofHub Reconciliation: ${client.name}`);
  console.log(`   Project ID: ${client.ph_project_id}\n`);

  // Refresh mode
  if (args.includes('--refresh')) {
    console.log('Refreshing PH task cache...');
    const count = await refreshPHCache(db, clientId, client.ph_project_id);
    console.log(`✅ Cached ${count} PH tasks\n`);
    process.exit(0);
  }

  // Full reconciliation
  const deep = args.includes('--deep');
  try {
    const result = await reconcileClient(db, clientId, client.ph_project_id, { deep });

    console.log(`\n✅ Reconciliation Complete${deep ? ' (Deep Mode)' : ''}\n`);
    console.log(`   Roadmap items:  ${result.total_roadmap}`);
    console.log(`   PH tasks:       ${result.total_ph}`);
    console.log(`   Linked:         ${result.linked}`);
    console.log(`   Unlinked:       ${result.unlinked}`);
    console.log(`   New links:      ${result.new_links}`);
    if (deep) {
      console.log(`   Scope summaries: ${result.scope_summaries || 0}`);
    }

    if (result.links.length > 0) {
      console.log(`\n   New Matches:`);
      for (const link of result.links) {
        console.log(`     • RI-${link.roadmap_item_id} → PH-${link.ph_task_id}`);
        console.log(`       "${link.ph_title}" (${link.method}, ${(link.confidence * 100).toFixed(0)}%)`);
      }
    }

    console.log('');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
