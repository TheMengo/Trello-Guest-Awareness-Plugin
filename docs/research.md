# Trello and Chrome integration research

Reviewed 27 October 2026. This records public documentation research; it is not a live Trello acceptance test.

## Membership and identity

Atlassian defines a guest as a board member who is not a member of that board's Workspace. Company domains, names, email addresses, paid status, and card membership do not determine guest status. See [What is a Workspace guest?](https://support.atlassian.com/trello/docs/board-guests/).

The extension resolves the current public `/b/{shortLink}` or `/c/{shortLink}` route through the REST API to stable Trello IDs. For a card, the API's `idBoard` relationship determines its board, including after a move. It requests board `id,idOrganization`, board member `id,username,fullName`, Workspace member IDs, and current card `id,idBoard,idMembers`. It does not request descriptions, attachments, comment actions, or email addresses. It validates complete shapes before classifying guests and projects responses to these fields before caching them. A missing Workspace, unreadable membership list, invalid payload, or API failure produces an explicit unable-to-verify state.

Documented read resources:

- [Boards](https://developer.atlassian.com/cloud/trello/rest/api-group-boards/): `GET /boards/{id}` and `GET /boards/{id}/members`.
- [Organizations (Workspaces)](https://developer.atlassian.com/cloud/trello/rest/api-group-organizations/): `GET /organizations/{id}/members`.
- [Cards](https://developer.atlassian.com/cloud/trello/rest/api-group-cards/): `GET /cards/{id}`, including `idMembers` and `idBoard`.

## Authorization and request limits

Trello still documents its key/user-token flow and an OAuth Authorization header. The extension uses that documented flow with `scope=read`, the selected expiration (`1hour`, `1day`, `30days`, or `never`; default `never`), and `response_type=token`; the employee explicitly copies their token into extension settings. An organization may distribute its public API key; no app secret is embedded. The key can be generated in the Trello Auth tab of a Power-Up in [Trello's developer administration](https://trello.com/apps/admin), without adding a Power-Up to an employee board. The extension's setup opens the authorization page and validates the saved credentials through `GET /members/me?fields=id`. The token is sent only in a header directly to `https://api.trello.com`, with cookies omitted, redirects disallowed, and no URL credentials. See [Authorizing with Trello's REST API](https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/).

`never` means no scheduled token expiration; Trello or the user can still revoke or invalidate it. The saved expiration preference affects newly issued tokens only. Existing tokens retain their original expiration and changing the preference does not invalidate them. Every employee must authorize a private individual token; tokens must not be shared.

Explicit Save & verify authorization checks always issue a fresh read (subject to 429 backoff), independently of membership caching. Membership requests are deduplicated across tabs in one worker; normal results last 60 seconds and explicit refresh respects a 30-second floor. The cache is bounded to 64 endpoint responses and dies with the service worker. Every request has an eight-second timeout. HTTP 429 produces a shared backoff of at least 60 seconds, respecting a longer Retry-After up to one hour. No immediate automatic retries occur. These are conservative client choices based on Trello's documented [rate limits](https://developer.atlassian.com/cloud/trello/guides/rest-api/rate-limits/).

## Access and notifications

Card membership, comment mentions, and guest access have different meanings. Card members start watching a card but can later unwatch it; membership is a reason to say a guest *may* be notified, not proof of delivery. See [Add a person to a card](https://support.atlassian.com/trello/docs/adding-a-member-to-a-card/).

Trello documents `@username` mentions and group mentions `@card` and `@board`. Draft usernames are matched to verified current board guests; names alone are not sufficient. The card warning explains the actual guest subset of each group audience. An older rendered mention is prior involvement; it does not predict future notifications. See [Comment on a card](https://support.atlassian.com/trello/docs/commenting-on-cards/).

No current public API guarantee for a stable, structured mention-to-member mapping in historical comment actions was established. Historical warnings therefore use only explicitly attributable mentions in currently rendered comment activity, when recognized. Unloaded activity and free text in older comments are not scanned through the API. The extension makes no claim that historical coverage is complete.

## Chrome integration and native submission limits

Cross-origin requests belong in the extension worker, which holds the API host permission; see [Cross-origin network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests). The content script sees membership snapshots and preference fingerprints, never the token. `chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'})` restricts credential reads to the worker and settings page; see [Chrome storage](https://developer.chrome.com/docs/extensions/reference/api/storage).

The public Trello documentation describes commenting behavior but provides no extension pre-submit hook, guaranteed DOM selector, or guarantee that synthetic browser events reproduce Trello's native React handlers. The integration must therefore use a deliberately narrow DOM adapter, preserve the editor, avoid private application state and request interception, and release unsupported submission paths unchanged. A realistic fixture can verify browser event ordering and single-use continuation, but cannot establish compatibility with an authenticated Trello rollout. Live acceptance on designated test cards remains necessary before broad internal rollout.

## Live DOM verification in 1.0.2

The authenticated test card was inspected directly. Its visible card root is `#overlay-contents[role="dialog"][aria-labelledby="card-back-name"]`; an old `.window` is hidden. Current comments use `[data-testid="comment-container"]` and rendered person chips whose `data-mention-id` is a username, such as the fictional replacement `guest_example`, rather than a stable ID. Matching component marker, person type, label, and exact verified username now resolve locally to a stable ID. The live comment editor is scoped by `[data-testid="card-back-comment-editor-container"]`, and its Save button is `[data-testid="card-back-comment-save-button"]` with no form. See [live validation](card-warning-fix.md) for the actual smoke test and its posting limits. No comment-action API request was added.
