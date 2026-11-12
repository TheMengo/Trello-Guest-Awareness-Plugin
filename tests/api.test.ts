import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, TrelloClient, isReference, isStableId, validCredentials } from '../src/api';

const boardId = '111111111111111111111111';
const workspaceId = '222222222222222222222222';
const internalId = '333333333333333333333333';
const guestId = '444444444444444444444444';
const cardId = '555555555555555555555555';
const credentials = { apiKey: 'a'.repeat(32), token: 'b'.repeat(64) };
const member = { id: guestId, username: 'alexguest', fullName: 'Alex Guest' };

function fixture(overrides: Record<string, unknown> = {}) {
  const requests: { url: string; init?: RequestInit }[] = [];
  const data: Record<string, unknown> = {
    [`/1/boards/${boardId}`]: { id: boardId, idOrganization: workspaceId },
    [`/1/boards/BoardOne`]: { id: boardId, idOrganization: workspaceId },
    [`/1/boards/${boardId}/members`]: [{ id: internalId, username: 'employee', fullName: 'Employee' }, member],
    [`/1/organizations/${workspaceId}/members`]: [{ id: internalId }],
    [`/1/cards/CardOne1`]: { id: cardId, idBoard: boardId, idMembers: [guestId] },
    [`/1/cards/${cardId}`]: { id: cardId, idBoard: boardId, idMembers: [guestId] },
    '/1/members/me': { id: internalId },
    ...overrides,
  };
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); requests.push({ url, init });
    const value = data[new URL(url).pathname];
    if (value instanceof Response) return value;
    if (value instanceof Error) throw value;
    return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { requests, fetcher, data };
}

test('API reference and credential validation rejects arbitrary routes and header injection', () => {
  assert.equal(isReference('BoardOne'), true);
  assert.equal(isStableId(boardId), true);
  for (const ref of ['../members/me', 'https://evil.example', 'BoardOne?fields=all', '', null]) assert.equal(isReference(ref), false);
  assert.equal(validCredentials(credentials), true);
  assert.equal(validCredentials({ ...credentials, token: 'x"\r\nAuthorization:' }), false);
  assert.throws(() => new TrelloClient({ apiKey: '', token: '' }), { code: 'NOT_CONFIGURED' });
});

test('loads board members and Workspace members through documented GET routes without cookies or URL secrets', async () => {
  const { fetcher, requests } = fixture();
  const snapshot = await new TrelloClient(credentials, fetcher, () => 1000).snapshot({ boardRef: 'BoardOne' });
  assert.equal(snapshot.board.id, boardId);
  assert.equal(snapshot.board.workspaceId, workspaceId);
  assert.deepEqual(snapshot.board.workspaceMemberIds, [internalId]);
  assert.equal(snapshot.board.members.length, 2);
  assert.equal(snapshot.fetchedAt, 1000);
  assert.equal(snapshot.historyAvailable, false);
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.init?.method, 'GET');
    assert.equal(request.init?.credentials, 'omit');
    assert.equal(request.init?.redirect, 'error');
    assert.equal(request.url.includes(credentials.token), false);
    assert.equal(request.url.includes(credentials.apiKey), false);
    assert.equal((request.init?.headers as Record<string, string>).Authorization, `OAuth oauth_consumer_key="${credentials.apiKey}", oauth_token="${credentials.token}"`);
  }
});

test('card deep links resolve stable card and board IDs; authoritative card board wins over stale board route', async () => {
  const { fetcher, requests } = fixture();
  const snapshot = await new TrelloClient(credentials, fetcher).snapshot({ cardRef: 'CardOne1', boardRef: 'OldBoard' });
  assert.deepEqual(snapshot.card, { id: cardId, boardId, memberIds: [guestId], historicalGuestIds: [] });
  assert.equal(requests.some(r => r.url.includes('OldBoard')), false);
});

test('coalesces simultaneous tabs and caches memberships; force refresh has a 30-second floor', async () => {
  let time = 1000;
  const { fetcher, requests } = fixture();
  const client = new TrelloClient(credentials, fetcher, () => time);
  const [a, b] = await Promise.all([client.snapshot({ boardRef: 'BoardOne' }), client.snapshot({ boardRef: 'BoardOne' })]);
  assert.deepEqual(a, b);
  assert.equal(requests.length, 3);
  time += 20_000;
  await client.snapshot({ boardRef: 'BoardOne', force: true });
  assert.equal(requests.length, 3);
  time += 11_000;
  await client.snapshot({ boardRef: 'BoardOne', force: true });
  assert.equal(requests.length, 6);
  time += 61_000;
  await client.snapshot({ boardRef: 'BoardOne' });
  assert.equal(requests.length, 9);
});

