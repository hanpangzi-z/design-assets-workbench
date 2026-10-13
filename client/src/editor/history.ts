import * as fabric from 'fabric';
import { loadPersistedEditorStateIntoFabricCanvas } from '@/editor/engine/fabricDocument';
import { restorePsdScene } from '@/editor/psdSceneRenderer';
import type { HistorySnapshot } from '@/store/editorStore';

type HistoryCanvas = fabric.Canvas & {
  __suspendHistory?: boolean;
};

export const HISTORY_RESTORED_EVENT = 'benlai:history-restored';

export async function restoreHistorySnapshot(canvas: fabric.Canvas | null, snapshot: HistorySnapshot | null) {
  if (!canvas || !snapshot) return;

  const historyCanvas = canvas as HistoryCanvas;
  const previousRenderOnAddRemove = canvas.renderOnAddRemove;
  historyCanvas.__suspendHistory = true;
  canvas.renderOnAddRemove = false;

  try {
    canvas.discardActiveObject();
    await loadPersistedEditorStateIntoFabricCanvas(canvas, snapshot as Record<string, unknown>);
    await restorePsdScene(canvas, { resolveAssetUrl: (path) => `/uploads/${path}` });
    (canvas as fabric.Canvas & { fire: (eventName: string, options?: unknown) => void })
      .fire(HISTORY_RESTORED_EVENT, { snapshot });
    canvas.renderOnAddRemove = previousRenderOnAddRemove;
    canvas.requestRenderAll();
    canvas.calcOffset();
  } finally {
    canvas.renderOnAddRemove = previousRenderOnAddRemove;
    window.setTimeout(() => {
      historyCanvas.__suspendHistory = false;
    }, 0);
  }
}
