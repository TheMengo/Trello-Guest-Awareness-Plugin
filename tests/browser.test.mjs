import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { installWorkerApi } from './fixtures/worker-api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = await readFile(path.join(ROOT, 'tests/fixtures/trello.html'), 'utf8');
const modernFixture = await readFile(path.join(ROOT, 'tests/fixtures/modern-trello.html'), 'utf8');
const ID = { board: 'a'.repeat(24), board2: 'b'.repeat(24), card: 'c'.repeat(24), card2: 'd'.repeat(24), workspace: 'f'.repeat(24), internal: '1'.repeat(24), alex: '2'.repeat(24), sam: '3'.repeat(24) };
const internal = { id: ID.internal, username: 'employee', fullName: 'Internal Employee' };
const alex = { id: ID.alex, username: 'guest_alex', fullName: 'Alex Johnson' };
const sam = { id: ID.sam, username: 'guest_sam', fullName: 'Sam Lee' };
const credentials = { apiKey: 'a'.repeat(32), token: 'b'.repeat(64) };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const shadowText = locator => locator.evaluate(node => node.shadowRoot?.querySelector('.indicator,dialog')?.textContent ?? node.textContent ?? '');
async function eventually(fn, message, timeout = 9000) {
  let value; const started = Date.now();
  while (Date.now() - started < timeout) { value = await fn(); if (value) return value; await sleep(40); }
  assert.ok(value, message);
}

async function setup(t, overrides = {}) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'tga-browser-'));
  const pageFixture = overrides.modern ? modernFixture : fixture;
  const mock = { members: [internal, alex], workspace: [internal], cardMembers: [ID.internal], card2Members: [ID.alex], status: 200, delay: 0, ...overrides };
  const errors = [];
  const launchOptions = {
    channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
    args: [`--disable-extensions-except=${path.join(ROOT, 'dist')}`, `--load-extension=${path.join(ROOT, 'dist')}`],
  };
  let context = await chromium.launchPersistentContext(profile, launchOptions);
  t.after(async () => {
    const violations = await worker.evaluate(() => globalThis.fixtureViolations ?? []).catch(() => []);
    await context.close(); await rm(profile, { recursive: true, force: true });
    assert.deepEqual(errors, [], 'No page or extension service-worker console errors');
    assert.deepEqual(violations, [], 'All extension requests are authorized, read-only, and credential-safe');
  });
  const watched = new WeakSet();
  function watchPage(page) {
    if (watched.has(page)) return; watched.add(page);
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  }
  context.on('page', watchPage);
  // Extension service-worker fetches cannot be context.route-intercepted. The fixture
  // substitutes only this isolated test worker's fetch; production bundles are unchanged.
  await context.route('https://trello.com/**', route => route.fulfill({ contentType: 'text/html', body: pageFixture }));
  let worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  async function installMock(target = worker) {
    worker = target;
    await worker.evaluate(installWorkerApi, { mock, ids: ID, members: { internal } });
    worker.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  }
  async function apiRequests() { return worker.evaluate(() => globalThis.fixtureRequests ?? []); }
  async function restart() {
    await context.close();
    context = await chromium.launchPersistentContext(profile, launchOptions);
    context.on('page', watchPage);
    await context.route('https://trello.com/**', route => route.fulfill({ contentType: 'text/html', body: pageFixture }));
    const replacement = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    await installMock(replacement);
    const reloadedPage = context.pages()[0] ?? await context.newPage(); watchPage(reloadedPage);
    return { context, page: reloadedPage };
  }
  await installMock();
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(async config => {
    globalThis.testTimeOffset = 0;
    const now = Date.now.bind(Date); Date.now = () => now() + globalThis.testTimeOffset;
    await chrome.storage.local.clear(); if (config) await chrome.storage.local.set({ credentials: config });
  }, overrides.unconfigured ? null : credentials);
  const page = context.pages()[0] ?? await context.newPage();
  watchPage(page);
  await page.goto(`https://trello.com/${overrides.boardOnly ? 'b/AbCd1234/product' : 'c/CaRd1234/card'}${overrides.contenteditable ? '?editor=contenteditable' : overrides.asyncSubmission ? '?submission=async' : ''}`);
  const board = page.locator('#tga-board-indicator');
  const card = page.locator('#tga-card-indicator');
  const dialog = page.locator('#tga-confirmation');
  const editor = page.getByRole('textbox', { name: 'Write a comment' });
  const save = page.getByRole('button', { name: 'Save', exact: true });
  async function ready() {
    try { await eventually(async () => {
      const text = await shadowText(board).catch(() => '');
      return mock.status !== 200 || overrides.unconfigured || mock.noWorkspace
        ? /Unable to verify/i.test(text) && !/Checking/i.test(text)
        : /This board has \d+ guests?\./i.test(text);
    }, 'Expected completed extension indicator'); } catch (error) {
      throw new Error(`${error.message}\nFixture API requests: ${JSON.stringify(await apiRequests())}\nIndicator: ${await shadowText(board).catch(() => '(absent)')}\nBrowser errors: ${JSON.stringify(errors)}`, { cause: error });
    }
  }
  async function openComposer() {
    if (overrides.modern && await page.getByTestId('card-back-new-comment-input-skeleton').count()) await page.getByTestId('card-back-new-comment-input-skeleton').click();
  }
  async function comment(text = 'Please review this release.') { await openComposer(); await editor.fill(text); await save.click(); }
  async function count() { return page.evaluate(() => window.fixture.submissions); }
  async function refresh() {
    // Advance only the isolated test worker clock past the production rate-limit floor.
    await worker.evaluate(data => { globalThis.fixtureData = data; globalThis.testTimeOffset += 65_000; }, mock);
    await board.getByRole('button', { name: /Refresh/i }).click();
  }
  return { context, worker, page, mock, apiRequests, installMock, restart, errors, extensionId, board, card, dialog, editor, save, ready, openComposer, comment, count, refresh };
}

test('MV3 loads: one guest indicator, native Cancel preserves draft, Post Anyway submits once', { timeout: 60000 }, async t => {
  const x = await setup(t); await x.ready();
  assert.match(await shadowText(x.board), /1 guest/i);
  assert.match(await shadowText(x.board), /cards|comments|attachments/i);
  await x.comment('Sensitive release note'); await x.dialog.getByRole('dialog').waitFor();
  assert.equal(await x.count(), 0);
  await mkdir(path.join(ROOT, 'test-results'), { recursive: true });
  await x.page.screenshot({ path: path.join(ROOT, 'test-results/light-desktop-confirmation.png'), fullPage: true, animations: 'disabled' });
  await x.dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await x.editor.inputValue(), 'Sensitive release note'); assert.equal(await x.count(), 0);
  await x.save.click(); await x.dialog.getByRole('dialog').waitFor();
  await x.dialog.getByRole('button', { name: 'Post Anyway', exact: true }).click();
  await eventually(async () => await x.count() === 1, 'Native post must resume exactly once');
  assert.equal(await x.editor.inputValue(), ''); assert.deepEqual(x.errors, []);
  assert.ok((await x.apiRequests()).length >= 4);
});

