import { classify } from './classify';
import { validCredentials } from './api';
import { authorizationExpiration, type AuthorizationExpiration } from './authorization';
import type { Credentials, Dismissal, Snapshot, Warning, WarningScope } from './types';

type WarningKey = Pick<Warning, 'scope' | 'scopeId' | 'fingerprint'> & { boardId?: string };
const PREFIX = 'dismissal:';
const ID = /^[a-f0-9]{24}$/i;

export function dismissalKey(scope: WarningScope, scopeId: string): string {
  if ((scope !== 'board' && scope !== 'card') || !ID.test(scopeId)) throw new Error('Invalid warning identity.');
  return `${PREFIX}${scope}:${scopeId}`;
}

export async function getSettings(): Promise<{ enabled: boolean }> {
  const result = await chrome.storage.local.get('enabled');
  return { enabled: result.enabled !== false };
}

export async function setEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ enabled });
}

export async function getAuthorizationExpiration(): Promise<AuthorizationExpiration> {
  const result = await chrome.storage.local.get('authorizationExpiration');
  return authorizationExpiration(result.authorizationExpiration);
}

/** Independent from credentials: changing this preference cannot change an issued token. */
export async function setAuthorizationExpiration(value: AuthorizationExpiration): Promise<void> {
  await chrome.storage.local.set({ authorizationExpiration: authorizationExpiration(value) });
}

export async function isDismissed(warning: WarningKey): Promise<boolean> {
  const key = dismissalKey(warning.scope, warning.scopeId);
  const result = await chrome.storage.local.get(key);
  return result[key]?.fingerprint === warning.fingerprint;
}

export async function dismissWarning(warning: WarningKey): Promise<void> {
  const key = dismissalKey(warning.scope, warning.scopeId);
  if (typeof warning.fingerprint !== 'string' || !warning.fingerprint || warning.fingerprint.length > 30_000) throw new Error('Invalid warning fingerprint.');
  const boardId = warning.boardId ?? (warning.scope === 'board' ? warning.scopeId : '');
  if (!ID.test(boardId)) throw new Error('Invalid board identity.');
  const entry: Dismissal = { key, scope: warning.scope, scopeId: warning.scopeId, boardId, fingerprint: warning.fingerprint, dismissedAt: Date.now() };
  await chrome.storage.local.set({ [key]: entry });
}

export async function listDismissals(): Promise<Dismissal[]> {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all).flatMap(([key, value]) => {
    if (!key.startsWith(PREFIX) || !value || typeof value !== 'object') return [];
    const item = value as Dismissal;
    if (!ID.test(item.scopeId) || !ID.test(item.boardId) || !['board', 'card'].includes(item.scope) || typeof item.fingerprint !== 'string' || typeof item.dismissedAt !== 'number') return [];
    if (key !== dismissalKey(item.scope, item.scopeId)) return [];
    return [{ ...item, key }];
  }).sort((a, b) => b.dismissedAt - a.dismissedAt);
}

export async function restoreDismissal(key: string): Promise<void> {
  if (!/^dismissal:(board|card):[a-f0-9]{24}$/i.test(key)) throw new Error('Invalid warning identity.');
  await chrome.storage.local.remove(key);
}

export async function clearDismissals(): Promise<void> {
  const entries = await listDismissals();
  await chrome.storage.local.remove(entries.map(entry => entry.key));
}

let reconciliation = Promise.resolve();

/** Invalidate on every observed membership transition, including guest-free snapshots. */
export function reconcileMembership(snapshot: Snapshot): Promise<void> {
  const task = reconciliation.then(async () => {
    const warning = classify(snapshot);
    const boardKey = `membership:board:${snapshot.board.id}`;
    const boardValue = await digest(JSON.stringify([snapshot.board.workspaceId, warning.guests.map(member => member.id)]));
    const cardKey = snapshot.card ? `membership:card:${snapshot.card.id}` : undefined;
    const cardValue = snapshot.card ? await digest(JSON.stringify([snapshot.board.id, boardValue, warning.cardGuests.map(member => member.id)])) : undefined;
    const saved = await chrome.storage.local.get(cardKey ? [boardKey, cardKey] : [boardKey]);
    const boardChanged = typeof saved[boardKey] === 'string' && saved[boardKey] !== boardValue;
    const cardChanged = cardKey && typeof saved[cardKey] === 'string' && saved[cardKey] !== cardValue;
    if (boardChanged || cardChanged) {
      const dismissed = await listDismissals();
      const affected = dismissed.filter(entry => (boardChanged && entry.boardId === snapshot.board.id) || (cardChanged && entry.scope === 'card' && entry.scopeId === snapshot.card!.id));
      if (affected.length) await chrome.storage.local.remove(affected.map(entry => entry.key));
    }
    const updates: Record<string, string> = {};
    if (saved[boardKey] !== boardValue) updates[boardKey] = boardValue;
    if (cardKey && cardValue && saved[cardKey] !== cardValue) updates[cardKey] = cardValue;
    if (Object.keys(updates).length) await chrome.storage.local.set(updates);
  });
  reconciliation = task.catch(() => undefined);
  return task;
}

async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Credentials are read afresh: another Settings tab may have replaced or removed them. */
export async function getCredentials(): Promise<Credentials | undefined> {
  const { credentials } = await chrome.storage.local.get('credentials');
  return validCredentials(credentials) ? { apiKey: credentials.apiKey, token: credentials.token } : undefined;
}

export async function saveCredentials(credentials: Credentials): Promise<void> {
  if (!validCredentials(credentials)) throw new Error('Invalid Trello authorization.');
  await chrome.storage.local.set({ credentials: { apiKey: credentials.apiKey, token: credentials.token } });
}

export async function removeCredentials(): Promise<void> {
  await chrome.storage.local.remove('credentials');
}

/** An empty token field only reuses the latest saved token for the exact same key. */
export async function credentialsForInput(apiKey: string, token: string): Promise<Credentials | undefined> {
  const key = apiKey.trim();
  const enteredToken = token.trim();
  const saved = enteredToken ? undefined : await getCredentials();
  const credentials = { apiKey: key, token: enteredToken || (saved?.apiKey === key ? saved.token : '') };
  return validCredentials(credentials) ? credentials : undefined;
}
