# Card warning fix and live validation — 1.0.2

Live card/member identifiers and the personal installation path are redacted in this public report. `guest_example` is a fictional replacement username. Original evidence is retained privately and excluded from repository and distribution packages.

## Root cause verified on live Trello

The authenticated test card at `[redacted live card URL]` showed a working one-guest board indicator but no card indicator. Inspection established three DOM mismatches:

- The current card is `#overlay-contents[role="dialog"][aria-labelledby="card-back-name"]`. The old `.window` dialog still exists but has `display:none`, no client rectangles, and is unrelated to the current card. None of the old visible-root selectors matched the new dialog, so `cardRoot()` returned null and card rendering/interception could not run.
- A previous `@guest_example` is an actual Trello-rendered mention component. Its parent has `data-mention-id="guest_example"`; its child has `data-testid="mention-guest_example"`, `data-mention-type="2"`, and label `@guest_example`, inside `[data-testid="comment-container"]`. The value is a username, not a 24-character member ID. The old helper used different history containers and discarded anything that was not a stable ID.
- The current editable ProseMirror textbox is inside `[data-testid="card-back-comment-editor-container"]`; the old editor selectors missed that container. The existing Save selector was correct: `button[data-testid="card-back-comment-save-button"]`, type button, outside the editor wrapper, with no native form. Trello also puts actual placeholder text nodes inside its empty editor.

The legacy-only fixture did not reproduce these structures. A new fixture reproducing the inspected markup failed against the old build despite successful board verification, then passed after the fix.

## Complete detection path

1. `src/dom.ts` extracts the public `/c/{shortLink}` route; the eight-character live reference is valid.
2. `src/content.ts` sends only that reference through the existing snapshot message.
3. `src/background.ts` validates the request and uses the existing authenticated read-only client.
4. `src/api.ts` resolves the stable card ID with `GET /cards/{ref}?fields=id,idBoard,idMembers`, follows the authoritative card→board relationship, and validates board/Workspace membership data.
5. `src/classify.ts` identifies board guests as board member IDs absent from Workspace membership. Card guests are the intersection with `idMembers`. In the live test, the unchanged API/worker path correctly produced the guest-card-member warning after the DOM adapter could render it.
6. The content script resolves a historical rendered mention component to an exact, unique current board username or stable ID. The identifier, component marker, label, optional member ID, and person type must agree. Only its stable member ID goes to classification. No historical comment bodies are fetched, persisted, or sent to the worker.
7. The indicator mounts at the current card heading, independently of whether the comment editor is open. A known collapsed composer is recognized rather than reported as an unsupported editor. Opening it enables the existing Save/keyboard confirmation guard.

## Exact source changes

- `src/dom.ts`: inspected modern card/editor selectors; collapsed composer recognition; heading placement; exact rendered mention resolution in current history containers; code/link exclusions; qualified unresolved state; placeholder-aware draft reads using a cloned node. The original editor and draft are never rewritten by extension code.
- `src/classify.ts`: strict pure `resolveRenderedMention()`, verified draft-chip IDs, exact usernames in historical warning text, and conservative lexical exclusions for escaped mentions, code, links, email/URL fragments, similar usernames, and ambiguous identities.
- `src/content.ts`: passes verified current board identities to the DOM resolver; uses the resolved stable IDs; renders historical/card-member warnings in the modern dialog; reports unresolved components as unverified; recognizes the modern collapsed/open composer.
- `tests/classify.test.ts`: 7 added pure regressions.
- `tests/browser.test.mjs`, `tests/fixtures/modern-trello.html`: 8 additional browser scenarios using sanitized live-derived structure.
- Patch metadata, installation text, documentation, and production/distribution builds updated to 1.0.2.

`src/api.ts`, `src/background.ts`, authorization, dismissal storage/keys, and permission configuration are unchanged in this patch. Native comment continuation, Cancel, single-dialog rules, and duplicate guards are retained. New historical evidence naturally changes the existing card-warning fingerprint; this is the intended existing dismissal invalidation rule, not a settings reset.

## Why no comment-actions API was added

