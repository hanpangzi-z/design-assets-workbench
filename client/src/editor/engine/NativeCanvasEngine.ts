import type {
  EditorDocument,
  EditorEngine,
  EditorEngineEvent,
  EditorEngineEventHandler,
  EditorObject,
  EditorObjectBase,
  EditorObjectPatch,
  EditorShapeType,
  ImageObject,
  ShapeObject,
  TextObject,
} from './types';
import { DEFAULT_CN_EDIT_FONT_FAMILY } from '../fontDefaults';

export type NativeCanvasEngineOptions = {
  width: number;
  height: number;
  backgroundColor?: string;
};

type NativeObject = EditorObject & {
  imageElement?: HTMLImageElement;
};

type CanvasPoint = { x: number; y: number };

const DEFAULT_FILL = '#EAF4F2';
const DEFAULT_STROKE = '#1A6B6B';
const DEFAULT_TEXT_FILL = '#141413';

export class NativeCanvasEngine implements EditorEngine {
  private element: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private objects: NativeObject[] = [];
  private activeObjectId: string | null = null;
  private dragStart: { pointer: CanvasPoint; objectLeft: number; objectTop: number } | null = null;
  private zoom = 1;
  private listeners: Record<EditorEngineEvent, Set<EditorEngineEventHandler>> = {
    selectionchange: new Set(),
    change: new Set(),
  };
  private readonly backgroundColor: string;

  private readonly handlePointerDown = (event: PointerEvent) => {
    const point = this.getCanvasPoint(event);
    if (!point) return;
    const target = this.findObjectAt(point);
    this.setActiveObjectId(target?.id || null);
    if (target && !target.locked) {
      this.dragStart = {
        pointer: point,
        objectLeft: target.left,
        objectTop: target.top,
      };
      this.element?.setPointerCapture?.(event.pointerId);
    }
    this.render();
  };

  private readonly handlePointerMove = (event: PointerEvent) => {
    if (!this.dragStart || !this.activeObjectId) return;
    const point = this.getCanvasPoint(event);
    const object = this.getNativeActiveObject();
    if (!point || !object || object.locked) return;
    object.left = this.dragStart.objectLeft + point.x - this.dragStart.pointer.x;
    object.top = this.dragStart.objectTop + point.y - this.dragStart.pointer.y;
    this.render();
  };

  private readonly handlePointerUp = (event: PointerEvent) => {
    const hadDrag = Boolean(this.dragStart);
    this.dragStart = null;
    this.element?.releasePointerCapture?.(event.pointerId);
    if (hadDrag) this.emit('change');
  };

  private readonly handleKeyDown = (event: KeyboardEvent) => {
    if ((event.key === 'Delete' || event.key === 'Backspace') && this.activeObjectId) {
      this.removeActiveObject();
      event.preventDefault();
    }
  };

  constructor(options: NativeCanvasEngineOptions) {
    this.backgroundColor = options.backgroundColor || '#ffffff';
    this.resize(options.width, options.height);
  }

  mount(element: HTMLCanvasElement) {
    this.element = element;
    this.ctx = element.getContext('2d');
    element.width = this.width;
    element.height = this.height;
    element.tabIndex = 0;
    element.style.outline = 'none';
    element.addEventListener('pointerdown', this.handlePointerDown);
    element.addEventListener('pointermove', this.handlePointerMove);
    element.addEventListener('pointerup', this.handlePointerUp);
    element.addEventListener('pointercancel', this.handlePointerUp);
    element.addEventListener('keydown', this.handleKeyDown);
    this.render();
  }

  dispose() {
    if (this.element) {
      this.element.removeEventListener('pointerdown', this.handlePointerDown);
      this.element.removeEventListener('pointermove', this.handlePointerMove);
      this.element.removeEventListener('pointerup', this.handlePointerUp);
      this.element.removeEventListener('pointercancel', this.handlePointerUp);
      this.element.removeEventListener('keydown', this.handleKeyDown);
    }
    this.element = null;
    this.ctx = null;
    this.dragStart = null;
  }

