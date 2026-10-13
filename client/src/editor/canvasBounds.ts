import * as fabric from 'fabric';

const MIN_VISIBLE_OVERLAP = 24;
const EXTREME_BOUNDS_FACTOR = 4;

type ObjectPosition = {
  left: number;
  top: number;
};

type SceneRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type CanvasStateValidation = {
  valid: boolean;
  reason?: string;
};

export function installCanvasDragBoundsGuard(canvas: fabric.Canvas) {
  const lastLegalPositions = new WeakMap<fabric.FabricObject, ObjectPosition>();
  const lastDragPositions = new WeakMap<fabric.FabricObject, ObjectPosition>();

  const rememberObject = (object: fabric.FabricObject | null | undefined) => {
    if (!object) return;
    rememberLegalPosition(canvas, object, lastLegalPositions);
    rememberDragPosition(object, lastDragPositions);
  };

  const guardObject = (object: fabric.FabricObject | null | undefined) => {
    if (!object) return false;
    return keepObjectNearCanvas(canvas, object, lastLegalPositions);
  };

  canvas.getObjects().forEach(rememberObject);

  const handleMouseDown = (event: { target?: fabric.FabricObject }) => {
    rememberObject(event.target);
  };
  const handleObjectAdded = (event: { target?: fabric.FabricObject }) => {
    rememberObject(event.target);
  };
  const handleObjectMoving = (event: { target?: fabric.FabricObject }) => {
    syncAbsoluteClipPathWithObject(event.target, lastDragPositions);
    rememberDragPosition(event.target, lastDragPositions);
  };
  const handleObjectModified = (event: { target?: fabric.FabricObject }) => {
    syncAbsoluteClipPathWithObject(event.target, lastDragPositions);
    if (event.target) rememberLegalPosition(canvas, event.target, lastLegalPositions);
    rememberDragPosition(event.target, lastDragPositions);
  };

  canvas.on('mouse:down', handleMouseDown);
  canvas.on('object:added', handleObjectAdded);
  canvas.on('object:moving', handleObjectMoving);
  canvas.on('object:modified', handleObjectModified);

  return () => {
    canvas.off('mouse:down', handleMouseDown);
    canvas.off('object:added', handleObjectAdded);
    canvas.off('object:moving', handleObjectMoving);
    canvas.off('object:modified', handleObjectModified);
  };
}

export function repairCanvasObjectsNearScene(canvas: fabric.Canvas) {
  let changed = false;
  canvas.getObjects().forEach((object) => {
    if (isPsdSceneSource(object)) return;
    if (!isVisibleCanvasObject(object)) return;
    if (clampObjectNearCanvas(canvas, object)) changed = true;
  });
  return changed;
}

export function isCanvasVisuallyLost(canvas: fabric.Canvas) {
  const visibleObjects = canvas.getObjects().filter((object) => isVisibleCanvasObject(object) && !isPsdSceneSource(object));
  if (visibleObjects.length === 0) return false;
  return !visibleObjects.some((object) => {
    const rect = getObjectSceneRect(object);
    return !!rect
      && !isExtremeRect(canvas, rect)
      && rectIntersectsCanvas(canvas, rect);
  });
}

export function validateCanvasStateBeforePersist(canvas: fabric.Canvas): CanvasStateValidation {
  const visibleObjects = canvas.getObjects().filter(isVisibleCanvasObject);
  if (visibleObjects.length === 0) return { valid: true };

  let hasVisibleIntersection = false;
  for (const object of visibleObjects) {
    const rect = getObjectSceneRect(object);
    if (!rect) {
      return { valid: false, reason: 'object has invalid bounds' };
    }
    // PSD source geometry can intentionally extend beyond the document;
    // the scene compositor clips it without moving the editable source.
    if (isPsdSceneSource(object)) continue;
    if (isExtremeRect(canvas, rect)) {
      return { valid: false, reason: 'object bounds are outside the safe range' };
    }
    if (rectIntersectsCanvas(canvas, rect)) {
      hasVisibleIntersection = true;
    }
  }

  return hasVisibleIntersection || visibleObjects.some(isPsdSceneSource)
    ? { valid: true }
    : { valid: false, reason: 'no visible object intersects the canvas' };
}

function isPsdSceneSource(object: fabric.FabricObject): boolean {
  return (object as fabric.FabricObject & { _psdSceneObject?: boolean })._psdSceneObject === true;
}

export function clampObjectNearCanvas(canvas: fabric.Canvas, object: fabric.FabricObject) {
  const rect = getObjectSceneRect(object);
  if (!rect) return false;

  const width = getCanvasSceneWidth(canvas);
  const height = getCanvasSceneHeight(canvas);
  if (width <= 0 || height <= 0) return false;

  const overlapX = Math.min(MIN_VISIBLE_OVERLAP, rect.width, width);
  const overlapY = Math.min(MIN_VISIBLE_OVERLAP, rect.height, height);
  const minLeft = overlapX - rect.width;
  const maxLeft = width - overlapX;
  const minTop = overlapY - rect.height;
  const maxTop = height - overlapY;

  const nextLeft = clamp(rect.left, minLeft, maxLeft);
  const nextTop = clamp(rect.top, minTop, maxTop);
  const dx = nextLeft - rect.left;
  const dy = nextTop - rect.top;
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return false;

  translateObject(object, dx, dy);
  object.setCoords();
  return true;
}

