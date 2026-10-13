import * as fabric from 'fabric';

const CROP_AUX = '_benlaiCropAux';
const CROP_CONTEXT = '_benlaiCropContext';
const DIM_FILL = 'rgba(0, 0, 0, 0.45)';
const CROP_STROKE = '#2557f6';

type CropDimRects = {
  top: fabric.Rect;
  left: fabric.Rect;
  right: fabric.Rect;
  bottom: fabric.Rect;
};

interface CropContext {
  rect: fabric.Rect;
  dim: CropDimRects;
  saved: {
    left: number;
    top: number;
    scaleX: number;
    scaleY: number;
    cropX: number;
    cropY: number;
    width: number;
    height: number;
    selectable: boolean;
    evented: boolean;
    lockMovementX: boolean;
    lockMovementY: boolean;
    lockScalingX: boolean;
    lockScalingY: boolean;
    lockRotation: boolean;
    hasControls: boolean;
  };
  /** the image-element-pixel coordinate of the source's top-left, in canvas px */
  sourceOriginX: number;
  sourceOriginY: number;
  /** scaleX/Y to apply to image while in crop mode */
  cropScaleX: number;
  cropScaleY: number;
  elementWidth: number;
  elementHeight: number;
}

type FabricObjectAux = fabric.FabricObject & { [CROP_AUX]?: boolean };
type FabricImageWithContext = fabric.FabricImage & { [CROP_CONTEXT]?: CropContext };
type CanvasWithSuspend = fabric.Canvas & { __suspendHistory?: boolean };

export function isImageCropping(image: fabric.FabricImage | null | undefined): boolean {
  return !!image && !!(image as FabricImageWithContext)[CROP_CONTEXT];
}

export function isCropAuxiliary(object: fabric.FabricObject | null | undefined): boolean {
  return !!object && (object as FabricObjectAux)[CROP_AUX] === true;
}

export function beginImageCrop(canvas: fabric.Canvas, image: fabric.FabricImage): void {
  if (isImageCropping(image)) return;
  (canvas as CanvasWithSuspend).__suspendHistory = true;
  const element = (image as fabric.FabricImage & { _element?: HTMLImageElement }).getElement?.()
    || (image as fabric.FabricImage & { _element?: HTMLImageElement })._element;
  const elementWidth = (element as HTMLImageElement)?.naturalWidth
    || (element as HTMLImageElement)?.width
    || image.width
    || 1;
  const elementHeight = (element as HTMLImageElement)?.naturalHeight
    || (element as HTMLImageElement)?.height
    || image.height
    || 1;

  const saved = {
    left: image.left || 0,
    top: image.top || 0,
    scaleX: image.scaleX || 1,
    scaleY: image.scaleY || 1,
    cropX: image.cropX || 0,
    cropY: image.cropY || 0,
    width: image.width || elementWidth,
    height: image.height || elementHeight,
    selectable: image.selectable !== false,
    evented: image.evented !== false,
    lockMovementX: image.lockMovementX === true,
    lockMovementY: image.lockMovementY === true,
    lockScalingX: image.lockScalingX === true,
    lockScalingY: image.lockScalingY === true,
    lockRotation: image.lockRotation === true,
    hasControls: image.hasControls !== false,
  };

  const visibleLeft = saved.left;
  const visibleTop = saved.top;
  const visibleWidth = saved.width * saved.scaleX;
  const visibleHeight = saved.height * saved.scaleY;

  const sourceOriginX = visibleLeft - saved.cropX * saved.scaleX;
  const sourceOriginY = visibleTop - saved.cropY * saved.scaleY;

  image.set({
    left: sourceOriginX,
    top: sourceOriginY,
    cropX: 0,
    cropY: 0,
    width: elementWidth,
    height: elementHeight,
    selectable: false,
    evented: false,
    lockMovementX: true,
    lockMovementY: true,
    lockScalingX: true,
    lockScalingY: true,
    lockRotation: true,
    hasControls: false,
    opacity: 1,
  });
  image.setCoords();

  const rect = new fabric.Rect({
    left: visibleLeft,
    top: visibleTop,
    width: visibleWidth,
    height: visibleHeight,
    fill: 'transparent',
    stroke: CROP_STROKE,
    strokeUniform: true,
    strokeWidth: 1.5,
    hasRotatingPoint: false,
    lockRotation: true,
    cornerColor: '#ffffff',
    cornerStrokeColor: CROP_STROKE,
    cornerSize: 10,
    transparentCorners: false,
    objectCaching: false,
    excludeFromExport: true,
  });
  (rect as FabricObjectAux)[CROP_AUX] = true;

  const dim = makeDimRects();
  Object.values(dim).forEach((r) => {
    (r as FabricObjectAux)[CROP_AUX] = true;
    canvas.add(r);
  });
  canvas.add(rect);
  canvas.setActiveObject(rect);

  (image as FabricImageWithContext)[CROP_CONTEXT] = {
    rect,
    dim,
    saved,
    sourceOriginX,
    sourceOriginY,
    cropScaleX: saved.scaleX,
    cropScaleY: saved.scaleY,
    elementWidth,
    elementHeight,
  };

  const sourceBounds = {
    left: sourceOriginX,
    top: sourceOriginY,
    width: elementWidth * saved.scaleX,
    height: elementHeight * saved.scaleY,
  };
  updateDimRects(dim, rect, sourceBounds);

  const onChanging = () => {
    clampRectToSource(rect, sourceBounds);
    updateDimRects(dim, rect, sourceBounds);
    canvas.requestRenderAll();
  };
  rect.on('moving', onChanging);
  rect.on('scaling', onChanging);
  rect.on('modified', onChanging);

  canvas.requestRenderAll();
}

