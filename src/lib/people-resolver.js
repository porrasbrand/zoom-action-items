/**
 * People Resolver
 * Maps transcript speaker names to ProofHub user IDs
 * Pulls from ProofHub API on first use, caches in memory
 */

import 'dotenv/config';

let peopleCache = null;
let lastFetch = 0;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Aliases: map common transcript names to PH email or first name
const NAME_ALIASES = {
  'phil': 'Phil@breakthrough3x.com',
  'phil mutrie': 'Phil@breakthrough3x.com',
  'philip mutrie': 'Phil@breakthrough3x.com',
  'dan': 'help@breakthrough3x.com',
  'dan kuschell': 'help@breakthrough3x.com',
  "dan's team": 'help@breakthrough3x.com',
  'ray z': 'rayz@breakthrough3x.com',
  'ray': 'rayz@breakthrough3x.com',
  'richard': 'richard@breakthrough3x.com',
  'richard bonn': 'richard@breakthrough3x.com',
  'richard o': 'osterude@gmail.com',
  'richard osterude': 'osterude@gmail.com',
  'manuel': 'manuel@breakthrough3x.com',
  'manuel porras': 'manuel@breakthrough3x.com',
  'juan': 'jmejia@breakthrough3x.com',
  'juan mejia': 'jmejia@breakthrough3x.com',
  'joaco': 'jmejia@breakthrough3x.com',
  'joaco malig': 'jmejia@breakthrough3x.com',
  'jacob': 'jacob.traffic@breakthrough3x.com',
  'jacob hastings': 'jacob.traffic@breakthrough3x.com',
  'vince': 'vince@breakthrough3x.com',
  'vince lei': 'vince@breakthrough3x.com',
  'bill': 'bill@breakthrough3x.com',
  'bill soady': 'bill@breakthrough3x.com',
  'sarah': 'sarah.young@breakthrough3x.com',
  'sarah young': 'sarah.young@breakthrough3x.com',
  'nicole': 'nicole@breakthrough3x.com',
  'allysa': 'allysa@breakthrough3x.com',
  'ric': 'Ric@doneforyousolutions.com',
  'ric thompson': 'Ric@doneforyousolutions.com',
};

/**
 * Fetch people from ProofHub API
 */
async function fetchPeopleFromPH() {
  const apiKey = process.env.PROOFHUB_API_KEY;
  const companyUrl = process.env.PROOFHUB_COMPANY_URL;
  if (!apiKey || !companyUrl) {
    console.warn('[People] ProofHub not configured, using empty people list');
    return [];
  }

  try {
    const res = await fetch(`https://${companyUrl}/api/v3/people`, {
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' }
    });
    if (!res.ok) throw new Error(`PH API ${res.status}`);
    const data = await res.json();

    const people = data.map(p => ({
      ph_id: String(p.id),
      email: p.email,
      first_name: p.first_name || '',
      last_name: p.last_name || '',
      name: ((p.first_name || '') + ' ' + (p.last_name || '')).trim() || p.email.split('@')[0],
      suspended: p.suspended || false,
      last_active: p.last_active,
    }));

    console.log(`[People] Loaded ${people.length} people from ProofHub`);
    return people;
  } catch (err) {
    console.error('[People] Failed to fetch from ProofHub:', err.message);
    return [];
  }
}

/**
 * Get people list (cached, refreshes every 24h)
 */
async function getPeople() {
  if (peopleCache && (Date.now() - lastFetch) < CACHE_TTL) return peopleCache;
  peopleCache = await fetchPeopleFromPH();
  lastFetch = Date.now();
  return peopleCache;
}

/**
 * Force refresh the people cache
 */
export async function refreshPeopleCache() {
  peopleCache = null;
  lastFetch = 0;
  return await getPeople();
}

/**
 * Resolve a person by name
 * Returns { ph_id, email, name, note } or null
 */
export async function resolvePerson(ownerName) {
  if (!ownerName) return null;
  const people = await getPeople();
  const input = ownerName.toLowerCase().trim();

  // 1. Check aliases first (maps transcript names to PH emails)
  const aliasEmail = NAME_ALIASES[input];
  if (aliasEmail) {
    const person = people.find(p => p.email.toLowerCase() === aliasEmail.toLowerCase());
    if (person) return { ph_id: person.ph_id, email: person.email, name: person.name, note: null };
  }

  // 2. Exact match on name
  for (const p of people) {
    if (p.name.toLowerCase() === input || p.first_name.toLowerCase() === input) {
      return { ph_id: p.ph_id, email: p.email, name: p.name, note: null };
    }
  }

  // 3. Partial match (input starts with first name)
  for (const p of people) {
    const firstName = p.first_name.toLowerCase();
    if (firstName && (input.startsWith(firstName) || firstName.startsWith(input))) {
      return { ph_id: p.ph_id, email: p.email, name: p.name, note: null };
    }
  }

  // 4. Email match
  for (const p of people) {
    if (input.includes('@') && p.email.toLowerCase() === input) {
      return { ph_id: p.ph_id, email: p.email, name: p.name, note: null };
    }
  }

  return null;
}

/**
 * Synchronous resolve for backward compatibility (uses cached data)
 * Falls back to alias lookup if cache not loaded
 */
export function resolvePersonSync(ownerName) {
  if (!ownerName) return null;
  const input = ownerName.toLowerCase().trim();

  // Use cache if available
  if (peopleCache) {
    const aliasEmail = NAME_ALIASES[input];
    if (aliasEmail) {
      const person = peopleCache.find(p => p.email.toLowerCase() === aliasEmail.toLowerCase());
      if (person) return { ph_id: person.ph_id, email: person.email, name: person.name, note: null };
    }
    for (const p of peopleCache) {
      if (p.name.toLowerCase() === input || p.first_name.toLowerCase() === input) {
        return { ph_id: p.ph_id, email: p.email, name: p.name, note: null };
      }
    }
    for (const p of peopleCache) {
      const firstName = p.first_name.toLowerCase();
      if (firstName && (input.startsWith(firstName) || firstName.startsWith(input))) {
        return { ph_id: p.ph_id, email: p.email, name: p.name, note: null };
      }
    }
  }

  return null;
}

/**
 * Get all people for dropdowns
 */
export async function getAllPeople() {
  const people = await getPeople();
  return people.map(p => ({
    name: p.name,
    aliases: [],
    ph_id: p.ph_id,
    email: p.email,
    note: p.suspended ? 'suspended' : null
  }));
}

/**
 * Get all people synchronously (from cache, for dropdowns)
 */
export function getAllPeopleSync() {
  if (!peopleCache) return [];
  return peopleCache.map(p => ({
    name: p.name,
    aliases: [],
    ph_id: p.ph_id,
    email: p.email,
    note: p.suspended ? 'suspended' : null
  }));
}

export default {
  resolvePerson,
  resolvePersonSync,
  getAllPeople,
  getAllPeopleSync,
  refreshPeopleCache
};
