/**
 * Misc reusable helpers. Add carefully — keep this file small.
 */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Weekday name in UTC. Used by the description-styler scaffold so the
 * greeting (`<owner> - Happy <weekday>!`) is deterministic and never
 * hallucinated by the LLM.
 */
export function weekdayName(date = new Date()) {
  return WEEKDAYS[date.getUTCDay()];
}
