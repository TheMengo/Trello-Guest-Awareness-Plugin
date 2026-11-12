# Validation report

Date: 12 November 2026. Release: 1.0.3. Platform: macOS arm64, Node.js 24.16.0, npm 11.16.0, TypeScript 5.9.3, Playwright 1.55.1, downloaded unbranded Chromium 140.0.7339.186. Build target/minimum Chrome version: 120.

## Commands and results

Run from the project directory:

```sh
npm test
```

The aggregate runs these exact scripts in order:

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed, no diagnostics. |
| `npm run test:unit` | 82 tests passed, 0 failed/skipped. |
| `npm run build` | Passed; production Manifest V3 bundle created in `dist/`. |
| `npm run test:browser` | 46 tests passed, 0 failed/skipped. |

The additional authorization tests retain native browser fetch receiver checks; see [the root cause and lifecycle report](authorization-fix.md). No real credentials were used.

The verification environment used a compatible local unbranded Chromium executable selected with `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. A normal development machine can use `npx playwright install chromium` followed by `npm test` without the override. Chromium execution required local process-launch permission in the agent environment.

The cached browser installation was incomplete; a matching official Playwright Chromium archive was downloaded and extracted. An initial sandboxed aggregate attempt could not launch Chromium (OS process-launch denial). The complete aggregate passed after granting the required local launch permission. No production change was needed for those environment failures.

Current card-warning and live-DOM evidence is documented in [card-warning-fix.md](card-warning-fix.md).

Full aggregate output is retained locally under ignored `test-results/`. Raw logs are excluded from public packages; the results above summarize that run. Distribution validation uses `npm run package`, ZIP CRC checks on every entry, Manifest V3/permission assertions, and SHA-256 checksum verification. All passed; the unpacked ZIP has `manifest.json` at its root and the source ZIP contains TypeScript, tests, fixtures, documentation, and the production build.

## What ran

Unit tests independently verify expiration defaults/validation and read-only URLs; preference independence from credentials/dismissals; guest set difference; stable identity/signal fingerprints; exact usernames and conservative exclusions; membership, prior mention, `@card` and `@board` distinctions; storage independence/restoration and observed membership invalidation; API projection/validation; authorization failures; timeout/rate-limit backoff; cache/coalescing/transfer races; and worker sender restrictions/credential isolation. See [all 27 original coverage areas](test-coverage.md).

Browser tests launch a persistent Chromium profile with the actual production `dist/` folder loaded through `--load-extension`. They use actual Chrome extension storage, the production service worker, isolated content script, Shadow DOM UI, options page, and native form/contenteditable fixture handlers. The test page uses Trello URLs fulfilled with the deterministic HTML fixture. Since Playwright page routing does not intercept extension-worker fetches in this environment, the tests substitute **only the test worker’s global fetch** with deterministic Trello-shaped responses before creating the production API client. The production bundle is not modified. HTTP method, host, Authorization header, absence of query tokens, and minimal requested fields are asserted by the fixtures/unit tests.

Scenarios include zero/one/multiple guests; board-only versus assigned/mentioned/prior guests; current special mention audiences; Cancel and Escape preserving drafts; native click and Ctrl/Command+Enter continuation; ordinary Enter/empty comments; double clicks; deferred native form submission; independent persistent board/card preferences; restore-one/restore-all; guest removal/addition/card assignment; rapid navigation and pending requests; stale retained editors; API/permission/expired-authorization failure; disconnecting authorization; disabled/no-extension baseline; cross-tab preference updates; page refresh; and restarting Chromium with the same actual unpacked extension/profile.

Four new Settings scenarios cover the default Never expires selection, all four documented options, correct authorization URLs, storage after closing/reopening Settings, invalid/missing preference recovery, and preservation of existing credentials/verified status. Each choice is followed by a fresh blank-token Save & verify. The earlier 42 browser tests remain and pass.

All 46 browser tests complete without observed page or extension-worker console errors. Fixture submission counters verify one native submission per approved action in tested paths; no real Trello comment was posted. The production content-script and background-worker bundles are byte-for-byte identical to 1.0.2; the manifest differs only in version.

## Visual and accessibility verification

Screenshots were generated with animations disabled and visually inspected: [light desktop confirmation](screenshots/light-desktop-confirmation.png), [dark 390×844 confirmation](screenshots/dark-mobile-confirmation.png), [current light Settings](screenshots/settings-expiration-light.png), and [current dark mobile Settings](screenshots/settings-expiration-dark-mobile.png). Modal surfaces are opaque; text and controls fit without clipping. Settings screenshots have empty credential fields. The historical Settings screenshot is not distributed because its fixed-expiration instructions predate the expiration selector.

Automated checks verify a native dialog with accessible name and description references, initial focus on Cancel, full Tab/Shift+Tab wrap, focus restoration on Escape, preserved draft text, dark theme computed colors, and a dialog fitting the narrow viewport. Light/dark switching and standard desktop width also run. This is not a formal WCAG audit: screen-reader announcements, high-contrast mode, browser zoom, and every color combination have not been manually certified.

## Boundaries

- The current authenticated Trello test card was inspected and smoke-tested separately: membership/history/draft warnings, native Save and Command+Enter pre-post confirmation, Cancel/draft preservation, and card-close cleanup passed without posting. **Live Post Anyway posting and live historical-only involvement without assignment remain unverified.** See [the card fix report](card-warning-fix.md) for exact evidence and acceptance bounds.
- The browser restart test reloads the actual extension and preserves storage; Chrome’s extension-manager Reload button / `chrome.runtime.reload()` was not accepted as coverage. The latter disabled command-line-loaded extensions in this headless environment. Reload Trello tabs after manually reloading the extension.
- No new live Trello token was issued during expiration testing. Authorization pages/responses are mocked with fictional credentials. Edge was not separately tested. No extension-store submission or enterprise deployment was performed.
- Unsupported editors, unavailable/stale verification, and reused old editor nodes preserve native functionality rather than guaranteeing a pre-post confirmation. Historical mentions cover only visible supported resolved components matching verified identities. Membership detection is eventual.

See [limitations](limitations.md) and [troubleshooting](troubleshooting.md) for operational details.
