import type { Member, Snapshot } from './types';

export interface Credentials { apiKey: string; token: string }
export interface SnapshotRequest { boardRef?: string; cardRef?: string; force?: boolean }
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type ApiErrorCode = 'NOT_CONFIGURED' | 'INVALID_REQUEST' | 'AUTH' | 'PERMISSION' | 'NOT_FOUND' | 'RATE_LIMIT' | 'NETWORK' | 'TIMEOUT' | 'INTERNAL' | 'BAD_REQUEST' | 'HTTP_ERROR' | 'INVALID_DATA' | 'NO_WORKSPACE';

/** Error text is deliberately fixed: never expose response bodies, URLs, or credentials. */
export class ApiError extends Error {
  constructor(public readonly code: ApiErrorCode, message: string) { super(message); this.name = 'ApiError'; }
}

export const isStableId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
export const isReference = (value: unknown): value is string => typeof value === 'string' && (/^[a-zA-Z0-9]{8}$/.test(value) || isStableId(value));
export const validCredentials = (value: unknown): value is Credentials => {
  if (!value || typeof value !== 'object') return false;
  const input = value as Record<string, unknown>;
  return typeof input.apiKey === 'string' && /^[a-f0-9]{32}$/i.test(input.apiKey)
    && typeof input.token === 'string' && /^[a-zA-Z0-9_-]{16,256}$/.test(input.token);
};

const invalid = (): never => { throw new ApiError('INVALID_DATA', 'Trello returned incomplete membership data. Unable to verify guest status.'); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function id(value: unknown): string { return isStableId(value) ? value : invalid(); }
function idList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100_000) return invalid();
  return [...new Set(value.map(id))];
}
function memberList(value: unknown): Member[] {
  if (!Array.isArray(value) || value.length > 100_000) return invalid();
  const seen = new Set<string>();
  return value.map(entry => {
    const member = object(entry);
    const memberId = id(member.id);
    if (seen.has(memberId)) return invalid();
    seen.add(memberId);
    if (typeof member.username !== 'string' || !/^[a-zA-Z0-9_]{1,128}$/.test(member.username)
      || typeof member.fullName !== 'string' || member.fullName.length > 512) return invalid();
    return { id: memberId, username: member.username, fullName: member.fullName || member.username };
  });
}

// Drop any unrelated properties even if Trello ignores a requested fields projection.
function minimalResource(path: string, value: unknown): unknown {
  if (path.startsWith('organizations/')) {
    if (!Array.isArray(value) || value.length > 100_000) return invalid();
    return idList(value.map(entry => object(entry).id)).map(memberId => ({ id: memberId }));
  }
  if (path.includes('/members?')) return memberList(value);
  const data = object(value);
  if (path.startsWith('cards/')) return { id: id(data.id), idBoard: id(data.idBoard), idMembers: idList(data.idMembers) };
  if (path.startsWith('boards/')) return { id: id(data.id), idOrganization: data.idOrganization === null || data.idOrganization === undefined || data.idOrganization === '' ? null : id(data.idOrganization) };
  return { id: id(data.id) };
}

/** Only documented, fixed GET routes. Membership cache lives in the service worker's memory. */
export class TrelloClient {
  private readonly cache = new Map<string, { value: unknown; fetchedAt: number }>();
  private readonly pending = new Map<string, Promise<{ value: unknown; fetchedAt: number }>>();
  private readonly referenceAliases = new Map<string, string>();
  private blockedUntil = 0;
  constructor(private readonly credentials: Credentials,
    private readonly fetcher: Fetcher = (input, init) => globalThis.fetch(input, init),
    private readonly now: () => number = Date.now,
    private readonly timeoutMs = 8_000) {
    if (!validCredentials(credentials)) throw new ApiError('NOT_CONFIGURED', 'Connect a read-only Trello token in extension settings. Unable to verify guest status.');
  }

  async checkAuth(): Promise<void> {
    if (this.now() < this.blockedUntil) throw new ApiError('RATE_LIMIT', 'Trello is rate limiting requests. Wait before verifying again.');
    // Explicit verification must reach Trello, even after a recent success.
    const result = object((await this.fetchResource('members/me?fields=id')).value);
    id(result.id);
  }

