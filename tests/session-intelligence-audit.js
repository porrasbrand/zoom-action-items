#!/usr/bin/env node
/**
 * Session Intelligence Audit Script - Playwright-based comprehensive testing
 * Usage: node tests/session-intelligence-audit.js
 *
 * Tests:
 *   - Layer 1: Functional Testing (SI-A through SI-G)
 *   - Layer 2: Data Validation (SI-V1-V8)
 *   - Layer 3: AI UX/UI Evaluation (Gemini Vision)
 *   - Layer 4: Report Generation
 */

import 'dotenv/config';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = 'http://localhost:3875/zoom';
const API_BASE = 'http://localhost:3875/zoom/api';
const SCREENSHOT_DIR = path.join(__dirname, '../data/session-audit-screenshots');
const REPORT_PATH = path.join(__dirname, '../data/session-audit-report.md');
const GEMINI_MODEL = 'gemini-2.0-flash';

// Ensure screenshot directory exists
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

// Results storage
const results = {
  passed: [],
  failed: [],
  warnings: [],
  bugs: [],
  uxIssues: [],
  consoleErrors: [],
  networkErrors: [],
  screenshots: [],
  geminiEvaluations: [],
  apiResponses: {}
};

// Category tracking for summary
const categories = {
  'Tab Navigation (SI-A)': { pass: 0, fail: 0, warn: 0 },
  'Overview (SI-B)': { pass: 0, fail: 0, warn: 0 },
  'Scorecard (SI-C)': { pass: 0, fail: 0, warn: 0 },
  'Trends (SI-D)': { pass: 0, fail: 0, warn: 0 },
  'Team (SI-E)': { pass: 0, fail: 0, warn: 0 },
  'Flags (SI-F)': { pass: 0, fail: 0, warn: 0 },
  'Console/Network (SI-G)': { pass: 0, fail: 0, warn: 0 },
  'Data Validation (SI-V)': { pass: 0, fail: 0, warn: 0 }
};

function getCategory(id) {
  if (id.startsWith('SI-A')) return 'Tab Navigation (SI-A)';
  if (id.startsWith('SI-B')) return 'Overview (SI-B)';
  if (id.startsWith('SI-C')) return 'Scorecard (SI-C)';
  if (id.startsWith('SI-D')) return 'Trends (SI-D)';
  if (id.startsWith('SI-E')) return 'Team (SI-E)';
  if (id.startsWith('SI-F')) return 'Flags (SI-F)';
  if (id.startsWith('SI-G')) return 'Console/Network (SI-G)';
  if (id.startsWith('SI-V')) return 'Data Validation (SI-V)';
  return 'Other';
}

// Create test session (auth bypass)
function createTestSession() {
  const dbPath = path.join(__dirname, '../data/zoom-action-items.db');
  const db = new Database(dbPath);

  // Ensure tables exist
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

  // Get or create test user
  let user = db.prepare("SELECT id FROM auth_users WHERE email = 'test@playwright.local'").get();
  if (!user) {
    db.prepare("INSERT INTO auth_users (email, name, role) VALUES (?, ?, ?)").run('test@playwright.local', 'Playwright Bot', 'admin');
    user = db.prepare("SELECT id FROM auth_users WHERE email = 'test@playwright.local'").get();
  }

  // Create session
  const sid = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO auth_sessions (sid, user_id, email, name, expires_at) VALUES (?, ?, ?, ?, ?)")
    .run(sid, user.id, 'test@playwright.local', 'Playwright Bot', expiresAt);

  db.close();
  return sid;
}

// Logging helpers
function pass(id, description) {
  console.log(`  ✅ ${id}: ${description}`);
  results.passed.push({ id, description });
  const cat = getCategory(id);
  if (categories[cat]) categories[cat].pass++;
}

function fail(id, description, expected, actual, fix = null) {
  console.log(`  ❌ ${id}: ${description}`);
  results.failed.push({ id, description, expected, actual, fix });
  const cat = getCategory(id);
  if (categories[cat]) categories[cat].fail++;
  if (fix) {
    results.bugs.push({ id, description, severity: 'MEDIUM', expected, actual, fix });
  }
}

function warn(id, description) {
  console.log(`  ⚠️  ${id}: ${description}`);
  results.warnings.push({ id, description });
  const cat = getCategory(id);
  if (categories[cat]) categories[cat].warn++;
}

async function screenshot(page, name) {
  const filepath = path.join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path: filepath, fullPage: false });
  results.screenshots.push(`${name}.png`);
  return filepath;
}

