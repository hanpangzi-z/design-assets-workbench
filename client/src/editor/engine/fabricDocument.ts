import * as fabric from 'fabric';
import { PSD_SOURCE_CUSTOM_PROPERTIES, type PsdImportCanvas } from '../psdImportState';
import type {
  EditorDocument,
  EditorObject,
  EditorObjectBase,
  GroupObject,
  ShapeObject,
} from './types';

type FabricObjectWithCustom = fabric.FabricObject & {
  _layerId?: string | number;
  _layerName?: string;
  _layerType?: string;
  _psdLocked?: boolean;
  _psdLayerBounds?: unknown;
  _psdPreviewVisualBounds?: unknown;
  _psdTextPreview?: boolean;
  _psdTextContent?: string;
  _psdTextOptions?: Record<string, unknown>;
};

type FabricJson = Record<string, unknown>;

const fabricObjectClass = fabric.FabricObject as unknown as { customProperties?: string[] };
fabricObjectClass.customProperties = Array.from(new Set([
  ...(fabricObjectClass.customProperties || []), ...PSD_SOURCE_CUSTOM_PROPERTIES,
]));

export type PersistedEditorState = EditorDocument | FabricJson;

export function serializeFabricCanvasToDocument(canvas: fabric.Canvas): EditorDocument {
  return {
    version: 1,
    width: canvas.getWidth(),
    height: canvas.getHeight(),
    objects: canvas.getObjects().map((object, index) => fabricObjectToEditorObject(object, index)),
    metadata: {
      sourceEngine: 'fabric',
      fabricJson: serializeCanvasWithPsdScene(canvas),
    },
  };
}

export function serializeFabricCanvasToFabricJson(canvas: fabric.Canvas): FabricJson {
  return serializeCanvasWithPsdScene(canvas);
}

function serializeCanvasWithPsdScene(canvas: fabric.Canvas): FabricJson {
  const state = canvas.toJSON() as FabricJson;
  const source = canvas as PsdImportCanvas;
  if (source.__psdScene) {
    state.__psdScene = JSON.parse(JSON.stringify(source.__psdScene));
    state.__psdSceneVersion = source.__psdSceneVersion || 1;
  }
  if (source.__psdVisibilityOverrides) state.__psdVisibilityOverrides = { ...source.__psdVisibilityOverrides };
  return state;
}

function restorePsdCanvasMetadata(canvas: fabric.Canvas, state: FabricJson) {
  const target = canvas as PsdImportCanvas;
  target.__psdSceneSession?.dispose();
  target.__psdScene = state.__psdScene;
  target.__psdSceneVersion = typeof state.__psdSceneVersion === 'number' ? state.__psdSceneVersion : undefined;
  target.__psdVisibilityOverrides = state.__psdVisibilityOverrides && typeof state.__psdVisibilityOverrides === 'object'
    ? { ...(state.__psdVisibilityOverrides as Record<string, boolean>) } : {};
}

export async function loadPersistedEditorStateIntoFabricCanvas(
  canvas: fabric.Canvas,
  state: PersistedEditorState,
) {
  if (isEditorDocument(state)) {
    await loadEditorDocumentIntoFabricCanvas(canvas, state);
    return;
  }
  restorePsdCanvasMetadata(canvas, state);
  await canvas.loadFromJSON(state);
  canvas.requestRenderAll();
}

export async function loadEditorDocumentIntoFabricCanvas(
  canvas: fabric.Canvas,
  document: EditorDocument,
) {
  canvas.setDimensions({ width: document.width, height: document.height });

  const fabricJson = getFabricJsonFromDocument(document);
  if (fabricJson) {
    restorePsdCanvasMetadata(canvas, fabricJson);
    await canvas.loadFromJSON(fabricJson);
    canvas.requestRenderAll();
    return;
  }

  canvas.clear();
  canvas.backgroundColor = '#ffffff';
  canvas.requestRenderAll();
}

export function getFabricJsonFromDocument(document: EditorDocument): FabricJson | null {
  const metadata = document.metadata as (EditorDocument['metadata'] & { fabric?: unknown }) | undefined;
  if (isRecord(metadata?.fabricJson)) return metadata.fabricJson;
  if (isRecord(metadata?.fabric)) return metadata.fabric;
  return null;
}

export function isEditorDocument(value: unknown): value is EditorDocument {
  if (!isRecord(value)) return false;
  return value.version === 1
    && typeof value.width === 'number'
    && typeof value.height === 'number'
    && Array.isArray(value.objects)
    && isRecord(value.metadata)
    && (isRecord(value.metadata.fabricJson) || isRecord((value.metadata as { fabric?: unknown }).fabric));
}

