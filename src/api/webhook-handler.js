/**
 * Zoom Webhook Handler
 * Receives recording.completed events and triggers transcript processing
 *
 * Zoom Challenge-Response validation:
 * https://developers.zoom.us/docs/api/rest/webhook-reference/#validate-your-webhook-endpoint
 */

import crypto from 'crypto';

/**
 * Create the webhook route handler
 * @param {object} options
 * @param {string} options.secretToken - Zoom webhook secret token
 * @param {function} options.onRecordingCompleted - Callback when recording is ready
 */
export function createWebhookHandler({ secretToken, onRecordingCompleted }) {
  return async (req, res) => {
    const body = req.body;

    // 1. Handle Zoom CRC (Challenge-Response Check) for URL validation
    if (body.event === 'endpoint.url_validation') {
      const plainToken = body.payload?.plainToken;
      if (!plainToken) {
        return res.status(400).json({ error: 'Missing plainToken' });
      }

      const hashForValidation = crypto
        .createHmac('sha256', secretToken)
        .update(plainToken)
        .digest('hex');

      console.log(`[Webhook] URL validation challenge received, responding...`);
      return res.status(200).json({
        plainToken,
        encryptedToken: hashForValidation
      });
    }

    // 2. Verify webhook signature (for all other events)
    const signature = req.headers['x-zm-signature'];
    const timestamp = req.headers['x-zm-request-timestamp'];

    if (signature && timestamp) {
      const message = `v0:${timestamp}:${JSON.stringify(body)}`;
      const expectedSig = 'v0=' + crypto
        .createHmac('sha256', secretToken)
        .update(message)
        .digest('hex');

      if (signature !== expectedSig) {
        console.warn('[Webhook] Invalid signature, rejecting');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    // 3. Handle recording.completed event
    if (body.event === 'recording.completed') {
      const payload = body.payload || {};
      const object = payload.object || {};
      const meetingId = object.uuid || object.id;
      const topic = object.topic || 'Unknown';
      const recordingFiles = object.recording_files || [];

      // Check if there's a transcript file
      const hasTranscript = recordingFiles.some(f =>
        f.file_type === 'TRANSCRIPT' || f.recording_type === 'audio_transcript'
      );

      console.log(`[Webhook] recording.completed: "${topic}" (${meetingId}) — ${recordingFiles.length} files, transcript: ${hasTranscript}`);

      // Respond immediately (Zoom expects 200 within 3 seconds)
      res.status(200).json({ received: true });

      // Process after a delay (transcript may need extra time)
      if (hasTranscript) {
        console.log(`[Webhook] Transcript available, processing in 30 seconds...`);
        setTimeout(() => {
          if (onRecordingCompleted) {
            onRecordingCompleted({ meetingId, topic, recordingFiles });
          }
        }, 30 * 1000);
      } else {
        console.log(`[Webhook] No transcript yet, will check again in 5 minutes...`);
        setTimeout(() => {
          if (onRecordingCompleted) {
            onRecordingCompleted({ meetingId, topic, recordingFiles });
          }
        }, 5 * 60 * 1000);
      }
      return;
    }

    // 4. Handle recording.transcript_completed (if subscribed)
    if (body.event === 'recording.transcript_completed') {
      const payload = body.payload || {};
      const object = payload.object || {};
      const meetingId = object.meeting_id || object.uuid;
      const topic = object.topic || 'Unknown';

      console.log(`[Webhook] recording.transcript_completed: "${topic}" (${meetingId})`);
      res.status(200).json({ received: true });

      // Process immediately — transcript is definitely ready
      setTimeout(() => {
        if (onRecordingCompleted) {
          onRecordingCompleted({ meetingId, topic });
        }
      }, 10 * 1000); // 10 second grace period
      return;
    }

    // 5. Unknown event — acknowledge but ignore
    console.log(`[Webhook] Unknown event: ${body.event}`);
    res.status(200).json({ received: true, event: body.event });
  };
}
