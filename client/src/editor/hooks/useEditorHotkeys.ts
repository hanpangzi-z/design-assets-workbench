import { useEffect, useRef } from 'react';
import * as fabric from 'fabric';
import useEditorStore, { type ActiveTool } from '@/store/editorStore';
import { restoreHistorySnapshot } from '@/editor/history';

interface UseEditorHotkeysOptions {
  onBeginPreviewTextEdit?: (target: fabric.FabricObject | null) => void;
}

const PASTE_OFFSET = 16;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function isFabricEditingText(canvas: fabric.Canvas | null): boolean {
  if (!canvas) return false;
  const active = canvas.getActiveObject() as (fabric.FabricObject & { isEditing?: boolean }) | null;
  return Boolean(active?.isEditing);
}

function isActiveSelection(obj: fabric.FabricObject | null | undefined): obj is fabric.ActiveSelection {
  return !!obj && (obj as { type?: string }).type === 'activeSelection';
}

function isGroup(obj: fabric.FabricObject | null | undefined): obj is fabric.Group {
  return !!obj && (obj as { type?: string }).type === 'group';
}

async function cloneActiveObjects(canvas: fabric.Canvas): Promise<fabric.FabricObject[] | null> {
  const active = canvas.getActiveObject();
  if (!active) return null;
  if (isActiveSelection(active)) {
    const objects = active.getObjects();
    return Promise.all(objects.map((obj) => obj.clone() as Promise<fabric.FabricObject>));
  }
  const cloned = (await active.clone()) as fabric.FabricObject;
  return [cloned];
}

function setSelectionFromObjects(canvas: fabric.Canvas, objects: fabric.FabricObject[]) {
  const targets = sortObjectsByCanvasOrder(canvas, objects);
  canvas.discardActiveObject();
  if (targets.length === 1) {
    canvas.setActiveObject(targets[0]);
  } else if (targets.length > 1) {
    const sel = new fabric.ActiveSelection(targets, {
      canvas,
      multiSelectionStacking: 'canvas-stacking',
    } as Partial<fabric.ActiveSelectionOptions>);
    canvas.setActiveObject(sel);
  }
  canvas.requestRenderAll();
}

function sortObjectsByCanvasOrder(canvas: fabric.Canvas, objects: fabric.FabricObject[]) {
  const stack = canvas.getObjects();
  return [...objects].sort((a, b) => stack.indexOf(a) - stack.indexOf(b));
}

function removeActiveObject(canvas: fabric.Canvas) {
  const active = canvas.getActiveObject();
  if (!active) return;
  if (isActiveSelection(active)) {
    const objects = active.getObjects().slice();
    active.removeAll();
    canvas.discardActiveObject();
    objects.forEach((obj) => canvas.remove(obj));
  } else {
    canvas.discardActiveObject();
    canvas.remove(active);
  }
  canvas.requestRenderAll();
}

function moveActiveObject(canvas: fabric.Canvas, dx: number, dy: number) {
  const active = canvas.getActiveObject();
  if (!active) return false;
  if (active.lockMovementX && active.lockMovementY) return false;
  const nextLeft = (active.left || 0) + (active.lockMovementX ? 0 : dx);
  const nextTop = (active.top || 0) + (active.lockMovementY ? 0 : dy);
  active.set({ left: nextLeft, top: nextTop });
  active.setCoords();
  canvas.fire('object:modified', { target: active });
  canvas.requestRenderAll();
  return true;
}

function selectAllOnCanvas(canvas: fabric.Canvas) {
  const objects = canvas.getObjects().filter((obj) => obj.selectable !== false && obj.evented !== false);
  if (objects.length === 0) return;
  setSelectionFromObjects(canvas, objects);
}

function toggleLockOnActive(canvas: fabric.Canvas) {
  const active = canvas.getActiveObject();
  if (!active) return;
  const targets: fabric.FabricObject[] = isActiveSelection(active) ? active.getObjects() : [active];
  const allLocked = targets.every((obj) => obj.lockMovementX && obj.lockMovementY);
  const nextLocked = !allLocked;
  targets.forEach((obj) => {
    obj.set({
      lockMovementX: nextLocked,
      lockMovementY: nextLocked,
      lockScalingX: nextLocked,
      lockScalingY: nextLocked,
      lockRotation: nextLocked,
      hasControls: !nextLocked,
    });
  });
  if (isActiveSelection(active)) {
    active.set({
      lockMovementX: nextLocked,
      lockMovementY: nextLocked,
      lockScalingX: nextLocked,
      lockScalingY: nextLocked,
      lockRotation: nextLocked,
      hasControls: !nextLocked,
    });
  }
  canvas.requestRenderAll();
}

