#!/usr/bin/env node
/**
 * Capture OpenAI chat-completions rate-limit headers from a sample call.
 *
 * Uses fetch() directly (not the SDK) so we can read response headers, since
 * the openai npm SDK strips those by default in most versions.
 *
 * Output: a single JSON line with the captured headers + a tier inference.
 */

import 'dotenv/config';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('Missing OPENAI_API_KEY');
  process.exit(1);
}

const model = process.env.TITLE_STYLER_MODEL || 'gpt-5.4-mini';

const body = {
  model,
  temperature: 0.2,
  max_completion_tokens: 32,
  messages: [
    { role: 'system', content: 'Reply with the single word: ok' },
    { role: 'user', content: 'ping' },
  ],
};

const start = Date.now();
const res = await fetch('https://api.openai.com/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(body),
});
const latencyMs = Date.now() - start;

const want = [
  'x-ratelimit-limit-requests',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-reset-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-tokens',
];
const headers = {};
for (const h of want) headers[h] = res.headers.get(h) || null;

let bodyJson = null;
try { bodyJson = await res.json(); } catch {}

// Tier inference (rough — OpenAI publishes these caps):
// Tier 1: gpt-5.4-mini ~500 RPM
// Tier 2: ~5000 RPM
// Tier 3: ~5000 RPM (higher TPM)
// Tier 4: ~10000 RPM
// Tier 5: ~10000+ RPM
const rpm = parseInt(headers['x-ratelimit-limit-requests'] || '0', 10);
let tier = 'unknown';
if (rpm > 0 && rpm <= 500) tier = 'Tier 1 (~500 RPM gpt-5.4-mini)';
else if (rpm > 500 && rpm <= 5000) tier = 'Tier 2 (~5000 RPM)';
else if (rpm > 5000 && rpm <= 10000) tier = 'Tier 3-4 (~5000-10000 RPM)';
else if (rpm > 10000) tier = 'Tier 5 (10000+ RPM)';

console.log(JSON.stringify({
  status: res.status,
  ok: res.ok,
  model,
  latencyMs,
  headers,
  tier,
  sample_response: bodyJson?.choices?.[0]?.message?.content || null,
  error: bodyJson?.error || null,
}, null, 2));
