import { test } from 'node:test';
import assert from 'node:assert/strict';

test('service worker RPC keeps credentials private and restricts senders and mutations', async t => {
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
  const extensionUrl = `chrome-extension://${extensionId}/`;
  const stored: Record<string, any> = { credentials: { apiKey: 'a'.repeat(32), token: 'b'.repeat(64) }, enabled: true };
  const storageListeners: ((changes: Record<string, any>, area: string) => void)[] = [];
  const broadcasts: any[] = [];
  const accessLevels: string[] = [];
  let optionsOpened = 0;
  let messageListener: any;
  let networkCalls = 0;
  const local = {
    async setAccessLevel({ accessLevel }: { accessLevel: string }) { accessLevels.push(accessLevel); },
    async get(keys: string | string[] | null) {
      if (keys === null) return { ...stored };
      return Object.fromEntries((typeof keys === 'string' ? [keys] : keys).filter(k => k in stored).map(k => [k, stored[k]]));
    },
    async set(values: Record<string, unknown>) {
      const changes: Record<string, unknown> = {};
      for (const [key, newValue] of Object.entries(values)) { changes[key] = { oldValue: stored[key], newValue }; stored[key] = newValue; }
      for (const listener of storageListeners) listener(changes, 'local');
    },
    async remove(keys: string | string[]) {
      const changes: Record<string, unknown> = {};
      for (const key of typeof keys === 'string' ? [keys] : keys) { changes[key] = { oldValue: stored[key] }; delete stored[key]; }
      for (const listener of storageListeners) listener(changes, 'local');
    },
  };
  (globalThis as any).chrome = {
    runtime: { id: extensionId, getURL: (path: string) => extensionUrl + path,
      onMessage: { addListener: (fn: any) => { messageListener = fn; } },
      openOptionsPage: async () => { optionsOpened++; } },
    storage: { local, onChanged: { addListener: (fn: any) => storageListeners.push(fn) } },
    action: { onClicked: { addListener() {} } },
    tabs: { sendMessage: async (tabId: number, message: any) => { broadcasts.push({ tabId, message }); } },
  };
  globalThis.fetch = async () => { networkCalls++; return new Response(JSON.stringify({ id: '1'.repeat(24) }), { status: 200 }); };
  await import('../src/background');
  const trello = { id: extensionId, url: 'https://trello.com/c/CardOne1/1-test', tab: { id: 4 } };
  const options = { id: extensionId, url: extensionUrl + 'options.html' };
  const request = (message: unknown, sender: unknown = trello): Promise<any> => new Promise(resolve => {
    const handled = messageListener(message, sender, resolve);
    if (!handled) resolve(undefined);
  });

  await t.test('locks local storage to trusted extension contexts', () => {
    assert.deepEqual(accessLevels, ['TRUSTED_CONTEXTS']);
  });
  await t.test('rejects cross-extension, external-site, malformed, and null messages', async () => {
    assert.equal(await request({ type: 'snapshot', boardRef: 'BoardOne' }, { ...trello, id: 'anotherextension' }), undefined);
    assert.equal(await request({ type: 'snapshot', boardRef: 'BoardOne' }, { ...trello, url: 'https://trello.com.evil.test/b/BoardOne' }), undefined);
    assert.equal(await request(null), undefined);
    assert.equal(await request([]), undefined);
    assert.equal(networkCalls, 0);
  });
  await t.test('returns only enabled status and dismissal fingerprints to content scripts', async () => {
    const reply = await request({ type: 'get-preferences' });
    assert.deepEqual(reply, { ok: true, enabled: true, dismissals: {} });
    assert.equal(JSON.stringify(reply).includes(stored.credentials.token), false);
  });
  await t.test('does not let content scripts invoke setup authorization verification', async () => {
    assert.equal((await request({ type: 'check-auth' })).code, 'INVALID_REQUEST');
    assert.equal(networkCalls, 0);
    assert.deepEqual(await request({ type: 'check-auth' }, options), { ok: true });
    assert.equal(networkCalls, 1);
  });
  await t.test('validates IDs and fingerprints before writing preference state', async () => {
    const invalid = await request({ type: 'dismiss', scope: 'board', scopeId: '../bad', boardId: '1'.repeat(24), fingerprint: 'value' });
    assert.equal(invalid.code, 'INVALID_REQUEST');
    const oversized = await request({ type: 'dismiss', scope: 'board', scopeId: '1'.repeat(24), boardId: '1'.repeat(24), fingerprint: 'x'.repeat(20_000) });
    assert.equal(oversized.code, 'INVALID_REQUEST');
    const reply = await request({ type: 'dismiss', scope: 'board', scopeId: '1'.repeat(24), boardId: '1'.repeat(24), fingerprint: 'membership-v1' });
    assert.deepEqual(reply, { ok: true });
    assert.equal((await request({ type: 'get-preferences' })).dismissals['dismissal:board:' + '1'.repeat(24)], 'membership-v1');
  });
  await t.test('broadcasts preference changes without exposing credentials', async () => {
    await local.set({ credentials: { apiKey: 'c'.repeat(32), token: 'd'.repeat(64) } });
    const last = broadcasts.at(-1);
    assert.deepEqual(last, { tabId: 4, message: { type: 'preferences-changed', credentialsChanged: true } });
    assert.equal(JSON.stringify(broadcasts).includes('d'.repeat(64)), false);
    const before = broadcasts.length;
    await local.set({ 'membership:board:123': 'hash' });
    assert.equal(broadcasts.length, before);
  });
  await t.test('handles missing credentials and opens the settings UI without network access', async () => {
    await local.remove('credentials');
    const reply = await request({ type: 'snapshot', boardRef: 'BoardOne' });
    assert.equal(reply.code, 'NOT_CONFIGURED');
    assert.equal(networkCalls, 1);
    assert.deepEqual(await request({ type: 'open-settings' }), { ok: true });
    assert.equal(optionsOpened, 1);
  });
  await t.test('credentials removed during membership reconciliation invalidate the pending snapshot', async () => {
    await local.set({ credentials: { apiKey: 'a'.repeat(32), token: 'b'.repeat(64) } });
    globalThis.fetch = async input => {
      const path = new URL(String(input)).pathname;
      const data = path.endsWith('/members') ? [{ id: '2'.repeat(24), username: 'employee', fullName: 'Employee' }]
        : { id: '1'.repeat(24), idOrganization: '3'.repeat(24) };
      return new Response(JSON.stringify(data), { status: 200 });
    };
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const oldDigest = crypto.subtle.digest;
    let changed = false;
    crypto.subtle.digest = async (algorithm, data) => {
      if (!changed) { changed = true; await local.remove('credentials'); }
      return digest(algorithm, data);
    };
    try {
      const reply = await request({ type: 'snapshot', boardRef: 'BoardOne' });
      assert.equal(reply.ok, false);
      assert.equal(reply.code, 'NOT_CONFIGURED');
    } finally { crypto.subtle.digest = oldDigest; }
  });
  await t.test('Save verification always makes fresh authenticated reads using current storage even before its change event', async () => {
    const original = { apiKey: 'a'.repeat(32), token: 'b'.repeat(64) };
    const replacement = { apiKey: 'c'.repeat(32), token: 'd'.repeat(64) };
    await local.set({ credentials: original });
    const observed: string[] = [];
    globalThis.fetch = async (_input, init) => {
      observed.push(new Headers(init?.headers).get('Authorization') ?? '');
      return new Response(JSON.stringify({ id: '1'.repeat(24) }), { status: 200 });
    };
    assert.deepEqual(await request({ type: 'check-auth' }, options), { ok: true });
    assert.deepEqual(await request({ type: 'check-auth' }, options), { ok: true });
    stored.credentials = replacement; // Deliberately do not dispatch storage.onChanged yet.
    assert.deepEqual(await request({ type: 'check-auth' }, options), { ok: true });
    assert.equal(observed.length, 3);
    assert.equal(observed[0], `OAuth oauth_consumer_key="${original.apiKey}", oauth_token="${original.token}"`);
    assert.equal(observed[2], `OAuth oauth_consumer_key="${replacement.apiKey}", oauth_token="${replacement.token}"`);
  });
  await t.test('removing saved credentials during an auth request cannot report a stale verified success', async () => {
    await local.set({ credentials: { apiKey: 'a'.repeat(32), token: 'b'.repeat(64) } });
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    globalThis.fetch = async () => {
      started(); await gate;
      return new Response(JSON.stringify({ id: '1'.repeat(24) }), { status: 200 });
    };
    const verification = request({ type: 'check-auth' }, options);
    await entered;
    delete stored.credentials; // Also covers removal before the storage event is delivered.
    release();
    const reply = await verification;
    assert.equal(reply.ok, false);
    assert.equal(reply.code, 'NOT_CONFIGURED');
    assert.match(reply.error, /changed during verification/);
  });
  await t.test('a credential change event invalidates a pending auth response', async () => {
    await local.set({ credentials: { apiKey: 'a'.repeat(32), token: 'b'.repeat(64) } });
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    globalThis.fetch = async () => {
      started(); await gate;
      return new Response(JSON.stringify({ id: '1'.repeat(24) }), { status: 200 });
    };
    const verification = request({ type: 'check-auth' }, options);
    await entered;
    await local.set({ credentials: { apiKey: 'c'.repeat(32), token: 'd'.repeat(64) } });
    release();
    assert.equal((await verification).code, 'NOT_CONFIGURED');
  });
  await t.test('an internal storage failure is actionable and never reported as an unreachable Trello server', async () => {
    const get = local.get;
    local.get = async () => { throw new Error('Sensitive internal failure'); };
    try {
      const reply = await request({ type: 'check-auth' }, options);
      assert.equal(reply.code, 'INTERNAL');
      assert.match(reply.error, /Reload the extension/);
      assert.equal(reply.error.includes('Sensitive'), false);
      assert.equal(reply.error.includes('network'), false);
      assert.equal(reply.error.includes('reached'), false);
    } finally { local.get = get; }
  });

  await t.test('rewriting identical saved credentials neither invalidates verification nor broadcasts a credential change', async () => {
    const credentials = { apiKey: 'a'.repeat(32), token: 'b'.repeat(64) };
    await local.set({ credentials });
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    globalThis.fetch = async () => {
      started(); await gate;
      return new Response(JSON.stringify({ id: '1'.repeat(24) }), { status: 200 });
    };
    const verification = request({ type: 'check-auth' }, options);
    await entered;
    const before = broadcasts.length;
    await local.set({ credentials: { ...credentials } });
    assert.equal(broadcasts.length, before);
    release();
    assert.deepEqual(await verification, { ok: true });
  });

});
