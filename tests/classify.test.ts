import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, extractMentions, resolveRenderedMention } from '../src/classify';
import type { Member, Snapshot } from '../src/types';

const internal: Member = { id: '111111111111111111111111', username: 'inside', fullName: 'Inside Member' };
const alex: Member = { id: '222222222222222222222222', username: 'alex', fullName: 'Alex Guest' };
const sam: Member = { id: '333333333333333333333333', username: 'sam_guest', fullName: 'Sam Guest' };
const boardId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const cardId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
function snapshot(members = [internal, alex], cardMembers: string[] = []): Snapshot {
  return { board: { id: boardId, workspaceId: 'cccccccccccccccccccccccc', members, workspaceMemberIds: [internal.id] }, card: { id: cardId, boardId, memberIds: cardMembers }, fetchedAt: 1 };
}

test('no guests produces no warnings', () => {
  const result = classify(snapshot([internal], [internal.id]), '@inside');
  assert.deepEqual(result.guests, []);
  assert.deepEqual(result.messages, []);
  assert.equal(result.specific, false);
});

test('one guest unassigned to card produces board awareness only', () => {
  const result = classify(snapshot());
  assert.deepEqual(result.guests, [alex]);
  assert.equal(result.scope, 'board');
  assert.equal(result.scopeId, boardId);
  assert.match(result.messages[0], /1 guest outside its Workspace membership/);
  assert.doesNotMatch(result.messages[0], /company|notify|notification/i);
});

test('multiple guests are a set difference from Workspace members', () => {
  const result = classify(snapshot([sam, alex, internal]));
  assert.deepEqual(result.guests, [alex, sam]);
  assert.match(result.messages[0], /2 guests/);
});

test('guest card member has a notification-specific warning', () => {
  const result = classify(snapshot([internal, alex], [alex.id]));
  assert.equal(result.scope, 'card');
  assert.equal(result.scopeId, cardId);
  assert.deepEqual(result.cardGuests, [alex]);
  assert.match(result.messages.join(' '), /depending on their notification preferences/);
});

test('internal member on card does not produce a guest card warning', () => {
  const result = classify(snapshot([internal, alex], [internal.id]));
  assert.deepEqual(result.cardGuests, []);
  assert.equal(result.specific, false);
});

test('exact identifiable guest mentions in draft may directly notify guests', () => {
  const result = classify(snapshot([internal, alex, sam]), 'Please review, @Alex and @sam_guest.');
  assert.deepEqual(result.draftGuests, [alex, sam]);
  assert.match(result.messages.join(' '), /may directly notify these guests/);
  assert.equal(result.specific, true);
});

test('mention parser ignores prefix matches, emails, URLs, and code', () => {
  const result = extractMentions('hello@alex @alexander @alex-extra https://trello.com/@alex `@alex` ```\n@sam_guest\n``` @unknown', [alex, sam]);
  assert.deepEqual(result.memberIds, []);
});

test('mention parser ignores non-ASCII email-like prefixes and unterminated code', () => {
  assert.deepEqual(extractMentions('é@alex\n```@alex', [alex]).memberIds, []);
  assert.deepEqual(extractMentions('`@alex', [alex]).memberIds, []);
});

test('only verified guest IDs contribute to previous-comment involvement', () => {
  const result = classify(snapshot([internal, alex]), '', [alex.id, internal.id, 'eeeeeeeeeeeeeeeeeeeeeeee']);
  assert.deepEqual(result.previousGuests, [alex]);
  assert.match(result.messages.join(' '), /does not by itself mean they will receive notifications about future comments/);
  assert.equal(result.specific, true);
});

test('card historicalGuestIds are classified without reading comment text', () => {
  const data = snapshot();
  data.card!.historicalGuestIds = [alex.id];
  assert.deepEqual(classify(data).previousGuests, [alex]);
});

test('@card uses actual card membership while @board includes all board guests', () => {
  const result = classify(snapshot([internal, alex, sam], [alex.id]), '@card @board');
  assert.deepEqual(result.specials, ['board', 'card']);
  assert.match(result.messages.join(' '), /@card may notify.*1 guest: Alex Guest/);
  assert.match(result.messages.join(' '), /@board may notify.*all 2 board guests: Alex Guest, Sam Guest/);
});

test('@card without guest members explains access separately from notifications', () => {
  const result = classify(snapshot([internal, alex], [internal.id]), '@card');
  assert.match(result.messages.join(' '), /None of the current card members are board guests; other board guests still have access/);
  assert.equal(result.specific, true);
});

test('fingerprints are stable across member ordering and duplicate IDs', () => {
  const first = snapshot([internal, sam, alex], [sam.id, alex.id]);
  const second = snapshot([alex, internal, sam], [alex.id, sam.id, alex.id]);
  assert.equal(classify(first, '@sam_guest @alex').fingerprint, classify(second, '@alex @sam_guest').fingerprint);
});

test('adding or removing a board guest changes board dismissal fingerprint', () => {
  assert.notEqual(classify(snapshot()).fingerprint, classify(snapshot([internal, alex, sam])).fingerprint);
  assert.notEqual(classify(snapshot()).fingerprint, classify(snapshot([internal])).fingerprint);
});

test('adding a guest to an existing card changes scope and card fingerprint', () => {
  const before = classify(snapshot([internal, alex, sam], [alex.id]));
  const after = classify(snapshot([internal, alex, sam], [alex.id, sam.id]));
  assert.notEqual(before.fingerprint, after.fingerprint);
  assert.equal(after.scope, 'card');
});

