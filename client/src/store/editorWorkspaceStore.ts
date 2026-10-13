import { create } from 'zustand';
import type { DesignFile } from 'shared/types';

export const MAX_OPEN_BOARDS = 12;

const OPEN_BOARDS_STORAGE_KEY = 'benlai-editor-open-boards';
const DRAFT_STORAGE_PREFIX = 'benlai-editor-draft:';

export interface EditorOpenBoard {
  key: string;
  route: string;
  name: string;
  fileId?: number | null;
  draftId?: string | null;
  fileType?: string;
  thumbnailPath?: string | null;
  previewDataUrl?: string;
  width?: number;
  height?: number;
  isNew?: boolean;
  updatedAt: number;
}

export interface DraftCanvasState {
  name: string;
  width: number;
  height: number;
  canvas: Record<string, unknown>;
  previewDataUrl?: string;
  updatedAt: number;
}

interface EditorWorkspaceState {
  boards: EditorOpenBoard[];
  upsertBoard: (board: EditorOpenBoard) => void;
  addFileBoards: (files: DesignFile[]) => EditorOpenBoard[];
  updateBoard: (key: string, patch: Partial<EditorOpenBoard>) => void;
  removeBoard: (key: string) => void;
}

function safeReadStorage(key: string) {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeWriteStorage(key: string, value: string) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // Session storage may be unavailable or full. The editor still works without persistence.
  }
}

function safeRemoveStorage(key: string) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function normalizeBoard(value: unknown): EditorOpenBoard | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<EditorOpenBoard>;
  if (!record.key || !record.route || !record.name) return null;
  return {
    key: String(record.key),
    route: String(record.route),
    name: String(record.name),
    fileId: typeof record.fileId === 'number' ? record.fileId : null,
    draftId: record.draftId ? String(record.draftId) : null,
    fileType: record.fileType ? String(record.fileType) : undefined,
    thumbnailPath: record.thumbnailPath ?? null,
    previewDataUrl: record.previewDataUrl,
    width: typeof record.width === 'number' ? record.width : undefined,
    height: typeof record.height === 'number' ? record.height : undefined,
    isNew: record.isNew === true,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : Date.now(),
  };
}

function readBoards() {
  const raw = safeReadStorage(OPEN_BOARDS_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeBoard).filter(Boolean).slice(-MAX_OPEN_BOARDS) as EditorOpenBoard[];
  } catch {
    return [];
  }
}

function writeBoards(boards: EditorOpenBoard[]) {
  safeWriteStorage(OPEN_BOARDS_STORAGE_KEY, JSON.stringify(boards.slice(-MAX_OPEN_BOARDS)));
}

function mergeBoards(current: EditorOpenBoard[], incoming: EditorOpenBoard[]) {
  const byKey = new Map(current.map((board) => [board.key, board]));
  incoming.forEach((board) => {
    const existing = byKey.get(board.key);
    byKey.set(board.key, existing ? { ...existing, ...board } : board);
  });
  return Array.from(byKey.values()).slice(-MAX_OPEN_BOARDS);
}

const useEditorWorkspaceStore = create<EditorWorkspaceState>((set, get) => ({
  boards: readBoards(),
  upsertBoard: (board) => {
    const boards = mergeBoards(get().boards, [board]);
    writeBoards(boards);
    set({ boards });
  },
  addFileBoards: (files) => {
    const boardsToAdd = files.map((file) => makeOpenBoardFromFile(file));
    const boards = mergeBoards(get().boards, boardsToAdd);
    writeBoards(boards);
    set({ boards });
    return boardsToAdd;
  },
  updateBoard: (key, patch) => {
    const boards = get().boards.map((board) => (
      board.key === key ? { ...board, ...patch, updatedAt: Date.now() } : board
    ));
    writeBoards(boards);
    set({ boards });
  },
  removeBoard: (key) => {
    const boards = get().boards.filter((board) => board.key !== key);
    writeBoards(boards);
    set({ boards });
  },
}));

export function getFileBoardKey(fileId: number, pageNumber = 1) {
  return pageNumber > 1 ? `file-${fileId}-page-${pageNumber}` : `file-${fileId}`;
}

export function getDraftBoardKey(draftId: string) {
  return `draft-${draftId}`;
}

export function createDraftId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function makeOpenBoardFromFile(file: DesignFile, route = `/editor/${file.id}`): EditorOpenBoard {
  return {
    key: getFileBoardKey(file.id),
    route,
    name: file.name || file.originalFilename || `画板 ${file.id}`,
    fileId: file.id,
    draftId: null,
    fileType: file.fileType,
    thumbnailPath: file.thumbnailPath ?? null,
    width: file.width,
    height: file.height,
    isNew: false,
    updatedAt: Date.now(),
  };
}

export function makeDraftOpenBoard({
  draftId,
  route,
  name,
  width,
  height,
  previewDataUrl,
}: {
  draftId: string;
  route: string;
  name: string;
  width: number;
  height: number;
  previewDataUrl?: string;
}): EditorOpenBoard {
  return {
    key: getDraftBoardKey(draftId),
    route,
    name: name || '未命名画布',
    fileId: null,
    draftId,
    fileType: 'new',
    thumbnailPath: null,
    previewDataUrl,
    width,
    height,
    isNew: true,
    updatedAt: Date.now(),
  };
}

export function readDraftCanvasState(draftId: string): DraftCanvasState | null {
  const raw = safeReadStorage(`${DRAFT_STORAGE_PREFIX}${draftId}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DraftCanvasState;
    if (!parsed || typeof parsed !== 'object' || !parsed.canvas || typeof parsed.canvas !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeDraftCanvasState(draftId: string, state: DraftCanvasState) {
  safeWriteStorage(`${DRAFT_STORAGE_PREFIX}${draftId}`, JSON.stringify(state));
}

export function removeDraftCanvasState(draftId: string) {
  safeRemoveStorage(`${DRAFT_STORAGE_PREFIX}${draftId}`);
}

export default useEditorWorkspaceStore;