test('No guests: indicator absent and native comment works without confirmation', { timeout: 60000 }, async t => {
  const x = await setup(t, { members: [internal] });
  await eventually(async () => (await x.apiRequests()).length >= 4, 'Expected membership API calls'); await sleep(250);
  assert.equal(await x.board.count(), 0); await x.comment();
  await eventually(async () => await x.count() === 1, 'No-guest native submit'); assert.equal(await x.dialog.count(), 0);
});

test('Multiple guests, assigned guest, draft mentions, @card/@board audience, prior explicit mention', { timeout: 60000 }, async t => {
  const x = await setup(t, { members: [internal, alex, sam], cardMembers: [ID.internal, ID.alex] }); await x.ready();
  assert.match(await shadowText(x.board), /2 guests/i);
  await eventually(async () => /Alex Johnson/.test(await shadowText(x.card).catch(() => '')), 'Card member warning');
  assert.match(await shadowText(x.card), /may receive|notification/i);
  await x.editor.fill('@guest_sam @card @board Please review');
  await eventually(async () => /Sam Lee/.test(await shadowText(x.card).catch(() => '')), 'Resolved current guest mention');
  await x.page.evaluate(id => window.fixture.setHistory(id), ID.sam);
  await eventually(async () => /previous|earlier|prior/i.test(await shadowText(x.card).catch(() => '')), 'Prior involvement warning');
  await x.save.click(); await x.dialog.getByRole('dialog').waitFor();
  const text = await shadowText(x.dialog); assert.match(text, /Alex Johnson/); assert.match(text, /Sam Lee/); assert.match(text, /@card/); assert.match(text, /@board/);
  assert.equal(await x.dialog.count(), 1); assert.equal(await x.count(), 0);
});

test('Keyboard comment submission is confirmed; ordinary Enter and empty comments are unchanged', { timeout: 60000 }, async t => {
  const x = await setup(t); await x.ready();
  await x.editor.focus(); await x.editor.press('Control+Enter'); assert.equal(await x.dialog.count(), 0); assert.equal(await x.count(), 0);
  await x.editor.fill('Line one'); await x.editor.press('Enter'); assert.equal(await x.dialog.count(), 0);
  assert.match(await x.editor.inputValue(), /\n/);
  await x.editor.press('Control+Enter'); await x.dialog.getByRole('dialog').waitFor();
  await x.dialog.getByRole('button', { name: 'Post Anyway', exact: true }).click();
  await eventually(async () => await x.count() === 1, 'Keyboard post resumed');
});

test('Double click Post Anyway and rapid original clicks never duplicate comments or dialogs', { timeout: 60000 }, async t => {
  const x = await setup(t); await x.ready(); await x.comment('One comment only'); await x.dialog.getByRole('dialog').waitFor();
  await x.dialog.getByRole('button', { name: 'Post Anyway', exact: true }).dblclick();
  await eventually(async () => await x.count() === 1, 'Single post after double click');
  await sleep(100); assert.equal(await x.count(), 1); assert.equal(await x.dialog.count(), 0);
  await x.editor.fill('Next draft'); await x.save.dblclick(); await x.dialog.getByRole('dialog').waitFor();
  assert.equal(await x.dialog.count(), 1); assert.equal(await x.count(), 1);
});

test('Contenteditable native composer preserves draft and resumes its own handler', { timeout: 60000 }, async t => {
  const x = await setup(t, { contenteditable: true }); await x.ready();
  await x.comment('Rich editor @guest_alex'); await x.dialog.getByRole('dialog').waitFor();
  await x.dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await x.editor.innerText(), 'Rich editor @guest_alex');
  await x.editor.press('Meta+Enter'); await x.dialog.getByRole('dialog').waitFor();
  await x.dialog.getByRole('button', { name: 'Post Anyway', exact: true }).click();
  await eventually(async () => await x.count() === 1, 'Rich native submit');
  assert.equal(await x.editor.innerText(), '');
});

test('Asynchronous native Save handler resumes its own form submit once after approval', { timeout: 60000 }, async t => {
  const x = await setup(t, { asyncSubmission: true }); await x.ready();
  await x.comment('Async native submission'); await x.dialog.getByRole('dialog').waitFor(); assert.equal(await x.count(), 0);
  await x.dialog.getByRole('button', { name: 'Post Anyway', exact: true }).click();
  await eventually(async () => await x.count() === 1, 'Delayed native submit must retain approval');
  await sleep(150); assert.equal(await x.count(), 1); assert.equal(await x.dialog.count(), 0);
});

test('Navigating during confirmation closes popup and preserves the retained original draft', { timeout: 60000 }, async t => {
  const x = await setup(t); await x.ready(); await x.comment('Keep this draft during navigation'); await x.dialog.getByRole('dialog').waitFor();
  await x.page.evaluate(() => window.fixture.navigateDelayed('AbCd1234', 'CaRd5678', 3000));
  await eventually(async () => await x.dialog.count() === 0, 'Old-card dialog closes on navigation');
  assert.equal(await x.count(), 0); assert.equal(await x.editor.inputValue(), 'Keep this draft during navigation');
  // New-card API information must not be attributed to Trello's retained old-card editor.
  await sleep(250);
  if (await x.card.count()) {
    const retained = await shadowText(x.card);
    assert.doesNotMatch(retained, /Alex Johnson|card member|may receive notifications/i, 'New-card identity must not attach to the retained old editor');
    assert.match(retained, /unavailable|not recognized/i);
  }
});