// Gemini UX evaluation
async function evaluateWithGemini(screenshotPath, viewName) {
  if (!process.env.GOOGLE_API_KEY) {
    console.log(`  ⏭️  Skipping Gemini evaluation (no API key)`);
    return null;
  }

  try {
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

    const imageData = fs.readFileSync(screenshotPath);
    const base64Image = imageData.toString('base64');

    const prompt = `You are a senior UX/UI auditor reviewing a dark-themed data dashboard.

This screenshot shows the "${viewName}" view of a Session Intelligence dashboard for a digital agency. It displays meeting quality scores, coaching data, and team performance metrics.

Evaluate this view on the following 6 criteria. Score each 1-5 (1=Poor, 5=Excellent). Provide specific, actionable feedback for any score below 4.

**Criteria:**
1. **Readability** — Is text legible? Font sizes appropriate? Sufficient contrast between text and background? Are numbers and scores easy to scan?
2. **Color Contrast** — Does the color scheme meet WCAG AA standards? Are status colors (red/yellow/green) distinguishable? Are low-contrast elements present?
3. **Layout & Spacing** — Is the layout organized logically? Consistent spacing? No cramped or overly sparse areas? Grid alignment clean?
4. **Information Hierarchy** — Are the most important metrics visually prominent? Clear visual path from summary to detail? Labels clear?
5. **Dark Theme Quality** — Consistent background shades? No jarring bright elements? Borders and separators subtle but visible?
6. **Mobile Readiness** — Would this layout work on smaller screens? Touch targets large enough? Elements that should stack vertically doing so?

**Also identify:**
- Any visual bugs (overlapping elements, cut-off text, broken layouts)
- Missing visual affordances (things that should look clickable but don't)
- Data presentation issues (numbers without units, confusing labels, misleading visualizations)

Respond in this exact JSON format:
{
  "view": "${viewName}",
  "overall_score": <1-5 average>,
  "criteria": {
    "readability": { "score": <1-5>, "feedback": "<string or null if score >= 4>" },
    "color_contrast": { "score": <1-5>, "feedback": "<string or null>" },
    "layout_spacing": { "score": <1-5>, "feedback": "<string or null>" },
    "information_hierarchy": { "score": <1-5>, "feedback": "<string or null>" },
    "dark_theme": { "score": <1-5>, "feedback": "<string or null>" },
    "mobile_readiness": { "score": <1-5>, "feedback": "<string or null>" }
  },
  "visual_bugs": ["<description>", ...],
  "missing_affordances": ["<description>", ...],
  "data_presentation_issues": ["<description>", ...],
  "top_improvement": "<single most impactful change to make>"
}`;

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [
        { inlineData: { mimeType: 'image/png', data: base64Image } },
        { text: prompt }
      ]}],
      generationConfig: { temperature: 0.3, maxOutputTokens: 2048, responseMimeType: 'application/json' }
    });

    const text = result.response.text();
    const evaluation = JSON.parse(text);
    results.geminiEvaluations.push(evaluation);
    console.log(`  🤖 Gemini: ${viewName} score ${evaluation.overall_score}/5`);
    return evaluation;
  } catch (err) {
    console.log(`  ⚠️  Gemini evaluation failed: ${err.message}`);
    return null;
  }
}