function groupActiveSelection(canvas: fabric.Canvas) {
  const active = canvas.getActiveObject();
  if (!isActiveSelection(active)) return;
  const objects = sortObjectsByCanvasOrder(canvas, active.getObjects().slice());
  if (objects.length < 2) return;
  const stack = canvas.getObjects();
  const indexes = objects.map((obj) => stack.indexOf(obj)).filter((index) => index >= 0);
  const insertIndex = indexes.length > 0 ? Math.min(...indexes) : stack.length;
  canvas.discardActiveObject();
  objects.forEach((obj) => canvas.remove(obj));
  const group = new fabric.Group(objects, {
    subTargetCheck: true,
    interactive: false,
    objectCaching: true,
  } as Partial<fabric.GroupProps>);
  const custom = group as fabric.Group & { _layerId?: string; _layerName?: string; _layerType?: string };
  custom._layerId = `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  custom._layerName = '组合';
  custom._layerType = 'group';
  canvas.insertAt(insertIndex, group);
  canvas.setActiveObject(group);
  canvas.fire('object:modified', { target: group });
  canvas.requestRenderAll();
}

function ungroupActiveGroup(canvas: fabric.Canvas) {
  const active = canvas.getActiveObject();
  if (!isGroup(active)) return;
  const insertIndex = Math.max(0, canvas.getObjects().indexOf(active));
  const items = active.removeAll() as fabric.FabricObject[];
  canvas.remove(active);
  items.forEach((obj, offset) => {
    obj.set({
      selectable: obj.selectable !== false,
      evented: obj.evented !== false,
    });
    obj.setCoords();
    canvas.insertAt(insertIndex + offset, obj);
  });
  if (items.length > 0) {
    const sel = new fabric.ActiveSelection(items, {
      canvas,
      multiSelectionStacking: 'canvas-stacking',
    } as Partial<fabric.ActiveSelectionOptions>);
    canvas.setActiveObject(sel);
  }
  canvas.fire('object:modified', { target: items[items.length - 1] || active });
  canvas.requestRenderAll();
}

function isSpaceKey(event: KeyboardEvent) {
  return event.code === 'Space'
    || event.key === ' '
    || event.key === 'Space'
    || event.key === 'Spacebar'
    || event.keyCode === 32
    || event.which === 32;
}

function isLetterKey(event: KeyboardEvent, letter: string) {
  const normalized = letter.toLowerCase();
  return event.key.toLowerCase() === normalized
    || event.code === `Key${normalized.toUpperCase()}`;
}

function isBracketKey(event: KeyboardEvent, side: 'left' | 'right') {
  return side === 'left'
    ? event.key === '[' || event.code === 'BracketLeft'
    : event.key === ']' || event.code === 'BracketRight';
}

function changeZOrder(canvas: fabric.Canvas, direction: 'forward' | 'backward' | 'front' | 'back') {
  const active = canvas.getActiveObject();
  if (!active) return;
  const targets: fabric.FabricObject[] = isActiveSelection(active) ? active.getObjects() : [active];
  targets.forEach((obj) => {
    if (direction === 'forward') canvas.bringObjectForward(obj);
    else if (direction === 'backward') canvas.sendObjectBackwards(obj);
    else if (direction === 'front') canvas.bringObjectToFront(obj);
    else canvas.sendObjectToBack(obj);
  });
  canvas.fire('object:modified', { target: active });
  canvas.requestRenderAll();
}

async function pasteFromClipboard(canvas: fabric.Canvas, clipboard: fabric.FabricObject[]) {
  if (clipboard.length === 0) return;
  const fresh = await Promise.all(clipboard.map((obj) => obj.clone() as Promise<fabric.FabricObject>));
  fresh.forEach((obj) => {
    obj.set({
      left: (obj.left || 0) + PASTE_OFFSET,
      top: (obj.top || 0) + PASTE_OFFSET,
      evented: true,
    });
    canvas.add(obj);
  });
  setSelectionFromObjects(canvas, fresh);
  canvas.fire('object:modified', { target: fresh[fresh.length - 1] });
}

async function duplicateActive(canvas: fabric.Canvas) {
  const clones = await cloneActiveObjects(canvas);
  if (!clones) return;
  clones.forEach((obj) => {
    obj.set({
      left: (obj.left || 0) + PASTE_OFFSET,
      top: (obj.top || 0) + PASTE_OFFSET,
      evented: true,
    });
    canvas.add(obj);
  });
  setSelectionFromObjects(canvas, clones);
  canvas.fire('object:modified', { target: clones[clones.length - 1] });
}

export default function useEditorHotkeys(options: UseEditorHotkeysOptions = {}) {
  const clipboardRef = useRef<fabric.FabricObject[] | null>(null);
  const spacePreviousToolRef = useRef<ActiveTool | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const handler = async (event: KeyboardEvent) => {
      const canvas = useEditorStore.getState().canvas;
      const ctrl = event.ctrlKey || event.metaKey;
      const shift = event.shiftKey;
      const key = event.key;
      const fromInput = isEditableTarget(event.target);

      if (ctrl && (key === '0' || event.code === 'Numpad0')) {
        event.preventDefault();
        useEditorStore.getState().setZoom(100);
        return;
      }
      if (ctrl && (key === '=' || key === '+' || event.code === 'NumpadAdd')) {
        event.preventDefault();
        const store = useEditorStore.getState();
        store.setZoom(store.zoom + 10);
        return;
      }
      if (ctrl && (key === '-' || event.code === 'NumpadSubtract')) {
        event.preventDefault();
        const store = useEditorStore.getState();
        store.setZoom(store.zoom - 10);
        return;
      }

      if (fromInput) return;

      if (!ctrl && !event.altKey && !event.metaKey && isSpaceKey(event)) {
        if (isFabricEditingText(canvas)) return;
        event.preventDefault();
        if (event.repeat) return;
        const store = useEditorStore.getState();
        if (store.activeTool !== 'hand') {
          spacePreviousToolRef.current = store.activeTool;
          store.setActiveTool('hand');
        }
        return;
      }

      if (ctrl && isLetterKey(event, 'z')) {
        if (isFabricEditingText(canvas)) return;
        event.preventDefault();
        if (!canvas) return;
        const store = useEditorStore.getState();
        const snapshot = shift ? store.redo() : store.undo();
        void restoreHistorySnapshot(canvas, snapshot);
        return;
      }
      if (ctrl && isLetterKey(event, 'y')) {
        if (isFabricEditingText(canvas)) return;
        event.preventDefault();
        if (!canvas) return;
        const snapshot = useEditorStore.getState().redo();
        void restoreHistorySnapshot(canvas, snapshot);
        return;
      }

      if (!canvas) return;
      if (isFabricEditingText(canvas)) return;

      if (ctrl && isLetterKey(event, 'c')) {
        event.preventDefault();
        const clones = await cloneActiveObjects(canvas);
        if (clones) clipboardRef.current = clones;
        return;
      }
      if (ctrl && isLetterKey(event, 'x')) {
        event.preventDefault();
        const clones = await cloneActiveObjects(canvas);
        if (clones) {
          clipboardRef.current = clones;
          removeActiveObject(canvas);
        }
        return;
      }
      if (ctrl && isLetterKey(event, 'v')) {
        event.preventDefault();
        const clipboard = clipboardRef.current;
        if (clipboard && clipboard.length > 0) await pasteFromClipboard(canvas, clipboard);
        return;
      }
      if (ctrl && isLetterKey(event, 'd')) {
        event.preventDefault();
        await duplicateActive(canvas);
        return;
      }
      if (ctrl && isLetterKey(event, 'a')) {
        event.preventDefault();
        selectAllOnCanvas(canvas);
        return;
      }
      if (ctrl && isLetterKey(event, 'l')) {
        event.preventDefault();
        toggleLockOnActive(canvas);
        return;
      }
      if (ctrl && !shift && isLetterKey(event, 'g')) {
        event.preventDefault();
        groupActiveSelection(canvas);
        return;
      }
      if (ctrl && shift && isLetterKey(event, 'g')) {
        event.preventDefault();
        ungroupActiveGroup(canvas);
        return;
      }
      if (ctrl && isBracketKey(event, 'right')) {
        event.preventDefault();
        changeZOrder(canvas, shift ? 'front' : 'forward');
        return;
      }
      if (ctrl && isBracketKey(event, 'left')) {
        event.preventDefault();
        changeZOrder(canvas, shift ? 'back' : 'backward');
        return;
      }

      if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') {
        const step = shift ? 10 : 1;
        let dx = 0;
        let dy = 0;
        if (key === 'ArrowLeft') dx = -step;
        if (key === 'ArrowRight') dx = step;
        if (key === 'ArrowUp') dy = -step;
        if (key === 'ArrowDown') dy = step;
        if (moveActiveObject(canvas, dx, dy)) event.preventDefault();
        return;
      }

      if (key === 'Delete' || key === 'Backspace') {
        const active = canvas.getActiveObject();
        if (!active) return;
        event.preventDefault();
        removeActiveObject(canvas);
        return;
      }

      if (key === 'Escape') {
        if (canvas.getActiveObject()) {
          canvas.discardActiveObject();
          canvas.requestRenderAll();
        }
        return;
      }

      if (key === 'Enter' || key === 'F2') {
        const cb = optionsRef.current.onBeginPreviewTextEdit;
        if (!cb) return;
        const active = canvas.getActiveObject();
        if (!active) return;
        event.preventDefault();
        cb(active);
      }
    };

    const restoreSpaceTool = (event?: KeyboardEvent | FocusEvent) => {
      if (event instanceof KeyboardEvent && !isSpaceKey(event)) return;
      const previousTool = spacePreviousToolRef.current;
      if (!previousTool) return;
      if (event instanceof KeyboardEvent) event.preventDefault();
      spacePreviousToolRef.current = null;
      const store = useEditorStore.getState();
      if (store.activeTool === 'hand') store.setActiveTool(previousTool);
    };

    document.addEventListener('keydown', handler, true);
    document.addEventListener('keyup', restoreSpaceTool, true);
    window.addEventListener('blur', restoreSpaceTool);
    return () => {
      document.removeEventListener('keydown', handler, true);
      document.removeEventListener('keyup', restoreSpaceTool, true);
      window.removeEventListener('blur', restoreSpaceTool);
      restoreSpaceTool();
    };
  }, []);
}
