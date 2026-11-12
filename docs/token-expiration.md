# Authorization token expiration — 1.0.3

The Settings page now offers **Authorization token expiration** immediately before **Open read-only authorization**. Options are **1 hour** (`1hour`), **1 day** (`1day`), **30 days** (`30days`), and **Never expires** (`never`, default). The native select shares the Settings page’s light/dark colors and focus styling.

The choice saves automatically in trusted local extension storage as `authorizationExpiration`, independently of credentials, enabled status, and warning dismissals. Settings restores it when reopened. Missing, malformed, and unsupported values fall back to `never`. Controls wait for restoration and saving; a storage write failure restores the prior selection and displays an error.

The choice affects only newly issued tokens. Existing tokens retain their original expiration and their saved verification state is not invalidated by changing the preference. **Never expires** means no scheduled expiration; Trello can still revoke or invalidate the token. Each person must authorize their own token and can revoke it through Trello account settings.

## Authorization and security

`src/authorization.ts` validates the expiration and builds `https://trello.com/1/authorize` using the configured public API key, the chosen `expiration`, `scope=read`, `response_type=token`, and the existing application name. This follows [Trello’s documented authorization endpoint and expiration values](https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/).

The URL never includes a saved authorization token. The existing manual token-copying workflow and fresh **Save & verify** request remain unchanged, including blank-input reuse of a saved token for the same API key. No credentials are logged or embedded. No browser permissions, runtime dependencies, backend, API writes, or comment handling changes were added.

## Files and validation

- `src/authorization.ts`: pure expiration validation and URL construction.
- `src/preferences.ts`, `src/options.ts`: separate persistence, restore, synchronization, and authorization-button integration.
- `public/options.html`, `public/options.css`: accessible selector, explanatory text, and matching theme styling.
- `tests/authorization.test.ts`, `tests/preferences.test.ts`, `tests/browser.test.mjs`: expiration and existing-workflow regression coverage.
- README, installation instructions, privacy/research/test documentation, package metadata, generated `dist/`, and distribution ZIPs updated for 1.0.3.
- Publication review redacted personal/live-board details from earlier reports and replaced live identities in fixtures with fictional examples. Original private evidence and live screenshots remain outside the repository and source package. Packaging uses an explicit documentation allowlist.

Validation results and environment are recorded in [the test report](test-report.md). Browser tests exercise all four choices, read-only URL parameters, default selection, persisted values after reopening, malformed storage recovery, unchanged existing credentials/verification, and fresh blank-token verification. The complete board warning, card warning, and comment-confirmation regression suite also runs.

Settings screenshots use empty credential fields: [light](screenshots/settings-expiration-light.png) and [dark mobile](screenshots/settings-expiration-dark-mobile.png).

## Rebuild and reload

```sh
npm ci
npm run build
npm test
npm run package
```

If needed, first install a test browser with `npx playwright install chromium`. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can select another compatible unbranded Chromium executable. The installable ZIP has `manifest.json` at its root; extract it before loading.

For an existing installation, copy the contents of `dist/` into the same folder Chrome currently loads. At `chrome://extensions`, click **Reload** for Trello Guest Awareness, reopen Settings, and refresh Trello tabs. Keep the loaded directory unchanged to retain the extension ID and local credentials/preferences. Verify version **1.0.3** and the default **Never expires** selection; select another choice, reopen Settings, and confirm it persists.

Automated authorization tests use fictional credentials and intercepted pages/responses. They do not issue real tokens, grant access, or post Trello comments. No new live token was generated for this change. Existing live Post Anyway and Edge acceptance limitations remain as documented in [limitations](limitations.md).