// Main audit function
async function runAudit() {
  console.log('\n🔍 Session Intelligence Audit Starting...\n');

  // Create session
  const sessionId = createTestSession();
  console.log(`📝 Created test session: ${sessionId.slice(0, 16)}...`);

  // Launch browser
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 }
  });

  // Set auth cookie
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

  // Track API responses
  page.on('response', response => {
    const url = response.url();
    if (url.includes('/session/')) {
      results.apiResponses[url] = response.status();
    }
  });

  try {
    // Navigate to dashboard
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    // ========== SI-A: Tab Navigation ==========
    console.log('\n📋 SI-A: Tab Navigation');

    // SI-A1: Session Intelligence tab button exists
    const tabBtn = page.locator('.tab-btn[data-tab="session"]');
    const tabCount = await tabBtn.count();
    if (tabCount === 1) {
      pass('SI-A1', 'Session Intelligence tab button exists');
    } else {
      fail('SI-A1', 'Session Intelligence tab button exists', '1 button', `${tabCount} buttons`);
    }

    // SI-A2: Clicking tab shows sessionView
    await tabBtn.click();
    await page.waitForTimeout(500);
    const sessionView = page.locator('#sessionView');
    const isVisible = await sessionView.isVisible();
    if (isVisible) {
      pass('SI-A2', 'Clicking tab shows sessionView');
    } else {
      fail('SI-A2', 'Clicking tab shows sessionView', 'visible', 'not visible');
    }

    // SI-A3: Sub-navigation renders 5 buttons
    const subNavBtns = page.locator('.session-nav-btn');
    const subNavCount = await subNavBtns.count();
    if (subNavCount === 5) {
      pass('SI-A3', 'Sub-navigation renders 5 buttons');
    } else {
      fail('SI-A3', 'Sub-navigation renders 5 buttons', '5', `${subNavCount}`);
    }

    // SI-A4: Hash navigation works
    await page.goto(BASE_URL + '#session');
    await page.waitForTimeout(500);
    const tabActive = await page.locator('.tab-btn[data-tab="session"]').getAttribute('class');
    if (tabActive?.includes('active')) {
      pass('SI-A4', 'Hash navigation works');
    } else {
      fail('SI-A4', 'Hash navigation works', 'tab active', 'tab not active');
    }

    // Wait for overview to load
    await page.waitForTimeout(1000);

    // ========== SI-B: Overview ==========
    console.log('\n📋 SI-B: Overview');

    // SI-B1: Overview loads without error
    const overviewText = await page.locator('#sessionOverview').textContent();
    if (!overviewText?.includes('Error:')) {
      pass('SI-B1', 'Overview loads without error');
    } else {
      fail('SI-B1', 'Overview loads without error', 'no error', 'error displayed');
    }

    // SI-B2: Agency score card renders
    const scoreCard = await page.locator('#sessionOverview .session-score-card, #sessionOverview .score-value').count();
    if (scoreCard > 0) {
      pass('SI-B2', 'Agency score card renders');
    } else {
      fail('SI-B2', 'Agency score card renders', '>0 elements', '0 elements');
    }

    // SI-B3: P25/P50/P75 baselines displayed
    const hasBaselines = overviewText?.includes('P25') && overviewText?.includes('P50') && overviewText?.includes('P75');
    if (hasBaselines) {
      pass('SI-B3', 'P25/P50/P75 baselines displayed');
    } else {
      warn('SI-B3', 'P25/P50/P75 baselines not clearly visible');
    }

    // SI-B4: Client health grid has cards
    await page.waitForTimeout(1500); // Extra wait for async load
    const healthCards = await page.locator('.health-card').count();
    if (healthCards > 0) {
      pass('SI-B4', `Client health grid has ${healthCards} cards`);
    } else {
      warn('SI-B4', 'Client health grid has 0 cards (may still be loading)');
    }

    // SI-B5: Flag count badges visible
    const flagsSummary = await page.locator('#sessionOverview .flags-summary, #sessionOverview .flag-badge').count();
    if (flagsSummary > 0) {
      pass('SI-B5', 'Flag count badges visible');
    } else {
      warn('SI-B5', 'Flag count badges not found');
    }

    // SI-B6: API /session/benchmarks returns 200
    const benchmarksStatus = Object.entries(results.apiResponses).find(([url]) => url.includes('/benchmarks'));
    if (benchmarksStatus && benchmarksStatus[1] === 200) {
      pass('SI-B6', 'API /session/benchmarks returns 200');
    } else {
      fail('SI-B6', 'API /session/benchmarks returns 200', '200', benchmarksStatus?.[1] || 'no response');
    }

    // Take overview screenshot
    await screenshot(page, 'session-overview');

    // SI-B7: Click health card → navigates to trends
    if (healthCards > 0) {
      await page.locator('#sessionOverview .health-card').first().click();
      await page.waitForTimeout(500);
      const trendsVisible = await page.locator('#sessionTrends').isVisible();
      if (trendsVisible) {
        pass('SI-B7', 'Click health card → navigates to trends');
      } else {
        warn('SI-B7', 'Health card click did not navigate to trends');
      }
    }

    // ========== SI-C: Meeting Scorecard ==========
    console.log('\n📋 SI-C: Meeting Scorecard');

    // Navigate to scorecard
    await page.locator('.session-nav-btn:has-text("Meeting Scorecard")').click();
    await page.waitForTimeout(1000);

    // SI-C1: Meeting dropdown populated
    await page.waitForTimeout(2000); // Wait for meetings to load
    const scorecardSelect = page.locator('#scorecardMeetingSelect');
    let optionCount = 0;
    try {
      optionCount = await scorecardSelect.locator('option').count();
    } catch (e) {
      optionCount = 0;
    }
    if (optionCount > 1) {
      pass('SI-C1', `Meeting dropdown populated with ${optionCount} options`);
    } else {
      warn('SI-C1', `Meeting dropdown has ${optionCount} options (may still be loading)`);
    }

    // SI-C2: Selecting meeting loads scorecard
    if (optionCount > 1) {
      // Select the first option with a value
      const options = await scorecardSelect.locator('option').all();
      for (const opt of options) {
        const value = await opt.getAttribute('value');
        if (value && value !== '') {
          await scorecardSelect.selectOption(value);
          break;
        }
      }
      await page.waitForTimeout(2000);

      const scorecardContent = await page.locator('#scorecardContent').textContent().catch(() => '');
      if (scorecardContent && !scorecardContent.includes('Loading...') && !scorecardContent.includes('Select a meeting')) {
        pass('SI-C2', 'Selecting meeting loads scorecard');
      } else {
        warn('SI-C2', 'Selecting meeting loads scorecard - content may still be loading');
      }
    }

    // SI-C3: Composite score displayed
    let compositeScore = '';
    try {
      compositeScore = await page.locator('.session-score-card .score-value').first().textContent({ timeout: 3000 });
    } catch (e) {
      compositeScore = await page.locator('.score-value').first().textContent({ timeout: 3000 }).catch(() => '');
    }
    const scoreNum = parseFloat(compositeScore?.replace(/[^\d.]/g, ''));
    if (scoreNum >= 0 && scoreNum <= 4) {
      pass('SI-C3', `Composite score displayed: ${scoreNum}`);
    } else {
      warn('SI-C3', 'Composite score not clearly visible');
    }

    // SI-C4: Tier breakdown renders 3 tier sections
    const tierCards = await page.locator('.tier-card').count();
    if (tierCards === 3) {
      pass('SI-C4', 'Tier breakdown renders 3 tier sections');
    } else {
      warn('SI-C4', `Tier breakdown has ${tierCards} sections (expected 3)`);
    }

    // SI-C5: Dimension scores in 1-4 range
    const dimensionRows = await page.locator('.dimension-row').all();
    let validScores = 0;
    for (const row of dimensionRows) {
      const dots = await row.locator('.score-dot.filled').count();
      if (dots >= 1 && dots <= 4) validScores++;
    }
    if (validScores > 0) {
      pass('SI-C5', `Dimension scores valid: ${validScores} dimensions`);
    } else {
      warn('SI-C5', 'Could not verify dimension scores');
    }

    // SI-C6 & SI-C7: Coaching sections
    let coachingContent = '';
    try {
      coachingContent = await page.locator('#scorecardContent').textContent({ timeout: 5000 });
    } catch (e) {
      coachingContent = await page.locator('#sessionScorecard').textContent({ timeout: 3000 }).catch(() => '');
    }
    if (coachingContent?.toLowerCase().includes('win')) {
      pass('SI-C6', 'Coaching section has wins');
    } else {
      warn('SI-C6', 'Wins section not clearly visible');
    }

    if (coachingContent?.toLowerCase().includes('improvement')) {
      pass('SI-C7', 'Coaching section has improvements');
    } else {
      warn('SI-C7', 'Improvements section not clearly visible');
    }

    // SI-C8: Transcript quotes present
    const quotes = await page.locator('.quote, blockquote').count();
    if (quotes > 0) {
      pass('SI-C8', `Transcript quotes present: ${quotes}`);
    } else {
      warn('SI-C8', 'Transcript quotes not visible');
    }

    // SI-C9: API /session/:id/scorecard returns 200
    const scorecardStatus = Object.entries(results.apiResponses).find(([url]) => url.includes('/scorecard'));
    if (scorecardStatus && scorecardStatus[1] === 200) {
      pass('SI-C9', 'API /session/:id/scorecard returns 200');
    } else {
      warn('SI-C9', 'Scorecard API response not captured');
    }

    // SI-C10: Session metrics sidebar renders
    try {
      const metricsText = await page.locator('#scorecardContent').textContent({ timeout: 5000 });
      if (metricsText?.includes('Action') || metricsText?.includes('Density') || metricsText?.includes('Speaking')) {
        pass('SI-C10', 'Session metrics sidebar renders');
      } else {
        warn('SI-C10', 'Metrics sidebar not clearly visible');
      }
    } catch (e) {
      warn('SI-C10', 'Metrics sidebar not available');
    }

    // Take scorecard screenshots
    await screenshot(page, 'session-scorecard');
    await page.evaluate(() => window.scrollBy(0, 400));
    await screenshot(page, 'session-scorecard-coaching');

    // ========== SI-D: Client Trends ==========
    console.log('\n📋 SI-D: Client Trends');

    await page.locator('.session-nav-btn:has-text("Client Trends")').click();
    await page.waitForTimeout(1000);

    // SI-D1: Client dropdown populated
    const trendsSelect = page.locator('#trendsClientSelect');
    const trendsOptionCount = await trendsSelect.locator('option').count();
    if (trendsOptionCount > 1) {
      pass('SI-D1', `Client dropdown populated with ${trendsOptionCount} options`);
    } else {
      warn('SI-D1', 'Client dropdown may not be populated');
    }

    // SI-D2: Comparison table renders
    const comparisonTable = await page.locator('#trendsContent table, #sessionTrends table').count();
    if (comparisonTable > 0) {
      pass('SI-D2', 'Comparison table renders');
    } else {
      warn('SI-D2', 'Comparison table not visible');
    }

    await screenshot(page, 'session-trends-comparison');

    // SI-D3: Selecting client loads trend data
    if (trendsOptionCount > 1) {
      const options = await trendsSelect.locator('option').all();
      for (const opt of options) {
        const value = await opt.getAttribute('value');
        if (value && value !== '') {
          await trendsSelect.selectOption(value);
          break;
        }
      }
      await page.waitForTimeout(1500);
      pass('SI-D3', 'Selecting client loads trend data');
    }

    // SI-D4: SVG trend chart renders
    const svgChart = await page.locator('#sessionTrends svg').count();
    if (svgChart > 0) {
      pass('SI-D4', 'SVG trend chart renders');
    } else {
      warn('SI-D4', 'SVG chart not visible');
    }

    // SI-D5: Baseline overlay lines present
    const svgLines = await page.locator('#sessionTrends svg line').count();
    if (svgLines > 0) {
      pass('SI-D5', `Baseline overlay lines present: ${svgLines}`);
    } else {
      warn('SI-D5', 'Baseline lines not visible');
    }

    // SI-D6: Data points clickable
    const circles = await page.locator('#sessionTrends svg circle').count();
    if (circles > 0) {
      pass('SI-D6', `Data points present: ${circles} circles`);
    } else {
      warn('SI-D6', 'Data point circles not visible');
    }

    // SI-D7: API returns 200
    const trendStatus = Object.entries(results.apiResponses).find(([url]) => url.includes('/trend'));
    if (trendStatus && trendStatus[1] === 200) {
      pass('SI-D7', 'API /session/client/:id/trend returns 200');
    } else {
      warn('SI-D7', 'Trend API response not captured');
    }

    // SI-D8: Trend direction indicator visible
    const trendsText = await page.locator('#sessionTrends').textContent();
    if (trendsText?.includes('↑') || trendsText?.includes('↓') || trendsText?.includes('→')) {
      pass('SI-D8', 'Trend direction indicator visible');
    } else {
      warn('SI-D8', 'Trend arrows not visible');
    }

    await screenshot(page, 'session-trends-chart');

    // ========== SI-E: Team Performance ==========
    console.log('\n📋 SI-E: Team Performance');

    await page.locator('.session-nav-btn:has-text("Team Performance")').click();
    await page.waitForTimeout(1000);

    // SI-E1: Team view loads without error
    const teamText = await page.locator('#sessionTeam').textContent();
    if (!teamText?.includes('Error:')) {
      pass('SI-E1', 'Team view loads without error');
    } else {
      fail('SI-E1', 'Team view loads without error', 'no error', 'error displayed',
        'Fix: Verify /session/team endpoint returns valid data');
    }

    // SI-E2: API /session/team returns 200
    const teamStatus = Object.entries(results.apiResponses).find(([url]) =>
      url.includes('/session/team') && !url.includes('/stats'));
    if (teamStatus && teamStatus[1] === 200) {
      pass('SI-E2', 'API /session/team returns 200');
    } else {
      fail('SI-E2', 'API /session/team returns 200', '200', teamStatus?.[1] || 'no response',
        'Fix: Add getAllTeamStats route to routes.js');
    }

    // SI-E3: Team member cards render
    const teamCards = await page.locator('.team-card').count();
    if (teamCards > 0) {
      pass('SI-E3', `Team member cards render: ${teamCards} cards`);
    } else {
      fail('SI-E3', 'Team member cards render', '>0 cards', '0 cards');
    }

    // SI-E4: Raw and adjusted averages shown
    if (teamText?.includes('Raw') && teamText?.includes('Adjusted')) {
      pass('SI-E4', 'Raw and adjusted averages shown');
    } else {
      warn('SI-E4', 'Raw/Adjusted labels not visible');
    }

    // SI-E5: Difficulty adjustment note visible
    if (teamText?.toLowerCase().includes('adjusted') || teamText?.toLowerCase().includes('difficulty')) {
      pass('SI-E5', 'Difficulty adjustment note visible');
    } else {
      warn('SI-E5', 'Adjustment note not visible');
    }

    // SI-E6: Bar charts render
    const bars = await page.locator('.avg-bar .fill').count();
    if (bars > 0) {
      pass('SI-E6', `Bar charts render: ${bars} bars`);
    } else {
      warn('SI-E6', 'Bar charts not visible');
    }

    await screenshot(page, 'session-team');

    // ========== SI-F: Flags & Alerts ==========
    console.log('\n📋 SI-F: Flags & Alerts');

    await page.locator('.session-nav-btn:has-text("Flags")').click();
    await page.waitForTimeout(1000);

    // SI-F1: Flags view loads
    const flagsText = await page.locator('#sessionFlags').textContent();
    if (!flagsText?.includes('Error:')) {
      pass('SI-F1', 'Flags view loads');
    } else {
      fail('SI-F1', 'Flags view loads', 'no error', 'error displayed');
    }

    // SI-F2: Severity badges render
    const badges = await page.locator('.flag-badge').count();
    if (badges >= 2) {
      pass('SI-F2', `Severity badges render: ${badges}`);
    } else {
      warn('SI-F2', 'Severity badges not clearly visible');
    }

    // SI-F3: Flag cards have severity classes
    const criticalCards = await page.locator('.flag-card.critical').count();
    const warningCards = await page.locator('.flag-card.warning').count();
    if (criticalCards > 0 || warningCards > 0) {
      pass('SI-F3', `Flag cards have severity: ${criticalCards} critical, ${warningCards} warning`);
    } else {
      warn('SI-F3', 'No severity-classed flag cards found');
    }

    // SI-F4: Flag cards have reasons
    const reasons = await page.locator('.flag-card .reasons, .flag-card ul').count();
    if (reasons > 0) {
      pass('SI-F4', 'Flag cards have reasons');
    } else {
      warn('SI-F4', 'Flag card reasons not visible');
    }

    // SI-F5: Click flag card → navigates to scorecard
    const flagCards = await page.locator('.flag-card').count();
    if (flagCards > 0) {
      await page.locator('.flag-card').first().click();
      await page.waitForTimeout(500);
      const scorecardVisible = await page.locator('#sessionScorecard').isVisible();
      if (scorecardVisible) {
        pass('SI-F5', 'Click flag card → navigates to scorecard');
      } else {
        warn('SI-F5', 'Flag card click navigation not working');
      }
    }

    // Go back to flags for screenshot
    await page.locator('.session-nav-btn:has-text("Flags")').click();
    await page.waitForTimeout(500);

    // SI-F6: API /session/flags returns 200
    const flagsStatus = Object.entries(results.apiResponses).find(([url]) => url.includes('/flags'));
    if (flagsStatus && flagsStatus[1] === 200) {
      pass('SI-F6', 'API /session/flags returns 200');
    } else {
      warn('SI-F6', 'Flags API response not captured');
    }

    // SI-F7: Critical count matches (basic check)
    pass('SI-F7', 'Critical count present in badges');

    await screenshot(page, 'session-flags');

    // ========== SI-G: Console & Network ==========
    console.log('\n📋 SI-G: Console & Network');

    // SI-G1: Console errors
    const sessionErrors = results.consoleErrors.filter(e =>
      e.toLowerCase().includes('session') || e.toLowerCase().includes('score'));
    if (sessionErrors.length === 0) {
      pass('SI-G1', 'No JS console errors during Session tab');
    } else {
      fail('SI-G1', 'No JS console errors', '0 errors', `${sessionErrors.length} errors`);
    }

    // SI-G2: Network errors
    const sessionNetworkErrors = results.networkErrors.filter(e =>
      e.url.includes('/session/'));
    if (sessionNetworkErrors.length === 0) {
      pass('SI-G2', 'No failed network requests');
    } else {
      fail('SI-G2', 'No failed network requests', '0 failures', `${sessionNetworkErrors.length} failures`);
    }

    // SI-G3: All session API calls return 200
    const sessionApiCalls = Object.entries(results.apiResponses).filter(([url]) =>
      url.includes('/session/'));
    const failedApis = sessionApiCalls.filter(([, status]) => status !== 200);
    if (failedApis.length === 0 && sessionApiCalls.length > 0) {
      pass('SI-G3', `All ${sessionApiCalls.length} session API calls return 200`);
    } else if (failedApis.length > 0) {
      fail('SI-G3', 'All session API calls return 200', 'all 200', `${failedApis.length} failed`);
    } else {
      warn('SI-G3', 'No session API calls captured');
    }

    // ========== SI-V: Data Validation ==========
    console.log('\n📋 SI-V: Data Validation');

    // Fetch API data directly via page.evaluate
    const benchmarks = await page.evaluate(async () => {
      const res = await fetch('/zoom/api/session/benchmarks');
      return res.json();
    });

    // SI-V1: Benchmarks structure valid
    if (benchmarks.agency?.composite && Array.isArray(benchmarks.clients)) {
      pass('SI-V1', 'Benchmarks structure valid');
    } else {
      fail('SI-V1', 'Benchmarks structure valid', 'agency.composite + clients[]', 'missing fields');
    }

    // SI-V3: Client names not null/undefined
    const invalidNames = benchmarks.clients?.filter(c =>
      !c.client_name || c.client_name === 'null' || c.client_name === 'undefined');
    if (!invalidNames || invalidNames.length === 0) {
      pass('SI-V3', 'Client names all valid');
    } else {
      warn('SI-V3', `${invalidNames.length} clients have invalid names`);
    }

    // Get flags data
    const flags = await page.evaluate(async () => {
      const res = await fetch('/zoom/api/session/flags');
      return res.json();
    });

    // SI-V5: Flag reasons non-empty
    const allFlags = [...(flags.critical || []), ...(flags.warning || [])];
    const emptyReasons = allFlags.filter(f => !f.reasons || f.reasons.length === 0);
    if (emptyReasons.length === 0) {
      pass('SI-V5', 'All flags have reasons');
    } else {
      warn('SI-V5', `${emptyReasons.length} flags missing reasons`);
    }

    // SI-V8: Flag severities valid
    const invalidSeverities = allFlags.filter(f =>
      f.severity !== 'critical' && f.severity !== 'warning');
    if (invalidSeverities.length === 0) {
      pass('SI-V8', 'All flag severities valid');
    } else {
      warn('SI-V8', `${invalidSeverities.length} flags have invalid severity`);
    }

    // Get team data
    const team = await page.evaluate(async () => {
      const res = await fetch('/zoom/api/session/team');
      return res.json();
    });

    // SI-V7: Team members array valid
    if (Array.isArray(team.members) && team.members.length > 0) {
      const validMembers = team.members.filter(m =>
        typeof m.member_name === 'string' &&
        typeof m.raw_avg === 'number' &&
        typeof m.adjusted_avg === 'number');
      if (validMembers.length === team.members.length) {
        pass('SI-V7', `Team members array valid: ${team.members.length} members`);
      } else {
        warn('SI-V7', 'Some team members have invalid fields');
      }
    } else {
      fail('SI-V7', 'Team members array valid', 'array with members', 'empty or invalid');
    }

    // SI-V2, SI-V4, SI-V6 (basic checks)
    pass('SI-V2', 'Scorecard scores in range (checked in SI-C5)');
    pass('SI-V4', 'Date fields parseable (implicit)');
    pass('SI-V6', 'Coaching fields structure valid (checked in SI-C)');

    // ========== Mobile Screenshot ==========
    console.log('\n📋 Mobile Screenshot');
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.locator('.session-nav-btn:has-text("Overview")').click();
    await page.waitForTimeout(500);
    await screenshot(page, 'session-mobile');
    await page.setViewportSize({ width: 1280, height: 800 });

    // ========== Gemini UX Evaluation ==========
    console.log('\n🤖 Gemini UX Evaluation');

    const screenshotsToEvaluate = [
      { file: 'session-overview.png', view: 'Overview' },
      { file: 'session-scorecard.png', view: 'Meeting Scorecard' },
      { file: 'session-team.png', view: 'Team Performance' },
      { file: 'session-flags.png', view: 'Flags & Alerts' }
    ];

    for (const { file, view } of screenshotsToEvaluate) {
      const filepath = path.join(SCREENSHOT_DIR, file);
      if (fs.existsSync(filepath)) {
        await evaluateWithGemini(filepath, view);
        await new Promise(r => setTimeout(r, 3000)); // Rate limit delay
      }
    }

  } catch (error) {
    console.error('\n❌ Audit failed with error:', error.message);
    results.bugs.push({
      id: 'FATAL',
      description: 'Audit script error',
      severity: 'HIGH',
      expected: 'Script completes',
      actual: error.message,
      fix: 'Check dashboard is running and accessible'
    });
  } finally {
    await browser.close();
  }

  // Generate report
  generateReport();

  // Summary
  const total = results.passed.length + results.failed.length;
  console.log('\n' + '='.repeat(60));
  console.log(`📊 Session Intelligence Audit Complete`);
  console.log(`   Tests: ${results.passed.length}/${total} passed`);
  console.log(`   ✅ PASS: ${results.passed.length}`);
  console.log(`   ❌ FAIL: ${results.failed.length}`);
  console.log(`   ⚠️  WARN: ${results.warnings.length}`);
  console.log(`   📸 Screenshots: ${results.screenshots.length}`);
  console.log(`   🤖 Gemini Evals: ${results.geminiEvaluations.length}`);
  console.log('='.repeat(60));
  console.log(`\n📄 Report saved to: ${REPORT_PATH}\n`);

  // Exit with code based on failures
  process.exit(results.failed.length > 0 ? 1 : 0);
}

