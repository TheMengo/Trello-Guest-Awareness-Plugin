import {resolveRenderedMention} from './classify';
import type {Member} from './types';

/** Current selectors were inspected on the live Trello test card; legacy adapters remain supported. */
export const BOARD_HEADER = '[data-testid="board-header"], .board-header';
export const CARD_ROOT = '#overlay-contents[role="dialog"][aria-labelledby="card-back-name"], [data-testid="card-detail-window"], [data-testid="card-back"], .window';
const MODERN_EDITOR = '[data-testid="card-back-comment-editor-container"] [contenteditable="true"][role="textbox"]';
export const EDITOR = `${MODERN_EDITOR}, [data-testid="card-comment-input"], .comment-box textarea, .comment-box [contenteditable="true"], [data-testid="card-back-new-comment"] [contenteditable="true"], [data-testid="card-back-comment-input-container"] [contenteditable="true"], [data-testid="card-comment-form"] [contenteditable="true"]`;
export const SAVE = '[data-testid="card-comment-save-button"], [data-testid="card-back-comment-save-button"], .js-add-comment';
const COMMENT_CONTAINER = 'form, .comment-box, [data-testid="card-comment-form"], [data-testid="card-back-new-comment"], [data-testid="card-back-comment-input-container"], [data-testid="card-back-comment-editor-container"]';
const HISTORY_CONTAINER = '[data-testid="comment-container"], [data-testid="card-comment"], .comment-container';
const CODE = 'pre, code, [data-node-type="codeBlock"], [data-prosemirror-node-name="codeBlock"]';
export type Editor = HTMLTextAreaElement | HTMLElement;
export interface RenderedMentions {memberIds:string[];unresolved:boolean}
export function route(pathname: string): {boardRef?:string;cardRef?:string} | null {
  const match = pathname.match(/^\/(b|c)\/([a-zA-Z0-9]{8}|[a-fA-F0-9]{24})(?:\/|$)/);
  return match ? {[match[1] === 'b' ? 'boardRef' : 'cardRef']:match[2]} : null;
}
export function visible(element: HTMLElement): boolean {
  return element.isConnected && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
}
export function cardRoot(): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>(CARD_ROOT)].find(visible) ?? null;
}
export function cardHeading(root: ParentNode): HTMLElement | null {
  return root.querySelector<HTMLElement>('#card-back-name, [data-testid="card-name"], h1, h2');
}
export function editorCollapsed(root: ParentNode): boolean {
  return [...root.querySelectorAll<HTMLElement>('[data-testid="card-back-new-comment-input-skeleton"]')].some(visible);
}
export function editors(root: ParentNode = document): Editor[] {
  return [...root.querySelectorAll<Editor>(EDITOR)].filter(e=>visible(e) && (e instanceof HTMLTextAreaElement || e.isContentEditable));
}
function editorText(editor: HTMLElement, proseOnly: boolean): string {
  // Never mutate the real editor: Trello renders its placeholder as an actual text node.
  const copy = editor.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('[data-testid="placeholder-test-id"], .ProseMirror-widget[aria-hidden="true"], .ProseMirror-separator').forEach(node=>node.remove());
  if(proseOnly)copy.querySelectorAll(`${CODE}, a[href]`).forEach(node=>node.remove());
  copy.querySelectorAll('br').forEach(node=>node.replaceWith('\n'));
  copy.querySelectorAll('p, div, li, pre').forEach(node=>node.append('\n'));
  return copy.textContent ?? '';
}
export function text(editor: Editor): string { return editor instanceof HTMLTextAreaElement ? editor.value : editorText(editor,false); }
export function draftText(editor: Editor): string { return editor instanceof HTMLTextAreaElement ? editor.value : editorText(editor,true); }
export function editorFor(target: Element): Editor | null {
  const exact = target.closest<Editor>(EDITOR);
  if(exact && (exact instanceof HTMLTextAreaElement || exact.isContentEditable)) return exact;
  const container = target.closest(COMMENT_CONTAINER);
  if(container){const available=editors(container);if(available.length===1)return available[0];}
  const root = cardRoot();
  const available = root ? editors(root) : [];
  return available.length === 1 ? available[0] : null;
}
export function saveFor(editor: Editor): HTMLElement | null {
  const container = editor.closest(COMMENT_CONTAINER);
  const roots: ParentNode[] = [...new Set([container, editor.closest('form'), cardRoot()].filter((node): node is HTMLElement => !!node))];
  for(const root of roots){
    const candidates = [...root.querySelectorAll<HTMLElement>(SAVE)].filter(visible);
    if(candidates.length === 1) return candidates[0];
    if(candidates.length > 1) return null;
  }
  return null;
}
function unsafeMention(node: HTMLElement, legacyLink=false): boolean {
  if(node.closest(CODE))return true;
  const link=node.closest('a[href]');
  return !!link&&!(legacyLink&&link===node&&node.classList.contains('atMention'));
}
/** Resolve only rendered mention components, never plain historical @text or author avatars. */
export function renderedMentions(root: ParentNode, members: Member[]): RenderedMentions {
  const ids=new Set<string>();let unresolved=false;
  for(const wrapper of root.querySelectorAll<HTMLElement>('[data-mention-id]')){
    if(!visible(wrapper)||unsafeMention(wrapper))continue;
    const marker=wrapper.matches('[data-testid^="mention-"]')?wrapper:wrapper.querySelector<HTMLElement>('[data-testid^="mention-"]');
    if(!marker||!visible(marker)||unsafeMention(marker))continue;
    // The person mention marker observed in current Trello has type 2.
    if(marker.dataset.mentionType!==undefined&&marker.dataset.mentionType!=='2')continue;
    const id=resolveRenderedMention({identifier:wrapper.dataset.mentionId??'',label:marker.textContent??'',testId:marker.dataset.testid??'',mentionType:marker.dataset.mentionType,memberId:wrapper.dataset.memberId},members);
    if(id)ids.add(id);else unresolved=true;
  }
  // Older Trello rendered explicit stable member IDs in .atMention components.
  for(const mention of root.querySelectorAll<HTMLElement>('.atMention[data-member-id], .atMention[data-mention-id]')){
    if(!visible(mention)||unsafeMention(mention,true))continue;
    const id=mention.dataset.memberId??mention.dataset.mentionId??'';
    if(/^[a-f0-9]{24}$/i.test(id)&&members.some(m=>m.id===id))ids.add(id);
  }
  return{memberIds:[...ids].sort(),unresolved};
}
export function previousMentions(root: ParentNode, members: Member[]): RenderedMentions {
  const ids=new Set<string>();let unresolved=false;
  for(const comment of root.querySelectorAll<HTMLElement>(HISTORY_CONTAINER)){
    if(!visible(comment)||comment.closest('[contenteditable="true"]'))continue;
    const result=renderedMentions(comment,members);
    result.memberIds.forEach(id=>ids.add(id));unresolved ||= result.unresolved;
  }
  return{memberIds:[...ids].sort(),unresolved};
}
