export const AUTHORIZATION_EXPIRATIONS = ['1hour', '1day', '30days', 'never'] as const;
export type AuthorizationExpiration = typeof AUTHORIZATION_EXPIRATIONS[number];

export function authorizationExpiration(value: unknown): AuthorizationExpiration {
  return AUTHORIZATION_EXPIRATIONS.some(option => option === value) ? value as AuthorizationExpiration : 'never';
}

/** This public-key URL issues a new read-only token; it never contains a saved token. */
export function authorizationUrl(apiKey: string, expiration: unknown = 'never'): string {
  if (!/^[a-f0-9]{32}$/i.test(apiKey)) throw new Error('Invalid Trello API key.');
  const url = new URL('https://trello.com/1/authorize');
  url.search = new URLSearchParams({
    key: apiKey, name: 'Trello Guest Awareness', scope: 'read',
    expiration: authorizationExpiration(expiration), response_type: 'token'
  }).toString();
  return url.toString();
}
