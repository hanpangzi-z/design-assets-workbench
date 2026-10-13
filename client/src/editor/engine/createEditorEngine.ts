import { FabricEditorEngine, type FabricEditorEngineOptions } from './FabricEditorEngine';
import { NativeCanvasEngine } from './NativeCanvasEngine';
import type { EditorEngine } from './types';

export type EditorEngineKind = 'fabric' | 'native-canvas';

export function getConfiguredEditorEngineKind(): EditorEngineKind {
  const value = import.meta.env.VITE_EDITOR_ENGINE;
  return value === 'native-canvas' ? 'native-canvas' : 'fabric';
}

export function createEditorEngine(options: FabricEditorEngineOptions): EditorEngine {
  const kind = getConfiguredEditorEngineKind();
  if (kind === 'native-canvas') {
    return new NativeCanvasEngine({
      width: options.width,
      height: options.height,
      backgroundColor: typeof options.backgroundColor === 'string' ? options.backgroundColor : '#ffffff',
    });
  }
  return new FabricEditorEngine(options);
}

export function getFabricCanvasFromEngine(engine: EditorEngine | null) {
  return engine instanceof FabricEditorEngine ? engine.getFabricCanvas() : null;
}