function keepObjectNearCanvas(
  canvas: fabric.Canvas,
  object: fabric.FabricObject,
  lastLegalPositions: WeakMap<fabric.FabricObject, ObjectPosition>,
) {
  const rect = getObjectSceneRect(object);
  if (!rect || isExtremeRect(canvas, rect)) {
    return restoreLastLegalPosition(object, lastLegalPositions)
      || (!!rect && clampObjectNearCanvas(canvas, object));
  }

  const changed = clampObjectNearCanvas(canvas, object);
  rememberLegalPosition(canvas, object, lastLegalPositions);
  return changed;
}

function rememberLegalPosition(
  canvas: fabric.Canvas,
  object: fabric.FabricObject,
  lastLegalPositions: WeakMap<fabric.FabricObject, ObjectPosition>,
) {
  const position = getObjectPosition(object);
  const rect = getObjectSceneRect(object);
  if (!position || !rect || isExtremeRect(canvas, rect)) return;
  lastLegalPositions.set(object, position);
}

function restoreLastLegalPosition(
  object: fabric.FabricObject,
  lastLegalPositions: WeakMap<fabric.FabricObject, ObjectPosition>,
) {
  const position = lastLegalPositions.get(object);
  if (!position) return false;
  const current = getObjectPosition(object);
  if (current) translateObject(object, position.left - current.left, position.top - current.top);
  object.set({ left: position.left, top: position.top });
  object.setCoords();
  return true;
}

function rememberDragPosition(
  object: fabric.FabricObject | null | undefined,
  lastDragPositions: WeakMap<fabric.FabricObject, ObjectPosition>,
) {
  if (!object) return;
  const position = getObjectPosition(object);
  if (position) lastDragPositions.set(object, position);
}

function syncAbsoluteClipPathWithObject(
  object: fabric.FabricObject | null | undefined,
  lastDragPositions: WeakMap<fabric.FabricObject, ObjectPosition>,
) {
  if (!object) return;
  const previous = lastDragPositions.get(object);
  const current = getObjectPosition(object);
  if (!previous || !current) return;
  const dx = current.left - previous.left;
  const dy = current.top - previous.top;
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return;
  translateAbsoluteClipPathsForObject(object, dx, dy);
}

function getObjectPosition(object: fabric.FabricObject): ObjectPosition | null {
  const left = toFiniteNumber(object.left);
  const top = toFiniteNumber(object.top);
  if (left === null || top === null) return null;
  return { left, top };
}

function getObjectSceneRect(object: fabric.FabricObject): SceneRect | null {
  try {
    const rect = object.getBoundingRect();
    if (!isFiniteRect(rect)) return null;
    return rect;
  } catch {
    return null;
  }
}

function isVisibleCanvasObject(object: fabric.FabricObject) {
  return object.visible !== false
    && (object.opacity ?? 1) > 0.03
    && object.type !== 'activeSelection';
}

function rectIntersectsCanvas(canvas: fabric.Canvas, rect: SceneRect) {
  const width = getCanvasSceneWidth(canvas);
  const height = getCanvasSceneHeight(canvas);
  return rect.left < width
    && rect.left + rect.width > 0
    && rect.top < height
    && rect.top + rect.height > 0;
}

function isExtremeRect(canvas: fabric.Canvas, rect: SceneRect) {
  const limit = Math.max(1, getCanvasSceneWidth(canvas), getCanvasSceneHeight(canvas)) * EXTREME_BOUNDS_FACTOR;
  const values = [
    rect.left,
    rect.top,
    rect.width,
    rect.height,
    rect.left + rect.width,
    rect.top + rect.height,
  ];
  return values.some((value) => !Number.isFinite(value) || Math.abs(value) > limit);
}

function isFiniteRect(rect: SceneRect) {
  return Number.isFinite(rect.left)
    && Number.isFinite(rect.top)
    && Number.isFinite(rect.width)
    && Number.isFinite(rect.height)
    && rect.width > 0
    && rect.height > 0;
}

function translateObject(object: fabric.FabricObject, dx: number, dy: number) {
  const left = toFiniteNumber(object.left) ?? 0;
  const top = toFiniteNumber(object.top) ?? 0;
  translateAbsoluteClipPathsForObject(object, dx, dy);
  object.set({
    left: left + dx,
    top: top + dy,
  });
}

function translateAbsoluteClipPathsForObject(object: fabric.FabricObject, dx: number, dy: number) {
  translateAbsoluteClipPath(object, dx, dy);
  const collection = object as fabric.FabricObject & {
    forEachObject?: (callback: (child: fabric.FabricObject) => void) => void;
  };
  if (object.type !== 'activeSelection' && object.type !== 'group') return;
  collection.forEachObject?.((child) => translateAbsoluteClipPath(child, dx, dy));
}

function translateAbsoluteClipPath(object: fabric.FabricObject, dx: number, dy: number) {
  const clipPath = object.clipPath as (fabric.FabricObject & { absolutePositioned?: boolean }) | undefined;
  if (!clipPath?.absolutePositioned) return;
  const left = toFiniteNumber(clipPath.left) ?? 0;
  const top = toFiniteNumber(clipPath.top) ?? 0;
  clipPath.set({
    left: left + dx,
    top: top + dy,
  });
  clipPath.setCoords();
}

function getCanvasSceneWidth(canvas: fabric.Canvas) {
  return Math.max(1, Number(canvas.getWidth()) || 1);
}

function getCanvasSceneHeight(canvas: fabric.Canvas) {
  return Math.max(1, Number(canvas.getHeight()) || 1);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function toFiniteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
