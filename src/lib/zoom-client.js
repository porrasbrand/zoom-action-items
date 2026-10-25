/**
 * Zoom Server-to-Server OAuth client.
 * Handles token refresh and recordings API.
 */

let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Get S2S OAuth access token (cached until expiry).
 */
export async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const { ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET } = process.env;
  if (!ZOOM_ACCOUNT_ID || !ZOOM_CLIENT_ID || !ZOOM_CLIENT_SECRET) {
    throw new Error('Missing ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, or ZOOM_CLIENT_SECRET');
  }

  const credentials = Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString('base64');

  const res = await fetch('https://zoom.us/oauth/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `grant_type=account_credentials&account_id=${ZOOM_ACCOUNT_ID}`,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Zoom token error ${res.status}: ${body}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;

  return cachedToken;
}

/**
 * List all users on the Zoom account.
 */
export async function listUsers() {
  const token = await getAccessToken();
  const res = await fetch('https://api.zoom.us/v2/users?page_size=100', {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Zoom users error ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.users || [];
}

/**
 * List completed recordings from the last N hours across ALL account users.
 * S2S OAuth apps can't use "me" — must query each user individually.
 * Returns array of meeting objects with recording files.
 */
export async function listRecordings(lookbackHours = 24) {
  const token = await getAccessToken();
  const from = new Date(Date.now() - lookbackHours * 3600_000).toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);

  const users = await listUsers();
  const allMeetings = [];

  for (const user of users) {
    const url = `https://api.zoom.us/v2/users/${user.id}/recordings?from=${from}&to=${to}&page_size=100`;

    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!res.ok) {
      console.warn(`  Warning: recordings fetch failed for ${user.email}: ${res.status}`);
      continue;
    }

    const data = await res.json();
    const meetings = data.meetings || [];
    allMeetings.push(...meetings);
  }

  return allMeetings;
}

/**
 * Download a recording file (VTT transcript).
 * Returns the raw text content.
 */
export async function downloadTranscript(downloadUrl) {
  const token = await getAccessToken();

  // Zoom download URLs require the token as a query param
  const separator = downloadUrl.includes('?') ? '&' : '?';
  const url = `${downloadUrl}${separator}access_token=${token}`;

  const res = await fetch(url, { redirect: 'follow' });

  if (!res.ok) {
    throw new Error(`Zoom download error ${res.status}: ${await res.text()}`);
  }

  return await res.text();
}

/**
 * Extract meetings that have VTT transcript files.
 * Returns simplified meeting objects with transcript download URLs.
 */
export function filterMeetingsWithTranscripts(meetings) {
  const results = [];

  for (const meeting of meetings) {
    const files = meeting.recording_files || [];
    const transcript = files.find(f => f.file_type === 'TRANSCRIPT' && f.status === 'completed');

    if (transcript) {
      results.push({
        uuid: meeting.uuid,
        topic: meeting.topic || 'Untitled',
        start_time: meeting.start_time,
        duration: meeting.duration, // minutes
        transcript_download_url: transcript.download_url,
        recording_id: transcript.id,
      });
    }
  }

  return results;
}