test('ordinary draft text is neither persisted nor fingerprinted', () => {
  const first = classify(snapshot(), 'Company secret: Alpha');
  const second = classify(snapshot(), 'Different body entirely');
  assert.equal(first.fingerprint, second.fingerprint);
  assert.doesNotMatch(first.fingerprint, /Company|secret|Alpha/);
});

test('a Workspace membership change reclassifies a guest without a board change', () => {
  const data = snapshot();
  data.board.workspaceMemberIds.push(alex.id);
  assert.deepEqual(classify(data).guests, []);
});


test('live structured username mention resolves to the verified stable member identity', () => {
  const guest = { id: alex.id, username: 'guest_demo', fullName: 'Demo Guest' };
  const live = { identifier: 'guest_demo', label: '@guest_demo', testId: 'mention-guest_demo', mentionType: '2' };
  assert.equal(resolveRenderedMention(live, [internal, guest]), guest.id);
  assert.equal(resolveRenderedMention({ ...live, identifier: 'GUEST_DEMO', label: '@Guest_Demo', testId: 'mention-GUEST_DEMO' }, [guest]), guest.id);
  const result = classify(snapshot([internal, guest]), '', [resolveRenderedMention(live, [guest])!]);
  assert.deepEqual(result.previousGuests, [guest]);
  assert.equal(result.cardGuests.length, 0);
  assert.match(result.messages.join(' '), /Demo Guest \(@guest_demo\)/);
  assert.match(result.messages.join(' '), /does not by itself mean.*future comments/);
});

test('structured stable-ID mentions require matching marker, username label, and optional member ID', () => {
  const mention = { identifier: alex.id, label: '@alex', testId: 'mention-'+alex.id, mentionType: '2', memberId: alex.id };
  assert.equal(resolveRenderedMention(mention, [alex]), alex.id);
  assert.equal(resolveRenderedMention({ ...mention, label: '@Alex Guest' }, [alex]), undefined);
  assert.equal(resolveRenderedMention({ ...mention, memberId: sam.id }, [alex, sam]), undefined);
});

test('plain labels, unknown people, similar usernames, and inconsistent chips are not verified mentions', () => {
  const mention = { identifier: 'alex', label: '@alex', testId: 'mention-alex', mentionType: '2' };
  for (const input of [
    { ...mention, testId: '' },
    { ...mention, identifier: 'alexander', testId: 'mention-alexander', label: '@alexander' },
    { ...mention, label: '@alexander' },
    { ...mention, identifier: 'unknown', testId: 'mention-unknown', label: '@unknown' },
    { ...mention, testId: 'mention-sam_guest' },
    { ...mention, mentionType: '1' },
    { ...mention, identifier: '/alex' },
  ]) assert.equal(resolveRenderedMention(input, [alex, sam]), undefined);
});

test('ambiguous usernames cannot resolve a rendered or typed mention to an arbitrary member', () => {
  const members = [alex, { ...sam, username: 'Alex' }];
  assert.equal(resolveRenderedMention({ identifier: 'alex', label: '@alex', testId: 'mention-alex' }, members), undefined);
  assert.deepEqual(extractMentions('@alex', members).memberIds, []);
});

test('resolved internal employee mention does not become guest involvement', () => {
  const id = resolveRenderedMention({ identifier: 'inside', label: '@inside', testId: 'mention-inside', mentionType: '2' }, [internal, alex]);
  assert.equal(id, internal.id);
  const result = classify(snapshot(), '', [id!], [id!]);
  assert.deepEqual(result.previousGuests, []);
  assert.deepEqual(result.draftGuests, []);
  assert.equal(result.specific, false);
});

test('verified current draft chips use member IDs without fabricating or retaining comment text', () => {
  const previous = classify(snapshot(), '', [alex.id]);
  const draft = classify(snapshot(), '', [], [alex.id, internal.id, 'unknown']);
  assert.deepEqual(draft.draftGuests, [alex]);
  assert.deepEqual(draft.previousGuests, []);
  assert.match(draft.messages.join(' '), /may directly notify this guest/);
  assert.notEqual(draft.fingerprint, previous.fingerprint);
  assert.equal(draft.fingerprint, classify(snapshot(), '@alex').fingerprint);
  const assigned = classify(snapshot([internal, alex], [alex.id]), '', [alex.id], [alex.id]);
  assert.deepEqual(assigned.cardGuests, [alex]);
  assert.match(assigned.messages.join(' '), /depending on their notification preferences/);
});

test('mention parser excludes escaped mentions, tilde and multi-backtick code, link labels and bare or relative URLs', () => {
  const rejected = [
    String.raw`\@alex`,
    '~~~\n@alex\n~~~',
    '``code @alex``',
    'www.example.com/?person=@alex',
    '/members?person=@alex',
    '../members?person=@alex',
    'ftp://example.com/?person=@alex',
    '[@alex](https://example.com)',
    '[@alex][profile]',
    'a\u0301@alex',
    '@alexé',
    '@alex\u0301',
  ];
  for (const text of rejected) assert.deepEqual(extractMentions(text, [alex]).memberIds, [], text);
  assert.deepEqual(extractMentions('Review (@alex), then @sam_guest.', [alex, sam]).memberIds, [alex.id, sam.id]);
});
