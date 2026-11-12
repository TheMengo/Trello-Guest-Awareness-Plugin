"use strict";
(() => {
  // src/api.ts
  var validCredentials = (value) => {
    if (!value || typeof value !== "object") return false;
    const input = value;
    return typeof input.apiKey === "string" && /^[a-f0-9]{32}$/i.test(input.apiKey) && typeof input.token === "string" && /^[a-zA-Z0-9_-]{16,256}$/.test(input.token);
  };

  // src/authorization.ts
  var AUTHORIZATION_EXPIRATIONS = ["1hour", "1day", "30days", "never"];
  function authorizationExpiration(value) {
    return AUTHORIZATION_EXPIRATIONS.some((option) => option === value) ? value : "never";
  }
  function authorizationUrl(apiKey, expiration = "never") {
    if (!/^[a-f0-9]{32}$/i.test(apiKey)) throw new Error("Invalid Trello API key.");
    const url = new URL("https://trello.com/1/authorize");
    url.search = new URLSearchParams({
      key: apiKey,
      name: "Trello Guest Awareness",
      scope: "read",
      expiration: authorizationExpiration(expiration),
      response_type: "token"
    }).toString();
    return url.toString();
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
  async function setEnabled(enabled) {
    await chrome.storage.local.set({ enabled });
  }
  async function getAuthorizationExpiration() {
    const result = await chrome.storage.local.get("authorizationExpiration");
    return authorizationExpiration(result.authorizationExpiration);
  }
  async function setAuthorizationExpiration(value) {
    await chrome.storage.local.set({ authorizationExpiration: authorizationExpiration(value) });
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
  async function restoreDismissal(key) {
    if (!/^dismissal:(board|card):[a-f0-9]{24}$/i.test(key)) throw new Error("Invalid warning identity.");
    await chrome.storage.local.remove(key);
  }
  async function clearDismissals() {
    const entries = await listDismissals();
    await chrome.storage.local.remove(entries.map((entry) => entry.key));
  }
  var reconciliation = Promise.resolve();
  async function getCredentials() {
    const { credentials } = await chrome.storage.local.get("credentials");
    return validCredentials(credentials) ? { apiKey: credentials.apiKey, token: credentials.token } : void 0;
  }
  async function saveCredentials(credentials) {
    if (!validCredentials(credentials)) throw new Error("Invalid Trello authorization.");
    await chrome.storage.local.set({ credentials: { apiKey: credentials.apiKey, token: credentials.token } });
  }
  async function removeCredentials() {
    await chrome.storage.local.remove("credentials");
  }
  async function credentialsForInput(apiKey, token) {
    const key = apiKey.trim();
    const enteredToken = token.trim();
    const saved = enteredToken ? void 0 : await getCredentials();
    const credentials = { apiKey: key, token: enteredToken || (saved?.apiKey === key ? saved.token : "") };
    return validCredentials(credentials) ? credentials : void 0;
  }

  // src/options.ts
  var get = (id) => document.getElementById(id);
  var status = get("status");
  var keyInput = get("api-key");
  var tokenInput = get("api-token");
  var enabledInput = get("enabled");
  var connection = get("connection-state");
  var expirationInput = get("authorization-expiration");
  var authorizeButton = get("authorize");
  var savedExpiration = "never";
  var currentCredentials;
  var displayedCredentials;
  var verificationAttempt = 0;
  var saving = false;
  var credentialChange = 0;
  var sameCredentials = (a, b) => a?.apiKey === b?.apiKey && a?.token === b?.token;
  function report(message, error = false) {
    status.textContent = message;
    status.classList.toggle("error", error);
  }
  function connectionState() {
    connection.textContent = currentCredentials ? "Authorization saved locally. Save & verify to check current access." : "No authorization saved.";
    get("disconnect").disabled = !currentCredentials;
  }
  async function renderDismissals() {
    const container = get("dismissals");
    const entries = await listDismissals();
    container.replaceChildren();
    get("restore-all").disabled = entries.length === 0;
    if (!entries.length) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "No dismissed warnings. Confirmations will appear when guests are detected.";
      container.append(empty);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "dismissal";
      const info = document.createElement("div");
      info.className = "dismissal-info";
      const title = document.createElement("strong");
      title.textContent = `${entry.scope === "board" ? "Board" : "Card"} confirmation`;
      const id = document.createElement("code");
      id.textContent = entry.scopeId;
      info.append(title, id);
      const button = document.createElement("button");
      button.className = "secondary";
      button.type = "button";
      button.textContent = "Restore";
      button.setAttribute("aria-label", `Restore ${entry.scope} warning ${entry.scopeId}`);
      button.addEventListener("click", () => void run(async () => {
        await restoreDismissal(entry.key);
        await renderDismissals();
        report("Warning restored. It will appear on the next relevant comment attempt.");
        get("restore-all").focus();
      }));
      row.append(info, button);
      container.append(row);
    }
  }
  async function run(action) {
    try {
      await action();
    } catch {
      report("Settings could not be updated. Reload this extension settings page and try again.", true);
    }
  }
  enabledInput.addEventListener("change", () => void run(async () => {
    await setEnabled(enabledInput.checked);
    report(enabledInput.checked ? "Guest awareness enabled." : "Guest awareness disabled. Trello commenting continues normally.");
  }));
  expirationInput.addEventListener("change", () => void (async () => {
    const selected = authorizationExpiration(expirationInput.value);
    expirationInput.disabled = authorizeButton.disabled = true;
    try {
      await setAuthorizationExpiration(selected);
      savedExpiration = selected;
      report("Token expiration preference saved. Existing tokens keep their original expiration.");
    } catch {
      expirationInput.value = savedExpiration;
      report("Token expiration preference could not be saved. Try again or reload Settings.", true);
    } finally {
      expirationInput.disabled = authorizeButton.disabled = false;
    }
  })());
  authorizeButton.addEventListener("click", () => {
    const apiKey = keyInput.value.trim();
    if (!/^[a-f0-9]{32}$/i.test(apiKey)) {
      report("Enter a valid Trello API key: 32 hexadecimal characters.", true);
      keyInput.focus();
      return;
    }
    window.open(authorizationUrl(apiKey, expirationInput.value), "_blank", "noopener,noreferrer");
    report("Complete authorization at Trello, then paste the token here. Only read access is requested.");
  });
  function verificationError(result) {
    const code = result && typeof result === "object" && "code" in result ? result.code : void 0;
    switch (code) {
      case "BAD_REQUEST":
        return "Trello rejected the request (HTTP 400). Check that the API key matches the token, then authorize a new read-only token.";
      case "AUTH":
        return "Trello rejected authorization (HTTP 401). The token may be expired, revoked, or paired with a different API key. Authorize a new read-only token.";
      case "NOT_FOUND":
        return "Trello returned HTTP 404 for authorization verification. Check for an extension update or a proxy blocking the API endpoint.";
      case "PERMISSION":
        return "Trello denied access (HTTP 403). Confirm that the token has read access and your account may use the API.";
      case "NOT_CONFIGURED":
        return "Saved authorization is missing or changed. Check the API key, paste its token, and save again.";
      case "NETWORK":
        return "The Trello request failed. Check your connection and whether api.trello.com is allowed, then try again.";
      case "TIMEOUT":
        return "Trello did not respond before the request timed out. Try again shortly.";
      case "RATE_LIMIT":
        return "Trello is rate limiting verification. Wait at least a minute before trying again.";
      case "INVALID_DATA":
        return "Trello returned an unexpected response. Try again; if it persists, check for an extension update.";
      case "HTTP_ERROR":
        return "Trello returned an HTTP error. Try again shortly; check Trello service status if it continues.";
      case "INTERNAL":
        return "The extension could not run verification. Reload the extension at chrome://extensions, reopen Settings, and try again.";
      default:
        return "The extension worker returned an invalid verification response. Reload the extension, reopen Settings, and try again.";
    }
  }
  async function saveAndVerify() {
    if (saving) return;
    saving = true;
    const attempt = ++verificationAttempt;
    const saveButton = get("save");
    saveButton.disabled = true;
    keyInput.disabled = tokenInput.disabled = true;
    let stage = "read";
    try {
      const credentials = await credentialsForInput(keyInput.value, tokenInput.value);
      if (attempt !== verificationAttempt) return;
      if (!credentials) {
        connection.textContent = "Authorization has not been verified.";
        report("Enter a valid Trello API key and its authorization token. A blank token can only reuse a saved token for the same API key.", true);
        return;
      }
      stage = "save";
      displayedCredentials = credentials;
      await saveCredentials(credentials);
      if (attempt !== verificationAttempt) return;
      currentCredentials = credentials;
      tokenInput.value = "";
      connectionState();
      connection.textContent = "Authorization saved. Verifying read access\u2026";
      report("Authorization saved. Verifying read access\u2026");
      stage = "verify";
      let result;
      try {
        result = await chrome.runtime.sendMessage({ type: "check-auth" });
      } catch {
        if (attempt === verificationAttempt) {
          connection.textContent = "Authorization saved, but access has not been verified.";
          report("Authorization was saved, but Settings could not contact the extension service worker. Reload the extension at chrome://extensions, reopen Settings, and try Save & verify again.", true);
        }
        return;
      }
      if (attempt !== verificationAttempt) return;
      const latest = await getCredentials();
      if (attempt !== verificationAttempt) return;
      if (!sameCredentials(latest, credentials)) {
        currentCredentials = displayedCredentials = latest;
        connectionState();
        report("Saved authorization changed during verification. Save & verify the current credentials again.", true);
        return;
      }
      if (result && typeof result === "object" && "ok" in result && result.ok === true) {
        connection.textContent = "Read access verified. Trello tabs will refresh their guest status.";
        report("Authorization saved and read access verified.");
      } else {
        connection.textContent = "Authorization saved, but access has not been verified.";
        report(`Unable to verify access. ${verificationError(result)}`, true);
      }
    } catch {
      if (attempt !== verificationAttempt) return;
      if (stage === "verify") {
        connection.textContent = "Authorization saved, but access has not been verified.";
        report("Authorization was saved, but the extension could not finish verification. Reload the extension and reopen Settings.", true);
      } else {
        connection.textContent = "Authorization has not been verified.";
        report(stage === "read" ? "Saved credentials could not be read. Reload Settings and check extension storage access." : "Authorization could not be saved. Reload Settings and check extension storage access.", true);
      }
    } finally {
      saving = false;
      saveButton.disabled = false;
      keyInput.disabled = tokenInput.disabled = false;
    }
  }
  get("credentials-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void saveAndVerify();
  });
  for (const input of [keyInput, tokenInput]) input.addEventListener("input", () => {
    connection.textContent = "Credentials edited. Save & verify to check these changes.";
  });
  get("disconnect").addEventListener("click", () => void run(async () => {
    verificationAttempt++;
    await removeCredentials();
    currentCredentials = displayedCredentials = void 0;
    tokenInput.value = "";
    connectionState();
    report("Saved credentials removed from this browser. Revoke the token at Trello if it is no longer needed.");
  }));
  get("restore-all").addEventListener("click", () => void run(async () => {
    await clearDismissals();
    await renderDismissals();
    report("All dismissed warnings restored. Board guest indicators remain visible.");
  }));
  void run(async () => {
    const [settings, saved, expiration] = await Promise.all([getSettings(), getCredentials(), getAuthorizationExpiration()]);
    enabledInput.checked = settings.enabled;
    savedExpiration = expiration;
    expirationInput.value = expiration;
    expirationInput.disabled = authorizeButton.disabled = false;
    currentCredentials = displayedCredentials = saved;
    keyInput.value = currentCredentials?.apiKey ?? "";
    connectionState();
    await renderDismissals();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if ("credentials" in changes) {
      const change = ++credentialChange;
      void run(async () => {
        const saved = await getCredentials();
        if (change !== credentialChange || sameCredentials(saved, displayedCredentials)) return;
        verificationAttempt++;
        currentCredentials = displayedCredentials = saved;
        connectionState();
        report(saved ? "Saved authorization changed. Save & verify to check the current credentials." : "No authorization saved. Paste a token before verifying.");
      });
    }
    if ("enabled" in changes) enabledInput.checked = changes.enabled.newValue !== false;
    if ("authorizationExpiration" in changes) {
      savedExpiration = authorizationExpiration(changes.authorizationExpiration.newValue);
      expirationInput.value = savedExpiration;
    }
    if (Object.keys(changes).some((key) => key.startsWith("dismissal:"))) void run(renderDismissals);
  });
})();
