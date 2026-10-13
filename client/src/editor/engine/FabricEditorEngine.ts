import * as fabric from 'fabric';
import { markPsdNativeEffectOverride } from '../psdImportState';
import {
  fabricObjectToEditorObject,
  loadEditorDocumentIntoFabricCanvas,
  serializeFabricCanvasToDocument,
} from './fabricDocument';
import type { EditorDocument, EditorEngine, EditorObjectPatch, EditorShapeType } from './types';
import { DEFAULT_CN_EDIT_FONT_FAMILY } from '../fontDefaults';

type FabricCanvasOptions = ConstructorParameters<typeof fabric.Canvas>[1];

export type FabricEditorEngineOptions = FabricCanvasOptions & {
  width: number;
  height: number;
};

export class FabricEditorEngine implements EditorEngine {
  private canvas: fabric.Canvas | null = null;

  constructor(private readonly options: FabricEditorEngineOptions) {}

  mount(element: HTMLCanvasElement) {
    this.canvas = new fabric.Canvas(element, this.options);
  }

  dispose() {
    const canvas = this.canvas;
    this.canvas = null;
    if (canvas) void canvas.dispose();
  }

  getFabricCanvas() {
    return this.canvas;
  }

  async addImage(url: string) {
    const canvas = this.requireCanvas();
    const image = await fabric.FabricImage.fromURL(url, { crossOrigin: 'anonymous' });
    const scale = Math.min(canvas.getWidth() / (image.width || 1), canvas.getHeight() / (image.height || 1), 0.8);
    image.set({
      left: (canvas.getWidth() - (image.width || 0) * scale) / 2,
      top: (canvas.getHeight() - (image.height || 0) * scale) / 2,
      scaleX: scale,
      scaleY: scale,
    });
    canvas.add(image);
    canvas.setActiveObject(image);
    canvas.requestRenderAll();
  }

  addText(text: string) {
    const canvas = this.requireCanvas();
    const object = new fabric.IText(text, {
      left: canvas.getWidth() / 2,
      top: canvas.getHeight() / 2,
      originX: 'center',
      originY: 'center',
      fontSize: 28,
      fill: '#141413',
      fontFamily: DEFAULT_CN_EDIT_FONT_FAMILY,
    });
    canvas.add(object);
    canvas.setActiveObject(object);
    canvas.requestRenderAll();
  }

  addShape(type: EditorShapeType) {
    const canvas = this.requireCanvas();
    const common = {
      left: canvas.getWidth() / 2,
      top: canvas.getHeight() / 2,
      originX: 'center' as const,
      originY: 'center' as const,
      fill: '#EAF4F2',
      stroke: '#1A6B6B',
      strokeWidth: 0,
    };
    const object = type === 'ellipse'
      ? new fabric.Ellipse({ ...common, rx: 80, ry: 56 })
      : type === 'triangle'
        ? new fabric.Triangle({ ...common, width: 140, height: 120 })
        : type === 'line'
          ? new fabric.Line([-70, 0, 70, 0], { ...common, fill: undefined, strokeWidth: 4 })
          : new fabric.Rect({ ...common, width: 140, height: 100 });
    canvas.add(object);
    canvas.setActiveObject(object);
    canvas.requestRenderAll();
  }

  getActiveObject() {
    const active = this.canvas?.getActiveObject();
    return active ? fabricObjectToEditorObject(active) : null;
  }

  updateActiveObject(patch: EditorObjectPatch) {
    const canvas = this.requireCanvas();
    const active = canvas.getActiveObject();
    if (!active) return;
    const values: Record<string, unknown> = { ...patch };
    if (patch.stroke !== undefined || patch.strokeWidth !== undefined) markPsdNativeEffectOverride(active, 'stroke');
    if (typeof patch.rotation === 'number') {
      values.angle = patch.rotation;
      delete values.rotation;
    }
    active.set(values);
    active.setCoords();
    canvas.requestRenderAll();
    canvas.fire('object:modified', { target: active });
  }

  removeActiveObject() {
    const canvas = this.requireCanvas();
    const activeObjects = canvas.getActiveObjects();
    activeObjects.forEach((object) => canvas.remove(object));
    canvas.discardActiveObject();
    canvas.requestRenderAll();
  }

  duplicateActiveObject() {
    const canvas = this.requireCanvas();
    const active = canvas.getActiveObject();
    if (!active) return;
    void active.clone().then((clone) => {
      clone.set({
        left: Number(clone.left || 0) + 24,
        top: Number(clone.top || 0) + 24,
      });
      canvas.add(clone);
      canvas.setActiveObject(clone);
      canvas.requestRenderAll();
      canvas.fire('object:modified', { target: clone });
    });
  }

  setZoom(value: number) {
    const canvas = this.requireCanvas();
    const zoom = Math.max(0.1, Math.min(4, value / 100));
    canvas.setZoom(zoom);
    canvas.requestRenderAll();
  }

  fitToViewport() {
    this.requireCanvas().requestRenderAll();
  }

  serialize(): EditorDocument {
    return serializeFabricCanvasToDocument(this.requireCanvas());
  }

  async load(document: EditorDocument) {
    await loadEditorDocumentIntoFabricCanvas(this.requireCanvas(), document);
  }

  async exportPng(): Promise<Blob> {
    const canvas = this.requireCanvas();
    const dataUrl = canvas.toDataURL({ format: 'png', multiplier: 1 });
    const response = await fetch(dataUrl);
    return response.blob();
  }

  private requireCanvas() {
    if (!this.canvas) throw new Error('Editor engine is not mounted.');
    return this.canvas;
  }
}