test('membership additions and removals appear after cache expiry', async () => {
  let time = 1000;
  const { fetcher, data } = fixture();
  const client = new TrelloClient(credentials, fetcher, () => time);
  assert.equal((await client.snapshot({ boardRef: 'BoardOne' })).board.members.length, 2);
  data[`/1/boards/${boardId}/members`] = [{ id: internalId, username: 'employee', fullName: 'Employee' }];
  time += 61_000;
  assert.equal((await client.snapshot({ boardRef: 'BoardOne' })).board.members.length, 1);
  data[`/1/boards/${boardId}/members`] = [member];
  time += 61_000;
  assert.deepEqual((await client.snapshot({ boardRef: 'BoardOne' })).board.members, [member]);
});

test('normal requests join an in-flight force refresh instead of reconciling older cached memberships', async () => {
  let time = 1000;
  const { fetcher, data } = fixture();
  let holdMembers = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let notifyStarted!: () => void;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  const controlled = async (input: string | URL | Request, init?: RequestInit) => {
    if (holdMembers && new URL(String(input)).pathname === `/1/boards/${boardId}/members`) { notifyStarted(); await gate; }
    return fetcher(input, init);
  };
  const client = new TrelloClient(credentials, controlled, () => time);
  await client.snapshot({ boardRef: 'BoardOne' });
  time += 31_000;
  data[`/1/boards/${boardId}/members`] = [{ id: internalId, username: 'employee', fullName: 'Employee' }];
  holdMembers = true;
  const refreshed = client.snapshot({ boardRef: 'BoardOne', force: true });
  await started;
  let normalSettled = false;
  const normal = client.snapshot({ boardRef: 'BoardOne' }).then(snapshot => { normalSettled = true; return snapshot; });
  try { await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(normalSettled, false); }
  finally { release(); }
  assert.equal((await refreshed).board.members.length, 1);
  assert.equal((await normal).board.members.length, 1);
});

test('shortLink and canonical board ID navigation share refreshed Workspace metadata', async () => {
  let time = 1000;
  const nextWorkspace = '666666666666666666666666';
  const { fetcher, data } = fixture({ [`/1/organizations/${nextWorkspace}/members`]: [{ id: internalId }, { id: guestId }] });
  const client = new TrelloClient(credentials, fetcher, () => time);
  assert.equal((await client.snapshot({ boardRef: 'BoardOne' })).board.workspaceId, workspaceId);
  time += 31_000;
  data[`/1/boards/${boardId}`] = { id: boardId, idOrganization: nextWorkspace };
  assert.equal((await client.snapshot({ cardRef: 'CardOne1', force: true })).board.workspaceId, nextWorkspace);
  const board = (await client.snapshot({ boardRef: 'BoardOne' })).board;
  assert.equal(board.workspaceId, nextWorkspace);
  assert.deepEqual(board.workspaceMemberIds, [internalId, guestId]);
});

test('a slow unknown shortLink response cannot replace newer canonical board metadata', async () => {
  let time = 1000;
  let release!: () => void;
  let started!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const nextWorkspace = '666666666666666666666666';
  const { fetcher } = fixture({
    [`/1/boards/${boardId}`]: { id: boardId, idOrganization: nextWorkspace },
    [`/1/organizations/${nextWorkspace}/members`]: [{ id: internalId }, { id: guestId }],
  });
  const controlled = async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname === '/1/boards/BoardOne') {
      started(); await gate;
      return new Response(JSON.stringify({ id: boardId, idOrganization: workspaceId }), { status: 200 });
    }
    return fetcher(input, init);
  };
  const client = new TrelloClient(credentials, controlled, () => time);
  const slow = client.snapshot({ boardRef: 'BoardOne' });
  await start;
  time += 1000;
  assert.equal((await client.snapshot({ cardRef: 'CardOne1' })).board.workspaceId, nextWorkspace);
  release();
  assert.equal((await slow).board.workspaceId, nextWorkspace);
  assert.equal((await client.snapshot({ boardRef: 'BoardOne' })).board.workspaceId, nextWorkspace);
});

