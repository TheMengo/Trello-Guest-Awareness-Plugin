"use strict";
(() => {
  // src/api.ts
  var ApiError = class extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
      this.name = "ApiError";
    }
  };
  var isStableId = (value) => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
  var isReference = (value) => typeof value === "string" && (/^[a-zA-Z0-9]{8}$/.test(value) || isStableId(value));
  var validCredentials = (value) => {
    if (!value || typeof value !== "object") return false;
    const input = value;
    return typeof input.apiKey === "string" && /^[a-f0-9]{32}$/i.test(input.apiKey) && typeof input.token === "string" && /^[a-zA-Z0-9_-]{16,256}$/.test(input.token);
  };
  var invalid = () => {
    throw new ApiError("INVALID_DATA", "Trello returned incomplete membership data. Unable to verify guest status.");
  };
  function object(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    return value;
  }
  function id(value) {
    return isStableId(value) ? value : invalid();
  }
  function idList(value) {
    if (!Array.isArray(value) || value.length > 1e5) return invalid();
    return [...new Set(value.map(id))];
  }
  function memberList(value) {
    if (!Array.isArray(value) || value.length > 1e5) return invalid();
    const seen = /* @__PURE__ */ new Set();
    return value.map((entry) => {
      const member = object(entry);
      const memberId = id(member.id);
      if (seen.has(memberId)) return invalid();
      seen.add(memberId);
      if (typeof member.username !== "string" || !/^[a-zA-Z0-9_]{1,128}$/.test(member.username) || typeof member.fullName !== "string" || member.fullName.length > 512) return invalid();
      return { id: memberId, username: member.username, fullName: member.fullName || member.username };
    });
  }
  function minimalResource(path, value) {
    if (path.startsWith("organizations/")) {
      if (!Array.isArray(value) || value.length > 1e5) return invalid();
      return idList(value.map((entry) => object(entry).id)).map((memberId) => ({ id: memberId }));
    }
    if (path.includes("/members?")) return memberList(value);
    const data = object(value);
    if (path.startsWith("cards/")) return { id: id(data.id), idBoard: id(data.idBoard), idMembers: idList(data.idMembers) };
    if (path.startsWith("boards/")) return { id: id(data.id), idOrganization: data.idOrganization === null || data.idOrganization === void 0 || data.idOrganization === "" ? null : id(data.idOrganization) };
    return { id: id(data.id) };
  }
  var TrelloClient = class {
    constructor(credentials, fetcher = (input, init) => globalThis.fetch(input, init), now = Date.now, timeoutMs = 8e3) {
      this.credentials = credentials;
      this.fetcher = fetcher;
      this.now = now;
      this.timeoutMs = timeoutMs;
      if (!validCredentials(credentials)) throw new ApiError("NOT_CONFIGURED", "Connect a read-only Trello token in extension settings. Unable to verify guest status.");
    }
    cache = /* @__PURE__ */ new Map();
    pending = /* @__PURE__ */ new Map();
    referenceAliases = /* @__PURE__ */ new Map();
    blockedUntil = 0;
    async checkAuth() {
      if (this.now() < this.blockedUntil) throw new ApiError("RATE_LIMIT", "Trello is rate limiting requests. Wait before verifying again.");
      const result = object((await this.fetchResource("members/me?fields=id")).value);
      id(result.id);
    }
    async snapshot(request) {
      if (request.boardRef !== void 0 && !isReference(request.boardRef) || request.cardRef !== void 0 && !isReference(request.cardRef) || !request.boardRef && !request.cardRef) {
        throw new ApiError("INVALID_REQUEST", "Open a Trello board or card to verify guest status.");
      }
      return this.snapshotAttempt(request, 0);
    }
    async snapshotAttempt(request, attempt) {
      const force = request.force === true;
      let card;
      let cardResource;
      let cardTime = Number.POSITIVE_INFINITY;
      if (request.cardRef) {
        const result = await this.get(`cards/${request.cardRef}?fields=id,idBoard,idMembers`, force);
        cardResource = result;
        const data = object(result.value);
        card = { id: id(data.id), boardId: id(data.idBoard), memberIds: idList(data.idMembers), historicalGuestIds: [] };
        cardTime = result.fetchedAt;
      }
      const boardRef = card?.boardId ?? request.boardRef;
      const boardResult = await this.get(`boards/${boardRef}?fields=id,idOrganization`, force);
      const board = object(boardResult.value);
      const boardId = id(board.id);
      if (board.idOrganization === null || board.idOrganization === void 0 || board.idOrganization === "") {
        throw new ApiError("NO_WORKSPACE", "This board has no verifiable Workspace. Unable to verify guest status.");
      }
      const workspaceId = id(board.idOrganization);
      const [boardMembers, workspaceMembers] = await Promise.all([
        this.get(`boards/${boardId}/members?fields=id,username,fullName`, force),
        this.get(`organizations/${workspaceId}/members?fields=id&filter=all`, force)
      ]);
      const consumed = [
        [`boards/${boardId}?fields=id,idOrganization`, boardResult],
        [`boards/${boardId}/members?fields=id,username,fullName`, boardMembers],
        [`organizations/${workspaceId}/members?fields=id&filter=all`, workspaceMembers]
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
      if (!Array.isArray(workspaceMembers.value) || workspaceMembers.value.length > 1e5) return invalid();
      const workspaceMemberIds = idList(workspaceMembers.value.map((value) => object(value).id));
      if (!workspaceMemberIds.length) return invalid();
      return {
        board: { id: boardId, workspaceId, members, workspaceMemberIds },
        ...card ? { card } : {},
        fetchedAt: Math.min(cardTime, boardResult.fetchedAt, boardMembers.fetchedAt, workspaceMembers.fetchedAt),
        historyAvailable: false
      };
    }
    async get(path, force) {
      if (this.now() < this.blockedUntil) throw new ApiError("RATE_LIMIT", "Trello is rate limiting requests. Guest verification will retry later.");
      const reference = /^(boards|cards)\/([^/?]+)(\?fields=(?:id,idOrganization|id,idBoard,idMembers))$/.exec(path);
      const canonicalId = reference && this.referenceAliases.get(`${reference[1]}:${reference[2]}`);
      if (canonicalId && reference) path = `${reference[1]}/${canonicalId}${reference[3]}`;
      const existing = this.pending.get(path);
      if (existing) return existing;
      const cached = this.cache.get(path);
      if (cached && this.now() - cached.fetchedAt < (force ? 3e4 : 6e4)) return cached;
      const promise = this.fetchResource(path);
      this.pending.set(path, promise);
      try {
        return await promise;
      } finally {
        this.pending.delete(path);
      }
    }
    async fetchResource(path) {
      const startedAt = this.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        let request;
        try {
          request = this.fetcher(`https://api.trello.com/1/${path}`, {
            method: "GET",
            credentials: "omit",
            redirect: "error",
            cache: "no-store",
            headers: { Accept: "application/json", Authorization: `OAuth oauth_consumer_key="${this.credentials.apiKey}", oauth_token="${this.credentials.token}"` },
            signal: controller.signal
          });
        } catch {
          throw new ApiError("INTERNAL", "The extension could not start its Trello request. Reload the extension and reopen Settings, then try again.");
        }
        let response;
        try {
          response = await request;
        } catch (error) {
          if (controller.signal.aborted || error instanceof DOMException && error.name === "AbortError") {
            throw new ApiError("TIMEOUT", "The Trello request timed out. Check your connection and try Save & verify again.");
          }
          if (error instanceof TypeError || error instanceof DOMException && error.name === "NetworkError") {
            throw new ApiError("NETWORK", "The Trello network request failed. Check your connection, proxy, and extension site access, then try again. Unable to verify guest status.");
          }
          throw new ApiError("INTERNAL", "An internal extension error interrupted Trello verification. Reload the extension and reopen Settings, then try again.");
        }
        if (response.status === 400) throw new ApiError("BAD_REQUEST", "Trello rejected the request (HTTP 400). Check the API key and authorize a new read-only token using that same key.");
        if (response.status === 401) throw new ApiError("AUTH", "Trello authorization expired or was revoked. Reconnect in extension settings. Unable to verify guest status.");
        if (response.status === 403) throw new ApiError("PERMISSION", "The authorized account cannot read this membership data. Unable to verify guest status.");
        if (response.status === 404) throw new ApiError("NOT_FOUND", "This Trello board or card is unavailable to the authorized account. Unable to verify guest status.");
        if (response.status === 429) {
          const raw = response.headers.get("Retry-After");
          const retry = raw && /^\d+$/.test(raw) ? Number(raw) * 1e3 : raw ? Date.parse(raw) - this.now() : 6e4;
          this.blockedUntil = this.now() + Math.max(6e4, Number.isFinite(retry) ? Math.min(retry, 36e5) : 6e4);
          throw new ApiError("RATE_LIMIT", "Trello is rate limiting requests. Guest verification will retry later.");
        }
        if (!response.ok) throw new ApiError("HTTP_ERROR", `Trello returned HTTP ${response.status}. Wait and try verification again.`);
        let json;
        try {
          json = await response.json();
        } catch {
          if (controller.signal.aborted) throw new ApiError("TIMEOUT", "The Trello request timed out. Check your connection and try Save & verify again.");
          throw new ApiError("INVALID_DATA", "Trello returned an unreadable response. Try again; if it continues, check your proxy or contact the extension maintainer.");
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
            while (this.referenceAliases.size > 128) this.referenceAliases.delete(this.referenceAliases.keys().next().value);
          }
        }
        const newer = this.cache.get(cacheKey);
        if (newer && newer.fetchedAt >= startedAt) return newer;
        this.cache.delete(cacheKey);
        this.cache.set(cacheKey, entry);
        while (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value);
        return entry;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError("INTERNAL", "An internal extension error prevented Trello verification. Reload the extension and reopen Settings, then try again.");
      } finally {
        clearTimeout(timer);
      }
    }
  };

  // src/classify.ts
  var sorted = (ids) => [...new Set(ids)].sort();
  var names = (members) => members.map((member) => member.fullName || `@${member.username}`).join(", ");
  var mentionNames = (members) => members.map((member) => member.fullName ? `${member.fullName} (@${member.username})` : `@${member.username}`).join(", ");
  function extractMentions(text, members) {
    const prose = text.replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/~~~[\s\S]*?(?:~~~|$)/g, " ").replace(/(`+)[\s\S]*?(?:\1|$)/g, " ").replace(/!?\[[^\]\n]*\]\([^\)\n]*\)/g, " ").replace(/!?\[[^\]\n]*\]\[[^\]\n]*\]/g, " ").replace(/(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|www\.)[^\s<>]+/gi, " ").replace(/(?:^|[\s(\[])(?:\.{0,2}\/)[^\s<>]+/g, " ");
    const usernames = /* @__PURE__ */ new Map();
    const ambiguous = /* @__PURE__ */ new Set();
    for (const member of members) {
      const username = member.username.toLowerCase();
      if (usernames.has(username) && usernames.get(username) !== member.id) ambiguous.add(username);
      usernames.set(username, member.id);
    }
    const memberIds = [];
    const specials = [];
    const pattern = /(^|[^\p{L}\p{M}\p{N}_@/\\])@([a-z0-9_]+)(?![\p{L}\p{M}\p{N}_-])/giu;
    for (const match of prose.matchAll(pattern)) {
      const username = match[2].toLowerCase();
      if (username === "card" || username === "board") specials.push(username);
      else if (usernames.has(username) && !ambiguous.has(username)) memberIds.push(usernames.get(username));
    }
    return { memberIds: sorted(memberIds), specials: sorted(specials) };
  }
  function classify(snapshot, draft = "", historicalMentionIds = [], verifiedDraftMentionIds = []) {
    const { board, card } = snapshot;
    const workspace = new Set(board.workspaceMemberIds);
    const guests = board.members.filter((member) => !workspace.has(member.id)).sort((a, b) => a.id.localeCompare(b.id));
    const cardMemberIds = new Set(card?.memberIds ?? []);
    const mentions = extractMentions(draft, board.members);
    const draftIds = /* @__PURE__ */ new Set([...mentions.memberIds, ...verifiedDraftMentionIds]);
    const previousIds = /* @__PURE__ */ new Set([...historicalMentionIds, ...card?.historicalGuestIds ?? []]);
    const cardGuests = guests.filter((member) => cardMemberIds.has(member.id));
    const draftGuests = guests.filter((member) => draftIds.has(member.id));
    const previousGuests = guests.filter((member) => previousIds.has(member.id));
    const specials = card ? mentions.specials : [];
    const specific = Boolean(card && (cardGuests.length || draftGuests.length || previousGuests.length || specials.length));
    const scope = specific ? "card" : "board";
    const messages = [];
    if (guests.length) {
      messages.push(`This board has ${guests.length} ${guests.length === 1 ? "guest" : "guests"} outside its Workspace membership. Board guests can view cards, comments, and attachments on this board.`);
      if (cardGuests.length) messages.push(`Guest card ${cardGuests.length === 1 ? "member" : "members"}: ${names(cardGuests)}. They may receive notifications about new comments, depending on their notification preferences.`);
      if (draftGuests.length) messages.push(`Guest ${draftGuests.length === 1 ? "mention" : "mentions"} in this draft: ${names(draftGuests)}. This comment may directly notify ${draftGuests.length === 1 ? "this guest" : "these guests"}.`);
      if (previousGuests.length) messages.push(`Previously mentioned guests: ${mentionNames(previousGuests)}. This indicates prior involvement; it does not by itself mean they will receive notifications about future comments.`);
      if (specials.includes("card")) messages.push(cardGuests.length ? `@card may notify the members of this card, including ${cardGuests.length} ${cardGuests.length === 1 ? "guest" : "guests"}: ${names(cardGuests)}.` : "@card targets this card\u2019s members. None of the current card members are board guests; other board guests still have access.");
      if (specials.includes("board")) messages.push(`@board may notify board members, including all ${guests.length} board ${guests.length === 1 ? "guest" : "guests"}: ${names(guests)}.`);
    }
    const boardFingerprint = ["v1", board.workspaceId, sorted(guests.map((member) => member.id))];
    const fingerprint = JSON.stringify(specific ? [...boardFingerprint, sorted(cardGuests.map((member) => member.id)), sorted(draftGuests.map((member) => member.id)), sorted(previousGuests.map((member) => member.id)), specials] : boardFingerprint);
    return { boardId: board.id, guests, cardGuests, draftGuests, previousGuests, specials, specific, messages, fingerprint, scope, scopeId: specific ? card.id : board.id };
  }

  // src/preferences.ts
  var PREFIX = "dismissal:";
  var ID = /^[a-f0-9]{24}$/i;
  function dismissalKey(scope, scopeId) {
    if (scope !== "board" && scope !== "card" || !ID.test(scopeId)) throw new Error("Invalid warning identity.");
    return `${PREFIX}${scope}:${scopeId}`;
  }
  async function getSettings() {
    const result = await chrome.storage.local.get("enabled");
    return { enabled: result.enabled !== false };
  }
  async function dismissWarning(warning) {
    const key = dismissalKey(warning.scope, warning.scopeId);
    if (typeof warning.fingerprint !== "string" || !warning.fingerprint || warning.fingerprint.length > 3e4) throw new Error("Invalid warning fingerprint.");
    const boardId = warning.boardId ?? (warning.scope === "board" ? warning.scopeId : "");
    if (!ID.test(boardId)) throw new Error("Invalid board identity.");
    const entry = { key, scope: warning.scope, scopeId: warning.scopeId, boardId, fingerprint: warning.fingerprint, dismissedAt: Date.now() };
    await chrome.storage.local.set({ [key]: entry });
  }
  async function listDismissals() {
    const all = await chrome.storage.local.get(null);
    return Object.entries(all).flatMap(([key, value]) => {
      if (!key.startsWith(PREFIX) || !value || typeof value !== "object") return [];
      const item = value;
      if (!ID.test(item.scopeId) || !ID.test(item.boardId) || !["board", "card"].includes(item.scope) || typeof item.fingerprint !== "string" || typeof item.dismissedAt !== "number") return [];
      if (key !== dismissalKey(item.scope, item.scopeId)) return [];
      return [{ ...item, key }];
    }).sort((a, b) => b.dismissedAt - a.dismissedAt);
  }
  var reconciliation = Promise.resolve();
  function reconcileMembership(snapshot) {
    const task = reconciliation.then(async () => {
      const warning = classify(snapshot);
      const boardKey = `membership:board:${snapshot.board.id}`;
      const boardValue = await digest(JSON.stringify([snapshot.board.workspaceId, warning.guests.map((member) => member.id)]));
      const cardKey = snapshot.card ? `membership:card:${snapshot.card.id}` : void 0;
      const cardValue = snapshot.card ? await digest(JSON.stringify([snapshot.board.id, boardValue, warning.cardGuests.map((member) => member.id)])) : void 0;
      const saved = await chrome.storage.local.get(cardKey ? [boardKey, cardKey] : [boardKey]);
      const boardChanged = typeof saved[boardKey] === "string" && saved[boardKey] !== boardValue;
      const cardChanged = cardKey && typeof saved[cardKey] === "string" && saved[cardKey] !== cardValue;
      if (boardChanged || cardChanged) {
        const dismissed = await listDismissals();
        const affected = dismissed.filter((entry) => boardChanged && entry.boardId === snapshot.board.id || cardChanged && entry.scope === "card" && entry.scopeId === snapshot.card.id);
        if (affected.length) await chrome.storage.local.remove(affected.map((entry) => entry.key));
      }
      const updates = {};
      if (saved[boardKey] !== boardValue) updates[boardKey] = boardValue;
      if (cardKey && cardValue && saved[cardKey] !== cardValue) updates[cardKey] = cardValue;
      if (Object.keys(updates).length) await chrome.storage.local.set(updates);
    });
    reconciliation = task.catch(() => void 0);
    return task;
  }
  async function digest(value) {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  async function getCredentials() {
    const { credentials } = await chrome.storage.local.get("credentials");
    return validCredentials(credentials) ? { apiKey: credentials.apiKey, token: credentials.token } : void 0;
  }

  // src/background.ts
  var client;
  var clientCredentials;
  var credentialVersion = 0;
  var tabs = /* @__PURE__ */ new Set();
  var storageReady = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  storageReady.catch(() => void 0);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const credentialsChanged = !!changes.credentials && !sameCredentials(changes.credentials.oldValue, changes.credentials.newValue);
    if (credentialsChanged) {
      client = void 0;
      clientCredentials = void 0;
      credentialVersion++;
    }
    if (credentialsChanged || Object.keys(changes).some((key) => key === "enabled" || key.startsWith("dismissal:"))) {
      for (const tabId of tabs) {
        void chrome.tabs.sendMessage(tabId, { type: "preferences-changed", credentialsChanged }).catch(() => tabs.delete(tabId));
      }
    }
  });
  function isOwnPage(sender) {
    return sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(""));
  }
  function allowedSender(sender) {
    if (sender.id !== chrome.runtime.id) return false;
    if (isOwnPage(sender)) return true;
    try {
      return new URL(sender.url ?? "").origin === "https://trello.com";
    } catch {
      return false;
    }
  }
  function sameCredentials(a, b) {
    if (!a || !b) return a === b;
    return a.apiKey === b.apiKey && a.token === b.token;
  }
  async function getClient() {
    await storageReady;
    const credentials = await getCredentials();
    if (!validCredentials(credentials)) throw new ApiError("NOT_CONFIGURED", "Connect a read-only Trello token in extension settings. Unable to verify guest status.");
    if (!client || !sameCredentials(clientCredentials, credentials)) {
      client = new TrelloClient(credentials);
      clientCredentials = { ...credentials };
    }
    return { client, credentials };
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!allowedSender(sender) || !message || typeof message !== "object" || Array.isArray(message)) return false;
    if (sender.tab?.id !== void 0) {
      tabs.add(sender.tab.id);
      while (tabs.size > 256) tabs.delete(tabs.values().next().value);
    }
    const input = message;
    const process = async () => {
      if (input.type === "open-settings") {
        await chrome.runtime.openOptionsPage();
        return { ok: true };
      }
      if (input.type === "get-preferences") {
        await storageReady;
        const [settings, dismissals] = await Promise.all([getSettings(), listDismissals()]);
        return { ok: true, enabled: settings.enabled, dismissals: Object.fromEntries(dismissals.map((row) => [row.key, row.fingerprint])) };
      }
      if (input.type === "dismiss") {
        if (input.scope !== "board" && input.scope !== "card" || !isStableId(input.scopeId) || !isStableId(input.boardId) || typeof input.fingerprint !== "string" || input.fingerprint.length === 0 || input.fingerprint.length > 16384) {
          throw new ApiError("INVALID_REQUEST", "Invalid warning preference.");
        }
        await storageReady;
        await dismissWarning({ scope: input.scope, scopeId: input.scopeId, boardId: input.boardId, fingerprint: input.fingerprint });
        return { ok: true };
      }
      if (input.type === "check-auth" && isOwnPage(sender)) {
        const selected = await getClient();
        const version = credentialVersion;
        await selected.client.checkAuth();
        const current = await getCredentials();
        if (credentialVersion !== version || !sameCredentials(selected.credentials, current)) {
          throw new ApiError("NOT_CONFIGURED", "Saved authorization changed during verification. Review the current credentials and choose Save & verify again.");
        }
        return { ok: true };
      }
      if (input.type === "snapshot") {
        if (input.boardRef !== void 0 && !isReference(input.boardRef) || input.cardRef !== void 0 && !isReference(input.cardRef) || !input.boardRef && !input.cardRef || input.force !== void 0 && typeof input.force !== "boolean") {
          throw new ApiError("INVALID_REQUEST", "Open a Trello board or card to verify guest status.");
        }
        const version = credentialVersion;
        const snapshot = await (await getClient()).client.snapshot({ boardRef: input.boardRef, cardRef: input.cardRef, force: input.force === true });
        if (credentialVersion !== version) throw new ApiError("NOT_CONFIGURED", "Trello authorization changed. Verifying again is required.");
        await reconcileMembership(snapshot);
        if (credentialVersion !== version) throw new ApiError("NOT_CONFIGURED", "Trello authorization changed. Verifying again is required.");
        return { ok: true, snapshot };
      }
      throw new ApiError("INVALID_REQUEST", "Unsupported extension request.");
    };
    void process().then(sendResponse).catch((error) => {
      sendResponse(error instanceof ApiError ? { ok: false, code: error.code, error: error.message } : { ok: false, code: "INTERNAL", error: "The extension could not complete verification. Reload the extension and reopen Settings, then try again." });
    });
    return true;
  });
  chrome.action.onClicked.addListener(() => {
    void chrome.runtime.openOptionsPage();
  });
})();
