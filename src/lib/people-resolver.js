/**
 * People Resolver
 * Maps transcript speaker names to ProofHub user IDs
 */

const PEOPLE_MAP = [
  { names: ['Philip Mutrie', 'Phil', 'Phil Mutrie'], ph_id: '12896349500', email: 'Phil@breakthrough3x.com' },
  { names: ['Bill Soady', 'Bill'], ph_id: '13652696772', email: 'bill@breakthrough3x.com' },
  { names: ['Richard', 'Richard Bonn', 'Richard Osterude', 'Richard O'], ph_id: '12930841172', email: 'richard@breakthrough3x.com' },
  { names: ['Joaco', 'Joaco Malig'], ph_id: '12953229550', email: 'jmejia@breakthrough3x.com' },
  { names: ['Jacob', 'Jacob Hastings', 'Jacob/Traffic Team'], ph_id: '13766931777', email: 'jacob.traffic@breakthrough3x.com' },
  { names: ['Vince', 'Vince Lei'], ph_id: '14513930205', email: 'vince@breakthrough3x.com' },
  { names: ['Sarah', 'Sarah Young'], ph_id: '12953338100', email: 'sarah.young@breakthrough3x.com' },
  { names: ['Manuel', 'Manuel Porras'], ph_id: '12953283825', email: 'minisite911@gmail.com' },
  { names: ['Juan', 'Juan Mejia'], ph_id: '12953229550', email: 'jmejia@breakthrough3x.com' },
  { names: ['Ray Z', 'Ray'], ph_id: '12953297394', email: 'rayz@breakthrough3x.com' },
  { names: ['Nicole'], ph_id: '13766918208', email: 'nicole.traffic@breakthrough3x.com' },
  { names: ['Dan Kuschell', 'Dan', "Dan's Team"], ph_id: null, email: 'help@breakthrough3x.com', note: 'CEO - usually delegates' },
];

/**
 * Resolve a person by name
 * Returns { ph_id, email, name, note } or null
 */
export function resolvePerson(ownerName) {
  if (!ownerName) return null;

  const normalizedInput = ownerName.toLowerCase().trim();

  for (const person of PEOPLE_MAP) {
    for (const name of person.names) {
      const normalizedName = name.toLowerCase().trim();

      // Exact match
      if (normalizedName === normalizedInput) {
        return {
          ph_id: person.ph_id,
          email: person.email,
          name: person.names[0],
          note: person.note || null
        };
      }

      // Partial match (input is prefix of name or vice versa)
      if (normalizedName.startsWith(normalizedInput) || normalizedInput.startsWith(normalizedName)) {
        return {
          ph_id: person.ph_id,
          email: person.email,
          name: person.names[0],
          note: person.note || null
        };
      }
    }
  }

  return null;
}

/**
 * Get all people for dropdowns
 */
export function getAllPeople() {
  return PEOPLE_MAP.map(person => ({
    name: person.names[0],
    aliases: person.names.slice(1),
    ph_id: person.ph_id,
    email: person.email,
    note: person.note || null
  }));
}

export default {
  resolvePerson,
  getAllPeople
};