test('a snapshot waiting on the old Workspace retries after another tab observes a board transfer', async () => {
  let time = 1000;
  let release!: () => void;
  let notifyStarted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  const nextWorkspace = '666666666666666666666666';
  const { fetcher, data } = fixture({ [`/1/organizations/${nextWorkspace}/members`]: [{ id: internalId }, { id: guestId }] });
  const controlled = async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname === `/1/organizations/${workspaceId}/members`) { notifyStarted(); await gate; }
    return fetcher(input, init);
  };
  const client = new TrelloClient(credentials, controlled, () => time);
  const oldSnapshot = client.snapshot({ boardRef: 'BoardOne' });
  await started;
  time += 31_000;
  data[`/1/boards/${boardId}`] = { id: boardId, idOrganization: nextWorkspace };
  const newSnapshot = await client.snapshot({ cardRef: 'CardOne1', force: true });
  assert.equal(newSnapshot.board.workspaceId, nextWorkspace);
  release();
  const completedOldRequest = await oldSnapshot;
  assert.equal(completedOldRequest.board.workspaceId, nextWorkspace);
  assert.deepEqual(completedOldRequest.board.workspaceMemberIds, [internalId, guestId]);
});

test('a card move observed through its canonical ID replaces an older in-flight card relationship', async () => {
  let time = 1000;
  let release!: () => void;
  let notifyStarted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  const nextBoard = '777777777777777777777777';
  const nextWorkspace = '666666666666666666666666';
  const { fetcher, data } = fixture({
    [`/1/boards/${nextBoard}`]: { id: nextBoard, idOrganization: nextWorkspace },
    [`/1/boards/${nextBoard}/members`]: [member],
    [`/1/organizations/${nextWorkspace}/members`]: [{ id: internalId }],
  });
  const controlled = async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname === `/1/organizations/${workspaceId}/members`) { notifyStarted(); await gate; }
    return fetcher(input, init);
  };
  const client = new TrelloClient(credentials, controlled, () => time);
  const oldSnapshot = client.snapshot({ cardRef: 'CardOne1' });
  await started;
  time += 31_000;
  data[`/1/cards/${cardId}`] = { id: cardId, idBoard: nextBoard, idMembers: [guestId] };
  assert.equal((await client.snapshot({ cardRef: cardId, force: true })).card?.boardId, nextBoard);
  release();
  const completed = await oldSnapshot;
  assert.equal(completed.card?.boardId, nextBoard);
  assert.equal(completed.board.id, nextBoard);
});

test('same-board guest assignment refreshed while a snapshot awaits Workspace membership cannot return stale card members', async () => {
  let time = 1000;
  let holdWorkspace = false;
  let release!: () => void;
  let notifyStarted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  const { fetcher, data } = fixture({
    '/1/cards/CardOne1': { id: cardId, idBoard: boardId, idMembers: [] },
    [`/1/cards/${cardId}`]: { id: cardId, idBoard: boardId, idMembers: [] },
  });
  const controlled = async (input: string | URL | Request, init?: RequestInit) => {
    if (holdWorkspace && new URL(String(input)).pathname === `/1/organizations/${workspaceId}/members`) { notifyStarted(); await gate; }
    return fetcher(input, init);
  };
  const client = new TrelloClient(credentials, controlled, () => time);
  await client.snapshot({ boardRef: 'BoardOne' });
  time = 22_000;
  assert.deepEqual((await client.snapshot({ cardRef: 'CardOne1' })).card?.memberIds, []);
  time = 77_000;
  holdWorkspace = true;
  const oldSnapshot = client.snapshot({ cardRef: 'CardOne1' });
  await started;
  time++;
  data[`/1/cards/${cardId}`] = { id: cardId, idBoard: boardId, idMembers: [guestId] };
  const freshSnapshot = client.snapshot({ cardRef: cardId, force: true });
  // Let the card refresh finish; both snapshots remain held on the shared org request.
  await new Promise(resolve => setTimeout(resolve, 5));
  release();
  assert.deepEqual((await freshSnapshot).card?.memberIds, [guestId]);
  assert.deepEqual((await oldSnapshot).card?.memberIds, [guestId]);
});

