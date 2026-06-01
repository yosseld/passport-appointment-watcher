#!/usr/bin/env node
/*
 * passport-watcher
 * ----------------
 * Watches the U.S. Dept of State Online Passport Appointment System
 * (passportappointment.travel.state.gov) for an opening at a given passport
 * agency (default: Miami) and ALARMS LOUDLY the instant one appears, so you can
 * grab it within the 15-minute hold window.
 *
 * Two openings it can detect (it auto-detects which page you're on):
 *  1. AGENCY page ("Find an Agency", Step 2): the target agency flips from
 *     "No appointments are available due to limited capacity" (no Select button)
 *     to SELECTABLE (a "Select" button appears). This is the reliable signal when
 *     the agency is currently at zero capacity (e.g. Miami today) — you can't even
 *     reach its date/time page until it's selectable again.
 *  2. DATE/TIME page ("Select an Appointment Window", Step 3): a day column stops
 *     saying "There are no appointments available." and shows a bookable window
 *     (a clock time OR a half-day "AM"/"PM" button).
 *
 * It NEVER books for you, solves CAPTCHAs, or enters personal info. When it
 * alarms you click through and finish booking yourself.
 *
 * One-time setup per run: complete Step 1 (Travel Plans) in the Chrome window it
 * opens, until you reach the "Find an Agency" page. The watcher then auto-searches
 * your zip and polls. (Step 1 may have a CAPTCHA — that's yours to clear.)
 *
 * Usage:
 *   node watcher.js            # watch
 *   node watcher.js --test     # fire the alarm once (+ ntfy if set), then exit
 *   node watcher.js --once     # open, print current state once, exit (debug)
 *
 * Config (env vars, all optional):
 *   AGENCY_NAME   target agency name to match   (default "Miami")
 *   SEARCH_ZIP    zip to search on Step 2       (default "33130" — downtown Miami)
 *   POLL_MIN_MS / POLL_MAX_MS  poll interval    (default 20000 / 35000, jittered)
 *   NTFY_TOPIC    ntfy.sh topic for phone push  (default off)
 *   NTFY_SERVER   ntfy server base              (default https://ntfy.sh)
 *   PROFILE_DIR   Chrome user-data dir          (default ./.chrome-profile)
 *   CDP_URL       attach to an existing Chrome started with --remote-debugging-port
 *                 + a NON-default --user-data-dir (Chrome >=136 blocks the default
 *                 profile). Leave unset to launch a dedicated profile.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

// Persistent data dir (config, browser profile, saved session). Stable across runs
// whether launched as a script OR a packaged .exe (so __dirname/temp don't matter).
const DATA_DIR = process.env.PASSPORT_WATCHER_DIR || path.join(os.homedir(), '.passport-watcher');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PROFILE_DIR = process.env.PROFILE_DIR || path.join(DATA_DIR, 'chrome-profile');
const SESSION_FILE = path.join(DATA_DIR, 'session-url.txt');

function loadConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) { return {}; } }
function saveConfig() { try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(CFG, null, 2), 'utf8'); } catch (_) {} }
const CFG = loadConfig();

// Precedence for each setting: environment variable > config.json > built-in default.
let AGENCY = process.env.AGENCY_NAME || CFG.agency || 'Miami';
let SEARCH_ZIP = process.env.SEARCH_ZIP || CFG.searchZip || '33130';
const START_URL = process.env.START_URL || 'https://passportappointment.travel.state.gov/';
// Agency-list re-search is a heavier form POST -> moderate. Calendar reload is a
// light GET where slots appear/vanish in seconds -> AGGRESSIVE.
const POLL_MIN_MS = intEnv('POLL_MIN_MS', CFG.pollMinMs || 12000);
const POLL_MAX_MS = intEnv('POLL_MAX_MS', CFG.pollMaxMs || 18000);
const CAL_MIN_MS = intEnv('CAL_MIN_MS', CFG.calMinMs || 4000);
const CAL_MAX_MS = intEnv('CAL_MAX_MS', CFG.calMaxMs || 8000);
let NTFY_TOPIC = process.env.NTFY_TOPIC || CFG.ntfyTopic || '';
const NTFY_SERVER = (process.env.NTFY_SERVER || CFG.ntfyServer || 'https://ntfy.sh').replace(/\/+$/, '');

const TEST = process.argv.includes('--test');
const ONCE = process.argv.includes('--once');

function intEnv(name, def) { const v = parseInt(process.env[name], 10); return Number.isFinite(v) ? v : def; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function jitter() { return POLL_MIN_MS + Math.floor(Math.random() * Math.max(1, POLL_MAX_MS - POLL_MIN_MS)); }
function calJitter() { return CAL_MIN_MS + Math.floor(Math.random() * Math.max(1, CAL_MAX_MS - CAL_MIN_MS)); }
function stamp() { return new Date().toLocaleString(); }
function log(msg) { console.log(`[${stamp()}] ${msg}`); }

// Persist the current flow URL so a restart can RESUME the session (no Step 1).
function saveSession(url) {
  try { if (url && /\/appointment\/new\//.test(url)) fs.writeFileSync(SESSION_FILE, url, 'utf8'); } catch (_) {}
}

function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 16) || 'agency'; }

// First run: ensure config.json exists and mint a private phone-alert topic so
// each person gets their own. Everything is stored in DATA_DIR/config.json.
function ensureConfig() {
  let changed = false;
  if (CFG.agency === undefined) { CFG.agency = AGENCY; CFG.searchZip = SEARCH_ZIP; changed = true; }
  if (!NTFY_TOPIC) {
    NTFY_TOPIC = 'passport-' + slug(AGENCY) + '-' + crypto.randomBytes(4).toString('hex');
    CFG.ntfyTopic = NTFY_TOPIC;
    changed = true;
  }
  if (changed) saveConfig();
}

// Launch a real browser carrying the watcher's own profile. Tries Chrome, then
// Edge (every Windows PC has Edge), so it works even without Chrome installed.
async function launchPersistent() {
  const base = {
    headless: false,
    viewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled', '--no-default-browser-check'],
  };
  const channels = process.env.BROWSER_CHANNEL ? [process.env.BROWSER_CHANNEL] : ['chrome', 'msedge'];
  let lastErr;
  for (const channel of channels) {
    try {
      const ctx = await chromium.launchPersistentContext(PROFILE_DIR, { ...base, channel });
      console.log(`  browser: ${channel}`);
      return ctx;
    } catch (e) { lastErr = e; console.log(`  ${channel} not available — trying next...`); }
  }
  throw new Error('Could not launch Chrome or Edge. Please install Google Chrome. ' + (lastErr ? String(lastErr.message).split('\n')[0] : ''));
}

// ---- Alarms (Windows: PowerShell SAPI speech + console beeps) --------------
function psFireAndForget(command) {
  try {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'ignore' });
    p.on('error', () => {});
    p.unref();
  } catch (_) { /* ignore */ }
}