  async addImage(url: string) {
    const imageElement = await loadImage(url);
    const maxWidth = this.width * 0.8;
    const maxHeight = this.height * 0.8;
    const scale = Math.min(maxWidth / imageElement.naturalWidth, maxHeight / imageElement.naturalHeight, 1);
    const width = imageElement.naturalWidth * scale;
    const height = imageElement.naturalHeight * scale;
    const object: NativeObject = {
      ...createBaseObject('image', (this.width - width) / 2, (this.height - height) / 2, width, height),
      type: 'image',
      src: url,
      naturalWidth: imageElement.naturalWidth,
      naturalHeight: imageElement.naturalHeight,
      imageElement,
    };
    this.addObject(object);
  }

  addText(text: string) {
    const fontSize = 28;
    const object: NativeObject = {
      ...createBaseObject('text', this.width / 2 - 80, this.height / 2 - fontSize, 160, fontSize * 1.4),
      type: 'text',
      text,
      fontSize,
      fontFamily: DEFAULT_CN_EDIT_FONT_FAMILY,
      fill: DEFAULT_TEXT_FILL,
    };
    this.addObject(object);
  }

  addShape(type: EditorShapeType) {
    const size = type === 'line'
      ? { width: 160, height: 4 }
      : type === 'triangle'
        ? { width: 140, height: 120 }
        : { width: 140, height: 100 };
    const object: NativeObject = {
      ...createBaseObject(type, (this.width - size.width) / 2, (this.height - size.height) / 2, size.width, size.height),
      type,
      fill: type === 'line' ? undefined : DEFAULT_FILL,
      stroke: DEFAULT_STROKE,
      strokeWidth: type === 'line' ? 4 : 0,
      ...(type === 'ellipse' ? { rx: size.width / 2, ry: size.height / 2 } : {}),
      ...(type === 'line' ? { x1: 0, y1: size.height / 2, x2: size.width, y2: size.height / 2 } : {}),
    };
    this.addObject(object);
  }

  getActiveObject(): EditorObject | null {
    const object = this.getNativeActiveObject();
    return object ? cloneSerializableObject(object) : null;
  }

  updateActiveObject(patch: EditorObjectPatch) {
    const object = this.getNativeActiveObject();
    if (!object) return;
    applyPatchToObject(object, patch);
    this.render();
    this.emit('change');
    this.emit('selectionchange');
  }

  removeActiveObject() {
    if (!this.activeObjectId) return;
    this.objects = this.objects.filter((object) => object.id !== this.activeObjectId);
    this.setActiveObjectId(null);
    this.render();
    this.emit('change');
  }

  duplicateActiveObject() {
    const active = this.getNativeActiveObject();
    if (!active) return;
    const clone: NativeObject = {
      ...cloneSerializableObject(active),
      id: createObjectId(),
      left: active.left + 24,
      top: active.top + 24,
      imageElement: active.imageElement,
    } as NativeObject;
    this.objects.push(clone);
    this.setActiveObjectId(clone.id);
    this.render();
    this.emit('change');
  }

  on(event: EditorEngineEvent, handler: EditorEngineEventHandler) {
    this.listeners[event].add(handler);
    return () => this.listeners[event].delete(handler);
  }

  setZoom(value: number) {
    this.zoom = Math.max(0.1, Math.min(4, value / 100));
    this.render();
  }

  fitToViewport() {
    this.zoom = 1;
    this.render();
  }

  serialize(): EditorDocument {
    return {
      version: 1,
      width: this.width,
      height: this.height,
      objects: this.objects.map(cloneSerializableObject),
      metadata: { sourceEngine: 'native-canvas' },
    };
  }

  async load(document: EditorDocument) {
    this.resize(document.width, document.height);
    const objects = document.objects.map((object, index) => ({
      ...cloneSerializableObject(object),
      zIndex: object.zIndex ?? index,
    })) as NativeObject[];
    await Promise.all(objects.map(async (object) => {
      if (object.type === 'image' && object.src) {
        try {
          object.imageElement = await loadImage(object.src);
        } catch {
          object.imageElement = undefined;
        }
      }
    }));
    this.objects = objects;
    this.setActiveObjectId(null);
    this.render();
    this.emit('change');
  }

