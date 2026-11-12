# Authorization verification fix — 1.0.1

## Reproduced root cause

The original Settings form handler did run. It saved credentials, sent `{type:'check-auth'}`, and received the worker's failure reply. The worker listener correctly retained the asynchronous message channel using `return true`; it was not a missing click listener or a dropped response.

`TrelloClient` stored the native browser function using the constructor default `fetcher = fetch`, then called it as `this.fetcher(...)`. That supplies the `TrelloClient` instance as the receiver of `WorkerGlobalScope.fetch`. Chromium rejects that receiver with a synchronous `TypeError: Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation`. No network request starts. The broad API catch then converted the internal invocation error to `NETWORK: Trello could not be reached`, which the worker returned and Settings displayed as saved but unverified.

A credential-free reproduction in an actual MV3 Chromium worker returned:

| Invocation | Result |
| --- | --- |
| `fetch(dataUrl)` | HTTP 200 |
| `({fetcher: fetch}).fetcher(dataUrl)` | Illegal invocation |
| A wrapper calling `globalThis.fetch(dataUrl)` | HTTP 200 |

This explains why a direct manual worker fetch reached Trello while the API class did not. It also explains why the original test suite passed: its arrow-function fetch replacements accepted arbitrary receivers and masked the browser's native WebIDL check.

The added Settings → worker → native-fetch regression failed against the old production build with the exact reported “Trello could not be reached” message. It passes against the fixed production build. The test preserves the original receiver when forwarding to the actual native browser fetch implementation, with a credential-free data URL as transport. Test credentials are fictional; there was no authenticated live Trello request.

## Corrected lifecycle

1. Settings handles native form submission and reads current extension storage. A blank token reuses only the latest saved valid token for the exact same API key. It cannot restore a token removed elsewhere or overwrite a replacement with an old in-memory token.
2. Valid credentials are saved through shared, validated persistence helpers. The token input clears. The UI explicitly enters a saved/verifying state.
3. Settings sends `check-auth` through runtime messaging. A messaging failure is reported as an extension-worker communication problem while acknowledging successful persistence.
4. The worker accepts this operation only from its own extension page, reads current trusted storage, and matches the API client to the current credential pair even if a storage change event has not arrived yet.
5. `checkAuth()` makes a fresh GET to `https://api.trello.com/1/members/me?fields=id`, using the existing documented OAuth Authorization header, omitted cookies, and rejected redirects. Native fetch is invoked through `(input, init) => globalThis.fetch(input, init)` so the receiver is correct. Explicit authorization verification bypasses membership response caching; rate-limit backoff still applies.
6. The worker validates the returned member ID, then verifies that the stored credentials and credential-change epoch still match. It cannot return a stale verified success after removal/replacement during the request. Identical credential writes do not invalidate verification or clear the membership client.
7. Settings independently checks the latest saved pair and attempt identity before displaying success. Failed HTTP 400/401/403 responses, timeout, transport failure, unexpected response, internal failure, and messaging failure have separate actionable messages. Arbitrary error text, server bodies, API keys, tokens, and authenticated URLs are never logged or echoed.

## Files changed

- `src/api.ts`: correct native-fetch receiver; fresh explicit verification; sanitized distinct internal, transport, timeout, HTTP, and response errors.
- `src/background.ts`: current-storage/client matching; verification invalidation on real credential changes; same-value write handling; actionable internal-worker errors.
- `src/preferences.ts`: validated/projected credential read, save, remove, and fresh blank-token resolution helpers.
- `src/options.ts`: lifecycle-specific error/status handling, fresh token reuse, concurrent credential-change protection, and independent worker-communication reporting.
- `tests/api.test.ts`, `tests/background.test.ts`, `tests/preferences.test.ts`, `tests/browser.test.mjs`: 14 new unit tests and 9 new browser tests.
- `package.json`, `package-lock.json`, `scripts/build.mjs`, `public/INSTALL.txt`: patch version 1.0.1; the manifest now takes its version from package metadata.
- README, research/troubleshooting/test documentation, production `dist/`, and patch release archives.

No changes were made to `src/content.ts`, `src/dom.ts`, `src/classify.ts`, UI warning rules, comment handling, or extension permissions. The rebuilt `content.js` is byte-for-byte identical to the original 1.0.0 distribution. Manifest permissions, host permissions, content-script registration, and CSP were compared against the original archive and are identical.

## Validation

```sh
npm test
npm run package
```

Type checking passed. All 71 unit tests and all 34 browser tests passed with no skips. The existing guest-awareness/comment scenarios still pass. Native-fetch authorization regression: expected failure before the fix, success after. No authenticated live Trello account was used; live credential validity must be retested by the user.

Recorded evidence: the native regression failed as expected on the old build; all 9 targeted authorization tests passed after the fix; the full run passed 71 unit and 34 browser tests. Raw run logs are retained locally and excluded from public packages.

## Reload and retest

1. Use the rebuilt `dist/` directory. If Chrome currently loads a copied extension directory, replace its contents with the new `dist/` contents while keeping the loaded directory path unchanged. This preserves its extension ID and saved storage. Do not remove/reinstall the extension just to reload it.
2. Open `chrome://extensions`, find Trello Guest Awareness, and click its Reload button. Confirm version **1.0.1**. Close any old Settings and service-worker DevTools tabs, then reopen Settings from the extension icon.
3. Open the extension service-worker inspector from `chrome://extensions`; select Network and clear old entries. Requests originate in the worker, so the Settings page's Network panel is not expected to contain the Trello API request. Avoid exporting authenticated request details or headers.
4. Keep the saved API key and leave the token field blank. Click **Save & verify**. A GET to `/1/members/me?fields=id` should appear in the worker Network panel; valid credentials yield **Authorization saved and read access verified**. Click again: explicit verification makes another request, rather than reporting cached success. An active HTTP 429 backoff intentionally delays a new attempt.
5. HTTP 400/401 requires checking the key/token pairing or authorizing a new read-only token. HTTP 403 requires checking account/API read access. Worker/internal failures instruct a reload; actual transport/timeout failures identify the corresponding condition. No failure should claim verified success.
6. Reload Trello tabs to reconnect the fresh content script and worker. A successful account check does not guarantee access to every Workspace member list; board-specific 403/unverifiable states remain explicit.

Nothing was pushed, published, or deployed.
