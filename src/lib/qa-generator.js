/**
 * Q&A Generator — creates template-based answers for common meeting questions.
 * No LLM calls — built from structured data (summaries, action items, evals).
 */

function formatDate(dateStr) {
  if (!dateStr) return 'Unknown';
  try { return new Date(dateStr).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); }
  catch { return dateStr; }
}

function formatSummaryAnswer(meeting) {
  const date = formatDate(meeting.start_time);
  const duration = meeting.duration_minutes || '?';
  const client = meeting.client_name || 'Unknown Client';

  let answer = `The meeting on ${date} with ${client} lasted ${duration} minutes.\n\n`;
  if (meeting.meeting_summary) {
    answer += meeting.meeting_summary;
  } else {
    answer += 'No detailed summary available for this meeting.';
  }
  return answer;
}

function formatActionItemsAnswer(meeting, items) {
  const date = formatDate(meeting.start_time);
  if (items.length === 0) {
    return `No action items were recorded from the ${date} meeting with ${meeting.client_name || 'this client'}.`;
  }

  let answer = `${items.length} action item${items.length > 1 ? 's' : ''} from the ${date} meeting:\n\n`;
  for (const item of items) {
    const status = (item.status || 'open').toUpperCase();
    const owner = item.owner_name || 'TBD';
    const priority = item.priority ? ` [${item.priority}]` : '';
    answer += `- [${status}] ${item.title} — Owner: ${owner}${priority}\n`;
  }
  return answer;
}

function formatSentimentAnswer(meeting, eval_) {
  const date = formatDate(meeting.start_time);
  const composite = eval_.composite_score || 0;
  const sentiment = eval_.client_sentiment || 0;
  const accountability = eval_.accountability || 0;

  let trend = composite >= 75 ? 'positive' : composite >= 50 ? 'moderate' : 'concerning';

  let answer = `Session evaluation for the ${date} meeting with ${meeting.client_name || 'this client'}:\n\n`;
  answer += `- **Composite Score:** ${composite}/100 (${trend})\n`;
  answer += `- **Client Sentiment:** ${sentiment}/100\n`;
  answer += `- **Accountability:** ${accountability}/100\n`;

  if (eval_.wins) answer += `\n**Wins:** ${eval_.wins}\n`;
  if (eval_.improvements) answer += `**Areas for Improvement:** ${eval_.improvements}\n`;
  if (eval_.coaching_notes) answer += `**Coaching Notes:** ${eval_.coaching_notes}\n`;

  return answer;
}

function formatDecisionsAnswer(meeting, decisions) {
  const date = formatDate(meeting.start_time);
  let answer = `${decisions.length} decision${decisions.length > 1 ? 's' : ''} recorded from the ${date} meeting:\n\n`;
  for (const d of decisions) {
    answer += `- ${d.decision}`;
    if (d.context) answer += ` (Context: ${d.context})`;
    answer += '\n';
  }
  return answer;
}

function formatNextStepsAnswer(meeting, openItems) {
  const date = formatDate(meeting.start_time);
  let answer = `Next steps from the ${date} meeting with ${meeting.client_name || 'this client'}:\n\n`;
  for (const item of openItems) {
    const owner = item.owner_name || 'TBD';
    const status = item.status === 'on-agenda' ? ' (on agenda)' : '';
    answer += `- ${item.title} — Owner: ${owner}${status}\n`;
  }
  return answer;
}

function formatCommitmentsAnswer(meeting, items) {
  const date = formatDate(meeting.start_time);
  if (items.length === 0) {
    return `No specific commitments were tracked from the ${date} meeting.`;
  }

  let answer = `Commitments from the ${date} meeting with ${meeting.client_name || 'this client'}:\n\n`;
  for (const item of items) {
    const owner = item.owner_name || 'TBD';
    answer += `- ${owner}: ${item.title}\n`;
  }
  return answer;
}

/**
 * Generate standard Q&A pairs for a meeting (no LLM call)
 */
export function generateMeetingQA(db, meetingId) {
  const meeting = db.prepare(
    'SELECT id, topic, start_time, duration_minutes, meeting_summary, client_name, client_id FROM meetings WHERE id = ?'
  ).get(meetingId);
  if (!meeting) return [];

  const items = db.prepare('SELECT title, owner_name, status, priority FROM action_items WHERE meeting_id = ?').all(meetingId);
  const eval_ = db.prepare('SELECT * FROM session_evaluations WHERE meeting_id = ?').get(meetingId);
  const decisions = db.prepare('SELECT decision, context FROM decisions WHERE meeting_id = ?').all(meetingId);

  const qaPairs = [];

  // 1. Summary (always)
  qaPairs.push({
    question_type: 'summary',
    question: 'What was discussed in this meeting?',
    answer: formatSummaryAnswer(meeting)
  });

  // 2. Action Items (always)
  qaPairs.push({
    question_type: 'action_items',
    question: 'What action items came from this meeting?',
    answer: formatActionItemsAnswer(meeting, items)
  });

  // 3. Sentiment (if eval exists)
  if (eval_) {
    qaPairs.push({
      question_type: 'sentiment',
      question: 'What was the client sentiment in this meeting?',
      answer: formatSentimentAnswer(meeting, eval_)
    });
  }

  // 4. Decisions (if any)
  if (decisions.length > 0) {
    qaPairs.push({
      question_type: 'key_decisions',
      question: 'What decisions were made in this meeting?',
      answer: formatDecisionsAnswer(meeting, decisions)
    });
  }

  // 5. Next Steps (if open items)
  const openItems = items.filter(i => i.status === 'open' || i.status === 'on-agenda');
  if (openItems.length > 0) {
    qaPairs.push({
      question_type: 'next_steps',
      question: 'What are the next steps from this meeting?',
      answer: formatNextStepsAnswer(meeting, openItems)
    });
  }

  // 6. Commitments (always)
  qaPairs.push({
    question_type: 'commitments',
    question: 'What commitments were made in this meeting?',
    answer: formatCommitmentsAnswer(meeting, items)
  });

  return qaPairs;
}

/**
 * Save Q&A pairs to DB
 */
export function saveQA(db, meetingId, qaPairs) {
  const stmt = db.prepare('INSERT OR REPLACE INTO meeting_qa_cache (meeting_id, question_type, question, answer) VALUES (?, ?, ?, ?)');
  const tx = db.transaction(() => {
    for (const qa of qaPairs) {
      stmt.run(meetingId, qa.question_type, qa.question, qa.answer);
    }
  });
  tx();
}
