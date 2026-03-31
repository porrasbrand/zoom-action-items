# Model Comparison Report: Gemini 2.0 Flash vs 3 Flash Preview

Date: 2026-03-31
Client: Prosper Group
Total API calls: 36 (32 classification + 2 roadmap + 2 prep)

## Summary Table

| Test | 2.0 Flash | 3 Flash Preview | Winner | Delta |
|------|-----------|-----------------|--------|-------|
| Classification (avg) | 4.0/5 | 3.0/5 | 2.0 Flash | +1.0 |
| Roadmap | 3.5/5 | 4.5/5 | 3 Flash | +1.0 |
| Meeting Prep | 4.3/5 | 4.3/5 | tie | +0.0 |
| **Overall** | **3.9** | **3.9** | **Tie** | **+0.0** |

## Performance

| Metric | 2.0 Flash | 3 Flash Preview |
|--------|-----------|-----------------|
| Avg latency (classification) | 804ms | 5762ms |
| Avg latency (roadmap) | 5657ms | 23594ms |
| Avg latency (prep) | 7123ms | 11224ms |
| Total tokens in | 21,413 | 21,431 |
| Total tokens out | 2,909 | 3,474 |

## Classification Comparison (16 items)

| # | Action Item | 2.0 Flash Cat | 3 FP Cat | 2.0 Flash Type | 3 FP Type | Agree? |
|---|-------------|---------------|----------|----------------|-----------|--------|
| 1 | Check video usage and access | creative | creative | video-editing | video-editing | ✅ |
| 2 | Provide EverWebinar login | funnel-campaign | crm-automation | webinar-page-setup | integration-setup | ❌ |
| 3 | Confirm webinar follow-up flow | email-marketing | email-marketing | webinar-email-sequence | webinar-email-sequence | ✅ |
| 4 | Decide on ad budget increase | paid-ads | paid-ads | campaign-optimization | campaign-optimization | ✅ |
| 5 | Invite 'friendlies' and check internal l | funnel-campaign | email-marketing | webinar-page-setup | content-emails | ❌ |
| 6 | Nudge Jared regarding Orlando paperwork | client-ops | client-ops | client-profiling | client-profiling | ✅ |
| 7 | Make sure it's currently set up to turn  | paid-ads | paid-ads | webinar-traffic | webinar-traffic | ✅ |
| 8 | Look at the ads that are performing, and | paid-ads | paid-ads | campaign-optimization | campaign-optimization | ✅ |
| 9 | Nudge him to make sure, hey, noticed you | client-ops | client-ops | client-profiling | client-profiling | ✅ |
| 10 | Edit and send updated webinar recording | creative | creative | video-editing | video-editing | ✅ |
| 11 | Deploy VIP delivery email and replay pag | email-marketing | email-marketing | content-emails | webinar-email-sequence | ❌ |
| 12 | Consult programmer on EverWebinar chat f | funnel-campaign | funnel-campaign | webinar-page-setup | webinar-page-setup | ✅ |
| 13 | Collect member testimonials for April ca | funnel-campaign | funnel-campaign | promo-campaign | promo-campaign | ✅ |
| 14 | Draft April 'raise hand' email campaign | email-marketing | email-marketing | raise-hand-emails | raise-hand-emails | ✅ |
| 15 | Consult Clay on Facebook Ad learning pha | paid-ads | paid-ads | meta-ads-management | meta-ads-management | ✅ |
| 16 | Send Outlook email forwarding instructio | client-ops | website | client-profiling | form-notification-config | ❌ |

**Agreement rate: 12/16 (75%)**

### Classification Judge Assessment
Model A's category and task_type classifications are more accurate overall. Owner detection is also slightly better. For instance, Model B incorrectly categorized 'Provide EverWebinar login' as 'crm-automation' and changed many `owner_side` classifications. Model A, although not perfect, provides better task category selection and assignment of owners.

**Specific differences:**
- Model B categorized 'Provide EverWebinar login' as 'crm-automation', Model A categorized it as 'funnel-campaign'. Model A is better.
- Model B classified the 1st task 'Check video usage and access' under client instead of b3x.
- Model B classified task #3 'Confirm webinar follow-up flow' under client instead of b3x.
- Model B classified the 5th task 'Invite friendlies' under email-marketing instead of funnel-campaign.
- Model B classified the 9th task owner_name as Bill instead of Null.
- Model B incorrectly classified 'Send Outlook email forwarding instructions' under 'website' instead of 'client-ops' and changed the 'task_type' and 'owner_side'.
- Model B misclassified some owner sides, which Model A had correct

## Roadmap Comparison

### Items Discussed Detection

| Model | Items Discussed | Status Changes | New Items Found |
|-------|-----------------|----------------|-----------------|
| 2.0 Flash | 1 | 0 | 6 |
| 3 Flash Preview | 4 | 4 | 6 |

### Roadmap Judge Assessment
Model B demonstrates superior performance in detecting discussed items and deriving accurate status changes with supporting evidence. While both models identify new items effectively, Model B's classifications and overall accuracy in reflecting the meeting's outcomes are stronger.

**Specific differences:**
- Model B more accurately detects which existing roadmap items were discussed in the meeting.
- Model B provides more granular status updates (e.g., 'in-progress', 'done') with relevant transcript evidence, while Model A mostly indicates 'unchanged'.
- Model B extracts a greater number of new actionable items from the meeting transcript.
- Model A fails to update roadmap item 10 although it is the basis of a new item
- Model A extracts 2 updates related to incorporating the webinar reply, model B incorporates them as a VIP update for the webinar.

## Meeting Prep Comparison

### Section Completeness

| Section | 2.0 Flash Items | 3 Flash Preview Items |
|---------|-----------------|----------------------|
| Completed | 0 | 0 |
| In Progress | 0 | 2 |
| Needs Client Action | 3 | 3 |
| Stale Items | 0 | 0 |
| Strategic Recs | 3 | 3 |
| Agenda Items | 4 | 4 |
| Est. Meeting Length | 30min | 30min |

### Prep Judge Assessment
Both models produce high-quality outputs that are comparable. They both present a complete status report, highlight strategic opportunities, and provide a suggested agenda. The actionability is high for both, making them effective meeting preparation tools.

**Specific differences:**
- Model B lists assignees of client overdue items, which could be slightly more actionable. Model B lists ETAs for In Progress items.
- Model A's strategic proposal reasoning connects directly to a specific action item, making it slightly more grounded.
- Model B's strategic item 'Unblock Funnel Infrastructure' is very direct and specific, indicating a clear, immediate priority.

## Recommendation

Based on the comparison:

- **For Classification:** Use 2.0 Flash - Model A's category and task_type classifications are more accurate overall. Owner detection is also slightly better. For instance, Model B incorrectly categorized 'Provide EverWebinar login' as 'crm-automation' and changed many `owner_side` classifications. Model A, although not perfect, provides better task category selection and assignment of owners.

- **For Roadmap Processing:** Use 3 Flash Preview - Model B demonstrates superior performance in detecting discussed items and deriving accurate status changes with supporting evidence. While both models identify new items effectively, Model B's classifications and overall accuracy in reflecting the meeting's outcomes are stronger.

- **For Meeting Prep:** Use either (tie) - Both models produce high-quality outputs that are comparable. They both present a complete status report, highlight strategic opportunities, and provide a suggested agenda. The actionability is high for both, making them effective meeting preparation tools.

**Overall Winner: Tie** (3.9 vs 3.9)
