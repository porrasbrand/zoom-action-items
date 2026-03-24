/**
 * Parse WebVTT transcript into speaker-labeled plain text.
 * Adapted from B3X Zoom2DriveMin N8N workflow.
 */

/**
 * Convert VTT content to readable transcript preserving timestamps and speakers.
 * @param {string} raw - Raw VTT or plain text content
 * @returns {string} Formatted transcript
 */
export function parseVTT(raw = '') {
  const src = raw.replace(/\r\n/g, '\n');

  // Detect if this is actually VTT format
  const isVTT = /^WEBVTT/i.test(src) || /-->\s+\d{2}:\d{2}:\d{2}\.\d{3}/.test(src);
  if (!isVTT) return src.trim();

  const cueRx = /(\d{2}:\d{2}:\d{2}\.\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}\.\d{3})(?:[^\n]*)\n([\s\S]*?)(?=\n{2,}|$)/g;

  const lines = [];
  let m;
  while ((m = cueRx.exec(src)) !== null) {
    const start = m[1];
    let payload = (m[3] || '').trim();

    // Extract speaker from WebVTT voice tag: <v Speaker Name>
    let speaker = null;
    payload = payload.replace(/<v\s+([^>]+)>/i, (_all, name) => {
      speaker = String(name || '').trim();
      return '';
    });

    // Strip remaining HTML-like tags
    payload = payload.replace(/<[^>]+>/g, '');

    // Collapse whitespace
    payload = payload.replace(/\n+/g, ' ').replace(/[ \t]+/g, ' ').trim();

    if (payload) {
      lines.push(`[${start}]${speaker ? ' ' + speaker + ':' : ''} ${payload}`);
    }
  }

  return lines.join('\n').trim();
}

/**
 * Extract unique speaker names from parsed transcript.
 * @param {string} parsedText - Output of parseVTT()
 * @returns {string[]} Array of speaker names
 */
export function extractSpeakers(parsedText) {
  const speakers = new Set();
  const speakerRx = /\[\d{2}:\d{2}:\d{2}\.\d{3}\]\s+([^:]+):/g;
  let m;
  while ((m = speakerRx.exec(parsedText)) !== null) {
    speakers.add(m[1].trim());
  }
  return [...speakers];
}