test('repeated relationship changes exhaust one retry and explicitly fail verification', async () => {
  let time = 1000;
  let releaseA!: () => void;
  let releaseB!: () => void;
  let notifyA!: () => void;
  let notifyB!: () => void;
  const gateA = new Promise<void>(resolve => { releaseA = resolve; });
  const gateB = new Promise<void>(resolve => { releaseB = resolve; });
  const startA = new Promise<void>(resolve => { notifyA = resolve; });
  const startB = new Promise<void>(resolve => { notifyB = resolve; });
  let holdB = false;
  const secondWorkspace = '666666666666666666666666';
  const thirdWorkspace = '777777777777777777777777';
  const { fetcher, data } = fixture({
    [`/1/organizations/${secondWorkspace}/members`]: [{ id: internalId }, { id: guestId }],
    [`/1/organizations/${thirdWorkspace}/members`]: [{ id: internalId }],
  });
  const controlled = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === `/1/organizations/${workspaceId}/members`) { notifyA(); await gateA; }
    if (holdB && path === `/1/organizations/${secondWorkspace}/members`) { notifyB(); await gateB; }
    return fetcher(input, init);
  };
  const client = new TrelloClient(credentials, controlled, () => time);
  const oldResult = client.snapshot({ boardRef: 'BoardOne' }).catch(error => error);
  await startA;
  time += 31_000;
  data[`/1/boards/${boardId}`] = { id: boardId, idOrganization: secondWorkspace };
  await client.snapshot({ boardRef: boardId, force: true });
  time = 100_000;
  holdB = true;
  releaseA();
  await startB;
  time += 31_000;
  data[`/1/boards/${boardId}`] = { id: boardId, idOrganization: thirdWorkspace };
  await client.snapshot({ boardRef: boardId, force: true });
  releaseB();
  const error = await oldResult;
  assert.ok(error instanceof ApiError);
  assert.equal(error.code, 'INVALID_DATA');
  assert.match(error.message, /Unable to verify guest status/);
});

test('missing Workspace and invalid members explicitly fail instead of returning zero guests', async () => {
  const badData = [null, {}, [{ id: guestId }], [{ id: guestId, username: 'alex', fullName: 'Alex' }, { id: guestId, username: 'alex', fullName: 'Alex' }]];
  for (const value of badData) {
    const { fetcher } = fixture({ [`/1/boards/${boardId}/members`]: value });
    await assert.rejects(new TrelloClient(credentials, fetcher).snapshot({ boardRef: 'BoardOne' }), { code: 'INVALID_DATA' });
  }
  const { fetcher } = fixture({ '/1/boards/BoardOne': { id: boardId, idOrganization: null } });
  await assert.rejects(new TrelloClient(credentials, fetcher).snapshot({ boardRef: 'BoardOne' }), { code: 'NO_WORKSPACE' });
});

test('an empty or malformed Workspace member list cannot classify everyone as a guest', async () => {
  for (const value of [[], {}, [{ id: 'not-an-id' }], [{ username: 'alex' }]]) {
    const { fetcher } = fixture({ [`/1/organizations/${workspaceId}/members`]: value });
    await assert.rejects(new TrelloClient(credentials, fetcher).snapshot({ boardRef: 'BoardOne' }), { code: 'INVALID_DATA' });
  }
});

test('unauthorized, forbidden, missing, and upstream errors are sanitized and distinguished', async () => {
  for (const [status, code] of [[401, 'AUTH'], [403, 'PERMISSION'], [404, 'NOT_FOUND'], [500, 'HTTP_ERROR']] as const) {
    const { fetcher } = fixture({ '/1/boards/BoardOne': new Response('Sensitive server details!', { status }) });
    await assert.rejects(new TrelloClient(credentials, fetcher).snapshot({ boardRef: 'BoardOne' }), error => {
      assert.ok(error instanceof ApiError); assert.equal(error.code, code);
      assert.equal(error.message.includes('Sensitive'), false); return true;
    });
  }
});

test('429 blocks subsequent network requests until Retry-After', async () => {
  let time = 1000;
  const { fetcher, requests, data } = fixture({ '/1/boards/BoardOne': new Response('', { status: 429, headers: { 'Retry-After': '120' } }) });
  const client = new TrelloClient(credentials, fetcher, () => time);
  await assert.rejects(client.snapshot({ boardRef: 'BoardOne' }), { code: 'RATE_LIMIT' });
  time += 61_000;
  await assert.rejects(client.snapshot({ boardRef: 'BoardOne' }), { code: 'RATE_LIMIT' });
  assert.equal(requests.length, 1);
  data['/1/boards/BoardOne'] = { id: boardId, idOrganization: workspaceId };
  time += 60_000;
  assert.equal((await client.snapshot({ boardRef: 'BoardOne' })).board.id, boardId);
});

