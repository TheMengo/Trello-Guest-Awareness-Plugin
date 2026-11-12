import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/classify';
import { clearDismissals, credentialsForInput, getCredentials, removeCredentials, saveCredentials, dismissalKey, dismissWarning, getSettings, isDismissed, listDismissals, reconcileMembership, restoreDismissal, setEnabled } from '../src/preferences';
import type { Snapshot } from '../src/types';
import { getAuthorizationExpiration, setAuthorizationExpiration } from '../src/preferences';
import { AUTHORIZATION_EXPIRATIONS } from '../src/authorization';

let data: Record<string, any> = {};
beforeEach(() => {
  data = {};
  (globalThis as any).chrome = { storage: { local: {
    async get(keys: string | string[] | null) {
      if (keys === null) return structuredClone(data);
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in data).map(key => [key, structuredClone(data[key])]));
    },
    async set(values: Record<string, any>) { Object.assign(data, structuredClone(values)); },
    async remove(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }
  } } };
});

const boardId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const cardId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const alexId = '111111111111111111111111';
const samId = '222222222222222222222222';
function snapshot(guestIds = [alexId], cardIds: string[] = []): Snapshot {
  return { board: { id: boardId, workspaceId: 'cccccccccccccccccccccccc', members: guestIds.map(id => ({ id, username: `user${id}`, fullName: 'Guest' })), workspaceMemberIds: [] }, card: { id: cardId, boardId, memberIds: cardIds }, fetchedAt: 1 };
}

test('enabled defaults true and persists independently', async () => {
  assert.deepEqual(await getSettings(), { enabled: true });
  await setEnabled(false);
  assert.deepEqual(await getSettings(), { enabled: false });
});

test('authorization expiration defaults to never and recovers from invalid storage', async () => {
  assert.equal(await getAuthorizationExpiration(), 'never');
  for (const invalid of [null, '', 'invalid', 'NEVER', 1, ['1hour'], { value: '1day' }]) {
    data.authorizationExpiration = invalid;
    assert.equal(await getAuthorizationExpiration(), 'never');
  }
});

test('all expiration preferences persist independently of credentials and warning settings', async () => {
  const credentials = { apiKey: 'a'.repeat(32), token: 'b'.repeat(64) };
  await saveCredentials(credentials);
  await setEnabled(false);
  const warning = classify(snapshot());
  await dismissWarning(warning);
  for (const value of AUTHORIZATION_EXPIRATIONS) {
    await setAuthorizationExpiration(value);
    assert.equal(data.authorizationExpiration, value);
    assert.equal(await getAuthorizationExpiration(), value);
    assert.deepEqual(await credentialsForInput(credentials.apiKey, ''), credentials);
    assert.deepEqual(await getSettings(), { enabled: false });
    assert.equal(await isDismissed(warning), true);
  }
  await clearDismissals();
  await removeCredentials();
  assert.equal(await getAuthorizationExpiration(), 'never');
});

test('do not show again persists through repeated reads', async () => {
  const warning = classify(snapshot());
  assert.equal(await isDismissed(warning), false);
  await dismissWarning(warning);
  assert.equal(await isDismissed(warning), true);
  assert.equal(await isDismissed(structuredClone(warning)), true);
  assert.equal((await listDismissals()).length, 1);
});

test('board and card dismissals are independent', async () => {
  const board = classify(snapshot());
  const card = classify(snapshot([alexId], [alexId]));
  await dismissWarning(board);
  assert.equal(await isDismissed(board), true);
  assert.equal(await isDismissed(card), false);
  await dismissWarning(card);
  await restoreDismissal(dismissalKey('board', boardId));
  assert.equal(await isDismissed(board), false);
  assert.equal(await isDismissed(card), true);
});

test('restoring all dismissals preserves credentials and enabled preference', async () => {
  data.credentials = { apiKey: 'saved', token: 'saved' };
  data.enabled = false;
  await dismissWarning(classify(snapshot()));
  await dismissWarning(classify(snapshot([alexId], [alexId])));
  await clearDismissals();
  assert.deepEqual(await listDismissals(), []);
  assert.equal(data.credentials.apiKey, 'saved');
  assert.equal(data.enabled, false);
});

test('guest addition invalidates the previous fingerprint', async () => {
  await dismissWarning(classify(snapshot()));
  assert.equal(await isDismissed(classify(snapshot([alexId, samId]))), false);
});