export function confirmImageCrop(canvas: fabric.Canvas, image: fabric.FabricImage): void {
  const context = (image as FabricImageWithContext)[CROP_CONTEXT];
  if (!context) return;
  const { rect, dim, saved, sourceOriginX, sourceOriginY, cropScaleX, cropScaleY, elementWidth, elementHeight } = context;

  const rectLeft = rect.left || 0;
  const rectTop = rect.top || 0;
  const rectWidth = (rect.width || 0) * (rect.scaleX || 1);
  const rectHeight = (rect.height || 0) * (rect.scaleY || 1);

  let cropX = (rectLeft - sourceOriginX) / cropScaleX;
  let cropY = (rectTop - sourceOriginY) / cropScaleY;
  let newWidth = rectWidth / cropScaleX;
  let newHeight = rectHeight / cropScaleY;

  cropX = clamp(cropX, 0, elementWidth);
  cropY = clamp(cropY, 0, elementHeight);
  newWidth = clamp(newWidth, 1, elementWidth - cropX);
  newHeight = clamp(newHeight, 1, elementHeight - cropY);

  image.set({
    left: rectLeft,
    top: rectTop,
    scaleX: cropScaleX,
    scaleY: cropScaleY,
    cropX,
    cropY,
    width: newWidth,
    height: newHeight,
    selectable: saved.selectable,
    evented: saved.evented,
    lockMovementX: saved.lockMovementX,
    lockMovementY: saved.lockMovementY,
    lockScalingX: saved.lockScalingX,
    lockScalingY: saved.lockScalingY,
    lockRotation: saved.lockRotation,
    hasControls: saved.hasControls,
  });
  image.setCoords();

  removeCropAuxiliaries(canvas, [rect, dim.top, dim.left, dim.right, dim.bottom]);
  delete (image as FabricImageWithContext)[CROP_CONTEXT];

  (canvas as CanvasWithSuspend).__suspendHistory = false;
  canvas.setActiveObject(image);
  canvas.fire('object:modified', { target: image });
  canvas.requestRenderAll();
}

