/**
 * Transcript Chunker — splits VTT transcripts into semantically meaningful chunks
 * for RAG retrieval. Uses hybrid speaker-turn grouping with size caps.
 *
 * Transcript format: [HH:MM:SS.mmm] Speaker Name: text content
 */

/**
 * Parse a raw VTT transcript into structured lines
 * @param {string} raw - Raw transcript text
 * @returns {Array<{timestamp: string, speaker: string, text: string}>}
 */
export function parseTranscript(raw) {
  if (!raw) return [];
  const lines = raw.split('\n').filter(l => l.trim());
  const parsed = [];

  for (const line of lines) {
    const match = line.match(/^\[(\d{2}:\d{2}:\d{2}\.\d{3})\]\s*(.+?):\s*(.+)$/);
    if (match) {
      parsed.push({
        timestamp: match[1],
        speaker: match[2].trim(),
        text: match[3].trim()
      });
    }
  }
  return parsed;
}

/**
 * Approximate token count (text length / 4)
 */
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Chunk a parsed transcript using hybrid speaker-turn + size cap strategy
 * @param {number} meetingId
 * @param {string} transcriptRaw
 * @param {string} clientId
 * @returns {Array<Object>} chunks ready for DB insertion
 */
export function chunkTranscript(meetingId, transcriptRaw, clientId) {
  const lines = parseTranscript(transcriptRaw);
  if (lines.length === 0) return [];

  // Step 1: Group consecutive lines from the same speaker into turns
  const turns = [];
  let currentTurn = null;

  for (const line of lines) {
    if (currentTurn && currentTurn.speaker === line.speaker) {
      currentTurn.text += ' ' + line.text;
      currentTurn.endTime = line.timestamp;
    } else {
      if (currentTurn) turns.push(currentTurn);
      currentTurn = {
        speaker: line.speaker,
        text: line.text,
        startTime: line.timestamp,
        endTime: line.timestamp
      };
    }
  }
  if (currentTurn) turns.push(currentTurn);

  // Step 2: Merge turns into chunks (~500 token target, split large turns)
  const chunks = [];
  let currentChunk = null;

  function pushChunk() {
    if (currentChunk && currentChunk.text.trim()) {
      currentChunk.tokenCount = estimateTokens(currentChunk.text);
      chunks.push(currentChunk);
    }
  }

  function newChunk(turn) {
    return {
      meetingId,
      clientId,
      chunkIndex: chunks.length,
      startTime: turn.startTime,
      endTime: turn.endTime,
      speakers: new Set([turn.speaker]),
      text: `${turn.speaker}: ${turn.text}`,
      tokenCount: 0
    };
  }

  for (const turn of turns) {
    const turnTokens = estimateTokens(turn.text);
    const turnText = `${turn.speaker}: ${turn.text}`;

    // Large turn (>800 tokens): split at sentence boundaries
    if (turnTokens > 800) {
      pushChunk();
      currentChunk = null;

      const sentences = turn.text.match(/[^.!?]+[.!?]+/g) || [turn.text];
      let sentenceChunk = '';

      for (const sentence of sentences) {
        if (estimateTokens(sentenceChunk + sentence) > 500 && sentenceChunk) {
          chunks.push({
            meetingId,
            clientId,
            chunkIndex: chunks.length,
            startTime: turn.startTime,
            endTime: turn.endTime,
            speakers: new Set([turn.speaker]),
            text: `${turn.speaker}: ${sentenceChunk.trim()}`,
            tokenCount: estimateTokens(sentenceChunk)
          });
          sentenceChunk = '';
        }
        sentenceChunk += sentence;
      }
      if (sentenceChunk.trim()) {
        chunks.push({
          meetingId,
          clientId,
          chunkIndex: chunks.length,
          startTime: turn.startTime,
          endTime: turn.endTime,
          speakers: new Set([turn.speaker]),
          text: `${turn.speaker}: ${sentenceChunk.trim()}`,
          tokenCount: estimateTokens(sentenceChunk)
        });
      }
      continue;
    }

    // Start a new chunk if none exists
    if (!currentChunk) {
      currentChunk = newChunk(turn);
      continue;
    }

    // Would adding this turn exceed 500 tokens?
    const combined = estimateTokens(currentChunk.text + '\n' + turnText);
    if (combined > 500) {
      pushChunk();
      currentChunk = newChunk(turn);
    } else {
      // Merge into current chunk
      currentChunk.text += '\n' + turnText;
      currentChunk.endTime = turn.endTime;
      currentChunk.speakers.add(turn.speaker);
    }
  }
  pushChunk();

  // Finalize: convert speaker Sets to JSON arrays, assign chunk indices
  return chunks.map((chunk, i) => ({
    meeting_id: chunk.meetingId,
    client_id: chunk.clientId || null,
    chunk_index: i,
    start_time: chunk.startTime,
    end_time: chunk.endTime,
    speakers: JSON.stringify([...chunk.speakers]),
    text: chunk.text,
    token_count: chunk.tokenCount
  }));
}

/**
 * Save chunks to the transcript_chunks table
 * @param {import('better-sqlite3').Database} db
 * @param {Array<Object>} chunks
 * @returns {Array<number>} inserted chunk IDs
 */
export function saveChunks(db, chunks) {
  const insert = db.prepare(`
    INSERT INTO transcript_chunks (meeting_id, client_id, chunk_index, start_time, end_time, speakers, text, token_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const ids = [];
  const insertMany = db.transaction((chunks) => {
    for (const chunk of chunks) {
      const result = insert.run(
        chunk.meeting_id,
        chunk.client_id,
        chunk.chunk_index,
        chunk.start_time,
        chunk.end_time,
        chunk.speakers,
        chunk.text,
        chunk.token_count
      );
      ids.push(result.lastInsertRowid);
    }
  });

  insertMany(chunks);
  return ids;
}

/**
 * Delete existing chunks for a meeting (for re-chunking)
 */
export function deleteChunksForMeeting(db, meetingId) {
  // Delete embeddings first (foreign key)
  db.prepare(`
    DELETE FROM transcript_embeddings WHERE chunk_id IN (
      SELECT id FROM transcript_chunks WHERE meeting_id = ?
    )
  `).run(meetingId);
  db.prepare('DELETE FROM transcript_chunks WHERE meeting_id = ?').run(meetingId);
}