test('Board dismissal persists over refresh, card warning remains independent, settings can restore', { timeout: 60000 }, async t => {
  const x = await setup(t); await x.ready(); await x.comment(); await x.dialog.getByRole('dialog').waitFor();
  await x.dialog.getByRole('checkbox').check(); await x.dialog.getByRole('button', { name: 'Post Anyway', exact: true }).click();
  await eventually(async () => await x.count() === 1, 'Dismissed warning posts');
  await x.page.reload(); await x.ready(); await x.comment('Board dismissal saved');
  await eventually(async () => await x.count() === 1, 'Board dismissal persisted'); assert.equal(await x.dialog.count(), 0);
  await x.page.getByRole('button', { name: 'Next card', exact: true }).click();
  await eventually(async () => /Alex Johnson/.test(await shadowText(x.card).catch(() => '')), 'New card stronger warning');
  await x.comment('Card warning is independent'); await x.dialog.getByRole('dialog').waitFor();
  await x.dialog.getByRole('checkbox').check(); await x.dialog.getByRole('button', { name: 'Post Anyway', exact: true }).click();
  await eventually(async () => await x.count() === 2, 'Card dismissal posts');
  const options = await x.context.newPage(); await options.goto(`chrome-extension://${x.extensionId}/options.html`);
  await options.setViewportSize({ width: 1280, height: await options.evaluate(() => document.documentElement.scrollHeight) });
  await options.screenshot({ path: path.join(ROOT, 'test-results/settings-desktop.png'), animations: 'disabled' });
  await options.getByRole('button', { name: `Restore board warning ${ID.board}`, exact: true }).click();
  assert.equal(await options.getByRole('button', { name: `Restore board warning ${ID.board}`, exact: true }).count(), 0);
  assert.equal(await options.getByRole('button', { name: `Restore card warning ${ID.card2}`, exact: true }).count(), 1, 'Restoring one scope preserves the other dismissal');
  await options.getByRole('button', { name: /Clear all|Restore all/i }).click();
  await x.page.bringToFront(); await x.editor.fill('Warnings restored'); await x.save.click(); await x.dialog.getByRole('dialog').waitFor();
  assert.match(await shadowText(x.dialog), /Alex Johnson/);
});

test('Guest membership changes invalidate board dismissal and removing guests removes banner', { timeout: 60000 }, async t => {
  const x = await setup(t); await x.ready(); await x.comment(); await x.dialog.getByRole('dialog').waitFor();
  await x.dialog.getByRole('checkbox').check(); await x.dialog.getByRole('button', { name: 'Post Anyway', exact: true }).click();
  await eventually(async () => await x.count() === 1, 'First post');
  x.mock.members.push(sam); await x.refresh();
  await eventually(async () => /2 guests/i.test(await shadowText(x.board).catch(() => '')), 'New guest count after refresh');
  await x.comment('New guest must warn again'); await x.dialog.getByRole('dialog').waitFor();
  await x.dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  x.mock.members = [internal]; await x.refresh();
  await eventually(async () => await x.board.count() === 0, 'Banner removed after guest removal');
});

test('Guest added to card invalidates its prior dismissal', { timeout: 60000 }, async t => {
  const x = await setup(t, { members: [internal, alex, sam], cardMembers: [ID.alex] }); await x.ready();
  await x.comment(); await x.dialog.getByRole('dialog').waitFor(); await x.dialog.getByRole('checkbox').check();
  await x.dialog.getByRole('button', { name: 'Post Anyway', exact: true }).click(); await eventually(async () => await x.count() === 1, 'Initial card post');
  x.mock.cardMembers.push(ID.sam); await x.refresh();
  await eventually(async () => /Sam Lee/.test(await shadowText(x.card).catch(() => '')), 'New guest card member');
  await x.comment('Changed audience'); await x.dialog.getByRole('dialog').waitFor(); assert.match(await shadowText(x.dialog), /Sam Lee/);
});

test('SPA card/board navigation and slow requests never display stale card warnings', { timeout: 60000 }, async t => {
  const x = await setup(t, { delay: 130 }); await x.ready();
  await x.page.getByRole('button', { name: 'Next card', exact: true }).click();
  await x.page.getByRole('button', { name: 'Board two', exact: true }).click();
  await sleep(900); assert.equal(await x.card.count(), 0); assert.equal(await x.dialog.count(), 0); assert.equal(await x.board.count(), 0);
  await x.page.getByRole('button', { name: 'Open card', exact: true }).click(); await x.ready();
  await x.comment('After navigation'); await x.dialog.getByRole('dialog').waitFor();
  assert.equal(await x.dialog.count(), 1); assert.equal(await x.count(), 0);
});

for (const [status, label] of [[401, 'expired authorization'], [403, 'missing Workspace permission'], [500, 'network/API failure']]) {
  test(`Unable to verify for ${label}; comment editor remains usable`, { timeout: 60000 }, async t => {
    const x = await setup(t, { status }); await x.ready();
    assert.match(await shadowText(x.board), /Unable to verify/i);
    await x.comment('Draft survives API failure');
    if (await x.dialog.count()) await x.dialog.getByRole('button', { name: /Post Anyway/i }).click();
    await eventually(async () => await x.count() === 1, 'API failure must not freeze native submit');
  });
}

test('Unconfigured extension explicitly shows unable-to-verify and does not block native comments', { timeout: 60000 }, async t => {
  const x = await setup(t, { unconfigured: true }); await x.ready(); assert.match(await shadowText(x.board), /Unable to verify/i);
  await x.comment('Unconfigured native draft');
  if (await x.dialog.count()) await x.dialog.getByRole('button', { name: /Post Anyway/i }).click();
  await eventually(async () => await x.count() === 1, 'Unconfigured native submit'); assert.equal((await x.apiRequests()).length, 0);
});

test('Settings setup validates credentials, requests only read authorization, verifies access and disconnects', { timeout: 60000 }, async t => {
  const x = await setup(t, { unconfigured: true }); await x.ready();
  const options = await x.context.newPage(); await options.goto(`chrome-extension://${x.extensionId}/options.html`);
  const key = options.getByRole('textbox', { name: 'API key', exact: true });
  const token = options.locator('#api-token');
  await key.fill('invalid'); const pages = x.context.pages().length;
  await options.getByRole('button', { name: 'Open read-only authorization', exact: true }).click();
  assert.match(await options.locator('#status').innerText(), /valid Trello API key/i);
  assert.equal(x.context.pages().length, pages); assert.equal((await x.apiRequests()).length, 0);
  await key.fill(credentials.apiKey);
  const opened = x.context.waitForEvent('page');
  await options.getByRole('button', { name: 'Open read-only authorization', exact: true }).click();
  const authorization = await opened; await authorization.waitForURL('https://trello.com/1/authorize?**');
  const url = new URL(authorization.url());
  assert.equal(url.searchParams.get('scope'), 'read'); assert.equal(url.searchParams.get('expiration'), 'never');
  assert.equal(url.searchParams.get('key'), credentials.apiKey); assert.equal(url.searchParams.get('response_type'), 'token');
  assert.equal(url.searchParams.has('token'), false); await authorization.close();
  await token.fill(credentials.token); await options.getByRole('button', { name: 'Save & verify', exact: true }).click();
  await eventually(async () => /read access verified/i.test(await options.locator('#status').innerText()), 'Saved read-only credentials verified');
  assert.ok((await x.apiRequests()).some(request => request.pathname === '/members/me'));
  assert.equal(await token.inputValue(), '', 'Token is cleared from the settings input after saving');
  await eventually(async () => /This board has 1 guest/.test(await shadowText(x.board).catch(() => '')), 'Configured open tab updates');
  await mkdir(path.join(ROOT, 'test-results'), { recursive: true });
  await options.setViewportSize({ width: 1280, height: await options.evaluate(() => document.documentElement.scrollHeight) });
  await options.screenshot({ path: path.join(ROOT, 'test-results/settings-setup-desktop.png'), animations: 'disabled' });
  await options.getByRole('button', { name: 'Remove saved credentials', exact: true }).click();
  await eventually(async () => /Unable to verify/i.test(await shadowText(x.board).catch(() => '')), 'Disconnect updates the open tab');
  await x.comment('After disconnect'); await eventually(async () => await x.count() === 1, 'Disconnected native submission remains available');
});

