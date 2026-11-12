# Trello Guest Awareness

A standalone Manifest V3 Chrome extension that shows Workspace guest access on a Trello board, explains guest involvement on an open card, and adds one contextual confirmation before recognized comment submissions. It never posts through the Trello API or modifies permissions.

**Version 1.0.3** adds a saved authorization token expiration choice, defaulting to **Never expires**. Existing authorization verification, board/card warnings, and comment confirmations are preserved. See the [expiration release notes](docs/token-expiration.md), [test report](docs/test-report.md), and [limitations](docs/limitations.md).

The authorization fix in version **1.0.1** and exact reload/retest steps are documented in [authorization-fix.md](docs/authorization-fix.md).

## Install

1. Download or clone this repository and keep its `dist/` folder on your computer (or extract the distribution ZIP to a permanent folder).
2. Open `chrome://extensions` in Chrome, or `edge://extensions` in Edge.
3. Turn on **Developer mode**, choose **Load unpacked**, and select `dist/` — the folder containing `manifest.json`.
4. Click the extension’s toolbar icon to open Settings.
5. Obtain a Trello developer API key using the [official Trello instructions](https://developer.atlassian.com/cloud/trello/guides/rest-api/api-introduction/). The key identifies the application; do not enter an application secret or your account password.
6. Paste the key into Settings. Select **Authorization token expiration**: **1 hour**, **1 day**, **30 days**, or **Never expires** (default). The selection saves automatically in this browser. Choose **Open read-only authorization**; Trello requests only `read` access with your chosen expiration. Review and approve, copy the resulting token, and paste it into Settings.
7. Choose **Save & verify**. Authorization must belong to an account able to read both the board and the Workspace member list. Reload open Trello tabs after first installation or after reloading the extension.

Changing the dropdown affects only newly issued tokens. Existing tokens retain their original expiration and remain usable with **Save & verify**; leave the token input blank to reuse the saved token for the same API key. **Never expires** means no scheduled expiration, but Trello can still revoke or invalidate the token. You can revoke access at any time in [your Trello account settings](https://trello.com/my/account).

No API key or secret is embedded in this project. Read-only tokens are sensitive: never share them between employees or commit them to a repository. An administrator may distribute an organization-owned public API key separately; every employee authorizes their own token.

To update an existing installation, replace the files in the folder Chrome already loads, click **Reload** on this extension at `chrome://extensions`, reopen Settings, and refresh Trello tabs. Keep the same loaded folder to retain its extension identity and saved settings.

## Use

- A compact indicator below the board header reports guest count, access, and expandable guest names. A guest is a board member absent from that board’s Workspace membership. This says nothing about their employer or email domain.
- The card indicator distinguishes guest card members, exact guest `@username` mentions in the draft, supported explicit resolved mentions in visible earlier comments, and `@card` / `@board` audiences.
- **Cancel** and Escape preserve the draft. **Post Anyway** invokes Trello’s original Save control once. The extension never creates a new comment request itself.
- **Do not show again for this board** suppresses general confirmations on that board. A card warning has a separate **Do not show again for this card** choice. Stronger/new signals or observed guest membership changes re-enable the relevant confirmation. The small board indicator stays visible.
- Settings restores one dismissal or all dismissals. Its enabled switch turns awareness off without removing authorization.
- **Refresh** requests fresh membership information, with a 30-second cache floor. Visible tabs also refresh approximately every 60–90 seconds and after returning to a tab. Changes are not instantaneous.
- Unconfigured, unauthorized, unavailable, malformed, and unverifiable membership states explicitly say **Unable to verify guest status**. Native comments remain usable in those states.

## Development

Use Node.js 22 or newer and npm. No backend, analytics, remote executable code, or runtime framework is used.

```sh
npm ci
npx playwright install chromium
npm run typecheck
npm run test:unit
npm run build
npm run test:browser
npm run package
```

`npm test` runs type checking, unit tests, the production build, and browser tests. Browser tests need a platform that can launch Chromium with unpacked extensions. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` optionally specifies a compatible unbranded Chromium executable. Tests mock all Trello pages/API calls; they neither use account credentials nor post to Trello. Browser test profiles are temporary.

`npm run build` creates `dist/`. `npm run package` creates `release/trello-guest-awareness-1.0.3.zip` (unpacked-extension contents at ZIP root), a source ZIP, and SHA-256 checksums. Do not select a ZIP in Load unpacked: extract it first. Packaging includes reviewed documentation and synthetic screenshots; private live-board evidence, raw test logs, browser profiles, and old release archives are excluded.

## Architecture and classification

`src/api.ts` uses fixed documented GET routes to resolve the card’s stable board ID, board Workspace ID, board members, Workspace members, and current card members. The card→board relationship from Trello takes precedence over stale URL context. A validated, complete snapshot is required for guest classification. No Workspace or an ambiguous empty Workspace list is treated as unverifiable.

`src/classify.ts` is pure and independently tested. Guests are the set difference `board member IDs − Workspace member IDs`. Exact username matches resolve against those identities; visible names alone are insufficient. Code, URL, and email-like text is ignored for draft mention detection. Previous mentions require a supported rendered component whose stable member ID or exact username resolves against current verified membership. They never imply automatic future notifications.

`src/background.ts` owns authorized requests and trusted-only local credential storage. It deduplicates concurrent requests across tabs, bounds an in-memory cache, times out requests, and respects rate-limit backoff. Its message interface accepts validated references and essential preferences, never comment text.

`src/content.ts` observes DOM and route changes without patching Trello’s JavaScript, network, or internal state. Shadow DOM isolates the indicators and an accessible native modal. A captured recognized Save click, native form submission, or Ctrl/Command+Enter is paused only when verified guests exist and the warning has not been dismissed. One approval reuses the original control; draft/context checks cancel stale attempts. Unknown editors and verification failures leave native behavior intact and are documented limitations.

`src/preferences.ts` stores separate board/card dismissal entries using stable IDs. Relevant identity/signal fingerprints exclude comment content. Minimal membership digests invalidate dismissals on observed changes, including a transition to no guests. `src/options.ts` provides authorization, enable/disable, and restoration. `src/authorization.ts` validates token expiration choices and builds the documented read-only authorization URL without saved tokens.

## Files

- `src/`: TypeScript source, including isolated UI and narrow DOM adapter.
- `public/`: local settings page and styles.
- `scripts/`: build, test bundling, and distribution packaging.
- `tests/`: pure/unit tests, worker security tests, actual MV3 browser tests, native-comment fixture.
- `dist/`: installable production extension.
- `docs/research.md`: official API/Chrome references and research decisions.
- `docs/privacy.md`, `docs/troubleshooting.md`, `docs/limitations.md`, `docs/test-report.md`.

No backend, additional browser permissions, or runtime dependencies are required. This repository is an unpacked extension distribution; it is not an extension-store listing.