export function cancelImageCrop(canvas: fabric.Canvas, image: fabric.FabricImage): void {
  const context = (image as FabricImageWithContext)[CROP_CONTEXT];
  if (!context) return;
  const { rect, dim, saved } = context;

  image.set({
    left: saved.left,
    top: saved.top,
    scaleX: saved.scaleX,
    scaleY: saved.scaleY,
    cropX: saved.cropX,
    cropY: saved.cropY,
    width: saved.width,
    height: saved.height,
    selectable: saved.selectable,
    evented: saved.evented,
    lockMovementX: saved.lockMovementX,
    lockMovementY: saved.lockMovementY,
    lockScalingX: saved.lockScalingX,
    lockScalingY: saved.lockScalingY,
    lockRotation: saved.lockRotation,
    hasControls: saved.hasControls,
  });
  image.setCoords();

  removeCropAuxiliaries(canvas, [rect, dim.top, dim.left, dim.right, dim.bottom]);
  delete (image as FabricImageWithContext)[CROP_CONTEXT];

  (canvas as CanvasWithSuspend).__suspendHistory = false;
  canvas.setActiveObject(image);
  canvas.requestRenderAll();
}

function removeCropAuxiliaries(canvas: fabric.Canvas, objects: fabric.FabricObject[]) {
  objects.forEach((object) => {
    object.off?.();
    canvas.remove(object);
  });
}

function makeDimRects(): CropDimRects {
  const base = {
    fill: DIM_FILL,
    selectable: false,
    evented: false,
    hoverCursor: 'default',
    objectCaching: false,
    hasControls: false,
    hasBorders: false,
    excludeFromExport: true,
  };
  return {
    top: new fabric.Rect({ ...base, left: 0, top: 0, width: 0, height: 0 }),
    left: new fabric.Rect({ ...base, left: 0, top: 0, width: 0, height: 0 }),
    right: new fabric.Rect({ ...base, left: 0, top: 0, width: 0, height: 0 }),
    bottom: new fabric.Rect({ ...base, left: 0, top: 0, width: 0, height: 0 }),
  };
}

function updateDimRects(dim: CropDimRects, rect: fabric.Rect, source: { left: number; top: number; width: number; height: number }) {
  const cropLeft = rect.left || 0;
  const cropTop = rect.top || 0;
  const cropWidth = (rect.width || 0) * (rect.scaleX || 1);
  const cropHeight = (rect.height || 0) * (rect.scaleY || 1);

  dim.top.set({
    left: source.left,
    top: source.top,
    width: source.width,
    height: Math.max(0, cropTop - source.top),
  });
  dim.bottom.set({
    left: source.left,
    top: cropTop + cropHeight,
    width: source.width,
    height: Math.max(0, (source.top + source.height) - (cropTop + cropHeight)),
  });
  dim.left.set({
    left: source.left,
    top: cropTop,
    width: Math.max(0, cropLeft - source.left),
    height: cropHeight,
  });
  dim.right.set({
    left: cropLeft + cropWidth,
    top: cropTop,
    width: Math.max(0, (source.left + source.width) - (cropLeft + cropWidth)),
    height: cropHeight,
  });
  [dim.top, dim.left, dim.right, dim.bottom].forEach((r) => r.setCoords());
}

function clampRectToSource(rect: fabric.Rect, source: { left: number; top: number; width: number; height: number }) {
  let left = rect.left || 0;
  let top = rect.top || 0;
  const scaleX = rect.scaleX || 1;
  const scaleY = rect.scaleY || 1;
  const minDimension = 8;
  let width = Math.max(minDimension, (rect.width || 0) * scaleX);
  let height = Math.max(minDimension, (rect.height || 0) * scaleY);

  if (left < source.left) left = source.left;
  if (top < source.top) top = source.top;
  if (left + width > source.left + source.width) width = source.left + source.width - left;
  if (top + height > source.top + source.height) height = source.top + source.height - top;

  rect.set({
    left,
    top,
    width: width / scaleX,
    height: height / scaleY,
  });
  rect.setCoords();
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