  async snapshot(request: SnapshotRequest): Promise<Snapshot> {
    if ((request.boardRef !== undefined && !isReference(request.boardRef))
      || (request.cardRef !== undefined && !isReference(request.cardRef))
      || (!request.boardRef && !request.cardRef)) {
      throw new ApiError('INVALID_REQUEST', 'Open a Trello board or card to verify guest status.');
    }
    return this.snapshotAttempt(request, 0);
  }

  private async snapshotAttempt(request: SnapshotRequest, attempt: number): Promise<Snapshot> {
    const force = request.force === true;
    let card: Snapshot['card'];
    let cardResource: { value: unknown; fetchedAt: number } | undefined;
    let cardTime = Number.POSITIVE_INFINITY;
    if (request.cardRef) {
      const result = await this.get(`cards/${request.cardRef}?fields=id,idBoard,idMembers`, force);
      cardResource = result;
      const data = object(result.value);
      card = { id: id(data.id), boardId: id(data.idBoard), memberIds: idList(data.idMembers), historicalGuestIds: [] };
      cardTime = result.fetchedAt;
    }
    // The API's card -> board relationship is authoritative, including when a card was moved.
    const boardRef = card?.boardId ?? request.boardRef!;
    const boardResult = await this.get(`boards/${boardRef}?fields=id,idOrganization`, force);
    const board = object(boardResult.value);
    const boardId = id(board.id);
    if (board.idOrganization === null || board.idOrganization === undefined || board.idOrganization === '') {
      throw new ApiError('NO_WORKSPACE', 'This board has no verifiable Workspace. Unable to verify guest status.');
    }
    const workspaceId = id(board.idOrganization);
    const [boardMembers, workspaceMembers] = await Promise.all([
      this.get(`boards/${boardId}/members?fields=id,username,fullName`, force),
      this.get(`organizations/${workspaceId}/members?fields=id&filter=all`, force),
    ]);
    // Another tab can refresh any consumed relationship or membership while
    // this request waits. Never reconcile an older assignment/guest set after
    // the worker has already observed its replacement. Identical data refreshed
    // with a newer timestamp does not require another pass.
    const consumed: [string, { value: unknown; fetchedAt: number }][] = [
      [`boards/${boardId}?fields=id,idOrganization`, boardResult],
      [`boards/${boardId}/members?fields=id,username,fullName`, boardMembers],
      [`organizations/${workspaceId}/members?fields=id&filter=all`, workspaceMembers],
    ];
    if (card && cardResource) consumed.push([`cards/${card.id}?fields=id,idBoard,idMembers`, cardResource]);
    const consumedDataChanged = consumed.some(([key, used]) => {
      const current = this.cache.get(key);
      return current && current !== used && JSON.stringify(current.value) !== JSON.stringify(used.value);
    });
    if (consumedDataChanged) {
      if (attempt === 0) return this.snapshotAttempt({ ...request, force: false }, 1);
      return invalid();
    }
    const members = memberList(boardMembers.value);
    if (!Array.isArray(workspaceMembers.value) || workspaceMembers.value.length > 100_000) return invalid();
    const workspaceMemberIds = idList(workspaceMembers.value.map(value => object(value).id));
    // An empty Workspace list on an owned board is too ambiguous to classify as all guests.
    if (!workspaceMemberIds.length) return invalid();
    return {
      board: { id: boardId, workspaceId, members, workspaceMemberIds },
      ...(card ? { card } : {}),
      fetchedAt: Math.min(cardTime, boardResult.fetchedAt, boardMembers.fetchedAt, workspaceMembers.fetchedAt),
      historyAvailable: false,
    };
  }

  private async get(path: string, force: boolean): Promise<{ value: unknown; fetchedAt: number }> {
    if (this.now() < this.blockedUntil) throw new ApiError('RATE_LIMIT', 'Trello is rate limiting requests. Guest verification will retry later.');
    const reference = /^(boards|cards)\/([^/?]+)(\?fields=(?:id,idOrganization|id,idBoard,idMembers))$/.exec(path);
    const canonicalId = reference && this.referenceAliases.get(`${reference[1]}:${reference[2]}`);
    if (canonicalId && reference) path = `${reference[1]}/${canonicalId}${reference[3]}`;
    // Once any caller starts refreshing a resource, every tab joins that refresh.
    // Returning its older TTL cache here could reconcile membership backwards.
    const existing = this.pending.get(path);
    if (existing) return existing;
    const cached = this.cache.get(path);
    // Force requests still coalesce across tabs for 30 seconds to avoid request storms.
    if (cached && this.now() - cached.fetchedAt < (force ? 30_000 : 60_000)) return cached;
    const promise = this.fetchResource(path);
    this.pending.set(path, promise);
    try { return await promise; } finally { this.pending.delete(path); }
  }

