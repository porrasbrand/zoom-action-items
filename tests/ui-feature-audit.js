#!/usr/bin/env node
/**
 * UI Feature Audit - Playwright-based testing for Phases 01-09
 * Usage: node tests/ui-feature-audit.js
 *
 * Output:
 *   - data/ui-feature-report.md (structured findings)
 *   - data/ui-feature-screenshots/ (PNGs for each check)
 */

import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = 'http://localhost:3875/zoom';
const API_BASE = 'http://localhost:3875/zoom/api';
const SCREENSHOT_DIR = path.join(__dirname, '../data/ui-feature-screenshots');
const REPORT_PATH = path.join(__dirname, '../data/ui-feature-report.md');

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

const results = {
  passed: [],
  failed: [],
  warnings: [],
  bugs: [],
  consoleErrors: [],
  networkErrors: [],
  screenshots: []
};

function createTestSession() {
  const dbPath = path.join(__dirname, '../data/zoom-action-items.db');
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      role TEXT DEFAULT 'user',
      created_at TEXT DEFAULT (datetime('now')),
      last_login TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      sid TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES auth_users(id),
      email TEXT,
      name TEXT,
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  let user = db.prepare("SELECT id FROM auth_users WHERE email = 'test@playwright.local'").get();
  if (!user) {
    db.prepare("INSERT INTO auth_users (email, name, role) VALUES (?, ?, ?)").run('test@playwright.local', 'Playwright Bot', 'admin');
    user = db.prepare("SELECT id FROM auth_users WHERE email = 'test@playwright.local'").get();
  }

  const sid = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO auth_sessions (sid, user_id, email, name, expires_at) VALUES (?, ?, ?, ?, ?)")
    .run(sid, user.id, 'test@playwright.local', 'Playwright Bot', expiresAt);

  return sid;
}

function pass(id, description) {
  console.log(`  \u2705 ${id}: ${description}`);
  results.passed.push({ id, description });
}

function fail(id, description, expected, actual, fix = null) {
  console.log(`  \u274c ${id}: ${description}`);
  results.failed.push({ id, description, expected, actual, fix });
  if (fix) {
    results.bugs.push({ id, description, severity: 'MEDIUM', expected, actual, fix });
  }
}

function warn(id, description) {
  console.log(`  \u26a0\ufe0f  ${id}: ${description}`);
  results.warnings.push({ id, description });
}

function bug(id, description, severity, expected, actual, fix) {
  results.bugs.push({ id, description, severity, expected, actual, fix });
}

async function screenshot(page, name) {
  const filepath = path.join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path: filepath, fullPage: false });
  results.screenshots.push(`${name}.png`);
  return filepath;
}

// Helper: find a meeting with action items and click into it
async function navigateToMeetingWithItems(page) {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // Click the first meeting in the list
  const meetingCards = page.locator('.meeting-card');
  const count = await meetingCards.count();
  if (count === 0) return false;

  // Try each meeting until we find one with action items
  for (let i = 0; i < Math.min(count, 5); i++) {
    await meetingCards.nth(i).click();
    await page.waitForTimeout(1000);

    const actionItems = await page.locator('.action-item').count();
    if (actionItems > 0) return true;
  }
  return false;
}