test('concurrent tabs write independent dismissal keys without losing either', async () => {
  const one = classify(snapshot());
  const two = classify(snapshot([alexId], [alexId]));
  await Promise.all([dismissWarning(one), dismissWarning(two)]);
  assert.equal((await listDismissals()).length, 2);
});

test('observed removal to zero guests then re-addition does not resurrect dismissal', async () => {
  const original = snapshot();
  await reconcileMembership(original);
  await dismissWarning(classify(original));
  await reconcileMembership(snapshot([]));
  await reconcileMembership(original);
  assert.equal(await isDismissed(classify(original)), false);
});

test('board guest changes invalidate associated board and card dismissals', async () => {
  const original = snapshot([alexId], [alexId]);
  await reconcileMembership(original);
  await dismissWarning(classify(snapshot()));
  await dismissWarning(classify(original));
  await reconcileMembership(snapshot([alexId, samId], [alexId]));
  assert.deepEqual(await listDismissals(), []);
});

test('card guest addition invalidates only that card dismissal', async () => {
  const original = snapshot([alexId, samId], [alexId]);
  const board = classify(snapshot([alexId, samId]));
  await reconcileMembership(original);
  await dismissWarning(board);
  await dismissWarning(classify(original));
  await reconcileMembership(snapshot([alexId, samId], [alexId, samId]));
  assert.equal(await isDismissed(board), true);
  assert.equal(await isDismissed(classify(original)), false);
});

test('unchanged observed membership leaves explicit dismissals intact', async () => {
  const original = snapshot([alexId], [alexId]);
  await reconcileMembership(original);
  await dismissWarning(classify(original));
  await reconcileMembership(structuredClone(original));
  assert.equal(await isDismissed(classify(original)), true);
  assert.match(data[`membership:board:${boardId}`], /^[a-f0-9]{64}$/);
  assert.doesNotMatch(data[`membership:board:${boardId}`], new RegExp(alexId));
});

test('invalid IDs and malformed storage cannot be used as warning keys', async () => {
  assert.throws(() => dismissalKey('board', 'Board Title'), /Invalid warning identity/);
  await assert.rejects(() => restoreDismissal('credentials'), /Invalid warning identity/);
  data['dismissal:board:garbage'] = { scope: 'board', scopeId: 'garbage', fingerprint: 'x', dismissedAt: 1 };
  assert.deepEqual(await listDismissals(), []);
});


test('credential persistence validates and projects only the essential pair', async () => {
  const original = { apiKey: 'a'.repeat(32), token: 'b'.repeat(64), unrelated: 'discard' };
  await saveCredentials(original);
  original.token = 'changed';
  assert.deepEqual(await getCredentials(), { apiKey: 'a'.repeat(32), token: 'b'.repeat(64) });
  assert.deepEqual(Object.keys(data.credentials).sort(), ['apiKey', 'token']);
  await assert.rejects(() => saveCredentials({ apiKey: 'invalid', token: 'invalid' }), /Invalid Trello authorization/);
  assert.equal((await getCredentials())?.token, 'b'.repeat(64));
});

test('blank token input reuses only the latest saved token for the matching API key', async () => {
  const apiKey = 'a'.repeat(32);
  await saveCredentials({ apiKey, token: 'b'.repeat(64) });
  assert.deepEqual(await credentialsForInput(apiKey, ''), { apiKey, token: 'b'.repeat(64) });
  await saveCredentials({ apiKey, token: 'd'.repeat(64) });
  assert.deepEqual(await credentialsForInput(apiKey, '  '), { apiKey, token: 'd'.repeat(64) });
  assert.equal(await credentialsForInput('c'.repeat(32), ''), undefined);
});

test('removing credentials prevents blank-token reuse without changing other settings', async () => {
  const apiKey = 'a'.repeat(32);
  await saveCredentials({ apiKey, token: 'b'.repeat(64) });
  await setEnabled(false);
  await removeCredentials();
  assert.equal(await getCredentials(), undefined);
  assert.equal(await credentialsForInput(apiKey, ''), undefined);
  assert.deepEqual(await getSettings(), { enabled: false });
});

test('explicit credentials input is trimmed and invalid persisted authorization is never reused', async () => {
  const apiKey = 'a'.repeat(32);
  data.credentials = { apiKey, token: 'bad' };
  assert.equal(await getCredentials(), undefined);
  assert.equal(await credentialsForInput(apiKey, ''), undefined);
  assert.deepEqual(await credentialsForInput(' '+apiKey+' ', ' '+'b'.repeat(64)+' '), { apiKey, token: 'b'.repeat(64) });
});
