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
  'alex': 'alex@example.com',
  'alex rivera': 'alex@example.com',
  'alex rivera': 'alex@example.com',
  'jamie': 'jamie@example.com',
  'jamie lee': 'jamie@example.com',
  "jamie's team": 'jamie@example.com',
  'dana z': 'dana@example.com',
  'dana': 'dana@example.com',
  'chris': 'chris@example.com',
  'chris novak': 'chris@example.com',
  'chris o': 'pat@example.com',
  'pat olsen': 'pat@example.com',
  'manuel': 'manuel@example.com',
  'manuel porras': 'manuel@example.com',
  'mp': 'manuel@example.com',
  'sam': 'sam@example.com',
  'sam ortiz': 'sam@example.com',
  'leo': 'sam@example.com',
  'leo park': 'sam@example.com',
  'jules': 'jules.traffic@example.com',
  'jules hart': 'jules.traffic@example.com',
  'mika': 'mika@example.com',
  'mika chen': 'mika@example.com',
  'kris': 'kris@example.com',
  'kris soto': 'kris@example.com',
  'nina': 'nina.ward@example.com',
  'nina ward': 'nina.ward@example.com',
  'ivy': 'ivy@example.com',
  'rae': 'rae@example.com',
  'ben': 'ben@contractor.example.com',
  'ben tate': 'ben@contractor.example.com',
};


// ProofHub group IDs
const PH_GROUP_AGENCY_INTERNAL = 1000000001;
const PH_GROUP_TRAFFIC = 1000000002;
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
      groups: p.groups || [],
      is_agency: (p.groups || []).includes(PH_GROUP_AGENCY_INTERNAL) || /@example.com$/i.test(p.email || ''),
      is_traffic: (p.groups || []).includes(PH_GROUP_TRAFFIC),
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
    note: p.suspended ? 'suspended' : null,
    is_agency: p.is_agency || false,
    is_traffic: p.is_traffic || false,
    groups: p.groups || []
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


/**
 * Get Agency internal team members (from PH group)
 */
export function getAgencyTeamSync() {
  if (!peopleCache) return [];
  return peopleCache.filter(p => p.is_agency).map(p => ({
    name: p.first_name || p.name.split(" ")[0],
    fullName: p.name,
    ph_id: p.ph_id,
    email: p.email,
    label: "★ " + (p.first_name || p.name.split(" ")[0]) + " - Agency"
  }));
}

/**
 * Check if a name is Agency internal
 */
export function isAgencyInternal(name) {
  if (!peopleCache || !name) return false;
  const input = name.toLowerCase().trim();
  return peopleCache.some(p => {
    if (!p.is_agency) return false;
    const first = (p.first_name || "").toLowerCase();
    const full = p.name.toLowerCase();
    return input === first || input === full || input.startsWith(first) || full.startsWith(input);
  });
}

export default {
  resolvePerson,
  resolvePersonSync,
  getAllPeople,
  getAllPeopleSync,
  refreshPeopleCache,
  getAgencyTeamSync,
  isAgencyInternal
};