  async exportPng(): Promise<Blob> {
    const element = this.requireElement();
    return new Promise((resolve, reject) => {
      element.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Failed to export native canvas.'));
      }, 'image/png');
    });
  }

  private width = 1;
  private height = 1;

  private resize(width: number, height: number) {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    if (this.element) {
      this.element.width = this.width;
      this.element.height = this.height;
    }
  }

  private addObject(object: NativeObject) {
    object.zIndex = this.objects.length;
    this.objects.push(object);
    this.setActiveObjectId(object.id);
    this.render();
    this.emit('change');
  }

  private setActiveObjectId(id: string | null) {
    if (this.activeObjectId === id) return;
    this.activeObjectId = id;
    this.emit('selectionchange');
  }

  private emit(event: EditorEngineEvent) {
    this.listeners[event].forEach((handler) => handler());
  }

  private render() {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = this.backgroundColor;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.scale(this.zoom, this.zoom);
    this.objects.forEach((object) => this.renderObject(ctx, object));
    const active = this.getNativeActiveObject();
    if (active) this.renderSelection(ctx, active);
    ctx.restore();
  }

  private renderObject(ctx: CanvasRenderingContext2D, object: NativeObject) {
    if (object.visible === false) return;
    ctx.save();
    ctx.globalAlpha = object.opacity;
    const width = object.width * object.scaleX;
    const height = object.height * object.scaleY;
    const centerX = object.left + width / 2;
    const centerY = object.top + height / 2;
    ctx.translate(centerX, centerY);
    ctx.rotate((object.rotation * Math.PI) / 180);
    ctx.scale(object.flipX ? -1 : 1, object.flipY ? -1 : 1);
    ctx.translate(-width / 2, -height / 2);

    if (object.type === 'image') this.renderImage(ctx, object, width, height);
    else if (object.type === 'text') this.renderText(ctx, object, width);
    else if (isShapeObject(object)) this.renderShape(ctx, object, width, height);
    ctx.restore();
  }

  private renderImage(ctx: CanvasRenderingContext2D, object: NativeObject, width: number, height: number) {
    if (object.imageElement) {
      ctx.drawImage(object.imageElement, 0, 0, width, height);
      return;
    }
    ctx.fillStyle = '#f3f4f6';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = '#cbd5e1';
    ctx.strokeRect(0, 0, width, height);
  }

  private renderText(ctx: CanvasRenderingContext2D, object: TextObject, width: number) {
    const fontSize = object.fontSize || 28;
    ctx.fillStyle = object.fill || DEFAULT_TEXT_FILL;
    ctx.font = `${object.fontStyle || 'normal'} ${object.fontWeight || 400} ${fontSize}px ${object.fontFamily || 'sans-serif'}`;
    ctx.textAlign = (object.textAlign as CanvasTextAlign) || 'left';
    ctx.textBaseline = 'top';
    wrapText(ctx, object.text, 0, 0, width, fontSize * (object.lineHeight || 1.2));
  }

  private renderShape(ctx: CanvasRenderingContext2D, object: ShapeObject, width: number, height: number) {
    ctx.beginPath();
    if (object.type === 'ellipse') {
      ctx.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
    } else if (object.type === 'triangle') {
      ctx.moveTo(width / 2, 0);
      ctx.lineTo(width, height);
      ctx.lineTo(0, height);
      ctx.closePath();
    } else if (object.type === 'line') {
      ctx.moveTo(object.x1 || 0, object.y1 ?? height / 2);
      ctx.lineTo(object.x2 ?? width, object.y2 ?? height / 2);
    } else {
      ctx.rect(0, 0, width, height);
    }
    if (object.fill) {
      ctx.fillStyle = object.fill;
      ctx.fill();
    }
    if (object.stroke || object.type === 'line') {
      ctx.strokeStyle = object.stroke || DEFAULT_STROKE;
      ctx.lineWidth = object.strokeWidth || 1;
      ctx.stroke();
    }
  }

  private renderSelection(ctx: CanvasRenderingContext2D, object: NativeObject) {
    const rect = getObjectBounds(object);
    ctx.save();
    ctx.strokeStyle = '#2557f6';
    ctx.lineWidth = 1 / this.zoom;
    ctx.setLineDash([6 / this.zoom, 4 / this.zoom]);
    ctx.strokeRect(rect.left, rect.top, rect.width, rect.height);
    ctx.restore();
  }

  private findObjectAt(point: CanvasPoint) {
    const scenePoint = { x: point.x / this.zoom, y: point.y / this.zoom };
    for (let i = this.objects.length - 1; i >= 0; i -= 1) {
      const object = this.objects[i];
      if (object.visible === false || object.opacity <= 0) continue;
      const rect = getObjectBounds(object);
      if (
        scenePoint.x >= rect.left
        && scenePoint.x <= rect.left + rect.width
        && scenePoint.y >= rect.top
        && scenePoint.y <= rect.top + rect.height
      ) return object;
    }
    return null;
  }

  private getCanvasPoint(event: PointerEvent): CanvasPoint | null {
    const element = this.element;
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: ((event.clientX - rect.left) / rect.width) * this.width,
      y: ((event.clientY - rect.top) / rect.height) * this.height,
    };
  }

  private getNativeActiveObject() {
    return this.objects.find((object) => object.id === this.activeObjectId) || null;
  }

  private requireElement() {
    if (!this.element) throw new Error('Native canvas engine is not mounted.');
    return this.element;
  }
}