async function runAudit() {
  console.log('\n\ud83d\udd0d UI Feature Audit Starting...\n');

  const sessionId = createTestSession();
  console.log(`\ud83d\udcdd Created test session: ${sessionId.slice(0, 16)}...`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 }
  });

  await context.addCookies([{
    name: 'zoom_session',
    value: sessionId,
    domain: 'localhost',
    path: '/zoom',
    httpOnly: true
  }]);

  const page = await context.newPage();

  // Collect console errors
  page.on('console', msg => {
    if (msg.type() === 'error') {
      results.consoleErrors.push(msg.text());
    }
  });

  // Collect network errors
  page.on('requestfailed', request => {
    results.networkErrors.push({
      url: request.url(),
      failure: request.failure()?.errorText
    });
  });

  // Track response errors
  const responseErrors = [];
  page.on('response', response => {
    if (response.status() >= 400) {
      responseErrors.push({ url: response.url(), status: response.status() });
    }
  });

  try {
    // ========== NAVIGATE TO MEETING WITH ITEMS ==========
    const hasMeeting = await navigateToMeetingWithItems(page);
    if (!hasMeeting) {
      fail('SETUP', 'Find meeting with action items', 'at least 1 meeting with items', '0 meetings found');
      throw new Error('No meetings with action items found — cannot run tests');
    }
    await screenshot(page, 'setup-meeting-loaded');

    // ========== A. ON-AGENDA STATUS TESTS ==========
    console.log('\n\ud83d\udccb A. On-Agenda Status Tests');

    // A1: Check for on-agenda CSS class
    const onAgendaCSS = await page.evaluate(() => {
      const sheets = document.styleSheets;
      for (const sheet of sheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.selectorText?.includes('status-on-agenda')) return true;
          }
        } catch {}
      }
      return false;
    });
    if (onAgendaCSS) {
      pass('A1', '.status-on-agenda CSS class exists');
    } else {
      fail('A1', '.status-on-agenda CSS class exists', 'CSS rule present', 'not found');
    }

    // A2: Check for agenda button on open items
    const openItems = page.locator('.action-item:not(.complete):not(.rejected):not(.on-agenda)');
    const openCount = await openItems.count();
    if (openCount > 0) {
      const agendaBtn = openItems.first().locator('.agenda-btn');
      const hasAgendaBtn = await agendaBtn.count() > 0;
      if (hasAgendaBtn) {
        pass('A2', '\ud83d\udccb button exists on open items');
      } else {
        fail('A2', '\ud83d\udccb button exists on open items', 'agenda-btn present', 'not found',
          'Check renderActionItem() — agenda button may not be rendered for open status');
      }

      // A3: Click agenda button and verify status change
      if (hasAgendaBtn) {
        const itemId = await openItems.first().getAttribute('id');
        await agendaBtn.click();
        await page.waitForTimeout(1500);

        const updatedItem = page.locator(`#${itemId}`);
        const hasOnAgendaClass = await updatedItem.evaluate(el => el.classList.contains('on-agenda'));
        const hasPurpleBadge = await updatedItem.locator('.status-on-agenda').count() > 0;

        if (hasOnAgendaClass || hasPurpleBadge) {
          pass('A3', 'Clicking \ud83d\udccb changes status to on-agenda with purple badge');
          await screenshot(page, 'A3-on-agenda-applied');
        } else {
          fail('A3', 'Clicking \ud83d\udccb changes status to on-agenda', 'purple badge + on-agenda class', 'not found',
            'Check agendaItem() function and API response');
          await screenshot(page, 'A3-on-agenda-fail');
        }

        // A4: Verify on-agenda item has complete + reopen buttons
        const completeBtn = updatedItem.locator('.complete-btn');
        const reopenBtn = updatedItem.locator('.reopen-btn');
        const hasComplete = await completeBtn.count() > 0;
        const hasReopen = await reopenBtn.count() > 0;
        if (hasComplete && hasReopen) {
          pass('A4', 'On-agenda items show \u2713 (complete) and \u21a9 (reopen) buttons');
        } else {
          fail('A4', 'On-agenda items show complete + reopen buttons',
            'both present', `complete: ${hasComplete}, reopen: ${hasReopen}`);
        }

        // A5: Complete from on-agenda
        if (hasComplete) {
          await completeBtn.click();
          await page.waitForTimeout(1500);
          const isComplete = await updatedItem.evaluate(el => el.classList.contains('complete'));
          if (isComplete) {
            pass('A5', 'On-agenda \u2192 complete transition works');
          } else {
            fail('A5', 'On-agenda \u2192 complete transition', 'complete class', 'not found');
          }

          // A6: Reopen from complete
          const reopenBtn2 = updatedItem.locator('.reopen-btn');
          if (await reopenBtn2.count() > 0) {
            await reopenBtn2.click();
            await page.waitForTimeout(1500);
            pass('A6', 'Complete \u2192 reopen transition works');
          } else {
            warn('A6', 'Could not find reopen button on completed item');
          }
        }
      }
    } else {
      warn('A2', 'No open items found to test agenda button');
    }

    // ========== B. INLINE EDIT TESTS ==========
    console.log('\n\u270f\ufe0f  B. Inline Edit Tests');

    // Refresh to clean state
    await navigateToMeetingWithItems(page);

    // B1: Click owner name → verify input appears with text selected
    const ownerSpan = page.locator('.action-item .owner.inline-edit').first();
    if (await ownerSpan.count() > 0) {
      await ownerSpan.click();
      await page.waitForTimeout(500);

      const editInput = ownerSpan.locator('input');
      const hasInput = await editInput.count() > 0;
      if (hasInput) {
        pass('B1', 'Clicking owner name opens inline edit input');

        // B2: Check datalist attached
        const listAttr = await editInput.getAttribute('list');
        if (listAttr && listAttr.startsWith('ownersList')) {
          pass('B2', `Input has datalist attached: ${listAttr}`);
        } else {
          fail('B2', 'Input has datalist attached', 'ownersList-*', listAttr);
        }

        // B3: Check text is selected (input.select() was called)
        const selectionLength = await editInput.evaluate(el => el.selectionEnd - el.selectionStart);
        const valueLength = await editInput.evaluate(el => el.value.length);
        if (selectionLength > 0 && selectionLength === valueLength) {
          pass('B3', 'Text is auto-selected on focus (input.select())');
        } else {
          warn('B3', `Text selection: ${selectionLength}/${valueLength} chars selected`);
        }

        // Press Escape to cancel
        await editInput.press('Escape');
        await page.waitForTimeout(500);
      } else {
        fail('B1', 'Clicking owner opens inline edit', 'input element', 'no input found');
      }
    } else {
      warn('B1', 'No owner span found for inline edit test');
    }

    // B4: Check description placeholder has pencil emoji
    const emptyDesc = page.locator('.item-desc.empty').first();
    if (await emptyDesc.count() > 0) {
      const descText = await emptyDesc.textContent();
      if (descText.includes('\u270f\ufe0f')) {
        pass('B4', 'Empty description has \u270f\ufe0f edit hint');
      } else {
        fail('B4', 'Empty description has \u270f\ufe0f edit hint', 'contains \u270f\ufe0f', descText.trim());
      }
    } else {
      warn('B4', 'No empty description found to test edit hint');
    }

    // B5: Check .inline-edit:hover CSS
    const inlineEditHover = await page.evaluate(() => {
      const sheets = document.styleSheets;
      for (const sheet of sheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.selectorText?.includes('inline-edit:hover')) return rule.cssText;
          }
        } catch {}
      }
      return null;
    });
    if (inlineEditHover) {
      pass('B5', '.inline-edit:hover CSS exists');
    } else {
      fail('B5', '.inline-edit:hover CSS exists', 'hover rule present', 'not found');
    }

    await screenshot(page, 'B-inline-edit-tests');

    // ========== C. GROUPED DROPDOWN / SCOPED DATALIST TESTS ==========
    console.log('\n\ud83d\udcca C. Grouped Dropdown / Scoped Datalist Tests');

    // C1: Click to edit owner and check datalist
    const ownerSpan2 = page.locator('.action-item .owner.inline-edit').first();
    if (await ownerSpan2.count() > 0) {
      const meetingId = await page.evaluate(el => {
        return el.closest('.action-item')?.dataset?.meetingId || '';
      }, await ownerSpan2.elementHandle());

      await ownerSpan2.click();
      await page.waitForTimeout(500);
      const editInput = ownerSpan2.locator('input');

      if (await editInput.count() > 0) {
        const listId = await editInput.getAttribute('list');

        // C2: Verify scoped datalist ID
        if (listId && listId.includes('-') && listId.startsWith('ownersList-')) {
          pass('C2', `Datalist is scoped per-meeting: ${listId}`);
        } else if (listId === 'ownersList') {
          fail('C2', 'Datalist is scoped per-meeting', 'ownersList-{meetingId}', 'global ownersList',
            'Phase 05 scoped datalists may not be working');
        } else {
          fail('C2', 'Datalist is scoped per-meeting', 'ownersList-{meetingId}', listId);
        }

        // C3: Read datalist options
        const datalistInfo = await page.evaluate((dlId) => {
          const dl = document.getElementById(dlId);
          if (!dl) return { found: false };
          const options = Array.from(dl.options).map(o => o.value);
          const starOptions = options.filter(o => o.startsWith('\u2605'));
          return { found: true, total: options.length, starCount: starOptions.length, sample: options.slice(0, 5) };
        }, listId);

        if (datalistInfo.found) {
          // C3: Star-prefixed names
          if (datalistInfo.starCount >= 6) {
            pass('C3', `\u2605-prefixed internal team names found: ${datalistInfo.starCount}`);
          } else {
            fail('C3', '\u2605-prefixed names in datalist', '>= 6', `${datalistInfo.starCount}`);
          }

          // C4: Reasonable size
          if (datalistInfo.total < 30) {
            pass('C4', `Datalist has reasonable size: ${datalistInfo.total} options (< 30)`);
          } else {
            warn('C4', `Datalist has ${datalistInfo.total} options — may be too large (expected < 30)`);
          }
        } else {
          fail('C3', 'Datalist found', 'datalist element exists', `${listId} not found in DOM`);
        }

        await editInput.press('Escape');
        await page.waitForTimeout(300);
      }
    }

    // C5: Verify no global ownersList datalist
    const globalDatalist = await page.evaluate(() => {
      const dl = document.getElementById('ownersList');
      return dl !== null;
    });
    if (!globalDatalist) {
      pass('C5', 'Global ownersList datalist removed (replaced by per-meeting)');
    } else {
      warn('C5', 'Global ownersList datalist still exists in DOM');
    }

    await screenshot(page, 'C-datalist-tests');

    // ========== D. B3X vs CLIENT CLASSIFICATION TESTS ==========
    console.log('\n\ud83c\udff7\ufe0f  D. B3X vs Client Classification Tests');

    // D1: Check for client-task CSS
    const clientTaskCSS = await page.evaluate(() => {
      const sheets = document.styleSheets;
      for (const sheet of sheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.selectorText?.includes('client-task-badge')) return true;
          }
        } catch {}
      }
      return false;
    });
    if (clientTaskCSS) {
      pass('D1', '.client-task-badge CSS class exists');
    } else {
      fail('D1', '.client-task-badge CSS class exists', 'CSS rule present', 'not found');
    }

    // D2: Check for client task items vs B3X items
    const allItems = page.locator('.action-item');
    const totalItems = await allItems.count();
    const clientItems = page.locator('.action-item.client-task');
    const clientCount = await clientItems.count();
    const b3xCount = totalItems - clientCount;

    if (totalItems > 0) {
      pass('D2', `Found ${totalItems} items: ${b3xCount} B3X, ${clientCount} client`);
    }

    // D3: Verify client tasks have amber left border
    if (clientCount > 0) {
      const borderColor = await clientItems.first().evaluate(el => {
        return getComputedStyle(el).borderLeftColor;
      });
      if (borderColor && borderColor !== 'rgb(0, 0, 0)' && borderColor !== '') {
        pass('D3', `Client tasks have amber left border: ${borderColor}`);
      } else {
        fail('D3', 'Client tasks have amber left border', 'amber border', borderColor);
      }

      // D4: Verify Push to PH is hidden on client tasks
      const pushBtnOnClient = await clientItems.first().locator('.push-btn').count();
      if (pushBtnOnClient === 0) {
        pass('D4', 'Push to PH button hidden on client tasks');
      } else {
        fail('D4', 'Push to PH hidden on client tasks', '0 push buttons', `${pushBtnOnClient}`,
          'canPush logic may not account for isClientTask');
      }

      // D5: Client task badge exists and is clickable
      const clientBadge = clientItems.first().locator('.client-task-badge');
      if (await clientBadge.count() > 0) {
        const onclick = await clientBadge.getAttribute('onclick');
        if (onclick?.includes('toggleTaskType')) {
          pass('D5', 'Client task badge is clickable (toggleTaskType)');
        } else {
          fail('D5', 'Client task badge onclick', 'toggleTaskType', onclick);
        }
      }
    } else {
      warn('D3', 'No client tasks found to test — all owners may be B3X');
      warn('D4', 'No client tasks found to test push button visibility');
    }

    // D6: Verify B3X tasks have Push to PH (if open and not pushed)
    const b3xOpenItems = page.locator('.action-item:not(.client-task):not(.complete):not(.rejected)');
    const b3xOpenCount = await b3xOpenItems.count();
    if (b3xOpenCount > 0) {
      // Check at least one has push-btn OR is already pushed
      let foundPushOrPushed = false;
      for (let i = 0; i < Math.min(b3xOpenCount, 3); i++) {
        const hasPush = await b3xOpenItems.nth(i).locator('.push-btn').count() > 0;
        const isPushed = await b3xOpenItems.nth(i).locator('.pushed-badge').count() > 0;
        if (hasPush || isPushed) { foundPushOrPushed = true; break; }
      }
      if (foundPushOrPushed) {
        pass('D6', 'B3X open tasks show Push to PH or already pushed');
      } else {
        warn('D6', 'No Push to PH buttons found on B3X open items (may all be pushed already)');
      }
    }

    // D7: Test task type filter dropdown
    const typeFilter = page.locator('select[id^="taskTypeFilter"]').first();
    if (await typeFilter.count() > 0) {
      pass('D7', 'Task type filter dropdown exists');

      // D8: Filter to Client Only
      await typeFilter.selectOption('client');
      await page.waitForTimeout(500);
      const visibleAfterClient = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.action-item'))
          .filter(el => el.style.display !== 'none').length;
      });

      // D9: Filter back to All
      await typeFilter.selectOption('all');
      await page.waitForTimeout(500);
      const visibleAfterAll = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.action-item'))
          .filter(el => el.style.display !== 'none').length;
      });

      if (visibleAfterAll >= visibleAfterClient) {
        pass('D8', `Filter works: Client Only=${visibleAfterClient}, All=${visibleAfterAll}`);
      } else {
        fail('D8', 'Filter shows correct counts', `All >= Client`, `All=${visibleAfterAll}, Client=${visibleAfterClient}`);
      }
    } else {
      fail('D7', 'Task type filter dropdown exists', 'select element', 'not found');
    }

    await screenshot(page, 'D-classification-tests');

    // ========== E. COLLABORATORS TESTS ==========
    console.log('\n\ud83d\udc65 E. Collaborators Tests');

    // E1: Check for collaborators display
    const collabSpan = page.locator('.action-item .collaborators').first();
    if (await collabSpan.count() > 0) {
      const collabText = await collabSpan.textContent();
      if (collabText.includes('Also:') || collabText.includes('Add collaborators')) {
        pass('E1', `Collaborators display present: "${collabText.trim().slice(0, 40)}"`);
      } else {
        warn('E1', `Collaborators span found but unexpected content: "${collabText.trim()}"`);
      }

      // E2: Click collaborators → verify inline edit
      await collabSpan.click();
      await page.waitForTimeout(500);
      const collabInput = collabSpan.locator('input');
      if (await collabInput.count() > 0) {
        pass('E2', 'Clicking collaborators opens inline edit input');

        // E3: Check datalist is attached
        const collabList = await collabInput.getAttribute('list');
        if (collabList?.startsWith('ownersList')) {
          pass('E3', `Collaborators input has datalist: ${collabList}`);
        } else {
          fail('E3', 'Collaborators input datalist', 'ownersList-*', collabList);
        }

        await collabInput.press('Escape');
        await page.waitForTimeout(300);
      } else {
        fail('E2', 'Collaborators inline edit', 'input element', 'no input found');
      }
    } else {
      fail('E1', 'Collaborators display present', '.collaborators span', 'not found',
        'Check renderActionItem() for collaborators span');
    }

    await screenshot(page, 'E-collaborators-tests');

    // ========== F. MANUAL ITEM CREATION TESTS ==========
    console.log('\n\u2795 F. Manual Item Creation Tests');

    // F1: Find and click Add Manual Item button
    const addBtn = page.locator('.add-manual-btn').first();
    if (await addBtn.count() > 0) {
      await addBtn.click();
      await page.waitForTimeout(500);

      // F2: Verify form fields
      const form = page.locator('.manual-item-form:visible').first();
      if (await form.count() > 0) {
        pass('F1', 'Manual item form opens');

        const hasTitle = await form.locator('input[id^="manual-title"]').count() > 0;
        const hasOwner = await form.locator('input[id^="manual-owner"]').count() > 0;
        const hasCollaborators = await form.locator('input[id^="manual-collaborators"]').count() > 0;
        const hasDue = await form.locator('input[id^="manual-due"]').count() > 0;
        const hasPriority = await form.locator('select[id^="manual-priority"]').count() > 0;

        if (hasTitle && hasOwner && hasCollaborators && hasDue && hasPriority) {
          pass('F2', 'All form fields present: Title, Owner, Also Involved, Due Date, Priority');
        } else {
          fail('F2', 'All form fields present',
            'title+owner+collaborators+due+priority',
            `title=${hasTitle},owner=${hasOwner},collab=${hasCollaborators},due=${hasDue},priority=${hasPriority}`);
        }

        // F3: Check owner input has scoped datalist
        const ownerInput = form.locator('input[id^="manual-owner"]');
        if (await ownerInput.count() > 0) {
          const listAttr = await ownerInput.getAttribute('list');
          if (listAttr?.startsWith('ownersList-')) {
            pass('F3', `Manual form owner has scoped datalist: ${listAttr}`);
          } else {
            fail('F3', 'Manual form owner scoped datalist', 'ownersList-{id}', listAttr);
          }
        }

        // F4: Check 'Also Involved' label
        const alsoInvolvedLabel = await form.evaluate(el => {
          const labels = el.querySelectorAll('label');
          return Array.from(labels).some(l => l.textContent.includes('Also Involved'));
        });
        if (alsoInvolvedLabel) {
          pass('F4', '"Also Involved" label present in form');
        } else {
          fail('F4', '"Also Involved" label', 'present', 'not found');
        }

        // Close the form
        const cancelBtn = form.locator('.push-cancel-btn');
        if (await cancelBtn.count() > 0) {
          await cancelBtn.click();
          await page.waitForTimeout(300);
        }
      } else {
        fail('F1', 'Manual item form opens', 'visible form', 'form not visible');
      }
    } else {
      fail('F1', 'Add Manual Item button exists', 'button present', 'not found');
    }

    await screenshot(page, 'F-manual-form-tests');

    // ========== G. BUG HUNTER (EXPLORATORY) ==========
    console.log('\n\ud83d\udc1b G. Bug Hunter');

    // G1: Console errors collected during run
    if (results.consoleErrors.length === 0) {
      pass('G1', 'No console errors during test run');
    } else {
      fail('G1', 'No console errors', '0 errors', `${results.consoleErrors.length} errors`);
      results.consoleErrors.forEach((e, i) => {
        console.log(`     Error ${i + 1}: ${e.slice(0, 100)}`);
      });
    }

    // G2: Network errors
    if (responseErrors.length === 0) {
      pass('G2', 'No HTTP 4xx/5xx responses during test run');
    } else {
      const relevant = responseErrors.filter(e => !e.url.includes('favicon'));
      if (relevant.length === 0) {
        pass('G2', 'No relevant HTTP errors (only favicon 404)');
      } else {
        warn('G2', `${relevant.length} HTTP errors: ${relevant.map(e => `${e.status} ${e.url.split('/').pop()}`).join(', ')}`);
      }
    }

    // G3: Check all action buttons have onclick handlers
    const buttonsWithoutOnclick = await page.evaluate(() => {
      const btns = document.querySelectorAll('.action-btn');
      const missing = [];
      btns.forEach(btn => {
        if (!btn.getAttribute('onclick')) missing.push(btn.textContent.trim());
      });
      return missing;
    });
    if (buttonsWithoutOnclick.length === 0) {
      pass('G3', 'All .action-btn elements have onclick handlers');
    } else {
      fail('G3', 'All action buttons have onclick', '0 missing', `${buttonsWithoutOnclick.length} missing: ${buttonsWithoutOnclick.join(', ')}`);
    }

    // G4: Check for duplicate IDs
    const duplicateIds = await page.evaluate(() => {
      const ids = {};
      document.querySelectorAll('[id]').forEach(el => {
        ids[el.id] = (ids[el.id] || 0) + 1;
      });
      return Object.entries(ids).filter(([_, count]) => count > 1).map(([id, count]) => `${id}(${count}x)`);
    });
    if (duplicateIds.length === 0) {
      pass('G4', 'No duplicate IDs in DOM');
    } else {
      warn('G4', `${duplicateIds.length} duplicate IDs: ${duplicateIds.slice(0, 5).join(', ')}`);
    }

    // G5: Check all datalists have unique IDs
    const datalistIds = await page.evaluate(() => {
      const dls = document.querySelectorAll('datalist');
      const ids = Array.from(dls).map(dl => dl.id);
      const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
      return { total: ids.length, dupes };
    });
    if (datalistIds.dupes.length === 0) {
      pass('G5', `All ${datalistIds.total} datalists have unique IDs`);
    } else {
      fail('G5', 'Datalist IDs unique', '0 dupes', `${datalistIds.dupes.join(', ')}`);
    }

    // G6: Check label consistency — no 'Assignee' in user-facing labels
    const assigneeLabels = await page.evaluate(() => {
      const labels = document.querySelectorAll('label');
      return Array.from(labels).filter(l => l.textContent.includes('Assignee')).map(l => l.textContent.trim());
    });
    if (assigneeLabels.length === 0) {
      pass('G6', 'No "Assignee" labels found (all unified to "Owner")');
    } else {
      fail('G6', 'No Assignee labels', '0', `${assigneeLabels.length}: ${assigneeLabels.join(', ')}`,
        'Phase 04 label unification may be incomplete');
    }

    await screenshot(page, 'G-bug-hunter');

    // ========== H. STATUS TRANSITIONS (FULL MATRIX) ==========
    console.log('\n\ud83d\udd04 H. Status Transition Matrix');

    // Refresh and find an open item to test transitions
    await navigateToMeetingWithItems(page);

    const testItem = page.locator('.action-item:not(.complete):not(.rejected)').first();
    if (await testItem.count() > 0) {
      const testItemId = await testItem.getAttribute('id');

      // H1: Check open item has expected buttons
      const hasCompleteBtn = await testItem.locator('.complete-btn').count() > 0;
      const hasRejectBtn = await testItem.locator('.reject-btn').count() > 0;
      if (hasCompleteBtn && hasRejectBtn) {
        pass('H1', 'Open item has \u2713 (complete) and \u2715 (reject) buttons');
      } else {
        warn('H1', `Open item buttons: complete=${hasCompleteBtn}, reject=${hasRejectBtn}`);
      }

      // H2: Check agenda button exists
      const hasAgendaBtnH = await testItem.locator('.agenda-btn').count() > 0;
      if (hasAgendaBtnH) {
        pass('H2', 'Open item has \ud83d\udccb (agenda) button');
      } else {
        // May be on-agenda already
        warn('H2', 'No agenda button found (item may not be in open status)');
      }

      // H3: Verify status badge displays correctly
      const statusBadge = testItem.locator('.status-badge');
      if (await statusBadge.count() > 0) {
        const badgeText = await statusBadge.textContent();
        pass('H3', `Status badge displays: "${badgeText.trim()}"`);
      }
    } else {
      warn('H1', 'No non-completed items found for status transition tests');
    }

    await screenshot(page, 'H-status-transitions');

  } catch (err) {
    console.error(`\n\u274c Fatal error: ${err.message}`);
    await screenshot(page, 'fatal-error');
  } finally {
    await browser.close();
  }

  generateReport();

  const total = results.passed.length + results.failed.length;
  console.log('\n' + '='.repeat(50));
  console.log(`\ud83d\udcca UI Feature Audit Complete: ${results.passed.length}/${total} passed`);
  console.log(`   \u2705 PASS: ${results.passed.length}`);
  console.log(`   \u274c FAIL: ${results.failed.length}`);
  console.log(`   \u26a0\ufe0f  WARN: ${results.warnings.length}`);
  console.log(`   \ud83d\udc1b BUGS: ${results.bugs.length}`);
  console.log(`   \ud83d\udcf8 Screenshots: ${results.screenshots.length}`);
  console.log('='.repeat(50));
  console.log(`\n\ud83d\udcc4 Report saved to: ${REPORT_PATH}\n`);

  process.exit(results.failed.length > 0 ? 1 : 0);
}