export function fabricObjectToEditorObject(object: fabric.FabricObject, zIndex = 0): EditorObject {
  const base = fabricObjectToEditorObjectBase(object, zIndex);
  const type = normalizeFabricObjectType(object);
  if (type === 'group') {
    const group = object as fabric.Group & { getObjects?: () => fabric.FabricObject[] };
    return {
      ...base,
      type,
      objects: group.getObjects?.().map((child, index) => fabricObjectToEditorObject(child, index)) || [],
    } satisfies GroupObject;
  }
  if (type === 'text') {
    const text = object as fabric.Textbox | fabric.IText | fabric.Text;
    const custom = object as FabricObjectWithCustom;
    return {
      ...base,
      type,
      text: String(custom._psdTextContent || text.text || ''),
      fontSize: finiteNumber(text.fontSize),
      fontFamily: typeof text.fontFamily === 'string' ? text.fontFamily : undefined,
      fontWeight: typeof text.fontWeight === 'string' || typeof text.fontWeight === 'number'
        ? text.fontWeight
        : undefined,
      fontStyle: typeof text.fontStyle === 'string' ? text.fontStyle : undefined,
      underline: text.underline || undefined,
      linethrough: text.linethrough || undefined,
      textAlign: typeof text.textAlign === 'string' ? text.textAlign : undefined,
      lineHeight: finiteNumber(text.lineHeight),
      charSpacing: finiteNumber(text.charSpacing),
      fill: stringPaint(text.fill),
      stroke: stringPaint(text.stroke),
      strokeWidth: finiteNumber(text.strokeWidth),
      styles: isRecord((text as fabric.IText & { styles?: unknown }).styles)
        ? ((text as fabric.IText & { styles?: Record<string, unknown> }).styles)
        : undefined,
    };
  }
  if (type === 'image') {
    const image = object as fabric.FabricImage & { getSrc?: () => string; cropX?: number; cropY?: number };
    const naturalWidth = finiteNumber(image.width);
    const naturalHeight = finiteNumber(image.height);
    const cropLeft = finiteNumber(image.cropX);
    const cropTop = finiteNumber(image.cropY);
    return {
      ...base,
      type,
      src: image.getSrc?.(),
      naturalWidth,
      naturalHeight,
      crop: cropLeft !== undefined || cropTop !== undefined
        ? {
            left: cropLeft || 0,
            top: cropTop || 0,
            width: naturalWidth || base.width,
            height: naturalHeight || base.height,
          }
        : undefined,
    };
  }
  return shapeObjectToEditorObject(object, type, base);
}

function fabricObjectToEditorObjectBase(object: fabric.FabricObject, zIndex: number): EditorObjectBase {
  const custom = object as FabricObjectWithCustom;
  const id = custom._layerId ? String(custom._layerId) : ensureFabricObjectId(custom);
  return {
    id,
    name: typeof custom._layerName === 'string' ? custom._layerName : undefined,
    type: normalizeFabricObjectType(object),
    left: finiteNumber(object.left) || 0,
    top: finiteNumber(object.top) || 0,
    width: finiteNumber(object.width) || 0,
    height: finiteNumber(object.height) || 0,
    rotation: finiteNumber(object.angle) || 0,
    scaleX: finiteNumber(object.scaleX) || 1,
    scaleY: finiteNumber(object.scaleY) || 1,
    flipX: object.flipX || undefined,
    flipY: object.flipY || undefined,
    opacity: finiteNumber(object.opacity) ?? 1,
    visible: object.visible !== false,
    locked: object.selectable === false || custom._psdLocked === true || undefined,
    zIndex,
    metadata: objectMetadata(custom),
  };
}

function shapeObjectToEditorObject(
  object: fabric.FabricObject,
  type: ShapeObject['type'],
  base: EditorObjectBase,
): ShapeObject {
  const rect = object as fabric.Rect;
  const ellipse = object as fabric.Ellipse;
  const line = object as fabric.Line;
  return {
    ...base,
    type,
    fill: stringPaint(object.fill),
    stroke: stringPaint(object.stroke),
    strokeWidth: finiteNumber(object.strokeWidth),
    radius: type === 'rect' ? finiteNumber(rect.rx) : undefined,
    rx: type === 'ellipse' ? finiteNumber(ellipse.rx) : undefined,
    ry: type === 'ellipse' ? finiteNumber(ellipse.ry) : undefined,
    x1: type === 'line' ? finiteNumber(line.x1) : undefined,
    y1: type === 'line' ? finiteNumber(line.y1) : undefined,
    x2: type === 'line' ? finiteNumber(line.x2) : undefined,
    y2: type === 'line' ? finiteNumber(line.y2) : undefined,
  };
}

export function normalizeFabricObjectType(object: fabric.FabricObject): EditorObject['type'] {
  if (object.type === 'image' || object instanceof fabric.FabricImage) return 'image';
  if (
    object.type === 'i-text'
    || object.type === 'textbox'
    || object.type === 'text'
    || object instanceof fabric.IText
    || object instanceof fabric.Textbox
    || object instanceof fabric.Text
  ) return 'text';
  if (object.type === 'ellipse' || object instanceof fabric.Ellipse) return 'ellipse';
  if (object.type === 'triangle' || object instanceof fabric.Triangle) return 'triangle';
  if (object.type === 'line' || object instanceof fabric.Line) return 'line';
  if (object.type === 'group') return 'group';
  return 'rect';
}

function objectMetadata(object: FabricObjectWithCustom): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  if (object._layerType) metadata.layerType = object._layerType;
  if (object._psdLayerBounds) metadata.psdLayerBounds = object._psdLayerBounds;
  if (object._psdPreviewVisualBounds) metadata.psdPreviewVisualBounds = object._psdPreviewVisualBounds;
  if (object._psdTextPreview) metadata.psdTextPreview = object._psdTextPreview;
  if (object._psdTextOptions) metadata.psdTextOptions = object._psdTextOptions;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function ensureFabricObjectId(object: FabricObjectWithCustom) {
  object._layerId = `layer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return String(object._layerId);
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function stringPaint(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