test('Disabled extension leaves Trello commenting intact', { timeout: 60000 }, async t => {
  const x = await setup(t);
  await x.worker.evaluate(async () => { await chrome.storage.local.set({ enabled: false }); });
  await x.page.reload(); await sleep(250); await x.comment('Disabled extension');
  await eventually(async () => await x.count() === 1, 'Disabled native submit'); assert.equal(await x.dialog.count(), 0);
});

test('Browser with no extension loaded preserves baseline native commenting', { timeout: 60000 }, async t => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  t.after(() => browser.close()); const context = await browser.newContext(); const page = await context.newPage();
  await context.route('https://trello.com/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
  await page.goto('https://trello.com/c/CaRd1234/card');
  await page.getByRole('textbox', { name: 'Write a comment' }).fill('Native baseline');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  assert.equal(await page.evaluate(() => window.fixture.submissions), 1);
  assert.equal(await page.locator('#tga-confirmation, #tga-board-indicator, #tga-card-indicator').count(), 0);
});

test('No Workspace and removed credentials are explicit unknown states instead of stale guest data', { timeout: 60000 }, async t => {
  const x = await setup(t, { noWorkspace: true }); await x.ready(); assert.match(await shadowText(x.board), /Unable to verify/i);
  await x.worker.evaluate(() => chrome.storage.local.remove('credentials'));
  await eventually(async () => /Unable to verify/i.test(await shadowText(x.board)), 'Removed credentials unknown state');
  await x.comment('Unknown status remains usable'); await eventually(async () => await x.count() === 1, 'Unknown native post');
});

test('Credential removal clears previously verified guest state in an open tab', { timeout: 60000 }, async t => {
  const x = await setup(t, { cardMembers: [ID.alex] }); await x.ready();
  await eventually(async () => /Alex Johnson/.test(await shadowText(x.card).catch(() => '')), 'Verified initial card data');
  await x.worker.evaluate(() => chrome.storage.local.remove('credentials'));
  await eventually(async () => /Unable to verify/i.test(await shadowText(x.board).catch(() => '')), 'Credentials change invalidates snapshot');
  assert.equal(await x.card.count(), 0); await x.comment('No stale confirmation');
  await eventually(async () => await x.count() === 1, 'Native submit without stale snapshot'); assert.equal(await x.dialog.count(), 0);
});

test('A dismissal in one Trello tab updates another tab without duplicate requests or secrets', { timeout: 60000 }, async t => {
  const x = await setup(t); await x.ready(); const second = await x.context.newPage();
  await second.goto('https://trello.com/c/CaRd1234/card');
  await eventually(async () => /This board has 1 guest/.test(await shadowText(second.locator('#tga-board-indicator')).catch(() => '')), 'Second tab receives cached membership');
  const initialRequests = (await x.apiRequests()).length;
  await x.comment('Dismiss across tabs'); await x.dialog.getByRole('dialog').waitFor(); await x.dialog.getByRole('checkbox').check();
  await x.dialog.getByRole('button', { name: 'Post Anyway', exact: true }).click(); await eventually(async () => await x.count() === 1, 'First tab post');
  await sleep(200); await second.getByRole('textbox', { name: 'Write a comment' }).fill('Second tab acknowledged');
  await second.getByRole('button', { name: 'Save', exact: true }).click();
  await eventually(() => second.evaluate(() => window.fixture.submissions === 1), 'Second tab uses persisted dismissal');
  assert.equal(await second.locator('#tga-confirmation').count(), 0);
  assert.ok((await x.apiRequests()).length <= initialRequests + 4, 'Preference broadcast does not duplicate API requests');
  const accessible = await second.evaluate(async () => { try { return await chrome.storage.local.get('credentials'); } catch { return null; } });
  assert.equal(accessible, null, 'Page world has no extension credential storage access');
});

test('Light/dark and narrow viewports: keyboard focus, Escape cancellation, dialog announcement', { timeout: 60000 }, async t => {
  const x = await setup(t, { cardMembers: [ID.alex] }); await x.ready();
  await x.page.setViewportSize({ width: 390, height: 844 }); await x.page.getByRole('button', { name: 'Toggle theme', exact: true }).click();
  await eventually(async () => await x.board.evaluate(host => getComputedStyle(host.shadowRoot.querySelector('.indicator')).backgroundColor) === 'rgb(51, 46, 27)', 'Indicator follows Trello dark theme');
  await x.comment('Accessible warning'); await x.dialog.getByRole('dialog').waitFor();
  const nativeDialog = x.dialog.getByRole('dialog'); assert.equal(await nativeDialog.count(), 1);
  await eventually(async () => await nativeDialog.evaluate(node => getComputedStyle(node).opacity) === '1', 'Dialog animation completes');
  assert.equal(await nativeDialog.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(34, 39, 43)', 'Dark dialog is opaque');
  assert.ok(await nativeDialog.getAttribute('aria-labelledby') || await nativeDialog.getAttribute('aria-label'), 'Dialog has accessible name');
  assert.ok(await nativeDialog.getAttribute('aria-describedby'), 'Dialog has announced description');
  const box = await nativeDialog.boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= 392, 'Dialog fits mobile width');
  assert.equal(await x.page.evaluate(() => document.activeElement?.id), 'tga-confirmation', 'Focus moves into isolated dialog host');
  await x.page.keyboard.press('Escape'); await eventually(async () => await x.dialog.count() === 0, 'Escape cancels');
  assert.equal(await x.editor.inputValue(), 'Accessible warning');
  assert.equal(await x.page.evaluate(() => document.activeElement?.id), 'comment', 'Cancel restores focus to original editor');
  await x.save.click(); await x.dialog.getByRole('dialog').waitFor();
  const focused = () => x.dialog.evaluate(host => { const active = host.shadowRoot.activeElement; return active?.tagName === 'INPUT' ? 'checkbox' : active?.textContent; });
  assert.equal(await focused(), 'Cancel'); await x.page.keyboard.press('Tab'); assert.equal(await focused(), 'Post Anyway');
  await x.page.keyboard.press('Tab'); assert.equal(await focused(), 'checkbox');
  await x.page.keyboard.press('Tab'); assert.equal(await focused(), 'Cancel');
  await x.page.keyboard.press('Shift+Tab'); assert.equal(await focused(), 'checkbox', 'Reverse focus wraps inside dialog');
  assert.equal(await x.page.evaluate(() => document.activeElement?.id), 'tga-confirmation', 'Tab focus stays inside modal');
  await mkdir(path.join(ROOT, 'test-results'), { recursive: true });
  await x.page.screenshot({ path: path.join(ROOT, 'test-results/dark-mobile-confirmation.png'), fullPage: true, animations: 'disabled' });
  assert.deepEqual(x.errors, []);
});