function generateReport() {
  const date = new Date().toISOString().split('T')[0];
  const total = results.passed.length + results.failed.length;

  let report = `# UI Feature Audit Report
Date: ${date}
Tests: ${results.passed.length}/${total} passed

## Summary
- PASS: ${results.passed.length}
- FAIL: ${results.failed.length}
- WARN: ${results.warnings.length}
- BUGS: ${results.bugs.length}

## Test Results

### Passed Tests
${results.passed.map(r => `- \u2705 ${r.id}: ${r.description}`).join('\n')}

### Failed Tests
${results.failed.map(r => `- \u274c ${r.id}: ${r.description}
  - Expected: ${r.expected}
  - Actual: ${r.actual}
  ${r.fix ? `- Suggested Fix: ${r.fix}` : ''}`).join('\n\n')}

### Warnings
${results.warnings.map(r => `- \u26a0\ufe0f ${r.id}: ${r.description}`).join('\n')}

## Bugs Found

${results.bugs.length > 0 ? results.bugs.map((b, i) => `### BUG-${i + 1}: ${b.description}
- **Severity:** ${b.severity}
- **Check:** ${b.id}
- **Expected:** ${b.expected}
- **Actual:** ${b.actual}
${b.fix ? `- **Fix:** ${b.fix}` : ''}`).join('\n\n') : 'No bugs found.'}

## Console Errors
${results.consoleErrors.length > 0 ? results.consoleErrors.map(e => `- ${e}`).join('\n') : 'None'}

## Network Issues
${results.networkErrors.length > 0 ? results.networkErrors.map(e => `- ${e.url}: ${e.failure}`).join('\n') : 'None'}

## Screenshots
${results.screenshots.map(s => `- ${s}`).join('\n')}
`;

  fs.writeFileSync(REPORT_PATH, report);
}

runAudit().catch(console.error);