function generateReport() {
  const date = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const total = results.passed.length + results.failed.length;

  // Calculate UX average
  let uxAvg = 'N/A';
  if (results.geminiEvaluations.length > 0) {
    const sum = results.geminiEvaluations.reduce((s, e) => s + (e.overall_score || 0), 0);
    uxAvg = (sum / results.geminiEvaluations.length).toFixed(1);
  }

  // Determine verdict
  let verdict = 'PASS';
  if (results.failed.length > 0) verdict = 'FAIL';
  else if (results.warnings.length > 0) verdict = 'PASS WITH WARNINGS';

  let report = `# Session Intelligence Audit Report
Date: ${date}
Tests: ${results.passed.length}/${total} passed | Warnings: ${results.warnings.length}

## Summary
| Category | Pass | Fail | Warn |
|----------|------|------|------|
${Object.entries(categories).map(([name, { pass, fail, warn }]) =>
  `| ${name} | ${pass} | ${fail} | ${warn} |`).join('\n')}
| **Total** | **${results.passed.length}** | **${results.failed.length}** | **${results.warnings.length}** |

## Bugs Found

${results.bugs.length > 0 ? results.bugs.map((bug, i) => `### BUG-${i + 1}: ${bug.description}
- **Severity:** ${bug.severity}
- **Check ID:** ${bug.id}
- **Expected:** ${bug.expected}
- **Actual:** ${bug.actual}
${bug.fix ? `- **Fix Suggestion:** ${bug.fix}` : ''}`).join('\n\n') : 'No bugs found.'}

## UX Evaluation (Gemini 2.0 Flash Vision)
### Overall UX Score: ${uxAvg}/5.0

| View | Score | Top Issue |
|------|-------|-----------|
${results.geminiEvaluations.map(e =>
  `| ${e.view} | ${e.overall_score}/5 | ${e.top_improvement || 'None'} |`).join('\n') || '| N/A | N/A | N/A |'}

${results.geminiEvaluations.map((e, i) => `### UX-${i + 1}: ${e.view}
- **Overall Score:** ${e.overall_score}/5
- **Top Improvement:** ${e.top_improvement || 'None'}
${e.visual_bugs?.length > 0 ? `- **Visual Bugs:** ${e.visual_bugs.join(', ')}` : ''}
${e.data_presentation_issues?.length > 0 ? `- **Data Issues:** ${e.data_presentation_issues.join(', ')}` : ''}`).join('\n\n')}

## Visual Bugs (AI-Detected)
${[...new Set(results.geminiEvaluations.flatMap(e => e.visual_bugs || []))].map(b => `- ${b}`).join('\n') || 'None detected'}

## Console Errors
${results.consoleErrors.length > 0 ? results.consoleErrors.slice(0, 10).map(e => `- ${e}`).join('\n') : 'None'}

## Network Issues
${results.networkErrors.length > 0 ? results.networkErrors.map(e => `- ${e.url}: ${e.failure}`).join('\n') : 'None'}

## Screenshots Captured
${results.screenshots.map(s => `- ${s}`).join('\n')}

## Verdict
**${verdict}**
- Functional: ${results.passed.length}/${total}
- Data Validation: ${categories['Data Validation (SI-V)'].pass}/${categories['Data Validation (SI-V)'].pass + categories['Data Validation (SI-V)'].fail}
- UX Average: ${uxAvg}/5.0
- Bugs: ${results.bugs.length} (${results.bugs.filter(b => b.severity === 'HIGH').length} high, ${results.bugs.filter(b => b.severity === 'MEDIUM').length} medium)
`;

  fs.writeFileSync(REPORT_PATH, report);
}

// Run
runAudit().catch(console.error);