function alarmAvailable() {
  const phrase = `Passport appointment available in ${AGENCY}. Book now. Book now.`.replace(/'/g, "''");
  psFireAndForget(
    `$ErrorActionPreference='SilentlyContinue';` +
    `Add-Type -AssemblyName System.Speech;` +
    `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Volume = 100; $s.Rate = 1;` +
    `for ($i = 0; $i -lt 4; $i++) {` +
    `  [console]::beep(1245, 220); [console]::beep(1660, 220); [console]::beep(1245, 220); [console]::beep(1975, 350);` +
    `  $s.Speak('${phrase}');` +
    `}`
  );
}

function alarmExpired() {
  const phrase = `Passport watcher session expired. Please redo travel plans.`.replace(/'/g, "''");
  psFireAndForget(
    `$ErrorActionPreference='SilentlyContinue';` +
    `Add-Type -AssemblyName System.Speech;` +
    `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Volume = 100; $s.Rate = 1;` +
    `[console]::beep(700, 250); [console]::beep(500, 400); $s.Speak('${phrase}');`
  );
}

// ntfy puts title/tags in HTTP headers, which must be Latin-1 (ByteString). An
// em-dash/smart-quote is code point > 255 and throws, silently killing the push.
function toAscii(s) {
  return String(s)
    .replace(/[‒-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x00-\x7F]/g, '');
}

async function pushPhone(title, body, priority = 'urgent', tags = 'rotating_light,passport') {
  if (!NTFY_TOPIC) return;
  try {
    await fetch(`${NTFY_SERVER}/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: { Title: toAscii(title), Priority: toAscii(priority), Tags: toAscii(tags) },
      body: String(body),
    });
  } catch (e) { log(`ntfy push failed: ${e.message}`); }
}

// ---- Page awareness --------------------------------------------------------
async function pageText(page) {
  try { return await page.evaluate(() => (document.body ? document.body.innerText : '')); } catch (_) { return ''; }
}

async function whereAreWe(page) {
  let url = '';
  try { url = page.url(); } catch (_) {}
  const u = (url || '').toLowerCase();
  const t = await pageText(page);
  // Header text is page-specific; the step-bar (FIND AN AGENCY / SELECT DATE & TIME /
  // APPOINTMENT CONFIRMATION) is ALL-CAPS and present on every page, so match case-
  // sensitively / by URL to avoid the step-bar.
  const onDateTime = /dateandtime/.test(u) || /Select an Appointment Window/.test(t);
  const onFindAgency = /findagency/.test(u);
  // NB: we deliberately do NOT classify "booking"/"expired"/"confirmed" by
  // URL/keyword — Step 1 (Travel Plans) and Step 4/5 all live under
  // /appointment/new/ and share step-bar text, so any such guess mislabels normal
  // navigation (we burned a false "expired" AND a false "confirmed" doing this).
  // Everything that isn't one of the two watch pages is a single quiet off-target state.
  return { url, onDateTime, onFindAgency };
}

// Step 3 detector: any day column not saying "no appointments available", or a
// bookable window (clock time OR half-day AM/PM button).
async function detectDateTime(page) {
  try {
    return await page.evaluate(() => {
      const t = document.body ? document.body.innerText : '';
      const noCount = (t.match(/There are no appointments available/g) || []).length;
      const dayCount = (t.match(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\w{3}\s+\d{1,2}\b/g) || []).length;
      const clockSlots = (t.match(/\b\d{1,2}:\d{2}\s*(AM|PM)\b/g) || []).length;
      // Half-day windows render as standalone "AM"/"PM" buttons (e.g. Atlanta "AM >").
      const windowSlots = [...document.querySelectorAll('a,button')]
        .filter((b) => /^(AM|PM)\b/i.test((b.textContent || '').trim())).length;
      const slotCount = clockSlots + windowSlots;
      const onDateTime = /Select an Appointment Window/.test(t);
      const available = onDateTime && dayCount > 0 && (noCount < dayCount || slotCount > 0);
      return { onDateTime, noCount, dayCount, slotCount, available };
    });
  } catch (_) { return { onDateTime: false, noCount: 0, dayCount: 0, slotCount: 0, available: false }; }
}

// Step 2 detector: is the target agency SELECTABLE (has a "Select" button and
// isn't flagged "limited capacity")?
async function detectAgency(page, agencyName) {
  try {
    return await page.evaluate((name) => {
      const findBlock = (nm) => {
        const els = [...document.querySelectorAll('li, div, .card, .agency, section')]
          .filter((el) => new RegExp(nm, 'i').test(el.textContent) && /Passport Agency/i.test(el.textContent));
        let block = null, best = Infinity;
        for (const el of els) { const L = (el.textContent || '').length; if (L < best) { best = L; block = el; } }
        return block;
      };
      const b = findBlock(name);
      if (!b) return { listed: false, selectable: false };
      const hasSelect = [...b.querySelectorAll('a,button,input')]
        .some((x) => /^select$/i.test(((x.textContent || x.value || '').trim())));
      const limited = /No appointments are available due to limited capacity/i.test(b.textContent);
      return { listed: true, selectable: hasSelect && !limited };
    }, agencyName);
  } catch (_) { return { listed: false, selectable: false }; }
}

// Re-run the agency search so availability is fresh (Step 2 doesn't persist results).
async function searchAgencies(page, zip) {
  try {
    const box = page.locator('#SearchCriteria');
    if (await box.count()) {
      await box.fill('');
      await box.fill(zip);
      const btn = page.locator('button.submitLocation, button.submitLocations');
      if (await btn.count()) { await btn.first().click().catch(() => {}); }
      else { await box.press('Enter').catch(() => {}); }
      await page.waitForFunction(() => /Passport Agency/i.test(document.body ? document.body.innerText : ''), { timeout: 9000 }).catch(() => {});
      await sleep(600);
    }
  } catch (_) { /* ignore */ }
}

async function settle(page) {
  try { await page.waitForLoadState('domcontentloaded', { timeout: 15000 }); } catch (_) {}
}

// Robust wait for the date/time grid to finish rendering, so we never judge a
// half-loaded page (a partial render can momentarily look "available").
async function settleDateTime(page) {
  try { await page.waitForLoadState('domcontentloaded', { timeout: 15000 }); } catch (_) {}
  try {
    await page.waitForFunction(() => {
      const t = document.body ? document.body.innerText : '';
      if (!/Select an Appointment Window/.test(t)) return true; // not on date/time
      const day = (t.match(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\w{3}\s+\d{1,2}\b/g) || []).length;
      const no = (t.match(/There are no appointments available/g) || []).length;
      const slot = /\b\d{1,2}:\d{2}\s*(AM|PM)\b/.test(t)
        || [...document.querySelectorAll('a,button')].some((b) => /^(AM|PM)\b/i.test((b.textContent || '').trim()));
      return day >= 1 && (no >= 1 || slot); // every column resolved to empty-or-slot
    }, { timeout: 10000 });
  } catch (_) {}
}

// Click the target agency's "Select" button on Find-an-Agency, to advance into
// its date/time page where we can verify a REAL slot (selectable != bookable).
async function clickAgencySelect(page, agencyName) {
  try {
    return await page.evaluate((name) => {
      const findBlock = (nm) => {
        const els = [...document.querySelectorAll('li, div, .card, .agency, section')]
          .filter((el) => new RegExp(nm, 'i').test(el.textContent) && /Passport Agency/i.test(el.textContent));
        let block = null, best = Infinity;
        for (const el of els) { const L = (el.textContent || '').length; if (L < best) { best = L; block = el; } }
        return block;
      };
      const b = findBlock(name);
      if (!b) return false;
      const sel = [...b.querySelectorAll('a, button, input')]
        .find((x) => /^select$/i.test(((x.textContent || x.value || '').trim())));
      if (sel) { sel.click(); return true; }
      return false;
    }, agencyName);
  } catch (_) { return false; }
}

// Shared "opening found" handler: alarm, bring to front, push, and keep nudging
// until the opening is gone or you advance to a booking step.
async function onAvailable(page, headline, instruction) {
  log(`🚨🚨 ${headline}`);
  console.log('    >>> SWITCH TO THE CHROME WINDOW NOW AND GRAB IT. ~15 min hold once you select a slot. <<<');
  await page.bringToFront().catch(() => {});
  alarmAvailable();
  await pushPhone(`PASSPORT OPENING - ${AGENCY}`, `${instruction} Open the watcher's Chrome and grab it within ~15 minutes.`);

  let lastAlarm = Date.now();
  while (true) {
    await sleep(4000);
    const w = await whereAreWe(page);
    // Only a real, still-visible date/time slot counts as "still open". Merely
    // being back on the agency list does NOT (selectable != bookable).
    let still = false;
    if (w.onDateTime) { still = (await detectDateTime(page)).available; }
    if (!still) { log('Opening no longer shown (you grabbed it, it was taken, or you moved on to book). Resuming watch...'); break; }
    if (Date.now() - lastAlarm > 18000) { await page.bringToFront().catch(() => {}); alarmAvailable(); lastAlarm = Date.now(); }
  }
}

// ---- Main ------------------------------------------------------------------
async function main() {
  ensureConfig();
  if (TEST) {
    console.log('Firing test alarm (you should HEAR a siren + spoken alert)...');
    alarmAvailable();
    await pushPhone(`TEST - passport watcher (${AGENCY})`, 'Test push. If you see this on your phone, alerts work.', 'high');
    await sleep(9000);
    console.log('Test done.');
    return;
  }

  console.log('========================================================');
  console.log(`  passport-watcher  -  target: ${AGENCY} Passport Agency`);
  console.log(`  search zip: ${SEARCH_ZIP}    calendar reload: ${Math.round(CAL_MIN_MS / 1000)}-${Math.round(CAL_MAX_MS / 1000)}s`);
  console.log(`  config file: ${CONFIG_FILE}`);
  console.log('  PHONE ALERTS -> subscribe to this in the free "ntfy" phone app:');
  console.log(`     ${NTFY_SERVER}/${NTFY_TOPIC}`);
  console.log('========================================================');
  console.log('  (Watch a different city? Edit "agency" + "searchZip" in the config file above.)');

  const context = await launchPersistent();
  // A reused profile can restore old tabs; keep one clean page, close the rest.
  const existing = context.pages();
  const page = existing[0] || (await context.newPage());
  for (const p of existing.slice(1)) { await p.close().catch(() => {}); }
  // Try to RESUME the prior session so you don't redo Step 1. The persistent profile
  // keeps your cookie; if the saved flow URL still loads a flow page, we pick up
  // exactly where we left off. Otherwise fall back to the home page.
  let resumed = false;
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const saved = (fs.readFileSync(SESSION_FILE, 'utf8') || '').trim();
      if (saved) {
        await page.goto(saved, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await settle(page);
        const w0 = await whereAreWe(page);
        if (w0.onFindAgency || w0.onDateTime) { resumed = true; console.log('  RESUMED prior session — no Step 1 needed.'); }
      }
    }
  } catch (_) {}
  if (!resumed) { await page.goto(START_URL, { waitUntil: 'domcontentloaded' }).catch(() => {}); }

  let closed = false;
  context.on('close', () => { closed = true; });
  process.on('SIGINT', async () => {
    console.log('\nStopping watcher.');
    try { await context.close(); } catch (_) {}
    process.exit(0);
  });

  await settle(page);

  console.log('\n>>> In the Chrome window, complete Step 1 (Travel Plans) until you reach');
  console.log('    the "Find an Agency" page. I auto-search ' + SEARCH_ZIP + '; when ' + AGENCY + ' is');
  console.log('    selectable I open its calendar and verify a REAL slot before alarming.');
  console.log('    On a real opening I scream — you pick the window and click Next to book.\n');

  if (ONCE) {
    const w = await whereAreWe(page);
    console.log('where:', JSON.stringify(w));
    if (w.onFindAgency) { await searchAgencies(page, SEARCH_ZIP); console.log('agency:', JSON.stringify(await detectAgency(page, AGENCY))); }
    if (w.onDateTime) { console.log('datetime:', JSON.stringify(await detectDateTime(page))); }
    return;
  }

  let establishedOnce = false;
  let offTargetSince = null;
  let offNudged = false;

  while (!closed) {
    const w = await whereAreWe(page);

    // --- Step 2: Find an Agency -> if selectable, GO VERIFY the real calendar -
    if (w.onFindAgency) {
      establishedOnce = true; offTargetSince = null; offNudged = false;
      saveSession(w.url);
      await searchAgencies(page, SEARCH_ZIP);
      const a = await detectAgency(page, AGENCY);
      if (a.selectable) {
        // selectable != bookable. Click Select to open the date/time page; the
        // Step-3 branch below does the REAL slot check (and is the only alarm).
        log(`${AGENCY} is selectable — opening its calendar to verify a real slot...`);
        const clicked = await clickAgencySelect(page, AGENCY);
        if (clicked) { await settleDateTime(page); } else { await sleep(2000); }
      } else {
        const wait = jitter();
        log(`${AGENCY}: not selectable yet${a.listed ? '' : ` (not in results for ${SEARCH_ZIP} — check SEARCH_ZIP)`}. Next check in ${Math.round(wait / 1000)}s.`);
        await sleep(wait);
      }
      continue;
    }

    // --- Step 3: date/time -> a REAL open window? (the ONLY thing that alarms) -
    if (w.onDateTime) {
      establishedOnce = true; offTargetSince = null; offNudged = false;
      saveSession(w.url);
      const d = await detectDateTime(page);
      if (d.available) {
        // Double-check ~1.5s later to rule out a transient half-rendered read.
        await sleep(1500);
        const d2 = await detectDateTime(page);
        if (d2.available) {
          await onAvailable(page, `REAL OPEN SLOT at ${AGENCY}! (days=${d2.dayCount}, empty=${d2.noCount}, windows=${d2.slotCount})`, `Pick the open window and click Next.`);
          continue;
        }
        log(`${AGENCY}: availability flickered (partial render) — ignoring, re-checking.`);
      }
      const wait = calJitter();
      log(`${AGENCY} calendar: no real slots (days=${d.dayCount}, empty=${d.noCount}). Reloading in ${Math.round(wait / 1000)}s.`);
      await sleep(wait);
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(async (e) => { log(`reload hiccup: ${e.message}`); await sleep(3000); });
      await settleDateTime(page);
      continue;
    }

    // --- Anywhere else: Step 1 setup, booking steps, home, expired --------
    // Single QUIET off-target state. No siren — Step 1 and the Step 4/5 booking
    // pages both land here, and mistaking either for "expired" is the bug we hit.
    if (!establishedOnce) {
      log('Waiting for you to reach "Find an Agency" (complete Step 1 Travel Plans in the Chrome window)...');
      await sleep(6000);
      continue;
    }
    // Was watching, now off the watch page (you're booking, or the session
    // dropped). Log softly; only after a sustained absence send ONE gentle nudge.
    if (offTargetSince === null) offTargetSince = Date.now();
    const offSec = Math.round((Date.now() - offTargetSince) / 1000);
    log(`Not on the agency-list / date-time page (you're booking, or the session dropped) — return to the agency list to resume watching ${AGENCY}. (${offSec}s)`);
    if (!offNudged && (Date.now() - offTargetSince) > 90000) {
      offNudged = true;
      alarmExpired();
      await pushPhone(`Passport watcher idle (${AGENCY})`, 'Off the watch page 90s+. If you are not booking, redo Step 1 to resume.', 'default', 'warning');
    }
    await sleep(8000);
  }
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
