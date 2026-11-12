import { ApiError, TrelloClient, isReference, isStableId, validCredentials, type Credentials } from './api';
import { dismissWarning, getCredentials, getSettings, listDismissals, reconcileMembership } from './preferences';

let client: TrelloClient | undefined;
let clientCredentials: Credentials | undefined;
let credentialVersion = 0;
const tabs = new Set<number>();
// Never allow content scripts to read API credentials, even through chrome.storage.
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
storageReady.catch(() => undefined);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const credentialsChanged = !!changes.credentials && !sameCredentials(changes.credentials.oldValue, changes.credentials.newValue);
  if (credentialsChanged) { client = undefined; clientCredentials = undefined; credentialVersion++; }
  if (credentialsChanged || Object.keys(changes).some(key => key === 'enabled' || key.startsWith('dismissal:'))) {
    for (const tabId of tabs) {
      void chrome.tabs.sendMessage(tabId, { type: 'preferences-changed', credentialsChanged }).catch(() => tabs.delete(tabId));
    }
  }
});

function isOwnPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(''));
}
function allowedSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  if (isOwnPage(sender)) return true;
  try { return new URL(sender.url ?? '').origin === 'https://trello.com'; } catch { return false; }
}
function sameCredentials(a: Credentials | undefined, b: Credentials | undefined): boolean {
  if (!a || !b) return a === b;
  return a.apiKey === b.apiKey && a.token === b.token;
}
async function getClient(): Promise<{ client: TrelloClient; credentials: Credentials }> {
  await storageReady;
  const credentials = await getCredentials();
  if (!validCredentials(credentials)) throw new ApiError('NOT_CONFIGURED', 'Connect a read-only Trello token in extension settings. Unable to verify guest status.');
  // Storage events may arrive after the message. Never reuse an older account's client.
  if (!client || !sameCredentials(clientCredentials, credentials)) {
    client = new TrelloClient(credentials);
    clientCredentials = { ...credentials };
  }
  return { client, credentials };
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!allowedSender(sender) || !message || typeof message !== 'object' || Array.isArray(message)) return false;
  if (sender.tab?.id !== undefined) {
    tabs.add(sender.tab.id);
    while (tabs.size > 256) tabs.delete(tabs.values().next().value!);
  }
  const input = message as Record<string, unknown>;
  const process = async (): Promise<unknown> => {
    if (input.type === 'open-settings') { await chrome.runtime.openOptionsPage(); return { ok: true }; }
    if (input.type === 'get-preferences') {
      await storageReady;
      const [settings, dismissals] = await Promise.all([getSettings(), listDismissals()]);
      return { ok: true, enabled: settings.enabled, dismissals: Object.fromEntries(dismissals.map(row => [row.key, row.fingerprint])) };
    }
    if (input.type === 'dismiss') {
      if ((input.scope !== 'board' && input.scope !== 'card') || !isStableId(input.scopeId)
        || !isStableId(input.boardId)
        || typeof input.fingerprint !== 'string' || input.fingerprint.length === 0 || input.fingerprint.length > 16_384) {
        throw new ApiError('INVALID_REQUEST', 'Invalid warning preference.');
      }
      await storageReady;
      await dismissWarning({ scope: input.scope, scopeId: input.scopeId, boardId: input.boardId, fingerprint: input.fingerprint });
      return { ok: true };
    }
    if (input.type === 'check-auth' && isOwnPage(sender)) {
      const selected = await getClient();
      const version = credentialVersion;
      await selected.client.checkAuth();
      const current = await getCredentials();
      if (credentialVersion !== version || !sameCredentials(selected.credentials, current)) {
        throw new ApiError('NOT_CONFIGURED', 'Saved authorization changed during verification. Review the current credentials and choose Save & verify again.');
      }
      return { ok: true };
    }
    if (input.type === 'snapshot') {
      if ((input.boardRef !== undefined && !isReference(input.boardRef))
        || (input.cardRef !== undefined && !isReference(input.cardRef))
        || (!input.boardRef && !input.cardRef)
        || (input.force !== undefined && typeof input.force !== 'boolean')) {
        throw new ApiError('INVALID_REQUEST', 'Open a Trello board or card to verify guest status.');
      }
      const version = credentialVersion;
      const snapshot = await (await getClient()).client.snapshot({ boardRef: input.boardRef as string | undefined, cardRef: input.cardRef as string | undefined, force: input.force === true });
      if (credentialVersion !== version) throw new ApiError('NOT_CONFIGURED', 'Trello authorization changed. Verifying again is required.');
      await reconcileMembership(snapshot);
      if (credentialVersion !== version) throw new ApiError('NOT_CONFIGURED', 'Trello authorization changed. Verifying again is required.');
      return { ok: true, snapshot };
    }
    throw new ApiError('INVALID_REQUEST', 'Unsupported extension request.');
  };
  void process().then(sendResponse).catch(error => {
    sendResponse(error instanceof ApiError
      ? { ok: false, code: error.code, error: error.message }
      : { ok: false, code: 'INTERNAL', error: 'The extension could not complete verification. Reload the extension and reopen Settings, then try again.' });
  });
  return true;
});

chrome.action.onClicked.addListener(() => { void chrome.runtime.openOptionsPage(); });
