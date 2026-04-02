#!/usr/bin/env node
/**
 * Create API Token
 * Generates an API token for a given email and role.
 *
 * Usage:
 *   node scripts/create-api-token.js --email user@example.com --role admin --name "API Client"
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

import { runAuthMigrations, createApiToken, listApiTokens } from '../src/lib/auth.js';

// Run migrations to ensure table exists
runAuthMigrations();

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    email: null,
    role: 'user',
    name: 'API Token',
    expires: null, // null = no expiry
    list: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--email':
      case '-e':
        options.email = next;
        i++;
        break;
      case '--role':
      case '-r':
        options.role = next;
        i++;
        break;
      case '--name':
      case '-n':
        options.name = next;
        i++;
        break;
      case '--expires':
        // Format: YYYY-MM-DD or days like "30d"
        if (next.endsWith('d')) {
          const days = parseInt(next.slice(0, -1));
          options.expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
        } else {
          options.expires = new Date(next).toISOString();
        }
        i++;
        break;
      case '--list':
      case '-l':
        options.list = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }

  return options;
}

function printHelp() {
  console.log(`
Create API Token - Generate API tokens for the Zoom Dashboard

Usage:
  node scripts/create-api-token.js --email <email> [options]

Required:
  --email, -e <email>     Email address for the token

Options:
  --role, -r <role>       Role (admin/user) - default: user
  --name, -n <name>       Token name/description - default: "API Token"
  --expires <date>        Expiration (YYYY-MM-DD or "30d") - default: never
  --list, -l              List all existing tokens
  --help, -h              Show this help

Examples:
  node scripts/create-api-token.js --email user@example.com --role admin
  node scripts/create-api-token.js -e user@example.com -r user -n "Dashboard API"
  node scripts/create-api-token.js --email user@example.com --expires 90d
  node scripts/create-api-token.js --list
`);
}

function main() {
  const options = parseArgs();

  if (options.list) {
    const tokens = listApiTokens();
    console.log('\n=== Existing API Tokens ===\n');
    if (tokens.length === 0) {
      console.log('No tokens found.');
    } else {
      tokens.forEach(t => {
        console.log(`ID: ${t.id}`);
        console.log(`  Email: ${t.email}`);
        console.log(`  Name: ${t.name}`);
        console.log(`  Role: ${t.role}`);
        console.log(`  Created: ${t.created_at}`);
        console.log(`  Expires: ${t.expires_at || 'Never'}`);
        console.log('');
      });
    }
    return;
  }

  if (!options.email) {
    console.error('Error: --email is required');
    printHelp();
    process.exit(1);
  }

  console.log('\n=== Creating API Token ===\n');
  console.log(`Email: ${options.email}`);
  console.log(`Role: ${options.role}`);
  console.log(`Name: ${options.name}`);
  console.log(`Expires: ${options.expires || 'Never'}`);
  console.log('');

  const token = createApiToken(options.email, options.name, options.role, options.expires);

  console.log('=== TOKEN CREATED ===');
  console.log('');
  console.log(`Token: ${token}`);
  console.log('');
  console.log('Usage:');
  console.log(`  curl -H "Authorization: Bearer ${token}" https://www.manuelporras.com/zoom/api/stats`);
  console.log('  OR');
  console.log(`  curl "https://www.manuelporras.com/zoom/api/stats?token=${token}"`);
  console.log('');
}

main();