test('Repeated navigation and page refresh do not duplicate listeners or comments', { timeout: 60000 }, async t => {
  const x = await setup(t); await x.ready();
  for (let i = 0; i < 4; i++) {
    await x.page.getByRole('button', { name: 'Next card', exact: true }).click();
    await x.page.getByRole('button', { name: 'Open card', exact: true }).click();
  }
  await sleep(750); // Allow the documented SPA route sampler to settle after the final click.
  assert.equal(await x.card.count(), 0, 'Final replacement editor is recognized and has no guest card membership');
  await x.ready(); await x.comment('One dialog after repeated navigation'); await x.dialog.getByRole('dialog').waitFor();
  assert.equal(await x.dialog.count(), 1); assert.equal(await x.board.count(), 1);
  await x.dialog.getByRole('button', { name: 'Post Anyway', exact: true }).click();
  await eventually(async () => await x.count() === 1, 'One comment after navigation');
  await x.page.reload(); await x.ready(); await x.comment('One after extension content reload'); await x.dialog.getByRole('dialog').waitFor();
  assert.equal(await x.dialog.count(), 1);
});

test('Browser restart reloads the actual unpacked extension and preserves independent dismissal', { timeout: 60000 }, async t => {
  const x = await setup(t); await x.ready(); await x.comment('Before extension reload'); await x.dialog.getByRole('dialog').waitFor();
  await x.dialog.getByRole('checkbox').check(); await x.dialog.getByRole('button', { name: 'Post Anyway', exact: true }).click();
  await eventually(async () => await x.count() === 1, 'Post before restart');
  const { page } = await x.restart(); await page.goto('https://trello.com/c/CaRd1234/card');
  await eventually(async () => /This board has 1 guest/.test(await shadowText(page.locator('#tga-board-indicator')).catch(() => '')), 'Actual extension reloaded');
  const editor = page.getByRole('textbox', { name: 'Write a comment' }); const save = page.getByRole('button', { name: 'Save', exact: true });
  await editor.fill('After actual extension reload'); await save.click();
  await eventually(() => page.evaluate(() => window.fixture.submissions === 1), 'Saved dismissal works after extension reload');
  assert.equal(await page.locator('#tga-confirmation').count(), 0);
  await page.getByRole('button', { name: 'Next card', exact: true }).click();
  await eventually(async () => /Alex Johnson/.test(await shadowText(page.locator('#tga-card-indicator')).catch(() => '')), 'Stronger card warning survives extension reload');
  await editor.fill('Independent warning after reload'); await save.click();
  const dialog = page.locator('#tga-confirmation'); await dialog.getByRole('dialog').waitFor();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal(await editor.inputValue(), 'Independent warning after reload');
  await save.click(); await dialog.getByRole('dialog').waitFor(); await dialog.getByRole('button', { name: 'Post Anyway', exact: true }).click();
  await eventually(() => page.evaluate(() => window.fixture.submissions === 2), 'Native post after reloaded card warning');
});

/** Uses the actual worker-native fetch WebIDL receiver check, without real Trello traffic. */
async function nativeSettings(t) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'tga-auth-native-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
    args: [`--disable-extensions-except=${path.join(ROOT, 'dist')}`, `--load-extension=${path.join(ROOT, 'dist')}`],
  });
  t.after(async () => { await context.close(); await rm(profile, { recursive: true, force: true }); });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await worker.evaluate(async () => {
    await chrome.storage.local.clear();
    const nativeFetch = globalThis.fetch;
    globalThis.authFixture = { status: 200, calls: 0, validReceiver: [], expectedToken: 'b'.repeat(64), matchedToken: [] };
    // A normal function deliberately preserves the production caller's receiver.
    // Forwarding that receiver to native fetch catches Illegal invocation: the old
    // arrow-function fetch fixtures silently accepted TrelloClient as `this`.
    globalThis.fetch = function (input, options = {}) {
      const target = new URL(input instanceof Request ? input.url : String(input));
      if (target.origin !== 'https://api.trello.com' || target.pathname !== '/1/members/me'
        || target.searchParams.has('key') || target.searchParams.has('token')
        || options.method !== 'GET' || options.credentials !== 'omit') throw new Error('Invalid authorization fixture request');
      const fixture = globalThis.authFixture;
      fixture.calls++;
      fixture.validReceiver.push(this === globalThis);
      fixture.matchedToken.push(new Headers(options.headers).get('Authorization')?.includes(`oauth_token="${fixture.expectedToken}"`) === true);
      const body = JSON.stringify({ id: '1'.repeat(24) });
      const dataUrl = 'data:application/json,' + encodeURIComponent(body);
      return Reflect.apply(nativeFetch, this, [dataUrl, { method: 'GET' }]).then(async response => {
        if(fixture.delay)await new Promise(resolve=>setTimeout(resolve,fixture.delay));
        return fixture.status === 200 ? response : new Response('Authorization fixture failure', { status: fixture.status });
      });
    };
  });
  const extensionId = new URL(worker.url()).host;
  const options = await context.newPage(); await options.goto(`chrome-extension://${extensionId}/options.html`);
  const key = options.getByRole('textbox', { name: 'API key', exact: true });
  const token = options.locator('#api-token');
  const save = options.getByRole('button', { name: 'Save & verify', exact: true });
  const status = options.locator('#status'); const connection = options.locator('#connection-state');
  async function setCredentials() { await key.fill(credentials.apiKey); await token.fill(credentials.token); }
  async function clickSave() {
    await save.click();
    await eventually(async () => await save.isEnabled() && !/Verifying read access/.test(await status.innerText()), 'Authorization attempt completes');
  }
  async function state() { return worker.evaluate(() => ({ calls: authFixture.calls, validReceiver: authFixture.validReceiver, matchedToken: authFixture.matchedToken })); }
  return { context, worker, extensionId, options, key, token, save, status, connection, setCredentials, clickSave, state };
}

