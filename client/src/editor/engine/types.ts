export type EditorShapeType = 'rect' | 'ellipse' | 'triangle' | 'line';
export type EditorObjectType = 'image' | 'text' | EditorShapeType | 'group';

export type EditorObjectBase = {
  id: string;
  name?: string;
  type: EditorObjectType;
  left: number;
  top: number;
  width: number;
  height: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  flipX?: boolean;
  flipY?: boolean;
  opacity: number;
  visible: boolean;
  locked?: boolean;
  zIndex?: number;
  metadata?: Record<string, unknown>;
};

export type EditorCrop = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type ImageObject = EditorObjectBase & {
  type: 'image';
  src?: string;
  naturalWidth?: number;
  naturalHeight?: number;
  crop?: EditorCrop;
};

export type TextObject = EditorObjectBase & {
  type: 'text';
  text: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: string | number;
  fontStyle?: string;
  underline?: boolean;
  linethrough?: boolean;
  textAlign?: string;
  lineHeight?: number;
  charSpacing?: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  styles?: Record<string, unknown>;
};

export type ShapeObject = EditorObjectBase & {
  type: EditorShapeType;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  radius?: number;
  rx?: number;
  ry?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
};

export type GroupObject = EditorObjectBase & {
  type: 'group';
  objects: EditorObject[];
};

export type EditorObject = ImageObject | TextObject | ShapeObject | GroupObject;

export type EditorDocumentMetadata = {
  sourceEngine?: 'fabric' | 'native-canvas' | string;
  fabricJson?: Record<string, unknown>;
  [key: string]: unknown;
};

export type EditorDocument = {
  version: number;
  width: number;
  height: number;
  objects: EditorObject[];
  metadata?: EditorDocumentMetadata;
};

export type EditorObjectPatch = Partial<
  Pick<EditorObjectBase, 'left' | 'top' | 'width' | 'height' | 'rotation' | 'scaleX' | 'scaleY' | 'opacity' | 'visible' | 'locked'>
> & {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  text?: string;
  fontSize?: number;
};

export type EditorEngineEvent = 'selectionchange' | 'change';
export type EditorEngineEventHandler = () => void;

export interface EditorEngine {
  mount(element: HTMLCanvasElement): void;
  dispose(): void;

  addImage(url: string): Promise<void>;
  addText(text: string): void;
  addShape(type: EditorShapeType): void;

  getActiveObject(): EditorObject | null;
  updateActiveObject(patch: EditorObjectPatch): void;
  removeActiveObject(): void;
  duplicateActiveObject(): void;

  on?(event: EditorEngineEvent, handler: EditorEngineEventHandler): () => void;

  setZoom(value: number): void;
  fitToViewport(): void;

  serialize(): EditorDocument;
  load(document: EditorDocument): Promise<void>;

  exportPng(): Promise<Blob>;
}
