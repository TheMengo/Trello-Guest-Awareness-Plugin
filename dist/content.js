"use strict";
(() => {
  // src/classify.ts
  var sorted = (ids) => [...new Set(ids)].sort();
  var names = (members) => members.map((member) => member.fullName || `@${member.username}`).join(", ");
  var mentionNames = (members) => members.map((member) => member.fullName ? `${member.fullName} (@${member.username})` : `@${member.username}`).join(", ");
  function resolveRenderedMention(input2, members) {
    const identifier = input2.identifier.toLowerCase();
    if (!/^[a-z0-9_]{1,128}$/.test(identifier) || input2.testId.toLowerCase() !== `mention-${identifier}` || input2.mentionType !== void 0 && input2.mentionType !== "2") return void 0;
    const matches = members.filter((member2) => member2.id.toLowerCase() === identifier || member2.username.toLowerCase() === identifier);
    if (matches.length !== 1) return void 0;
    const member = matches[0];
    if (!/^[a-f0-9]{24}$/i.test(member.id) || input2.label.trim().toLowerCase() !== `@${member.username.toLowerCase()}` || input2.memberId !== void 0 && input2.memberId.toLowerCase() !== member.id.toLowerCase()) return void 0;
    return member.id;
  }
  function extractMentions(text2, members) {
    const prose = text2.replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/~~~[\s\S]*?(?:~~~|$)/g, " ").replace(/(`+)[\s\S]*?(?:\1|$)/g, " ").replace(/!?\[[^\]\n]*\]\([^\)\n]*\)/g, " ").replace(/!?\[[^\]\n]*\]\[[^\]\n]*\]/g, " ").replace(/(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|www\.)[^\s<>]+/gi, " ").replace(/(?:^|[\s(\[])(?:\.{0,2}\/)[^\s<>]+/g, " ");
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
  function classify(snapshot2, draft = "", historicalMentionIds = [], verifiedDraftMentionIds = []) {
    const { board, card } = snapshot2;
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
  var reconciliation = Promise.resolve();

  // src/dom.ts
  var BOARD_HEADER = '[data-testid="board-header"], .board-header';
  var CARD_ROOT = '#overlay-contents[role="dialog"][aria-labelledby="card-back-name"], [data-testid="card-detail-window"], [data-testid="card-back"], .window';
  var MODERN_EDITOR = '[data-testid="card-back-comment-editor-container"] [contenteditable="true"][role="textbox"]';
  var EDITOR = `${MODERN_EDITOR}, [data-testid="card-comment-input"], .comment-box textarea, .comment-box [contenteditable="true"], [data-testid="card-back-new-comment"] [contenteditable="true"], [data-testid="card-back-comment-input-container"] [contenteditable="true"], [data-testid="card-comment-form"] [contenteditable="true"]`;
  var SAVE = '[data-testid="card-comment-save-button"], [data-testid="card-back-comment-save-button"], .js-add-comment';
  var COMMENT_CONTAINER = 'form, .comment-box, [data-testid="card-comment-form"], [data-testid="card-back-new-comment"], [data-testid="card-back-comment-input-container"], [data-testid="card-back-comment-editor-container"]';
  var HISTORY_CONTAINER = '[data-testid="comment-container"], [data-testid="card-comment"], .comment-container';
  var CODE = 'pre, code, [data-node-type="codeBlock"], [data-prosemirror-node-name="codeBlock"]';
  function route(pathname) {
    const match = pathname.match(/^\/(b|c)\/([a-zA-Z0-9]{8}|[a-fA-F0-9]{24})(?:\/|$)/);
    return match ? { [match[1] === "b" ? "boardRef" : "cardRef"]: match[2] } : null;
  }
  function visible(element2) {
    return element2.isConnected && element2.getClientRects().length > 0 && getComputedStyle(element2).visibility !== "hidden";
  }
  function cardRoot() {
    return [...document.querySelectorAll(CARD_ROOT)].find(visible) ?? null;
  }
  function cardHeading(root) {
    return root.querySelector('#card-back-name, [data-testid="card-name"], h1, h2');
  }
  function editorCollapsed(root) {
    return [...root.querySelectorAll('[data-testid="card-back-new-comment-input-skeleton"]')].some(visible);
  }
  function editors(root = document) {
    return [...root.querySelectorAll(EDITOR)].filter((e) => visible(e) && (e instanceof HTMLTextAreaElement || e.isContentEditable));
  }
  function editorText(editor, proseOnly) {
    const copy = editor.cloneNode(true);
    copy.querySelectorAll('[data-testid="placeholder-test-id"], .ProseMirror-widget[aria-hidden="true"], .ProseMirror-separator').forEach((node) => node.remove());
    if (proseOnly) copy.querySelectorAll(`${CODE}, a[href]`).forEach((node) => node.remove());
    copy.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
    copy.querySelectorAll("p, div, li, pre").forEach((node) => node.append("\n"));
    return copy.textContent ?? "";
  }
  function text(editor) {
    return editor instanceof HTMLTextAreaElement ? editor.value : editorText(editor, false);
  }
  function draftText(editor) {
    return editor instanceof HTMLTextAreaElement ? editor.value : editorText(editor, true);
  }
  function editorFor(target) {
    const exact = target.closest(EDITOR);
    if (exact && (exact instanceof HTMLTextAreaElement || exact.isContentEditable)) return exact;
    const container = target.closest(COMMENT_CONTAINER);
    if (container) {
      const available2 = editors(container);
      if (available2.length === 1) return available2[0];
    }
    const root = cardRoot();
    const available = root ? editors(root) : [];
    return available.length === 1 ? available[0] : null;
  }
  function saveFor(editor) {
    const container = editor.closest(COMMENT_CONTAINER);
    const roots = [...new Set([container, editor.closest("form"), cardRoot()].filter((node) => !!node))];
    for (const root of roots) {
      const candidates = [...root.querySelectorAll(SAVE)].filter(visible);
      if (candidates.length === 1) return candidates[0];
      if (candidates.length > 1) return null;
    }
    return null;
  }
  function unsafeMention(node, legacyLink = false) {
    if (node.closest(CODE)) return true;
    const link = node.closest("a[href]");
    return !!link && !(legacyLink && link === node && node.classList.contains("atMention"));
  }
  function renderedMentions(root, members) {
    const ids = /* @__PURE__ */ new Set();
    let unresolved = false;
    for (const wrapper of root.querySelectorAll("[data-mention-id]")) {
      if (!visible(wrapper) || unsafeMention(wrapper)) continue;
      const marker = wrapper.matches('[data-testid^="mention-"]') ? wrapper : wrapper.querySelector('[data-testid^="mention-"]');
      if (!marker || !visible(marker) || unsafeMention(marker)) continue;
      if (marker.dataset.mentionType !== void 0 && marker.dataset.mentionType !== "2") continue;
      const id = resolveRenderedMention({ identifier: wrapper.dataset.mentionId ?? "", label: marker.textContent ?? "", testId: marker.dataset.testid ?? "", mentionType: marker.dataset.mentionType, memberId: wrapper.dataset.memberId }, members);
      if (id) ids.add(id);
      else unresolved = true;
    }
    for (const mention of root.querySelectorAll(".atMention[data-member-id], .atMention[data-mention-id]")) {
      if (!visible(mention) || unsafeMention(mention, true)) continue;
      const id = mention.dataset.memberId ?? mention.dataset.mentionId ?? "";
      if (/^[a-f0-9]{24}$/i.test(id) && members.some((m) => m.id === id)) ids.add(id);
    }
    return { memberIds: [...ids].sort(), unresolved };
  }
  function previousMentions(root, members) {
    const ids = /* @__PURE__ */ new Set();
    let unresolved = false;
    for (const comment of root.querySelectorAll(HISTORY_CONTAINER)) {
      if (!visible(comment) || comment.closest('[contenteditable="true"]')) continue;
      const result = renderedMentions(comment, members);
      result.memberIds.forEach((id) => ids.add(id));
      unresolved ||= result.unresolved;
    }
    return { memberIds: [...ids].sort(), unresolved };
  }

  // src/ui.ts
  var css = `
:host{--bg:#fff7d6;--ink:#423500;--border:#e9bf44;--surface:#fff;--body:#172b4d;--muted:#44546f;--accent:#0c66e4;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--body);color-scheme:light dark;display:block;box-sizing:border-box}
@media(prefers-color-scheme:dark){:host{--bg:#332e1b;--ink:#f5d47d;--border:#a58b43;--surface:#22272b;--body:#dee4ea;--muted:#b6c2cf;--accent:#579dff}}
:host([data-theme=light]){--bg:#fff7d6;--ink:#423500;--border:#e9bf44;--surface:#fff;--body:#172b4d;--muted:#44546f;--accent:#0c66e4}
:host([data-theme=dark]){--bg:#332e1b;--ink:#f5d47d;--border:#a58b43;--surface:#22272b;--body:#dee4ea;--muted:#b6c2cf;--accent:#579dff}
*{box-sizing:border-box}button,a{font:inherit}button{cursor:pointer;border:1px solid transparent;border-radius:5px;padding:6px 10px;background:transparent;color:inherit;font-weight:600}button:hover{background:#8882}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid var(--accent);outline-offset:3px}button:disabled{cursor:default;opacity:.6}a{color:var(--accent)}p{margin:0 0 8px}p:last-child{margin:0}.indicator{border:1px solid var(--border);border-radius:7px;background:var(--bg);color:var(--ink);padding:8px 12px;margin:6px 0;max-width:100%;overflow-wrap:anywhere}.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.row strong{flex:1;min-width:160px}.details{margin-top:6px}summary{cursor:pointer}ul{padding-left:20px;margin:6px 0}.subtle{color:var(--muted);font-size:12px}.warning-detail{margin-top:5px}dialog{padding:0;border:1px solid var(--border);border-radius:12px;background:var(--surface);color:var(--body);width:min(480px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:auto;box-shadow:0 16px 56px #0005}dialog::backdrop{background:#091e4277}header{padding:22px 24px 12px;background:var(--bg);color:var(--ink);border-bottom:1px solid var(--border)}h2{font-size:19px;line-height:1.3;margin:0 0 5px}.content{padding:20px 24px}.content p{margin-bottom:12px}label{display:flex;gap:10px;align-items:flex-start;margin-top:18px}input{accent-color:var(--accent);width:17px;height:17px;flex-shrink:0;margin:2px 0}footer{display:flex;justify-content:flex-end;gap:8px;padding:0 24px 22px}.primary{background:#0c66e4;color:#fff}.primary:hover{background:#0055cc}.secondary{background:#8882}.error{color:#b42318} @media(prefers-reduced-motion:no-preference){dialog[open]{animation:appear .12s ease-out}@keyframes appear{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}}
`;
  function element(tag, content, className) {
    const node = document.createElement(tag);
    if (content !== void 0) node.textContent = content;
    if (className) node.className = className;
    return node;
  }
  function host(id) {
    const h = element("div");
    h.id = id;
    h.dataset.tga = "";
    const theme = document.documentElement.dataset.colorMode ?? document.documentElement.dataset.theme;
    if (theme?.includes("dark")) h.dataset.theme = "dark";
    else if (theme?.includes("light")) h.dataset.theme = "light";
    const root = h.attachShadow({ mode: "open" });
    root.append(element("style", css));
    return { host: h, root };
  }
  function button(label, action, className) {
    const b = element("button", label, className);
    b.type = "button";
    b.addEventListener("click", action);
    return b;
  }

  // src/content.ts
  var prefs = { enabled: true, dismissals: {} };
  var snapshot;
  var error = "Unable to verify guest status. Checking Trello authorization\u2026";
  var contextKey = "";
  var generation = 0;
  var lastFetch = 0;
  var pending = false;
  var replaying = false;
  var dialogHost;
  var closeDialog;
  var guard;
  var approvedSubmit;
  var knownEditor;
  var retiredEditors = /* @__PURE__ */ new WeakSet();
  var renderTimer;
  var retired = false;
  var events = new AbortController();
  var prefRequest = 0;
  async function rpc(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch {
      return { ok: false, error: "Unable to verify guest status. Reload this Trello tab after reloading the extension." };
    }
  }
  function openSettings() {
    void rpc({ type: "open-settings" });
  }
  async function preferences() {
    const version = ++prefRequest;
    const result = await rpc({ type: "get-preferences" });
    if (version !== prefRequest) return;
    if (result?.ok) {
      prefs = { enabled: result.enabled, dismissals: result.dismissals };
    }
  }
  function sameContext() {
    return JSON.stringify(route(location.pathname)) === contextKey;
  }
  function routeChanged() {
    const next = JSON.stringify(route(location.pathname));
    if (next !== contextKey) {
      if (knownEditor && route(location.pathname)?.cardRef) retiredEditors.add(knownEditor);
      contextKey = next;
      generation++;
      snapshot = void 0;
      lastFetch = 0;
      pending = false;
      guard = void 0;
      approvedSubmit = void 0;
      closeDialog?.(false);
      error = "Unable to verify guest status. Checking board membership\u2026";
      render();
      void refresh();
    }
  }
  async function refresh(force = false) {
    const ref = route(location.pathname);
    if (!ref || !prefs.enabled || pending || retired) return;
    pending = true;
    const version = generation;
    lastFetch = Date.now();
    const result = await rpc({ type: "snapshot", ...ref, force });
    if (!sameContext()) {
      routeChanged();
      return;
    }
    if (version !== generation) return;
    pending = false;
    if (result?.ok) {
      snapshot = result.snapshot;
      error = "";
    } else {
      snapshot = void 0;
      error = result?.error ?? "Unable to verify guest status.";
      closeDialog?.();
    }
    await preferences();
    if (!sameContext()) {
      routeChanged();
      return;
    }
    if (version === generation) {
      if (closeDialog) closeDialog();
      render();
    }
  }
  function historical() {
    const root = cardRoot();
    return root && snapshot ? previousMentions(root, snapshot.board.members) : { memberIds: [], unresolved: false };
  }
  function warning(editor) {
    if (!snapshot) return void 0;
    const history = historical();
    return classify(snapshot, editor ? draftText(editor) : "", history.memberIds, editor ? renderedMentions(editor, snapshot.board.members).memberIds : []);
  }
  function mountIndicator(id, anchor, title, messages, guests) {
    document.getElementById(id)?.remove();
    if (!anchor) return;
    const ui = host(id);
    const panel = element("div", void 0, "indicator");
    panel.setAttribute("role", "status");
    const row = element("div", void 0, "row");
    row.append(element("strong", title));
    if (id === "tga-board-indicator") row.append(button("Refresh", () => {
      void refresh(true);
    }), button("Settings", openSettings));
    panel.append(row);
    for (const message of messages) panel.append(element("p", message, "warning-detail"));
    if (guests?.length) {
      const details = element("details", void 0, "details");
      details.append(element("summary", "Guest names"));
      const list = element("ul");
      guests.forEach((name) => list.append(element("li", name)));
      details.append(list);
      panel.append(details);
    }
    ui.root.append(panel);
    anchor.insertAdjacentElement("afterend", ui.host);
  }
  var renderSignature = "";
  function render() {
    if (retired) return;
    if (!sameContext()) {
      routeChanged();
      return;
    }
    const ref = route(location.pathname);
    const header = document.querySelector(BOARD_HEADER);
    const root = cardRoot();
    const first = root ? editors(root)[0] : void 0;
    const staleEditor = !!first && retiredEditors.has(first);
    const w = warning(staleEditor ? void 0 : first);
    const adapterUnsupported = !!(ref?.cardRef && root && (!first && !editorCollapsed(root) || staleEditor || first && !saveFor(first)));
    const unresolvedHistory = historical().unresolved;
    knownEditor = first;
    const signature = JSON.stringify({ contextKey, prefs: prefs.enabled, error, w, adapterUnsupported, unresolvedHistory, theme: document.documentElement.dataset.colorMode ?? document.documentElement.dataset.theme, header: !!header, root: !!root });
    const wantsBoard = !!(ref && prefs.enabled && (error || w?.guests.length));
    const wantsCard = !!(ref?.cardRef && root && prefs.enabled && w?.guests.length && (w.specific || adapterUnsupported || unresolvedHistory));
    const boardMissing = wantsBoard && !!header && !document.getElementById("tga-board-indicator");
    const cardMissing = wantsCard && !document.getElementById("tga-card-indicator");
    if (signature === renderSignature && !boardMissing && !cardMissing) return;
    renderSignature = signature;
    document.getElementById("tga-board-indicator")?.remove();
    document.getElementById("tga-card-indicator")?.remove();
    if (!ref || !prefs.enabled) return;
    const boardAnchor = header ?? (ref.cardRef ? (root ? cardHeading(root) : void 0) ?? void 0 : void 0);
    if (error) {
      mountIndicator("tga-board-indicator", boardAnchor, "Unable to verify guest status", [error]);
      return;
    }
    if (!w?.guests.length) return;
    mountIndicator("tga-board-indicator", boardAnchor, `This board has ${w.guests.length} ${w.guests.length === 1 ? "guest" : "guests"}.`, ["Guests can view cards, comments, and attachments on this board. A guest is outside this board\u2019s Trello Workspace membership."], w.guests.map((m) => m.fullName || "@" + m.username));
    if (ref.cardRef && root && (w.specific || adapterUnsupported || unresolvedHistory)) {
      const anchor = cardHeading(root) ?? first?.closest('form, .comment-box, [data-testid="card-comment-form"], [data-testid="card-back-new-comment"], [data-testid="card-back-comment-editor-container"]');
      const messages = staleEditor ? [] : w.messages.slice(1);
      if (unresolvedHistory) messages.push("A rendered mention could not be matched to a verified board member. Guest involvement from that mention is unverified.");
      if (adapterUnsupported) messages.push("Comment controls are not recognized. Pre-post confirmation is unavailable in this editor; review guest access before using Trello\u2019s controls.");
      mountIndicator("tga-card-indicator", anchor ?? void 0, "Guest awareness on this card", messages);
    }
  }
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = void 0;
      routeChanged();
      render();
    }, 80);
  }
  function stop(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  function intercept(event, attempt) {
    if (!prefs.enabled || retired) return;
    if (event.type === "submit" && approvedSubmit && approvedSubmit.editor === attempt.editor && approvedSubmit.form === attempt.form && approvedSubmit.generation === generation && Date.now() < approvedSubmit.until && text(attempt.editor) === approvedSubmit.draft) {
      approvedSubmit = void 0;
      return;
    }
    if (replaying && event.type !== "submit") return;
    if (!sameContext()) {
      routeChanged();
      return;
    }
    if (!route(location.pathname)?.cardRef || retiredEditors.has(attempt.editor) || !visible(attempt.editor) || !cardRoot()?.contains(attempt.editor)) return;
    const raw = text(attempt.editor);
    if (!raw.trim()) return;
    if (guard?.editor === attempt.editor && guard.draft === raw && Date.now() < guard.until) {
      stop(event);
      return;
    }
    if (dialogHost) {
      stop(event);
      return;
    }
    if (!snapshot || Date.now() - snapshot.fetchedAt > 12e4) {
      void refresh(true);
      return;
    }
    const w = warning(attempt.editor);
    if (!w?.guests.length) return;
    if (prefs.dismissals[dismissalKey(w.scope, w.scopeId)] === w.fingerprint) return;
    stop(event);
    confirm(w, attempt, raw);
  }
  function confirm(w, attempt, rawDraft) {
    const currentGeneration = generation;
    const ui = host("tga-confirmation");
    dialogHost = ui.host;
    const dialog = element("dialog");
    dialog.setAttribute("aria-labelledby", "tga-title");
    dialog.setAttribute("aria-describedby", "tga-description");
    const header = element("header");
    header.append(element("h2", "Workspace Guest Warning"));
    header.querySelector("h2").id = "tga-title";
    header.append(element("p", w.specific ? "Guest involvement on this card" : "Guests have access to this board"));
    const content = element("div", void 0, "content");
    const description = element("div");
    description.id = "tga-description";
    description.append(element("p", `This board has ${w.guests.length} Workspace ${w.guests.length === 1 ? "guest" : "guests"} who can view your comment.`));
    w.messages.slice(1).forEach((message) => description.append(element("p", message)));
    description.append(element("p", "Please review your comment before posting."));
    content.append(description);
    const label = element("label");
    const checkbox = element("input");
    checkbox.type = "checkbox";
    label.append(checkbox, element("span", `Do not show again for this ${w.scope}`));
    content.append(label);
    const status = element("p", "", "subtle");
    status.setAttribute("role", "status");
    content.append(status);
    const footer = element("footer");
    let accepted = false;
    const close = (restore = true) => {
      if (dialog.open) dialog.close();
      ui.host.remove();
      dialogHost = void 0;
      closeDialog = void 0;
      if (restore && attempt.editor.isConnected) attempt.editor.focus();
    };
    closeDialog = close;
    const cancel = button("Cancel", () => close(), "secondary");
    const proceed = button("Post Anyway", () => {
      if (accepted) return;
      accepted = true;
      proceed.disabled = true;
      cancel.disabled = true;
      if (currentGeneration !== generation || !sameContext() || !visible(attempt.editor) || !cardRoot()?.contains(attempt.editor) || attempt.save && !visible(attempt.save) || text(attempt.editor) !== rawDraft || !prefs.enabled) {
        close();
        return;
      }
      const current = warning(attempt.editor);
      if (!current || current.fingerprint !== w.fingerprint) {
        close();
        return;
      }
      if (checkbox.checked) {
        prefs.dismissals[dismissalKey(w.scope, w.scopeId)] = w.fingerprint;
        void rpc({ type: "dismiss", scope: w.scope, scopeId: w.scopeId, boardId: snapshot.board.id, fingerprint: w.fingerprint }).then((result) => {
          if (!result?.ok) {
            delete prefs.dismissals[dismissalKey(w.scope, w.scopeId)];
          }
        });
      }
      close(false);
      guard = { editor: attempt.editor, draft: rawDraft, until: Date.now() + 1200 };
      approvedSubmit = attempt.form ? { editor: attempt.editor, form: attempt.form, draft: rawDraft, generation, until: Date.now() + 1200 } : void 0;
      const thisGuard = guard;
      setTimeout(() => {
        if (guard === thisGuard) guard = void 0;
        if (approvedSubmit && Date.now() >= approvedSubmit.until) approvedSubmit = void 0;
      }, 1250);
      replaying = true;
      try {
        if (attempt.save?.isConnected && !attempt.save.disabled) attempt.save.click();
        else if (attempt.form?.isConnected) attempt.form.requestSubmit(attempt.submitter instanceof HTMLButtonElement || attempt.submitter instanceof HTMLInputElement ? attempt.submitter : void 0);
      } catch {
        guard = void 0;
        approvedSubmit = void 0;
      } finally {
        replaying = false;
        if (attempt.editor.isConnected) attempt.editor.focus();
      }
    }, "primary");
    footer.append(cancel, proceed);
    dialog.append(header, content, footer);
    ui.root.append(dialog);
    (cardRoot() ?? document.body).append(ui.host);
    for (const eventType of ["click", "pointerdown", "mousedown", "keydown", "keyup"]) ui.root.addEventListener(eventType, (event) => event.stopPropagation());
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      close();
    });
    dialog.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const focusable = [checkbox, cancel, proceed].filter((e) => !e.disabled);
      if (event.shiftKey && ui.root.activeElement === focusable[0]) {
        event.preventDefault();
        focusable.at(-1).focus();
      } else if (!event.shiftKey && ui.root.activeElement === focusable.at(-1)) {
        event.preventDefault();
        focusable[0].focus();
      }
    });
    dialog.showModal();
    cancel.focus();
  }
  function click(event) {
    if (!(event.target instanceof Element) || replaying) return;
    const save = event.target.closest(SAVE);
    if (!save || !visible(save) || save.disabled) return;
    const editor = editorFor(save);
    if (editor) intercept(event, { editor, save, form: save.closest("form"), submitter: save });
  }
  function keyboard(event) {
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.isComposing || !(event.target instanceof Element)) return;
    const editor = editorFor(event.target);
    if (!editor || !(event.target === editor || editor.contains(event.target))) return;
    const save = saveFor(editor);
    if (!save || save.disabled) return;
    intercept(event, { editor, save, form: editor.closest("form"), submitter: save });
  }
  function submit(event) {
    if (!(event.target instanceof HTMLFormElement)) return;
    const editor = editors(event.target)[0];
    if (!editor) return;
    intercept(event, { editor, save: saveFor(editor), form: event.target, submitter: event.submitter });
  }
  function input() {
    if (guard && text(guard.editor) !== guard.draft) guard = void 0;
    scheduleRender();
  }
  function retire() {
    retired = true;
    events.abort();
    chrome.runtime.onMessage.removeListener(onPreferencesChanged);
    closeDialog?.(false);
    observer.disconnect();
    clearInterval(routeClock);
    clearInterval(refreshClock);
    if (renderTimer) clearTimeout(renderTimer);
    document.removeEventListener("click", click, true);
    document.removeEventListener("keydown", keyboard, true);
    document.removeEventListener("submit", submit, true);
    document.removeEventListener("input", input, true);
    document.getElementById("tga-board-indicator")?.remove();
    document.getElementById("tga-card-indicator")?.remove();
  }
  document.dispatchEvent(new CustomEvent("tga-retire"));
  document.addEventListener("tga-retire", retire, { once: true, signal: events.signal });
  document.addEventListener("click", click, { capture: true, signal: events.signal });
  document.addEventListener("keydown", keyboard, { capture: true, signal: events.signal });
  document.addEventListener("submit", submit, { capture: true, signal: events.signal });
  document.addEventListener("input", input, { capture: true, signal: events.signal });
  window.addEventListener("popstate", routeChanged, { signal: events.signal });
  window.addEventListener("hashchange", routeChanged, { signal: events.signal });
  window.addEventListener("focus", () => {
    if (Date.now() - lastFetch > 3e4) void refresh(true);
  }, { signal: events.signal });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - lastFetch > 3e4) void refresh(true);
  }, { signal: events.signal });
  var observer = new MutationObserver((records) => {
    if (records.some((record) => !(record.target instanceof Element) || !record.target.closest("[data-tga]"))) scheduleRender();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-color-mode", "data-theme"] });
  var routeClock = setInterval(routeChanged, 500);
  var refreshClock = setInterval(() => {
    if (!document.hidden && Date.now() - lastFetch >= 6e4) void refresh();
  }, 3e4);
  function onPreferencesChanged(message) {
    if (message?.type === "preferences-changed") {
      if (message.credentialsChanged) {
        snapshot = void 0;
        generation++;
        pending = false;
        closeDialog?.();
        error = "Unable to verify guest status. Authorization changed; checking membership\u2026";
        render();
      }
      void preferences().then(() => {
        if (retired) return;
        if (!prefs.enabled) {
          closeDialog?.();
          render();
        } else {
          render();
          void refresh(true);
        }
      });
    }
  }
  chrome.runtime.onMessage.addListener(onPreferencesChanged);
  void preferences().then(() => {
    routeChanged();
    render();
  });
})();
