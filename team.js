const db = require('better-sqlite3')('data/zoom-action-items.db');
console.log('=== TEAM MEMBERS ===');
const owners = db.prepare("SELECT DISTINCT owner_name, COUNT(*) as tasks FROM action_items WHERE owner_name IS NOT NULL AND length(owner_name) > 1 GROUP BY owner_name ORDER BY tasks DESC").all();
owners.forEach(o => console.log('  ' + o.owner_name + ' (' + o.tasks + ' action items)'));

console.log('\n=== CLIENTS CONFIG ===');
const fs = require('fs');
const clients = JSON.parse(fs.readFileSync('src/config/clients.json','utf-8'));
clients.clients.forEach(c => console.log('  ' + c.id + ' | ' + c.name + ' | ' + (c.industry||'?') + ' | services: ' + (c.services_active||[]).join(', ')));

console.log('\n=== PM2 PROCESSES ===');
