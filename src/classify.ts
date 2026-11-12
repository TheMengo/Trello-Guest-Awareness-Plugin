import type { Member, Snapshot, SpecialMention, Warning } from './types';

const sorted = (ids: string[]) => [...new Set(ids)].sort();
const names = (members: Member[]) => members.map(member => member.fullName || `@${member.username}`).join(', ');
const mentionNames = (members: Member[]) => members.map(member => member.fullName ? `${member.fullName} (@${member.username})` : `@${member.username}`).join(', ');

export interface RenderedMention {
  identifier: string;
  label: string;
  testId: string;
  mentionType?: string;
  memberId?: string;
}

/** Resolve observed Trello mention markup, never an arbitrary label or profile link. */
export function resolveRenderedMention(input: RenderedMention, members: Member[]): string | undefined {
  const identifier = input.identifier.toLowerCase();
  if (!/^[a-z0-9_]{1,128}$/.test(identifier)
    || input.testId.toLowerCase() !== `mention-${identifier}`
    || (input.mentionType !== undefined && input.mentionType !== '2')) return undefined;
  const matches = members.filter(member => member.id.toLowerCase() === identifier || member.username.toLowerCase() === identifier);
  if (matches.length !== 1) return undefined;
  const member = matches[0];
  if (!/^[a-f0-9]{24}$/i.test(member.id)
    || input.label.trim().toLowerCase() !== `@${member.username.toLowerCase()}`
    || (input.memberId !== undefined && input.memberId.toLowerCase() !== member.id.toLowerCase())) return undefined;
  return member.id;
}

/** Match complete Trello usernames conservatively, never names, URL/email fragments, or code. */
export function extractMentions(text: string, members: Member[]): { memberIds: string[]; specials: SpecialMention[] } {
  const prose = text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, ' ')
    .replace(/(`+)[\s\S]*?(?:\1|$)/g, ' ')
    .replace(/!?\[[^\]\n]*\]\([^\)\n]*\)/g, ' ')
    .replace(/!?\[[^\]\n]*\]\[[^\]\n]*\]/g, ' ')
    .replace(/(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|www\.)[^\s<>]+/gi, ' ')
    .replace(/(?:^|[\s(\[])(?:\.{0,2}\/)[^\s<>]+/g, ' ');
  const usernames = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const member of members) {
    const username = member.username.toLowerCase();
    if (usernames.has(username) && usernames.get(username) !== member.id) ambiguous.add(username);
    usernames.set(username, member.id);
  }
  const memberIds: string[] = [];
  const specials: SpecialMention[] = [];
  const pattern = /(^|[^\p{L}\p{M}\p{N}_@/\\])@([a-z0-9_]+)(?![\p{L}\p{M}\p{N}_-])/giu;
  for (const match of prose.matchAll(pattern)) {
    const username = match[2].toLowerCase();
    if (username === 'card' || username === 'board') specials.push(username);
    else if (usernames.has(username) && !ambiguous.has(username)) memberIds.push(usernames.get(username)!);
  }
  return { memberIds: sorted(memberIds), specials: sorted(specials) as SpecialMention[] };
}

/** Pure classification: guest means board member absent from this board's Workspace. */
export function classify(snapshot: Snapshot, draft = '', historicalMentionIds: string[] = [], verifiedDraftMentionIds: string[] = []): Warning {
  const { board, card } = snapshot;
  const workspace = new Set(board.workspaceMemberIds);
  const guests = board.members.filter(member => !workspace.has(member.id)).sort((a, b) => a.id.localeCompare(b.id));
  const cardMemberIds = new Set(card?.memberIds ?? []);
  const mentions = extractMentions(draft, board.members);
  const draftIds = new Set([...mentions.memberIds, ...verifiedDraftMentionIds]);
  const previousIds = new Set([...historicalMentionIds, ...(card?.historicalGuestIds ?? [])]);
  const cardGuests = guests.filter(member => cardMemberIds.has(member.id));
  const draftGuests = guests.filter(member => draftIds.has(member.id));
  const previousGuests = guests.filter(member => previousIds.has(member.id));
  const specials = card ? mentions.specials : [];
  const specific = Boolean(card && (cardGuests.length || draftGuests.length || previousGuests.length || specials.length));
  const scope = specific ? 'card' : 'board';
  const messages: string[] = [];
  if (guests.length) {
    messages.push(`This board has ${guests.length} ${guests.length === 1 ? 'guest' : 'guests'} outside its Workspace membership. Board guests can view cards, comments, and attachments on this board.`);
    if (cardGuests.length) messages.push(`Guest card ${cardGuests.length === 1 ? 'member' : 'members'}: ${names(cardGuests)}. They may receive notifications about new comments, depending on their notification preferences.`);
    if (draftGuests.length) messages.push(`Guest ${draftGuests.length === 1 ? 'mention' : 'mentions'} in this draft: ${names(draftGuests)}. This comment may directly notify ${draftGuests.length === 1 ? 'this guest' : 'these guests'}.`);
    if (previousGuests.length) messages.push(`Previously mentioned guests: ${mentionNames(previousGuests)}. This indicates prior involvement; it does not by itself mean they will receive notifications about future comments.`);
    if (specials.includes('card')) messages.push(cardGuests.length
      ? `@card may notify the members of this card, including ${cardGuests.length} ${cardGuests.length === 1 ? 'guest' : 'guests'}: ${names(cardGuests)}.`
      : '@card targets this card’s members. None of the current card members are board guests; other board guests still have access.');
    if (specials.includes('board')) messages.push(`@board may notify board members, including all ${guests.length} board ${guests.length === 1 ? 'guest' : 'guests'}: ${names(guests)}.`);
  }
  // Persist identities and signal categories, never the draft or a hash of its contents.
  const boardFingerprint = ['v1', board.workspaceId, sorted(guests.map(member => member.id))];
  const fingerprint = JSON.stringify(specific
    ? [...boardFingerprint, sorted(cardGuests.map(member => member.id)), sorted(draftGuests.map(member => member.id)), sorted(previousGuests.map(member => member.id)), specials]
    : boardFingerprint);
  return { boardId: board.id, guests, cardGuests, draftGuests, previousGuests, specials, specific, messages, fingerprint, scope, scopeId: specific ? card!.id : board.id };
}