test('failed requests are not mistaken for valid cache and can recover', async () => {
  const { fetcher, data } = fixture({ '/1/boards/BoardOne': new Error(`network secret ${credentials.token}`) });
  const client = new TrelloClient(credentials, fetcher);
  await assert.rejects(client.snapshot({ boardRef: 'BoardOne' }), error => {
    assert.ok(error instanceof ApiError); assert.equal(error.message.includes(credentials.token), false); return true;
  });
  data['/1/boards/BoardOne'] = { id: boardId, idOrganization: workspaceId };
  assert.equal((await client.snapshot({ boardRef: 'BoardOne' })).board.id, boardId);
});

test('timeouts abort requests and return a recoverable verification error', async () => {
  const fetcher = (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });
  await assert.rejects(new TrelloClient(credentials, fetcher, Date.now, 5).snapshot({ boardRef: 'BoardOne' }), { code: 'TIMEOUT' });
});

test('invalid snapshot references never issue API requests; setup can verify authorization', async () => {
  const { fetcher, requests } = fixture();
  const client = new TrelloClient(credentials, fetcher);
  await assert.rejects(client.snapshot({ boardRef: '../members/me' }), { code: 'INVALID_REQUEST' });
  await assert.rejects(client.snapshot({}), { code: 'INVALID_REQUEST' });
  assert.equal(requests.length, 0);
  await client.checkAuth();
  assert.equal(new URL(requests[0]!.url).pathname, '/1/members/me');
});

test('default transport invokes browser fetch with its global receiver', async () => {
  const native = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = function (this: unknown) {
    assert.equal(this, globalThis, 'Native WorkerGlobalScope.fetch rejects an arbitrary client receiver');
    calls++;
    return Promise.resolve(new Response(JSON.stringify({ id: internalId }), { status: 200 }));
  };
  try { await new TrelloClient(credentials).checkAuth(); assert.equal(calls, 1); }
  finally { globalThis.fetch = native; }
});

test('every explicit authorization check makes a fresh request, even within the membership cache floor', async () => {
  const { fetcher, requests, data } = fixture();
  const client = new TrelloClient(credentials, fetcher, () => 1000);
  await client.checkAuth();
  await client.checkAuth();
  assert.equal(requests.length, 2);
  data['/1/members/me'] = new Response('expired token details', { status: 401 });
  await assert.rejects(client.checkAuth(), { code: 'AUTH' });
  assert.equal(requests.length, 3);
});

test('request invocation errors remain internal and do not falsely blame connectivity', async () => {
  const fetcher = (): Promise<Response> => { throw new TypeError('Illegal invocation ' + credentials.token); };
  await assert.rejects(new TrelloClient(credentials, fetcher).checkAuth(), error => {
    assert.ok(error instanceof ApiError); assert.equal(error.code, 'INTERNAL');
    assert.match(error.message, /could not start|Reload/);
    assert.equal(error.message.includes('network'), false);
    assert.equal(error.message.includes(credentials.token), false);
    return true;
  });
});

test('rejected transport, internal processing, HTTP rejection and invalid JSON are distinct sanitized failures', async () => {
  const cases: [() => Promise<Response>, string][] = [
    [async () => { throw new TypeError('Failed to fetch ' + credentials.token); }, 'NETWORK'],
    [async () => { throw new Error('Unexpected internal ' + credentials.apiKey); }, 'INTERNAL'],
    [async () => new Response(credentials.token, { status: 400 }), 'BAD_REQUEST'],
    [async () => new Response(credentials.token, { status: 502 }), 'HTTP_ERROR'],
    [async () => new Response('invalid JSON ' + credentials.token, { status: 200 }), 'INVALID_DATA'],
  ];
  for (const [fetcher, code] of cases) {
    await assert.rejects(new TrelloClient(credentials, fetcher).checkAuth(), error => {
      assert.ok(error instanceof ApiError); assert.equal(error.code, code);
      assert.equal(error.message.includes(credentials.token), false);
      assert.equal(error.message.includes(credentials.apiKey), false);
      assert.equal(error.message.includes('https://'), false);
      return true;
    });
  }
});

test('explicit authorization checks respect rate-limit backoff instead of retrying on every Save', async () => {
  const { fetcher, requests } = fixture({ '/1/members/me': new Response('', { status: 429 }) });
  const client = new TrelloClient(credentials, fetcher, () => 1000);
  await assert.rejects(client.checkAuth(), { code: 'RATE_LIMIT' });
  await assert.rejects(client.checkAuth(), { code: 'RATE_LIMIT' });
  assert.equal(requests.length, 1);
});