test('Settings authorization reaches native worker fetch with the correct receiver', { timeout: 60000 }, async t => {
  const x = await nativeSettings(t); await x.setCredentials(); await x.clickSave();
  assert.match(await x.status.innerText(), /read access verified/i);
  assert.match(await x.connection.innerText(), /Read access verified/i);
  assert.deepEqual(await x.state(), { calls: 1, validReceiver: [true], matchedToken: [true] });
  assert.equal(await x.token.inputValue(), '');
});

test('Settings token expiration defaults to Never expires with all supported choices', { timeout: 60000 }, async t => {
  const x = await nativeSettings(t);
  const expiration = x.options.getByRole('combobox', { name: 'Authorization token expiration', exact: true });
  assert.equal(await expiration.inputValue(), 'never');
  assert.deepEqual(await expiration.locator('option').evaluateAll(options => options.map(option => ({ value: option.value, label: option.label }))), [
    { value: '1hour', label: '1 hour' }, { value: '1day', label: '1 day' },
    { value: '30days', label: '30 days' }, { value: 'never', label: 'Never expires' },
  ]);
  assert.equal(await expiration.evaluate(node => Boolean(node.compareDocumentPosition(document.getElementById('authorize')) & Node.DOCUMENT_POSITION_FOLLOWING)), true,
    'Expiration selector precedes the authorization button');
  assert.match(await x.options.locator('body').innerText(), /existing tokens retain|existing tokens keep|existing tokens.*original expiration/i);
  assert.match(await x.options.locator('body').innerText(), /no scheduled expiration/i);
  assert.equal((await x.state()).calls, 0, 'Opening Settings does not verify or replace authorization');
  await mkdir(path.join(ROOT, 'test-results'), { recursive: true });
  await x.options.emulateMedia({ colorScheme: 'light' });
  await x.options.screenshot({ path: path.join(ROOT, 'test-results/settings-expiration-light.png'), fullPage: true, animations: 'disabled' });
  const lightBackground = await expiration.evaluate(node => getComputedStyle(node).backgroundColor);
  await x.options.emulateMedia({ colorScheme: 'dark' }); await x.options.setViewportSize({ width: 390, height: 844 });
  assert.notEqual(await expiration.evaluate(node => getComputedStyle(node).backgroundColor), lightBackground, 'Expiration selector follows dark mode');
  assert.equal(await expiration.evaluate(node => getComputedStyle(node).backgroundColor), await x.key.evaluate(node => getComputedStyle(node).backgroundColor), 'Selector matches existing credential field styling');
  assert.equal(await x.options.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Settings fit the narrow viewport');
  await x.options.screenshot({ path: path.join(ROOT, 'test-results/settings-expiration-dark-mobile.png'), fullPage: true, animations: 'disabled' });
});

test('Each token expiration is persisted across Settings reopening and used only in read authorization URLs', { timeout: 60000 }, async t => {
  const x = await setup(t, { unconfigured: true });
  let options = await x.context.newPage(); await options.goto(`chrome-extension://${x.extensionId}/options.html`);
  for (const value of ['1hour', '1day', '30days', 'never']) {
    await options.getByRole('combobox', { name: 'Authorization token expiration', exact: true }).selectOption(value);
    await eventually(async () => await x.worker.evaluate(async expected => (await chrome.storage.local.get('authorizationExpiration')).authorizationExpiration === expected, value),
      `Expiration preference ${value} is persisted`);
    await options.close();
    options = await x.context.newPage(); await options.goto(`chrome-extension://${x.extensionId}/options.html`);
    await eventually(async () => await options.locator('#authorization-expiration').inputValue() === value, `Reopened Settings restores ${value}`);
    await options.getByRole('textbox', { name: 'API key', exact: true }).fill(credentials.apiKey);
    const opened = x.context.waitForEvent('page');
    await options.getByRole('button', { name: 'Open read-only authorization', exact: true }).click();
    const authorization = await opened; await authorization.waitForURL('https://trello.com/1/authorize?**');
    const url = new URL(authorization.url());
    assert.equal(url.origin, 'https://trello.com'); assert.equal(url.pathname, '/1/authorize');
    assert.deepEqual([...url.searchParams.keys()].sort(), ['expiration', 'key', 'name', 'response_type', 'scope']);
    assert.equal(url.searchParams.get('expiration'), value); assert.equal(url.searchParams.get('scope'), 'read');
    assert.equal(url.searchParams.get('key'), credentials.apiKey); assert.equal(url.searchParams.get('response_type'), 'token');
    assert.equal(url.searchParams.has('token'), false); await authorization.close();
  }
  assert.equal((await x.apiRequests()).length, 0, 'Selecting expiration and opening consent does not send an API verification request');
});

test('Invalid or missing saved token expiration safely restores Never expires', { timeout: 60000 }, async t => {
  const x = await nativeSettings(t);
  for (const value of ['forever', '', 'NEVER', '1hour&scope=write', 30, null, ['1day'], { expiration: '1day' }]) {
    await x.worker.evaluate(async saved => chrome.storage.local.set({ authorizationExpiration: saved }), value);
    await x.options.reload();
    await eventually(async () => await x.options.locator('#authorization-expiration').isEnabled(), 'Settings expiration restoration completes');
    assert.equal(await x.options.locator('#authorization-expiration').inputValue(), 'never');
  }
  await x.worker.evaluate(() => chrome.storage.local.remove('authorizationExpiration'));
  await x.options.reload();
  await eventually(async () => await x.options.locator('#authorization-expiration').isEnabled(), 'Settings handles a missing preference');
  assert.equal(await x.options.locator('#authorization-expiration').inputValue(), 'never');
  assert.equal((await x.state()).calls, 0);
});

test('Changing token expiration preserves verified credentials and blank-token verification', { timeout: 60000 }, async t => {
  const x = await nativeSettings(t); await x.setCredentials(); await x.clickSave();
  assert.match(await x.connection.innerText(), /Read access verified/i);
  for (const [index, value] of ['1hour', '1day', '30days', 'never'].entries()) {
    await x.options.locator('#authorization-expiration').selectOption(value);
    await eventually(async () => await x.worker.evaluate(async expected => (await chrome.storage.local.get('authorizationExpiration')).authorizationExpiration === expected, value),
      'New authorization expiration is saved independently');
    assert.match(await x.connection.innerText(), /Read access verified/i, 'An expiration choice does not invalidate current verification');
    assert.equal(await x.worker.evaluate(async expected => {
      const saved = (await chrome.storage.local.get('credentials')).credentials;
      return saved?.apiKey === expected.apiKey && saved?.token === expected.token;
    }, credentials), true, 'Existing credentials are unchanged');
    assert.equal((await x.state()).calls, index + 1, 'Changing expiration does not reverify or issue a token');
    assert.equal(await x.token.inputValue(), '');
    await x.clickSave();
    assert.match(await x.status.innerText(), /read access verified/i);
  }
  assert.deepEqual(await x.state(), { calls: 5, validReceiver: [true, true, true, true, true], matchedToken: [true, true, true, true, true] });
});

for (const status of [400, 401]) {
  test(`Settings authorization HTTP ${status} gives an actionable error without claiming unreachable`, { timeout: 60000 }, async t => {
    const x = await nativeSettings(t); await x.setCredentials();
    await x.worker.evaluate(value => { authFixture.status = value; }, status);
    await x.clickSave();
    const message = await x.status.innerText();
    assert.match(message, status === 400 ? /400|reject|key|token/i : /expired|revoked|reconnect|401/i);
    assert.doesNotMatch(message, /could not be reached|unreachable/i);
    assert.match(await x.connection.innerText(), /not.*verified|unverified|verification.*fail/i);
    assert.deepEqual(await x.state(), { calls: 1, validReceiver: [true], matchedToken: [true] });
  });
}

test('Save & verify with blank token reuses saved credentials and makes a fresh authorization request', { timeout: 60000 }, async t => {
  const x = await nativeSettings(t); await x.setCredentials(); await x.clickSave();
  assert.match(await x.status.innerText(), /read access verified/i);
  assert.equal(await x.token.inputValue(), '');
  await x.clickSave();
  assert.match(await x.status.innerText(), /read access verified/i);
  assert.deepEqual(await x.state(), { calls: 2, validReceiver: [true, true], matchedToken: [true, true] });
  await x.worker.evaluate(() => { authFixture.status = 401; });
  await x.clickSave();
  assert.match(await x.status.innerText(), /expired|revoked|reconnect|401/i);
  assert.match(await x.connection.innerText(), /not.*verified|unverified|verification.*fail/i);
  assert.equal((await x.state()).calls, 3, 'Revoked authorization is not hidden by a cached success');
});

test('An open Settings page reuses the latest stored token after another context replaces it', { timeout: 60000 }, async t => {
  const x = await nativeSettings(t); await x.setCredentials(); await x.clickSave();
  assert.match(await x.status.innerText(), /read access verified/i);
  await x.worker.evaluate(async apiKey => {
    authFixture.expectedToken = 'd'.repeat(64);
    await chrome.storage.local.set({ credentials: { apiKey, token: authFixture.expectedToken } });
  }, credentials.apiKey);
  assert.equal(await x.token.inputValue(), ''); await x.clickSave();
  assert.match(await x.status.innerText(), /read access verified/i);
  const state = await x.state(); assert.equal(state.calls, 2); assert.deepEqual(state.matchedToken, [true, true]);
  assert.equal(await x.worker.evaluate(async () => (await chrome.storage.local.get('credentials')).credentials?.token === authFixture.expectedToken), true,
    'Blank token cannot overwrite the replacement with a stale in-memory token');
});

test('An open Settings page cannot resurrect a removed token when the input is blank', { timeout: 60000 }, async t => {
  const x = await nativeSettings(t); await x.setCredentials(); await x.clickSave();
  assert.match(await x.status.innerText(), /read access verified/i);
  await x.worker.evaluate(() => chrome.storage.local.remove('credentials'));
  await x.clickSave();
  assert.match(await x.status.innerText(), /token|authorization|saved/i);
  assert.doesNotMatch(await x.status.innerText(), /read access verified/i);
  assert.equal(await x.worker.evaluate(async () => !!(await chrome.storage.local.get('credentials')).credentials), false);
  assert.equal((await x.state()).calls, 1, 'Missing token is handled before dispatching authenticated fetch');
});

test('Changing the API key with a blank token requires a matching token rather than reusing the old token', { timeout: 60000 }, async t => {
  const x = await nativeSettings(t); await x.setCredentials(); await x.clickSave();
  assert.match(await x.status.innerText(), /read access verified/i);
  await x.key.fill('c'.repeat(32)); await x.clickSave();
  assert.match(await x.status.innerText(), /token|authorization|key/i);
  assert.doesNotMatch(await x.status.innerText(), /read access verified/i);
  assert.equal((await x.state()).calls, 1);
  assert.equal(await x.worker.evaluate(async apiKey => (await chrome.storage.local.get('credentials')).credentials?.apiKey === apiKey, credentials.apiKey), true);
});

test('Settings reports worker communication failure separately from Trello connectivity and saved credentials', { timeout: 60000 }, async t => {
  const x = await nativeSettings(t); await x.setCredentials();
  await x.options.evaluate(() => { chrome.runtime.sendMessage = () => Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')); });
  await x.clickSave();
  const message = await x.status.innerText();
  assert.match(message, /worker|extension|reload|communication/i);
  assert.doesNotMatch(message, /Trello could not be reached|unreachable/i);
  assert.match(await x.connection.innerText(), /not.*verified|unverified|verification.*fail|verification.*unavailable/i);
  assert.equal(await x.worker.evaluate(async () => !!(await chrome.storage.local.get('credentials')).credentials), true, 'Successful saving remains explicit despite verification RPC failure');
  assert.equal((await x.state()).calls, 0);
});

test('Removing credentials during pending authorization cannot produce a late verified status', { timeout: 60000 }, async t => {
  const x = await nativeSettings(t); await x.setCredentials();
  await x.worker.evaluate(() => { authFixture.delay = 300; });
  await x.save.click();
  await eventually(async () => (await x.state()).calls === 1, 'Authorization request starts');
  await x.worker.evaluate(() => chrome.storage.local.remove('credentials'));
  await eventually(async () => await x.save.isEnabled(), 'Pending verification settles after credential removal');
  assert.doesNotMatch(await x.status.innerText(), /read access verified/i);
  assert.doesNotMatch(await x.connection.innerText(), /Read access verified/i);
  assert.equal(await x.worker.evaluate(async () => !!(await chrome.storage.local.get('credentials')).credentials), false);
});


const demoGuest = { id: ID.alex, username: 'guest_demo', fullName: 'Demo Guest' };
async function modernCardText(x) { return await x.card.count() ? shadowText(x.card) : ''; }
async function modernSetup(t, overrides = {}) {
  return setup(t, { modern: true, members: [internal, demoGuest], cardMembers: [ID.internal], card2Members: [ID.internal], ...overrides });
}

test('Modern live-derived card root shows assigned guest before opening the comment editor', { timeout: 60000 }, async t => {
  const x = await modernSetup(t, { cardMembers: [ID.alex] }); await x.ready();
  assert.equal(await x.page.locator('.window').isVisible(), false, 'Legacy root is unrelated and hidden');
  assert.equal(await x.page.locator('#overlay-contents').isVisible(), true);
  assert.equal(await x.editor.count(), 0, 'Comment composer begins collapsed');
  await eventually(async () => /Demo Guest/.test(await modernCardText(x)), 'Modern assigned-guest card warning');
  assert.match(await shadowText(x.card), /card member|card members/i);
  assert.match(await shadowText(x.card), /may receive notifications/i);
  assert.doesNotMatch(await shadowText(x.card), /not recognized|unavailable in this editor/i);
});

test('Modern username mention chip in a previous comment resolves a verified unassigned guest', { timeout: 60000 }, async t => {
  const x = await modernSetup(t); await x.ready();
  await x.page.evaluate(() => fixture.setHistory([{kind:'resolved',username:'guest_demo'}]));
  await eventually(async () => /Previously mentioned guests: Demo Guest/i.test(await modernCardText(x)), 'Explicit current Trello username chip maps to guest ID');
  const text = await shadowText(x.card);
  assert.match(text, /prior involvement/i);
  assert.match(text, /does not.*receive notifications.*future comments/i);
  assert.doesNotMatch(text, /Guest card member|Guest mention in this draft/i);
  assert.equal(await x.count(), 0);
  await mkdir(path.join(ROOT, 'test-results'), { recursive: true });
  await x.page.screenshot({ path: path.join(ROOT, 'test-results/modern-historical-mention.png'), fullPage: true, animations: 'disabled' });
});

test('Modern card with board guests and no direct involvement keeps only board awareness', { timeout: 60000 }, async t => {
  const x = await modernSetup(t); await x.ready(); await sleep(150);
  assert.match(await shadowText(x.board), /1 guest/i);
  assert.equal(await x.card.count(), 0, 'Collapsed supported composer is not an unsupported-editor warning');
  await x.openComposer(); await sleep(150);
  assert.equal(await x.card.count(), 0, 'Supported open composer is recognized without a direct card signal');
  assert.equal(await x.editor.count(), 1, 'Unrelated description contenteditable does not match the comment editor');
});

test('Modern draft guest mention warns before Save and Cancel preserves every character', { timeout: 60000 }, async t => {
  const x = await modernSetup(t); await x.ready(); await x.openComposer();
  const draft='Review @guest_demo before release.\nKeep this second line.';
  await x.editor.fill(draft);
  await eventually(async () => /mention.*this draft.*Demo Guest/i.test(await modernCardText(x)), 'Draft username resolves to verified board guest');
  await x.save.click(); await x.dialog.getByRole('dialog').waitFor();
  assert.equal(await x.count(), 0); assert.match(await shadowText(x.dialog), /may directly notify/i);
  await x.dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await x.editor.innerText(), draft); assert.equal(await x.count(), 0);
});

test('Modern historical internal, similar, plain-text, code, URL and inconsistent chips are not verified guest mentions', { timeout: 60000 }, async t => {
  const x = await modernSetup(t); await x.ready();
  for (const item of [
    {kind:'resolved',username:'employee'},
    {kind:'resolved',username:'guest_demo2'},
    {kind:'resolved',username:'other_user'},
    {kind:'plain',username:'guest_demo'},
    {kind:'code',username:'guest_demo'},
    {kind:'code-chip',username:'guest_demo'},
    {kind:'url',username:'guest_demo'},
    {kind:'inconsistent',username:'guest_demo'},
  ]) {
    await x.page.evaluate(item => fixture.setHistory([item]), item); await sleep(130);
    const text = await modernCardText(x);
    assert.doesNotMatch(text, /Previously mentioned guests:\s*Demo Guest/i, `Unverified item: ${item.kind}/${item.username}`);
    assert.doesNotMatch(text, /Guest card member|may directly notify/i);
  }
  assert.equal(await x.count(), 0);
});

test('Modern current draft excludes internal mentions, similar usernames, email, URL and code false positives', { timeout: 60000 }, async t => {
  const x = await modernSetup(t); await x.ready(); await x.openComposer();
  await x.editor.fill('@employee @guest_demo2 @other_user a@guest_demo https://example.invalid/@guest_demo `@guest_demo`');
  await sleep(150);
  const text = await modernCardText(x);
  assert.doesNotMatch(text, /Guest mention.*this draft/i);
  assert.equal(await x.count(), 0);
});

test('Modern no-form Save supports Cancel, Ctrl/Command Enter, Post Anyway and double click exactly once', { timeout: 60000 }, async t => {
  const x = await modernSetup(t); await x.ready(); await x.openComposer();
  assert.equal(await x.page.locator('#overlay-contents form').count(), 0);
  await x.editor.fill('@guest_demo keyboard draft'); await x.editor.press('Control+Enter');
  await x.dialog.getByRole('dialog').waitFor(); assert.equal(await x.count(), 0);
  await x.dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await x.editor.innerText(), '@guest_demo keyboard draft');
  await x.editor.press('Meta+Enter'); await x.dialog.getByRole('dialog').waitFor();
  await x.dialog.getByRole('button', { name: 'Post Anyway', exact: true }).dblclick();
  await eventually(async () => await x.count() === 1, 'Modern existing Save handler resumes exactly once');
  assert.equal(await x.editor.innerText(), '');
  await x.editor.fill('@guest_demo second draft'); await x.save.dblclick(); await x.dialog.getByRole('dialog').waitFor();
  assert.equal(await x.dialog.count(), 1); assert.equal(await x.count(), 1);
});

test('Modern previous-mention warning and pending dialog never leak to another card', { timeout: 60000 }, async t => {
  const x = await modernSetup(t, { delay: 100 }); await x.ready();
  await x.page.evaluate(() => fixture.setHistory([{kind:'resolved',username:'guest_demo'}]));
  await eventually(async () => /Previously mentioned guests/i.test(await modernCardText(x)), 'Initial history warning');
  await x.comment('Navigate with this untouched draft'); await x.dialog.getByRole('dialog').waitFor();
  // A top-layer modal intentionally blocks background input; app navigation is
  // driven directly here just as Trello SPA navigation can happen asynchronously.
  await x.page.evaluate(() => fixture.navigate('CaRd5678'));
  await sleep(750); await x.ready();
  assert.equal(await x.card.count(), 0); assert.equal(await x.dialog.count(), 0); assert.equal(await x.count(), 0);
  await x.comment('General warning after card change'); await x.dialog.getByRole('dialog').waitFor();
  assert.doesNotMatch(await shadowText(x.dialog), /Previously mentioned guests|Guest card member/i);
  await x.dialog.getByRole('button', { name: 'Post Anyway', exact: true }).click();
  await eventually(async () => await x.count() === 1, 'Only the new card native submission runs');
});
