/**
 * Commitment fingerprint — feature-based representation of an action item or
 * verifier candidate, used for dedup matching.
 *
 * Implements OpenAI's recommendation (~/super-agent-shared/dedup-openai-response.md):
 * "Make dedup a first-class matching problem, not a hashing problem."
 *
 * Goal: extract robust features (verb / object tokens / dates / amounts /
 * entities / client) that the matcher can score independently. Each feature
 * is allowed to be imperfect — the matcher uses MULTIPLE features so a single
 * miss doesn't break dedup.
 */

const VERB_CANONICAL = {
  // discuss family
  'discuss': 'discuss', 'discussion': 'discuss', 'talk': 'discuss', 'meet': 'discuss',
  // review family
  'review': 'review', 'audit': 'review', 'assess': 'review', 'evaluate': 'review',
  // decide family
  'decide': 'decide', 'decision': 'decide', 'finalize': 'decide', 'approve': 'decide',
  // send family
  'send': 'send', 'forward': 'send', 'share': 'send', 'email': 'send', 'deliver': 'send',
  // create family
  'create': 'create', 'build': 'create', 'set': 'create', 'setup': 'create',
  'draft': 'create', 'design': 'create', 'develop': 'create',
  // update family
  'update': 'update', 'edit': 'update', 'revise': 'update', 'refresh': 'update',
  'modify': 'update', 'tweak': 'update', 'adjust': 'update', 'change': 'update',
  // check family
  'check': 'check', 'verify': 'check', 'confirm': 'check', 'investigate': 'check',
  'test': 'check', 'inspect': 'check', 'validate': 'check',
  // follow-up family
  'follow': 'follow-up', 'followup': 'follow-up',
  // launch / push family
  'launch': 'launch', 'publish': 'launch', 'deploy': 'launch', 'release': 'launch',
  // research family
  'research': 'research', 'explore': 'research', 'study': 'research',
};

const STOPWORDS = new Set([
  'a','an','the','and','or','but','of','for','in','on','at','to','with','by','from','about',
  'our','their','his','her','its','my','your','we','they','he','she','it','i','you',
  'is','are','was','were','be','been','being','am','do','does','did','doing','done',
  'have','has','had','having','can','could','should','would','will','may','might',
  'this','that','these','those','there','here','what','which','who','whom','whose',
  'when','where','why','how','all','any','some','no','not','only','own','same','than',
  'too','very','just','also','as','so','if','because','while','during','through',
  'up','down','out','over','under','again','then','once',
]);

const DAY_NAMES = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
const MONTH_NAMES = ['january','february','march','april','may','june','july','august','september','october','november','december','jan','feb','mar','apr','jun','jul','aug','sep','sept','oct','nov','dec'];

export function fingerprint(item) {
  const title = String(item?.title || '');
  const desc = String(item?.description || '');
  const evSummary = String(item?.evidence?.summary || '');
  const text = `${title} ${desc} ${evSummary}`.trim();
  const tokens = text.toLowerCase().match(/[a-z][a-z0-9-]*/g) || [];
  const meaningful = tokens.filter(t => t.length > 2 && !STOPWORDS.has(t));

  return {
    verb: extractVerb(title || text),
    object_tokens: meaningful.slice(0, 30),
    bigrams: extractBigrams(meaningful),
    dates: extractDates(text),
    amounts: extractAmounts(text),
    entities: extractEntities(`${title} ${desc} ${evSummary}`),
    client_id: item?.client_id || null,
    raw_text: text.slice(0, 500),
  };
}

function extractVerb(text) {
  const words = String(text || '').toLowerCase().match(/[a-z]+/g) || [];
  for (const w of words) {
    if (STOPWORDS.has(w)) continue;
    if (VERB_CANONICAL[w]) return VERB_CANONICAL[w];
  }
  return words.find(w => !STOPWORDS.has(w) && w.length > 2) || 'unknown';
}

function extractBigrams(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    out.push(tokens[i] + '_' + tokens[i + 1]);
  }
  return out.slice(0, 30);
}

// Date extractor — looks for ISO dates, "May 12", "Friday", "next Monday", quarter ranges, etc.
// Returns canonical lowercase tokens like 'may-12', 'friday', 'q2'.
export function extractDates(text) {
  const out = new Set();
  const t = String(text || '').toLowerCase();
  // ISO YYYY-MM-DD
  const iso = t.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g);
  if (iso) iso.forEach(d => out.add(d));
  // "May 12", "May 12th", "May 12, 2026"
  for (const m of MONTH_NAMES) {
    const re = new RegExp(`\\b${m}\\s+(\\d{1,2})(st|nd|rd|th)?\\b`, 'g');
    let match;
    while ((match = re.exec(t)) !== null) {
      out.add(`${m.slice(0,3)}-${match[1]}`);
    }
  }
  // Day names ("Monday", "next Friday")
  for (const d of DAY_NAMES) {
    if (new RegExp(`\\b${d}\\b`).test(t)) out.add(d);
  }
  // Quarter mentions
  const q = t.match(/\bq[1-4]\b/g);
  if (q) q.forEach(x => out.add(x));
  // Common relative date phrases
  if (/\bnext (week|session|meeting)\b/.test(t)) out.add('next-session');
  if (/\bthis (week|session|meeting)\b/.test(t)) out.add('this-session');
  if (/\beow|by end of week|by friday\b/.test(t)) out.add('eow');
  if (/\bby (eod|end of day|tomorrow|today)\b/.test(t)) out.add('eod');
  return [...out];
}

export function extractAmounts(text) {
  const out = new Set();
  const t = String(text || '');
  // Dollar amounts $5,000 or $5k or $5000
  const dollars = t.match(/\$\s?[\d,]+(?:\.\d+)?(?:k|m)?/gi);
  if (dollars) dollars.forEach(d => out.add(d.toLowerCase().replace(/[\s,$]/g,'')));
  // Percentages 10%, 10-15%, 10–15 %
  const percents = t.match(/\b\d+\s*(?:[-–]\s*\d+)?\s*%/g);
  if (percents) percents.forEach(p => out.add(p.replace(/\s+/g,'')));
  // Plain integer counts in commitment context (e.g., "3 emails", "5 ads")
  const counts = t.match(/\b\d{1,4}\s+(?:emails?|ads?|pages?|videos?|posts?|leads?|reports?)\b/gi);
  if (counts) counts.forEach(c => out.add(c.toLowerCase().replace(/\s+/g,'-')));
  return [...out];
}

// Capitalized noun phrases — names, brands, accounts. Crude: 1-3 consecutive
// Capitalized words. Filters obvious sentence-start false positives by ignoring
// items that are entirely stopwords or that follow a sentence terminator.
export function extractEntities(text) {
  const out = new Set();
  const t = String(text || '');
  const re = /\b([A-Z][a-z']{1,}(?:\s+[A-Z][a-z']{1,}){0,2})\b/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const phrase = m[1].toLowerCase();
    const words = phrase.split(/\s+/).filter(Boolean);
    if (words.every(w => STOPWORDS.has(w))) continue;
    if (words.length === 1 && (STOPWORDS.has(phrase) || /^(the|i|a|an|and|or|but)$/i.test(phrase))) continue;
    out.add(phrase);
  }
  return [...out];
}

export function jaccard(setA, setB) {
  const a = new Set(setA);
  const b = new Set(setB);
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union ? intersection / union : 0;
}
