import { create } from 'zustand';
import type { Canvas as FabricCanvas } from 'fabric';
import type { EditorEngine } from '@/editor/engine/types';

export type ActiveTool = 'select' | 'hand' | 'text' | 'shape' | 'image';
export type HistorySnapshot = string | Record<string, unknown>;

interface EditorState {
  fileId: number | null;
  engine: EditorEngine | null;
  canvas: FabricCanvas | null;
  activeTool: ActiveTool;
  zoom: number;
  selectedObjectIds: string[];
  hoveredObjectId: string | null;
  canvasWidth: number;
  canvasHeight: number;
  isDirty: boolean;
  historyStack: HistorySnapshot[];
  historyIndex: number;

  setEngine: (engine: EditorEngine | null) => void;
  setCanvas: (canvas: FabricCanvas | null) => void;
  setFileId: (id: number | null) => void;
  setActiveTool: (tool: ActiveTool) => void;
  setZoom: (zoom: number) => void;
  setSelectedObjects: (ids: string[]) => void;
  setHoveredObjectId: (id: string | null) => void;
  setCanvasSize: (w: number, h: number) => void;
  setDirty: (dirty: boolean) => void;
  resetHistory: (state?: HistorySnapshot | null) => void;
  pushHistory: (state: HistorySnapshot) => void;
  undo: () => HistorySnapshot | null;
  redo: () => HistorySnapshot | null;
}

const MAX_HISTORY = 25;

const useEditorStore = create<EditorState>((set, get) => ({
  fileId: null,
  engine: null,
  canvas: null,
  activeTool: 'select',
  zoom: 100,
  selectedObjectIds: [],
  hoveredObjectId: null,
  canvasWidth: 1080,
  canvasHeight: 1080,
  isDirty: false,
  historyStack: [],
  historyIndex: -1,

  setEngine: (engine) => set({ engine }),
  setCanvas: (canvas) => set({ canvas }),
  setFileId: (id) => set({ fileId: id }),
  setActiveTool: (tool) => set({ activeTool: tool }),
  setZoom: (zoom) => set({ zoom: Math.max(10, Math.min(400, zoom)) }),
  setSelectedObjects: (ids) => set({ selectedObjectIds: ids }),
  setHoveredObjectId: (id) => set((state) => (
    state.hoveredObjectId === id ? {} : { hoveredObjectId: id }
  )),
  setCanvasSize: (w, h) => set({ canvasWidth: w, canvasHeight: h }),
  setDirty: (dirty) => set({ isDirty: dirty }),
  resetHistory: (state = null) => {
    if (!state) {
      set({ historyStack: [], historyIndex: -1, isDirty: false });
      return;
    }
    set({ historyStack: [state], historyIndex: 0, isDirty: false });
  },

  pushHistory: (state) => {
    const { historyStack, historyIndex } = get();
    if (!state) return;
    // 截断 redo 部分
    const newStack = historyStack.slice(0, historyIndex + 1);
    if (newStack[newStack.length - 1] === state) return;
    newStack.push(state);
    // 限制最大条数
    if (newStack.length > MAX_HISTORY) newStack.shift();
    set({ historyStack: newStack, historyIndex: newStack.length - 1, isDirty: true });
  },

  undo: () => {
    const { historyStack, historyIndex } = get();
    if (historyIndex <= 0) return null;
    const newIndex = historyIndex - 1;
    set({ historyIndex: newIndex });
    return historyStack[newIndex];
  },

  redo: () => {
    const { historyStack, historyIndex } = get();
    if (historyIndex >= historyStack.length - 1) return null;
    const newIndex = historyIndex + 1;
    set({ historyIndex: newIndex });
    return historyStack[newIndex];
  },
}));

export default useEditorStore;