function createBaseObject(
  type: EditorObject['type'],
  left: number,
  top: number,
  width: number,
  height: number,
): EditorObjectBase {
  return {
    id: createObjectId(),
    type,
    left,
    top,
    width,
    height,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    visible: true,
  };
}

function cloneSerializableObject<T extends EditorObject>(object: T): T {
  const { imageElement: _imageElement, ...serializable } = object as T & { imageElement?: HTMLImageElement };
  return { ...serializable } as T;
}

function applyPatchToObject(object: NativeObject, patch: EditorObjectPatch) {
  const numericKeys: Array<keyof EditorObjectPatch> = [
    'left',
    'top',
    'width',
    'height',
    'rotation',
    'scaleX',
    'scaleY',
    'opacity',
    'strokeWidth',
    'fontSize',
  ];
  numericKeys.forEach((key) => {
    const value = patch[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      (object as unknown as Record<string, number>)[key] = value;
    }
  });
  if (typeof patch.visible === 'boolean') object.visible = patch.visible;
  if (typeof patch.locked === 'boolean') object.locked = patch.locked;
  if ('fill' in patch && isFillableObject(object)) object.fill = patch.fill;
  if ('stroke' in patch && isStrokeableObject(object)) object.stroke = patch.stroke;
  if (typeof patch.text === 'string' && object.type === 'text') object.text = patch.text;
  object.width = Math.max(1, object.width);
  object.height = Math.max(1, object.height);
  object.scaleX = Math.max(0.01, object.scaleX);
  object.scaleY = Math.max(0.01, object.scaleY);
  object.opacity = Math.max(0, Math.min(1, object.opacity));
}

function getObjectBounds(object: EditorObject) {
  return {
    left: object.left,
    top: object.top,
    width: object.width * object.scaleX,
    height: object.height * object.scaleY,
  };
}

function createObjectId() {
  return `native-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isShapeObject(object: EditorObject): object is ShapeObject {
  return object.type === 'rect'
    || object.type === 'ellipse'
    || object.type === 'triangle'
    || object.type === 'line';
}

function isFillableObject(object: EditorObject): object is TextObject | ShapeObject {
  return object.type === 'text' || isShapeObject(object);
}

function isStrokeableObject(object: EditorObject): object is TextObject | ShapeObject {
  return object.type === 'text' || isShapeObject(object);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    image.src = url;
  });
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
) {
  const paragraphs = String(text || '').split(/\r\n|\r|\n/);
  let cursorY = y;
  paragraphs.forEach((paragraph) => {
    let line = '';
    Array.from(paragraph).forEach((char) => {
      const testLine = `${line}${char}`;
      if (line && ctx.measureText(testLine).width > maxWidth) {
        ctx.fillText(line, x, cursorY);
        line = char;
        cursorY += lineHeight;
      } else {
        line = testLine;
      }
    });
    ctx.fillText(line, x, cursorY);
    cursorY += lineHeight;
  });
}