  private async fetchResource(path: string): Promise<{ value: unknown; fetchedAt: number }> {
    const startedAt = this.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let request: Promise<Response>;
      try {
        // Browser fetch requires its global receiver. Calling a detached native
        // method as this.fetcher(...) otherwise fails before sending a request.
        request = this.fetcher(`https://api.trello.com/1/${path}`, {
          method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store',
          headers: { Accept: 'application/json', Authorization: `OAuth oauth_consumer_key="${this.credentials.apiKey}", oauth_token="${this.credentials.token}"` },
          signal: controller.signal,
        });
      } catch {
        throw new ApiError('INTERNAL', 'The extension could not start its Trello request. Reload the extension and reopen Settings, then try again.');
      }
      let response: Response;
      try { response = await request; }
      catch (error) {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
          throw new ApiError('TIMEOUT', 'The Trello request timed out. Check your connection and try Save & verify again.');
        }
        if (error instanceof TypeError || (error instanceof DOMException && error.name === 'NetworkError')) {
          throw new ApiError('NETWORK', 'The Trello network request failed. Check your connection, proxy, and extension site access, then try again. Unable to verify guest status.');
        }
        throw new ApiError('INTERNAL', 'An internal extension error interrupted Trello verification. Reload the extension and reopen Settings, then try again.');
      }
      if (response.status === 400) throw new ApiError('BAD_REQUEST', 'Trello rejected the request (HTTP 400). Check the API key and authorize a new read-only token using that same key.');
      if (response.status === 401) throw new ApiError('AUTH', 'Trello authorization expired or was revoked. Reconnect in extension settings. Unable to verify guest status.');
      if (response.status === 403) throw new ApiError('PERMISSION', 'The authorized account cannot read this membership data. Unable to verify guest status.');
      if (response.status === 404) throw new ApiError('NOT_FOUND', 'This Trello board or card is unavailable to the authorized account. Unable to verify guest status.');
      if (response.status === 429) {
        const raw = response.headers.get('Retry-After');
        const retry = raw && /^\d+$/.test(raw) ? Number(raw) * 1000 : raw ? Date.parse(raw) - this.now() : 60_000;
        this.blockedUntil = this.now() + Math.max(60_000, Number.isFinite(retry) ? Math.min(retry, 3_600_000) : 60_000);
        throw new ApiError('RATE_LIMIT', 'Trello is rate limiting requests. Guest verification will retry later.');
      }
      if (!response.ok) throw new ApiError('HTTP_ERROR', `Trello returned HTTP ${response.status}. Wait and try verification again.`);
      let json: unknown;
      try { json = await response.json(); }
      catch {
        if (controller.signal.aborted) throw new ApiError('TIMEOUT', 'The Trello request timed out. Check your connection and try Save & verify again.');
        throw new ApiError('INVALID_DATA', 'Trello returned an unreadable response. Try again; if it continues, check your proxy or contact the extension maintainer.');
      }
      const value = minimalResource(path, json);
      const entry = { value, fetchedAt: startedAt };
      let cacheKey = path;
      const reference = /^(boards|cards)\/([^/?]+)(\?fields=(?:id,idOrganization|id,idBoard,idMembers))$/.exec(path);
      if (reference) {
        const resourceId = id(object(value).id);
        cacheKey = `${reference[1]}/${resourceId}${reference[3]}`;
        if (reference[2] !== resourceId) {
          this.referenceAliases.set(`${reference[1]}:${reference[2]}`, resourceId);
          while (this.referenceAliases.size > 128) this.referenceAliases.delete(this.referenceAliases.keys().next().value!);
        }
      }
      // Unknown short links can initially race their canonical IDs. A slower,
      // older response must not overwrite newer metadata for the same board.
      const newer = this.cache.get(cacheKey);
      if (newer && newer.fetchedAt >= startedAt) return newer;
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, entry);
      // Bound long-lived workers even if many boards/cards are visited.
      while (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
      return entry;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('INTERNAL', 'An internal extension error prevented Trello verification. Reload the extension and reopen Settings, then try again.');
    } finally { clearTimeout(timer); }
  }
}
