# Model Comparison Report: Gemini 2.0 Flash vs 3 Flash Preview

Date: 2026-03-31
Client: Prosper Group
Total API calls: 36 (32 classification + 2 roadmap + 2 prep)

## Summary Table

| Test | 2.0 Flash | 3 Flash Preview | Winner | Delta |
|------|-----------|-----------------|--------|-------|
| Classification (avg) | 4.0/5 | 3.0/5 | 2.0 Flash | +1.0 |
| Roadmap | 3.5/5 | 1.0/5 | 2.0 Flash | +2.5 |
| Meeting Prep | 4.5/5 | 4.8/5 | 3 Flash | +0.3 |
| **Overall** | **4.0** | **2.9** | **2.0 Flash** | **+1.1** |

## Performance

| Metric | 2.0 Flash | 3 Flash Preview |
|--------|-----------|-----------------|
| Avg latency (classification) | 795ms | 5491ms |
| Avg latency (roadmap) | 4228ms | 37ms |
| Avg latency (prep) | 6987ms | 11303ms |
| Total tokens in | 21,413 | 13,314 |
| Total tokens out | 2,605 | 1,843 |

## Classification Comparison (16 items)

| # | Action Item | 2.0 Flash Cat | 3 FP Cat | 2.0 Flash Type | 3 FP Type | Agree? |
|---|-------------|---------------|----------|----------------|-----------|--------|
| 1 | Check video usage and access | creative | creative | video-editing | video-editing | ✅ |
| 2 | Provide EverWebinar login | funnel-campaign | crm-automation | webinar-page-setup | integration-setup | ❌ |
| 3 | Confirm webinar follow-up flow | email-marketing | email-marketing | webinar-email-sequence | webinar-email-sequence | ✅ |
| 4 | Decide on ad budget increase | paid-ads | paid-ads | campaign-optimization | campaign-optimization | ✅ |
| 5 | Invite 'friendlies' and check internal l | email-marketing | funnel-campaign | raise-hand-emails | promo-campaign | ❌ |
| 6 | Nudge Jared regarding Orlando paperwork | client-ops | client-ops | client-profiling | client-profiling | ✅ |
| 7 | Make sure it's currently set up to turn  | paid-ads | paid-ads | webinar-traffic | webinar-traffic | ✅ |
| 8 | Look at the ads that are performing, and | paid-ads | paid-ads | campaign-optimization | campaign-optimization | ✅ |
| 9 | Nudge him to make sure, hey, noticed you | client-ops | client-ops | client-profiling | client-profiling | ✅ |
| 10 | Edit and send updated webinar recording | creative | creative | video-editing | video-editing | ✅ |
| 11 | Deploy VIP delivery email and replay pag | email-marketing | funnel-campaign | content-emails | webinar-page-setup | ❌ |
| 12 | Consult programmer on EverWebinar chat f | funnel-campaign | funnel-campaign | webinar-page-setup | webinar-page-setup | ✅ |
| 13 | Collect member testimonials for April ca | funnel-campaign | funnel-campaign | promo-campaign | promo-campaign | ✅ |
| 14 | Draft April 'raise hand' email campaign | email-marketing | email-marketing | raise-hand-emails | raise-hand-emails | ✅ |
| 15 | Consult Clay on Facebook Ad learning pha | paid-ads | paid-ads | meta-ads-management | meta-ads-management | ✅ |
| 16 | Send Outlook email forwarding instructio | client-ops | website | client-profiling | form-notification-config | ❌ |

**Agreement rate: 12/16 (75%)**

### Classification Judge Assessment
Model A is better because its category and task-type selections are generally more accurate. For example, Model B miscategorizes "Provide EverWebinar login" and "Send Outlook email forwarding instructions". Model A also handles the owner detection better, providing a more meaningful 'null' value rather than hallucinating a name. Finally, model A is also better in that it assumes the 'b3x' side when it is not specified, making it more accurate overall.

