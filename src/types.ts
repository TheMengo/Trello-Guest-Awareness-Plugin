export interface Member {
  id: string;
  username: string;
  fullName: string;
}

export interface Board {
  id: string;
  workspaceId: string;
  members: Member[];
  workspaceMemberIds: string[];
}

export interface Card {
  id: string;
  boardId: string;
  memberIds: string[];
  historicalGuestIds?: string[];
}

export interface Snapshot {
  board: Board;
  card?: Card;
  fetchedAt: number;
  historyAvailable?: boolean;
}

export type WarningScope = 'board' | 'card';
export type SpecialMention = 'card' | 'board';

export interface Warning {
  boardId: string;
  guests: Member[];
  cardGuests: Member[];
  draftGuests: Member[];
  previousGuests: Member[];
  specials: SpecialMention[];
  specific: boolean;
  messages: string[];
  fingerprint: string;
  scope: WarningScope;
  scopeId: string;
}

export interface Dismissal {
  key: string;
  scope: WarningScope;
  scopeId: string;
  boardId: string;
  fingerprint: string;
  dismissedAt: number;
}

export interface Credentials {
  apiKey: string;
  token: string;
}