The documented [card actions endpoint](https://developer.atlassian.com/cloud/trello/rest/api-group-cards/#api-cards-id-actions-get) permits read-only comment action retrieval. Its example contains comment text and an author/memberCreator entity; the [actions reference](https://developer.atlassian.com/cloud/trello/rest/api-group-actions/) does not establish a stable mentioned-user identity contract. An arbitrary exact username token in API text can be a code sample, quoted literal, or URL rather than an actual mention. The inspected rendered mention component provides stronger evidence and fixes this case without collecting comment bodies.

Only recognized rendered components are verified. Plain historical `@text` is ignored. Unknown or inconsistent person components show a qualified **Guest involvement from that mention is unverified** status without attributing them to a verified guest. Unloaded/paginated activity remains outside historical coverage. Old usernames that no longer resolve to a current identity are not guessed.

Historical wording explicitly says prior involvement does not itself mean future comment notifications. Card membership remains a stronger potential-notification signal. Current draft mentions say the comment may directly notify the guest. These agree with Trello’s documented [comment mention behavior](https://support.atlassian.com/trello/docs/commenting-on-cards/).

## Automated validation

```sh
npm test
npm run package
```

- Type checking passed.
- **78 unit tests passed**, 0 failed/skipped.
- **42 Chromium extension browser tests passed**, 0 failed/skipped.
- Production Manifest V3 build passed.
- The existing 34 browser scenarios remain; 8 modern scenarios cover assigned guests, previous unassigned guest mentions, current drafts, board-only access, internal/similar/plain/code/URL/malformed mentions, no-form Save, Cancel, Ctrl/Command+Enter, double-click single submission, and stale-card cleanup.
- Existing authorization, independent dismissals/restoration, refresh, cross-tab, theme, API failure, and restart tests still pass.

Recorded outcomes: the old build failed the modern DOM regression; the fixed build passed the targeted cases and full suite. Raw run logs are retained locally and excluded from public packages.

## Actual live verification performed

This was separate from the fixtures and used the existing authenticated Chrome session on the **designated test card**. No credentials were read or exported. The installed Desktop folder was located from the user’s instruction; its path-derived extension ID matched the installed extension. Its seven extension files were backed up locally and updated in place. The user clicked Reload, preserving the extension directory, ID, stored authorization, and dismissals.

Verified in the live page after reload:

- The original **This board has 1 guest** indicator remained.
- Exactly one card indicator appeared, showing the assigned guest and the previous `@guest_example` mention with the correct future-notification qualification.
- The current ProseMirror editor and no-form Save control were recognized after editor initialization; no unsupported-control warning remained.
- A minimal `@guest_example` test draft added the current-draft guest warning.
- Clicking native Save opened one extension confirmation **before posting**. The visible comment count remained five.
- Cancel preserved the exact test draft. Command+Enter also opened confirmation before posting; Cancel again preserved the draft.
- The temporary test draft was removed using native editor keyboard handling, restoring the originally empty draft and disabled Save button. The draft warning cleared while card membership/history warnings remained.
- Closing the card removed the card indicator and kept the board indicator. The browser opened another card during navigation without retaining the previous card warning. Returning directly to the designated card restored exactly one warning; the historical warning appeared as activity loaded.
- The test card still had its original **five comments** at the end. No comment was posted, no membership was changed, and no dismissal checkbox was selected.

Live screenshots are retained privately because they contain real account identities and card activity. They are excluded from the repository and distribution packages.

## Remaining live acceptance boundaries

- **Post Anyway and duplicate-post prevention were tested in the real Chromium fixture with native handlers, not by posting to the live company board.** No live posting was necessary or performed. A separately approved disposable-card test can verify Trello’s handling of the programmatic continuation and resulting exactly-one comment.
- The live card already had the guest assigned. Historical-mention-without-assignment is covered independently by pure tests and the modern browser fixture; live membership was left unchanged.
- Other live cards, locales/UI variants, unloaded history, and Edge have not all been accepted. Unsupported controls remain warning-only/fail-open as documented.

## Rebuild and reload

```sh
npm ci
npm run build
```

For local validation, install the test browser with `npx playwright install chromium`, then run `npm test`. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` only when selecting another compatible local Chromium executable.

The original personal installation path is `[redacted installation path]`; the live test used version **1.0.2**. Keep the existing loaded directory name/path to preserve its extension ID and storage. Future rebuilds require copying the new `dist/` contents into that directory, clicking Reload for Trello Guest Awareness at `chrome://extensions`, and refreshing Trello tabs. Do not remove/reinstall just to update it.

Nothing was pushed, published, or deployed. No permissions, comment-body transmission, API write requests, or backend were added.