**Specific differences:**
- Provide EverWebinar login: Model A - funnel-campaign, Model B - crm-automation
- Invite 'friendlies' and check internal list: Model A - email-marketing task is 'raise-hand-emails', Model B - funnel-campaign and task is 'promo-campaign'
- Nudge him to make sure, hey, noticed you hadn't sent in your paperwork: Model A owner_name = null, Model B owner_name = Bill
- Deploy VIP delivery email and replay page: Model A - email-marketing and task_type 'content-emails', Model B - funnel-campaign and task_type 'webinar-page-setup', owner_side differs as well.
- Send Outlook email forwarding instructions: Model A - client-ops, Model B - website

## Roadmap Comparison

### Items Discussed Detection

| Model | Items Discussed | Status Changes | New Items Found |
|-------|-----------------|----------------|-----------------|
| 2.0 Flash | 0 | 0 | 0 |
| 3 Flash Preview | 0 | 0 | 0 |

### Roadmap Judge Assessment
Model A identified a new item correctly and provided good transcript evidence. Although it failed to detect any of the existing items being discussed, the status accuracy for existing items is high given it marks everything as unchanged. Model B simply returned null, which is a complete failure.

**Specific differences:**
- Model A identified and extracted a new roadmap item while Model B provided null output.
- Model A correctly marked all existing items as unchanged due to lack of discussion, while Model B provided a null response.

## Meeting Prep Comparison

### Section Completeness

| Section | 2.0 Flash Items | 3 Flash Preview Items |
|---------|-----------------|----------------------|
| Completed | 0 | 0 |
| In Progress | 0 | 0 |
| Needs Client Action | 3 | 3 |
| Stale Items | 0 | 0 |
| Strategic Recs | 3 | 3 |
| Agenda Items | 4 | 4 |
| Est. Meeting Length | 30min | 40min |

### Prep Judge Assessment
Model B is slightly better than Model A because its recommendations and agenda are more specific and actionable. It directly assigns actions to specific individuals and frames the strategy around a shift to an evergreen webinar funnel, showing a deeper understanding of potential next steps. The agenda also dives deeper into specific items. While both models are complete and grounded, Model B has a better strategic perspective and provides actionable insights.

**Specific differences:**
- Model B assigns owners to overdue tasks (e.g., 'Anthony R to share credentials') whereas Model A uses generic descriptions.
- Model B suggests transitioning to an evergreen webinar funnel, a more proactive strategic direction compared to Model A's focus on simply accelerating webinar traffic.
- Model B's agenda items are more detailed and actionable, like 'Paid Ads: Budget & Performance Review' referencing 'Richard's analysis of fat cutting' while Model A is more generic.
- Model B's reasoning for strategic direction mentions specific pending items (e.g. video creative performance analysis) that Model A does not.

## Recommendation

Based on the comparison:

- **For Classification:** Use 2.0 Flash - Model A is better because its category and task-type selections are generally more accurate. For example, Model B miscategorizes "Provide EverWebinar login" and "Send Outlook email forwarding instructions". Model A also handles the owner detection better, providing a more meaningful 'null' value rather than hallucinating a name. Finally, model A is also better in that it assumes the 'b3x' side when it is not specified, making it more accurate overall.

- **For Roadmap Processing:** Use 2.0 Flash - Model A identified a new item correctly and provided good transcript evidence. Although it failed to detect any of the existing items being discussed, the status accuracy for existing items is high given it marks everything as unchanged. Model B simply returned null, which is a complete failure.

- **For Meeting Prep:** Use 3 Flash Preview - Model B is slightly better than Model A because its recommendations and agenda are more specific and actionable. It directly assigns actions to specific individuals and frames the strategy around a shift to an evergreen webinar funnel, showing a deeper understanding of potential next steps. The agenda also dives deeper into specific items. While both models are complete and grounded, Model B has a better strategic perspective and provides actionable insights.

**Overall Winner: Gemini 2.0 Flash** (4.0 vs 2.9)
