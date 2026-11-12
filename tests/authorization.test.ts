import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTHORIZATION_EXPIRATIONS, authorizationExpiration, authorizationUrl } from '../src/authorization';

test('expiration accepts exactly the four documented choices and defaults safely', () => {
  for (const value of AUTHORIZATION_EXPIRATIONS) assert.equal(authorizationExpiration(value), value);
  for (const value of [undefined, null, '', '1week', 'NEVER', ' never ', 30, ['1day'], { expiration: '1day' }]) {
    assert.equal(authorizationExpiration(value), 'never');
  }
});

test('authorization URLs use the selected expiration and request only read access', () => {
  const key = 'a'.repeat(32);
  for (const expiration of AUTHORIZATION_EXPIRATIONS) {
    const url = new URL(authorizationUrl(key, expiration));
    assert.equal(url.origin, 'https://trello.com');
    assert.equal(url.pathname, '/1/authorize');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      key, name: 'Trello Guest Awareness', scope: 'read', expiration, response_type: 'token'
    });
    assert.equal(url.hash, '');
  }
  assert.equal(new URL(authorizationUrl(key)).searchParams.get('expiration'), 'never');
  assert.equal(new URL(authorizationUrl(key, 'invalid')).searchParams.get('expiration'), 'never');
  assert.throws(() => authorizationUrl('invalid'), /Invalid Trello API key/);
});
