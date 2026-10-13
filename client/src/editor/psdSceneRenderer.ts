import type * as fabric from 'fabric';
import type { ParsedLayer } from 'shared/types';
import {
  adjustPixels, blendPixels, blurAlpha, clamp, createGradientSampler, interpolatePixels, normalizeBlendMode,
  number, opacity, psdColor, spreadAlpha, supportedAdjustments, supportedBlendModes, unit,
  type PsdRecord,
} from './psdScenePixels';

export interface PsdSceneDiagnostic {
  sourceKey: string;
  layerKey: string;
  layerName: string;
  code: string;
  message: string;
  severity: 'warning' | 'error';
}
export interface PsdSceneMetadata {
  version: 1;
  width: number;
  height: number;
  layers: ParsedLayer[];
  compositeImagePath?: string;
  sourcePreview?: boolean;
  sourceEdited?: boolean;
  initialDiagnostics?: PsdSceneOptions['externalDiagnostics'];
}
export interface PsdSceneOptions {
  width?: number;
  height?: number;
  compositeImagePath?: string;
  sourceEdited?: boolean;
  maxWorkingBytes?: number;
  externalDiagnostics?: Array<{ code: string; message: string; severity: 'warning' | 'error'; layerKey?: string; layerName?: string }>;
  initialDiagnostics?: PsdSceneOptions['externalDiagnostics'];
  /** Import ownership check: a route/load change must not install a stale hook. */
  isCurrent?: () => boolean;
  resolveAssetUrl?: (path: string) => string;
  onDiagnostics?: (diagnostics: PsdSceneDiagnostic[]) => void;
  /** Native canvas/image boundaries also allow export tests without a browser process. */
  createCanvas?: (width: number, height: number) => HTMLCanvasElement;
  loadImage?: (url: string) => Promise<CanvasImageSource>;
}
export interface PsdSceneSession {
  refresh(): void;
  updateLayer(sourceKey: string, changes: { visible?: boolean; opacity?: number; blendMode?: string }): void;
  dispose(): void;
  getDiagnostics(): PsdSceneDiagnostic[];
  getSourcePreview(): boolean;
  setSourcePreview(enabled: boolean): void;
}
type Matrix = [number, number, number, number, number, number];
type SceneObject = fabric.FabricObject & {
  _psdSourceKey?: string;
  _psdClipBaseKey?: string;
  _psdOwnVisible?: boolean;
  _psdSceneObject?: boolean;
  _psdOriginalTransform?: Matrix;
  _psdOriginalDimensions?: number[];
  _psdMask?: PsdRecord;
};
type SceneCanvas = fabric.Canvas & {
  __psdScene?: PsdSceneMetadata;
  __psdSceneVersion?: number;
  __psdVisibilityOverrides?: Record<string, boolean>;
  __psdSceneSession?: PsdSceneSession;
};

const props = (layer: ParsedLayer): PsdRecord => layer.properties || {};
export const getPsdSourceKey = (layer: ParsedLayer) => String(props(layer).psdSourceKey ?? props(layer).sourceKey ?? layer.id);
function walk(layers: ParsedLayer[], visit: (layer: ParsedLayer) => void) {
  for (const layer of layers) { visit(layer); if (layer.children) walk(layer.children, visit); }
}
function surface(width: number, height: number) { const result = document.createElement('canvas'); result.width = width; result.height = height; return result; }
async function browserImage(url: string): Promise<HTMLImageElement> {
  const result = new Image(); result.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => { result.onload = () => resolve(); result.onerror = () => reject(new Error(`PSD asset could not be loaded: ${url}`)); result.src = url; });
  return result;
}
function multiplyMatrix(a: Matrix, b: Matrix): Matrix {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}
function inverseMatrix(m: Matrix): Matrix | null {
  const det = m[0] * m[3] - m[1] * m[2]; if (Math.abs(det) < 1e-10) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

export async function restorePsdScene(canvas: fabric.Canvas, options: PsdSceneOptions = {}): Promise<PsdSceneSession | null> {
  const metadata = (canvas as SceneCanvas).__psdScene;
  if (!metadata || metadata.version !== 1 || !Array.isArray(metadata.layers)) return null;
  const session = await installPsdScene(canvas, metadata.layers, { ...options, externalDiagnostics: options.externalDiagnostics || options.initialDiagnostics || metadata.initialDiagnostics, sourceEdited: metadata.sourceEdited, compositeImagePath: options.compositeImagePath || metadata.compositeImagePath, width: metadata.width, height: metadata.height });
  if (typeof metadata.sourcePreview === 'boolean') session.setSourcePreview(metadata.sourcePreview);
  return session;
}

/**
 * Keep Fabric source objects editable and serializable. Replace only the canvas drawing
 * entrypoint, which is shared by normal render and toCanvasElement/toDataURL export.
 * Pixel hit testing and source object sampling continue to use ordinary Fabric rendering.
 */
export async function installPsdScene(canvas: fabric.Canvas, layers: ParsedLayer[], options: PsdSceneOptions = {}): Promise<PsdSceneSession> {
  const target = canvas as SceneCanvas;
  target.__psdSceneSession?.dispose();
  const lifecycle = target as SceneCanvas & { __psdInstallGeneration?: number };
  const generation = (lifecycle.__psdInstallGeneration || 0) + 1;
  lifecycle.__psdInstallGeneration = generation;
  const width = Math.round(options.width ?? target.__psdScene?.width ?? canvas.getWidth());
  const height = Math.round(options.height ?? target.__psdScene?.height ?? canvas.getHeight());
  if (!(width > 0 && height > 0 && width * height <= 200_000_000)) throw new Error('PSD scene dimensions exceed the rendering memory limit.');
  const metadata: PsdSceneMetadata = { version: 1, width, height, layers: JSON.parse(JSON.stringify(layers)), compositeImagePath: options.compositeImagePath, sourceEdited: options.sourceEdited === true, initialDiagnostics: options.externalDiagnostics || options.initialDiagnostics };
  const depth = (siblings: ParsedLayer[]): number => siblings.length ? Math.max(...siblings.map((layer) => layer.children?.length ? 1 + depth(layer.children) : 0)) : 0;
  const estimatedWorkingBytes = width * height * 4 * (8 + depth(metadata.layers) * 2);
  const budgetExceeded = estimatedWorkingBytes > (options.maxWorkingBytes ?? 256 * 1024 * 1024);
  const factory = options.createCanvas || surface, loadImage = options.loadImage || browserImage;
  const images = new Map<string, CanvasImageSource>(), diagnostics = new Map<string, PsdSceneDiagnostic>();
  const nodes = new Map<string, ParsedLayer>();
  let disposed = false, installing = true, rendering = false;
  walk(metadata.layers, (layer) => nodes.set(getPsdSourceKey(layer), layer));
  const diagnose = (layer: ParsedLayer, code: string, message: string) => {
    const sourceKey = getPsdSourceKey(layer), key = `${sourceKey}:${code}`;
    if (diagnostics.has(key)) return;
    diagnostics.set(key, { sourceKey, layerKey: sourceKey, layerName: layer.layerName || sourceKey, code, message, severity: code === 'scene-render-failed' ? 'error' : 'warning' });
    if (!installing) options.onDiagnostics?.([...diagnostics.values()]);
  };
  for (const diagnostic of metadata.initialDiagnostics || []) {
    const sourceKey = diagnostic.layerKey || '';
    diagnostics.set(`${sourceKey}:${diagnostic.code}`, { ...diagnostic, sourceKey, layerKey: sourceKey, layerName: diagnostic.layerName || sourceKey });
  }
  const assetPaths = new Map<string, ParsedLayer>();
  walk(metadata.layers, (layer) => {
    const properties = props(layer);
    for (const path of [properties.psdMask?.imagePath, properties.psdUserMask?.imagePath, properties.psdFallbackImagePath]) if (typeof path === 'string') assetPaths.set(path, layer);
  });
  if (budgetExceeded && metadata.layers[0]) diagnose(metadata.layers[0], 'scene-memory-budget', '图层合成预计超过浏览器离屏内存预算，已保留原稿完整尺寸的保真预览；当前仅能查看原稿，编辑后的图层合成不可用。');
  if (options.compositeImagePath && metadata.layers[0]) assetPaths.set(options.compositeImagePath, metadata.layers[0]);
  // Limit concurrent decoded masks; large layer sets must not initiate hundreds of images at once.
  const pending = [...assetPaths.entries()];
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (pending.length) {
      const [path, layer] = pending.pop()!;
      try { images.set(path, await loadImage(options.resolveAssetUrl?.(path) || path)); }
      catch { diagnose(layer, path === options.compositeImagePath ? 'source-preview-missing' : 'mask-asset-missing', '蒙版或保真底图无法读取；该图层的合成结果可能不同。'); }
    }
  }));
  if (lifecycle.__psdInstallGeneration !== generation || options.isCurrent?.() === false || canvas.destroyed) {
    images.clear(); throw Object.assign(new Error('PSD scene import was superseded.'), { name: 'AbortError' });
  }
  installing = false;
  const make = () => factory(width, height);
  const ctx = (value: HTMLCanvasElement) => {
    const context = value.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('PSD renderer could not allocate a 2D surface.');
    return context;
  };
  const pixels = (value: HTMLCanvasElement) => ctx(value).getImageData(0, 0, width, height);
  const write = (value: HTMLCanvasElement, data: Uint8ClampedArray) => { const context = ctx(value), image = context.createImageData(width, height); image.data.set(data); context.putImageData(image, 0, 0); };
  const copy = (value: HTMLCanvasElement) => { const out = make(); ctx(out).drawImage(value, 0, 0); return out; };
  let objects = new Map<string, SceneObject>(), order = new Map<string, number>();
  let sceneOrder = new Map<fabric.FabricObject, number>();
  const identities = new WeakMap<object, number>(); let nextIdentity = 0, revision = 0;
  const identity = (value: object) => { if (!identities.has(value)) identities.set(value, ++nextIdentity); return identities.get(value)!; };
  let cached: HTMLCanvasElement | null = null, cachedSignature = '';
  const isSelection = (object: fabric.FabricObject) => String(object.type).toLowerCase() === 'activeselection';
  const hasSourceDescendant = (object: fabric.FabricObject): boolean => {
    if (nodes.has((object as SceneObject)._psdSourceKey || '')) return true;
    return typeof (object as fabric.Group).getObjects === 'function' && (object as fabric.Group).getObjects().some(hasSourceDescendant);
  };
  const expandObjects = (values: fabric.FabricObject[]) => {
    const flattened: fabric.FabricObject[] = [], seen = new Set<fabric.FabricObject>();
    const expand = (object: fabric.FabricObject) => {
      if (isSelection(object) || (String(object.type).toLowerCase() === 'group' && hasSourceDescendant(object))) {
        (object as fabric.Group).getObjects().forEach(expand); return;
      }
      if (!seen.has(object)) { seen.add(object); flattened.push(object); }
    };
    values.forEach(expand); return flattened;
  };
  const captureObjects = () => {
    nodes.clear(); walk(metadata.layers, (layer) => nodes.set(getPsdSourceKey(layer), layer));
    objects = new Map(); order = new Map();
    const flattened = expandObjects(canvas.getObjects());
    sceneOrder = new Map(flattened.map((object, index) => [object, index]));
    flattened.forEach((value, index) => {
      const object = value as SceneObject;
      if (!object._psdSourceKey || !nodes.has(object._psdSourceKey)) return;
      if (objects.has(object._psdSourceKey)) {
        const oldKey = object._psdSourceKey, original = nodes.get(oldKey)!, newKey = `${oldKey}:copy:${identity(object)}`;
        const duplicate: ParsedLayer = JSON.parse(JSON.stringify(original));
        duplicate.properties = { ...duplicate.properties, psdSourceKey: newKey, psdClipBaseKey: undefined, clipping: false };
        duplicate.id = -identity(object); duplicate.children = undefined;
        const insert = (siblings: ParsedLayer[]): boolean => {
          const at = siblings.findIndex((layer) => getPsdSourceKey(layer) === oldKey);
          if (at >= 0) { siblings.splice(at + 1, 0, duplicate); return true; }
          return siblings.some((layer) => layer.children && insert(layer.children));
        };
        insert(metadata.layers); nodes.set(newKey, duplicate); object._psdSourceKey = newKey; object._psdClipBaseKey = undefined; revision++;
        diagnose(duplicate, 'copied-source', '复制图层已作为独立 PSD 图层合成，原图层的剪贴关系不会被复用。');
      }
      objects.set(object._psdSourceKey, object); order.set(object._psdSourceKey, index);
      object._psdSceneObject = true;
      if (!object._psdOriginalTransform) object._psdOriginalTransform = [...object.calcTransformMatrix()] as Matrix;
      if (!object._psdOriginalDimensions) { const anchor = object.getXY(); object._psdOriginalDimensions = [object.width, object.height, typeof object.originX === 'number' ? object.originX - 0.5 : object.originX === 'right' ? 0.5 : object.originX === 'center' ? 0 : -0.5, typeof object.originY === 'number' ? object.originY - 0.5 : object.originY === 'bottom' ? 0.5 : object.originY === 'center' ? 0 : -0.5, anchor.x, anchor.y]; }
      const node = nodes.get(object._psdSourceKey)!;
      if (object._psdOwnVisible === undefined) object._psdOwnVisible = node.visible !== false;
      for (let parent = object.group; parent; parent = parent.group) {
        if (!isSelection(parent) && (parent.opacity !== 1 || parent.globalCompositeOperation !== 'source-over' || parent.clipPath)) diagnose(node, 'native-group-style-approximate', '用户组合的变换已保留；组合透明度、混合或裁剪与 PSD 父组交互时可能有差异，请解组后分别编辑或核对原稿。');
      }
    });
  };
  captureObjects();
  walk(metadata.layers, (layer) => { if (layer.imagePath && layer.layerType !== 'group' && !objects.has(getPsdSourceKey(layer))) diagnose(layer, 'source-asset-missing', '源图层像素未加载，初始外观使用原稿完整合成图保留。'); });
  const firstObject = (layer: ParsedLayer): SceneObject | undefined => {
    const own = objects.get(getPsdSourceKey(layer)); if (own) return own;
    for (const child of layer.children || []) { const found = firstObject(child); if (found) return found; }
    return undefined;
  };
  const visible = (layer: ParsedLayer) => {
    const key = getPsdSourceKey(layer), override = target.__psdVisibilityOverrides?.[key], object = objects.get(key);
    if (object) for (let parent = object.group; parent; parent = parent.group) if (!parent.visible) return false;
    return override ?? (object ? object._psdOwnVisible ?? object.visible : layer.visible !== false);
  };
  const layerOpacity = (layer: ParsedLayer) => opacity(objects.get(getPsdSourceKey(layer))?.opacity ?? layer.opacity);
  const movementMatrix = (object: SceneObject): Matrix | undefined => {
    const original = object._psdOriginalTransform, dimensions = object._psdOriginalDimensions;
    if (!original) return undefined;
    if (!dimensions) { const inverse = inverseMatrix(original); return inverse ? multiplyMatrix(object.calcTransformMatrix() as Matrix, inverse) : undefined; }
    const anchor = object.getPointByOrigin(dimensions[2] + 0.5, dimensions[3] + 0.5);
    const parent = object.group?.calcTransformMatrix();
    const x = parent ? parent[0] * anchor.x + parent[2] * anchor.y + parent[4] : anchor.x, y = parent ? parent[1] * anchor.x + parent[3] * anchor.y + parent[5] : anchor.y;
    const baseline = [...original] as Matrix;
    baseline[4] = dimensions[4] ?? original[4] + original[0] * dimensions[0] * dimensions[2] + original[2] * dimensions[1] * dimensions[3];
    baseline[5] = dimensions[5] ?? original[5] + original[1] * dimensions[0] * dimensions[2] + original[3] * dimensions[1] * dimensions[3];
    const current = [...object.calcTransformMatrix()] as Matrix; current[4] = x; current[5] = y;
    const inverse = inverseMatrix(baseline); return inverse ? multiplyMatrix(current, inverse) : undefined;
  };
  const mode = (layer: ParsedLayer) => {
    const object = objects.get(getPsdSourceKey(layer));
    // Imported objects use source-over because the scene owns blending; later user changes still count.
    const value = object?.globalCompositeOperation;
    return normalizeBlendMode(value && value !== 'source-over' ? value : layer.blendMode);
  };
  const composite = (dest: HTMLCanvasElement, source: HTMLCanvasElement, blend: string, amount: number, layer: ParsedLayer) => {
    blend = normalizeBlendMode(blend);
    if (!supportedBlendModes.has(blend)) { diagnose(layer, `blend-${blend}`, `混合模式“${blend}”无法准确转换，请使用原稿保真预览核对。`); blend = 'normal'; }
    if (blend === 'normal') { const context = ctx(dest); context.save(); context.globalAlpha = amount; context.drawImage(source, 0, 0); context.restore(); }
    else write(dest, blendPixels(pixels(dest).data, pixels(source).data, blend, amount));
  };
  const mask = (layer: ParsedLayer): HTMLCanvasElement | undefined => {
    const object = objects.get(getPsdSourceKey(layer)) as (SceneObject & { _psdSimpleShape?: boolean }) | undefined;
    const info = (object?._psdSimpleShape && props(layer).psdMaskIncludesVectorGeometry ? props(layer).psdUserMask : props(layer).psdMask) as PsdRecord | undefined;
    if (!info || info.disabled === true) return undefined;
    const out = make(), context = ctx(out), defaultAlpha = clamp(number(info.defaultColor, 255), 0, 255) / 255;
    context.fillStyle = `rgba(255,255,255,${defaultAlpha})`; context.fillRect(0, 0, width, height);
    if (!info.imagePath) return out;
    const image = images.get(info.imagePath); if (!image) return undefined;
    context.save();
    if (info.linked !== false) {
      const object = firstObject(layer);
      let movement = object && movementMatrix(object);
      if (movement && layer.layerType === 'group') {
        // A group's mask follows a common group transformation. Moving one child
        // does not move the group mask merely because it happens to be first.
        walk(layer.children || [], (child) => {
          const source = objects.get(getPsdSourceKey(child)), change = source && movementMatrix(source);
          if (!change || !movement) return;
          if (change.some((value, index) => Math.abs(value - movement![index]) > 1e-5)) movement = undefined;
        });
      }
      if (movement) context.transform(...movement);
    }
    // Replace the patch, including fully transparent pixels, rather than source-over its default.
    const x = number(info.x), y = number(info.y), w = number(info.width), h = number(info.height);
    context.clearRect(x, y, w, h); context.drawImage(image, x, y, w, h); context.restore();
    return out;
  };
  const applyMask = (source: HTMLCanvasElement, layer: ParsedLayer) => {
    const coverage = mask(layer); if (!coverage) return source;
    const context = ctx(source); context.save(); context.globalCompositeOperation = 'destination-in'; context.drawImage(coverage, 0, 0); context.restore(); return source;
  };
  const own = (layer: ParsedLayer) => {
    const out = make(), object = objects.get(getPsdSourceKey(layer)); if (!object || includedObjects && !includedObjects.has(object)) return out;
    const savedOpacity = object.opacity, savedVisible = object.visible, savedComposite = object.globalCompositeOperation;
    const previousSkip = canvas.skipOffscreen;
    try {
      object.opacity = 1; object.visible = true; object.globalCompositeOperation = 'source-over'; canvas.skipOffscreen = false;
      object.render(ctx(out));
    } finally { object.opacity = savedOpacity; object.visible = savedVisible; object.globalCompositeOperation = savedComposite; canvas.skipOffscreen = previousSkip; }
    return applyMask(out, layer);
  };
  const alphaBounds = (data: Uint8ClampedArray) => {
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let i = 3; i < data.length; i += 4) if (data[i]) { const p = (i - 3) / 4, x = p % width, y = Math.floor(p / width); minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    return { x: minX, y: minY, width: Math.max(1, maxX - minX + 1), height: Math.max(1, maxY - minY + 1) };
  };
  const effects = (source: HTMLCanvasElement, layer: ParsedLayer) => {
    const originalEffects = props(layer).effects || layer.textStyle?.effects;
    const overrides = (objects.get(getPsdSourceKey(layer)) as unknown as PsdRecord | undefined)?._psdEffectOverrides;
    const fx = originalEffects ? { ...originalEffects, ...overrides } : undefined;
    const fill = opacity(props(layer).fillOpacity);
    if ((!fx || fx.disabled) && fill === 1) return source;
    const sourceData = pixels(source).data, originalAlpha = new Uint8ClampedArray(width * height);
    for (let i = 0; i < originalAlpha.length; i++) originalAlpha[i] = sourceData[i * 4 + 3];
    const bounds = alphaBounds(sourceData), result = make(), foreground = copy(source);
    if (!fx || fx.disabled) { if (fill < 1) { const data = pixels(foreground).data; for (let i = 3; i < data.length; i += 4) data[i] *= fill; write(foreground, data); } return foreground; }
    // Styles are independent of Fill Opacity. Work on a unit coverage color plane,
    // then restore original shape coverage once after all interior overlays.
    const contentPlane = new Uint8ClampedArray(sourceData);
    for (let i = 3; i < contentPlane.length; i += 4) contentPlane[i] = originalAlpha[(i - 3) / 4] ? fill * 255 : 0;
    write(foreground, contentPlane);
    const scale = Math.max(0.01, number(fx.scale, 1));
    const all = (name: string) => { const value = fx[name]; return (Array.isArray(value) ? value : value ? [value] : []).filter((e: PsdRecord) => e.enabled !== false); };
    const alphaSurface = (coverage: Uint8ClampedArray, effect: PsdRecord, gradient = false) => {
      const out = make(), data = new Uint8ClampedArray(width * height * 4), rgb = psdColor(effect.color) || [0, 0, 0];
      const gradientBounds = (effect.align ?? effect.gradient?.align) === false ? { x: 0, y: 0, width, height } : bounds;
      const sample = gradient ? createGradientSampler(effect, gradientBounds) : null;
      for (let p = 0; p < coverage.length; p++) {
        if (!coverage[p]) continue;
        const color = sample?.(p % width, Math.floor(p / width));
        for (let c = 0; c < 3; c++) data[p * 4 + c] = color?.[c] ?? rgb[c];
        data[p * 4 + 3] = coverage[p] * (color?.[3] ?? 1);
      }
      write(out, data); return out;
    };
    const validate = (effect: PsdRecord, name: string) => {
      if ((effect.fillType === 'gradient' || name === 'gradientOverlay') && (!effect.gradient || effect.gradient.type !== 'solid')) {
        diagnose(layer, `${name}-gradient`, '噪声渐变无法准确还原；请使用原稿保真预览核对。'); return false;
      }
      if (effect.fillType === 'pattern') { diagnose(layer, `${name}-pattern`, '图案填充缺少可用图案像素；请使用原稿保真预览核对。'); return false; }
      if (effect.contour || number(effect.noise) || number(effect.jitter) || effect.interpolationMethod && effect.interpolationMethod !== 'classic') diagnose(layer, `${name}-approximation`, '该图层样式的轮廓、噪点或渐变插值采用兼容绘制，与原稿可能存在差异。');
      return true;
    };
    for (const effect of [...all('dropShadow'), ...all('outerGlow')]) {
      const name = all('dropShadow').includes(effect) ? 'dropShadow' : 'outerGlow';
      if (!validate(effect, name)) continue;
      const size = clamp(unit(effect.size) * scale, 0, Math.max(width, height)), choke = clamp(unit(effect.choke)) * size;
      let coverage = blurAlpha(spreadAlpha(originalAlpha, width, height, choke), width, height, Math.max(0, size - choke));
      if (name === 'dropShadow') {
        const angle = number(effect.useGlobalLight ? props(layer).psdGlobalAngle : effect.angle, 120) * Math.PI / 180, distance = unit(effect.distance) * scale;
        const dx = Math.round(-Math.cos(angle) * distance), dy = Math.round(Math.sin(angle) * distance), shifted = new Uint8ClampedArray(coverage.length);
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (x - dx >= 0 && x - dx < width && y - dy >= 0 && y - dy < height) shifted[y * width + x] = coverage[(y - dy) * width + x - dx];
        coverage = shifted;
      }
      composite(result, alphaSurface(coverage, effect), effect.blendMode || 'normal', opacity(effect.opacity), layer);
    }
    for (const name of ['solidFill', 'gradientOverlay']) for (const effect of all(name)) {
      if (!validate(effect, name)) continue;
      const overlay = alphaSurface(originalAlpha, effect, name === 'gradientOverlay');
      // Fill overlays recolor content without increasing its soft alpha.
      const before = pixels(foreground), overlayData = pixels(overlay).data;
      for (let i = 3; i < overlayData.length; i += 4) { const coverage = originalAlpha[(i - 3) / 4]; overlayData[i] = coverage ? overlayData[i] / coverage * 255 : 0; }
      const blend = normalizeBlendMode(effect.blendMode);
      if (!supportedBlendModes.has(blend)) diagnose(layer, `effect-blend-${blend}`, `图层样式混合模式“${blend}”无法准确转换。`);
      const blended = blendPixels(before.data, overlayData, blend, opacity(effect.opacity));
      write(foreground, blended);
    }
    const coveredForeground = pixels(foreground).data;
    for (let i = 3; i < coveredForeground.length; i += 4) coveredForeground[i] *= originalAlpha[(i - 3) / 4] / 255;
    write(foreground, coveredForeground);
    composite(result, foreground, 'normal', 1, layer);
    for (const effect of all('stroke')) {
      if (!validate(effect, 'stroke')) continue;
      const size = clamp(unit(effect.size) * scale, 0, Math.max(width, height)), position = effect.position || 'outside';
      const outer = spreadAlpha(originalAlpha, width, height, position === 'inside' ? 0 : position === 'center' ? size / 2 : size);
      const inner = spreadAlpha(originalAlpha, width, height, position === 'outside' ? 0 : position === 'center' ? size / 2 : size, false);
      const coverage = outer.map((v, i) => Math.max(0, v - inner[i]));
      const paint = effect.gradient ? { ...effect.gradient, ...effect, type: effect.type || effect.gradient.style || 'linear', gradient: effect.gradient } : effect;
      composite(result, alphaSurface(coverage, paint, effect.fillType === 'gradient'), effect.blendMode || 'normal', opacity(effect.opacity), layer);
    }
    for (const name of ['innerShadow', 'innerGlow']) for (const effect of all(name)) {
      if (!validate(effect, name)) continue;
      const size = clamp(unit(effect.size) * scale, 0, Math.max(width, height)), inverse = originalAlpha.map((v) => 255 - v);
      let coverage = blurAlpha(spreadAlpha(inverse, width, height, clamp(unit(effect.choke)) * size), width, height, size);
      if (name === 'innerShadow') {
        const angle = number(effect.useGlobalLight ? props(layer).psdGlobalAngle : effect.angle, 120) * Math.PI / 180, distance = unit(effect.distance) * scale, dx = Math.round(-Math.cos(angle) * distance), dy = Math.round(Math.sin(angle) * distance);
        coverage = coverage.map((_, p) => { const x = p % width - dx, y = Math.floor(p / width) - dy; return x >= 0 && x < width && y >= 0 && y < height ? coverage[y * width + x] : 255; });
      }
      coverage = coverage.map((v, i) => originalAlpha[i] * (name === 'innerGlow' && effect.source === 'center' ? 255 - v : v) / 255);
      const before = pixels(result), output = blendPixels(before.data, pixels(alphaSurface(coverage, effect)).data, normalizeBlendMode(effect.blendMode), opacity(effect.opacity));
      for (let i = 3; i < output.length; i += 4) output[i] = before.data[i];
      write(result, output);
    }
    for (const name of ['bevel', 'satin', 'patternOverlay']) if (all(name).length) diagnose(layer, `effect-${name}`, `图层样式“${name}”暂不能准确合成；请使用原稿保真预览核对。`);
    if (['dropShadow', 'innerShadow', 'outerGlow', 'innerGlow', 'stroke'].some((name) => all(name).length)) diagnose(layer, 'effect-edge-approximation', '图层样式的扩张与模糊使用兼容算法，与 Photoshop 边缘可能存在细微差异。');
    return result;
  };
  const adjusted = (backdrop: HTMLCanvasElement, layer: ParsedLayer) => {
    const setting = (props(layer).psdAdjustment || props(layer).adjustment) as PsdRecord | undefined;
    if (!setting || !supportedAdjustments.has(setting.type)) { diagnose(layer, 'adjustment-unsupported', `调整图层“${setting?.type || layer.layerName}”无法准确转换；请使用原稿保真预览核对。`); return; }
    if (['hue/saturation', 'color balance', 'selective color', 'brightness/contrast', 'black & white'].includes(setting.type)) diagnose(layer, 'adjustment-approximation', '调整图层使用兼容颜色算法；请与原稿保真预览核对色彩。');
    const before = pixels(backdrop), after = ctx(backdrop).createImageData(width, height); after.data.set(adjustPixels(before.data, setting));
    const blend = mode(layer);
    if (blend !== 'normal') {
      const mixed = blendPixels(before.data, after.data, blend); for (let i = 3; i < mixed.length; i += 4) mixed[i] = before.data[i]; after.data.set(mixed);
    }
    const coverage = mask(layer); write(backdrop, interpolatePixels(before, after, layerOpacity(layer), coverage && pixels(coverage).data));
  };
  const rank = (layer: ParsedLayer): number => {
    const ownOrder = order.get(getPsdSourceKey(layer)); if (ownOrder !== undefined) return ownOrder;
    const ranks = (layer.children || []).map(rank).filter(Number.isFinite);
    return ranks.length ? Math.min(...ranks) : NaN;
  };
  const clippingBase = (layer: ParsedLayer) => objects.get(getPsdSourceKey(layer))?._psdClipBaseKey || props(layer).psdClipBaseKey;
  let nativeParents = new Map<string | null, Array<{ object: SceneObject; index: number }>>();
  let includedObjects: Set<fabric.FabricObject> | null = null;
  const content = (layer: ParsedLayer) => {
    if (layer.layerType !== 'group') return own(layer);
    const out = make(); renderNodes(out, layer.children || [], getPsdSourceKey(layer)); return applyMask(out, layer);
  };
  const renderOne = (backdrop: HTMLCanvasElement, layer: ParsedLayer) => {
    if (!visible(layer)) return;
    if (layer.layerType === 'adjustment') { adjusted(backdrop, layer); return; }
    if (layer.layerType === 'group') {
      const blend = mode(layer), passThrough = blend === 'pass through' || blend === 'pass';
      if (passThrough) {
        const before = pixels(backdrop), after = copy(backdrop); renderNodes(after, layer.children || [], getPsdSourceKey(layer));
        const coverage = mask(layer); write(backdrop, interpolatePixels(before, pixels(after), layerOpacity(layer), coverage && pixels(coverage).data));
        if (props(layer).effects) diagnose(layer, 'pass-through-group-effects', '穿透组样式无法独立于背景准确还原；请使用原稿保真预览核对。');
      } else {
        const group = make(); renderNodes(group, layer.children || [], getPsdSourceKey(layer));
        composite(backdrop, effects(applyMask(group, layer), layer), blend, layerOpacity(layer), layer);
      }
      return;
    }
    if (!objects.has(getPsdSourceKey(layer))) return;
    composite(backdrop, effects(own(layer), layer), mode(layer), layerOpacity(layer), layer);
  };
  const renderNodes = (backdrop: HTMLCanvasElement, siblings: ParsedLayer[], parentKey: string | null = null) => {
    const initial = [...siblings].sort((a, b) => number(a.sortOrder) - number(b.sortOrder));
    const ranks = initial.map(rank);
    // Adjustment nodes have no Fabric proxy. Anchor them between their original
    // neighboring sources rather than mixing DB sortOrder with canvas object indices.
    ranks.forEach((value, index) => {
      if (Number.isFinite(value)) return;
      let before = index - 1, after = index + 1;
      while (before >= 0 && !Number.isFinite(ranks[before])) before--;
      while (after < ranks.length && !Number.isFinite(ranks[after])) after++;
      const a = before >= 0 ? ranks[before] : undefined, b = after < ranks.length ? ranks[after] : undefined;
      ranks[index] = a !== undefined && b !== undefined && a < b ? (a + b) / 2 : a !== undefined ? a + 0.001 : b !== undefined ? b - 0.001 : index;
    });
    const entries = initial.map((layer, index) => ({ layer, rank: ranks[index], native: undefined as SceneObject | undefined }));
    for (const native of nativeParents.get(parentKey) || []) entries.push({ layer: { ...siblings[0], id: -identity(native.object), layerType: 'image', children: undefined, properties: {}, visible: native.object.visible }, rank: native.index, native: native.object });
    const sortedEntries = entries.sort((a, b) => a.rank - b.rank);
    const sorted = sortedEntries.map(({ layer }) => layer);
    for (let i = 0; i < sorted.length; i++) {
      if (sortedEntries[i].native) { sortedEntries[i].native!.render(ctx(backdrop)); continue; }
      const base = sorted[i], key = getPsdSourceKey(base), children: ParsedLayer[] = [];
      let end = i + 1;
      while (end < sorted.length && clippingBase(sorted[end]) === key) children.push(sorted[end++]);
      if (!children.length || base.layerType === 'adjustment') {
        if (clippingBase(base)) diagnose(base, 'clipping-detached', '剪贴图层不再紧邻原基底，已按独立图层绘制。');
        renderOne(backdrop, base); continue;
      }
      i = end - 1;
      if (!visible(base)) continue;
      if (!firstObject(base)) { for (const child of children) if (firstObject(child)) diagnose(child, 'clipping-base-missing', '剪贴基底已删除或未加载，关联剪贴内容暂不显示；恢复基底后会重新合成。'); continue; }
      const original = content(base), coverage = pixels(original).data, stack = copy(original), colors = pixels(stack).data;
      for (let p = 3; p < colors.length; p += 4) colors[p] = 255;
      write(stack, colors);
      for (const child of children) {
        if (!visible(child)) continue;
        if (child.layerType === 'adjustment') adjusted(stack, child);
        else composite(stack, effects(content(child), child), mode(child), layerOpacity(child), child);
      }
      const output = pixels(stack).data;
      for (let p = 3; p < output.length; p += 4) output[p] = coverage[p];
      write(stack, output);
      let baseMode = mode(base);
      if (baseMode === 'pass through' || baseMode === 'pass') { diagnose(base, 'clipping-pass-through-group', '穿透组作为剪贴基底按隔离组合成；已保留原稿保真预览，编辑后请核对组与背景的混合结果。'); baseMode = 'normal'; }
      // Base styles sit around the complete clipping stack. Restoring raw base
      // alpha after painting its effects would erase outer strokes and shadows.
      composite(backdrop, effects(stack, base), baseMode, layerOpacity(base), base);
    }
  };
  const originalRender = canvas._renderObjects;
  // Detect known fidelity limits before allocating/computing the editable scene.
  // A pristine document can show its embedded composite immediately.
  walk(metadata.layers, (layer) => {
    const setting = props(layer).psdAdjustment || props(layer).adjustment;
    if (layer.layerType === 'adjustment') {
      if (!setting || !supportedAdjustments.has(setting.type)) diagnose(layer, 'adjustment-unsupported', '该调整图层暂不能准确转换，已保留原稿保真预览。');
      else if (['hue/saturation', 'color balance', 'selective color', 'brightness/contrast', 'black & white'].includes(setting.type)) diagnose(layer, 'adjustment-approximation', '调整图层使用兼容颜色算法；请与原稿保真预览核对色彩。');
    }
    const blend = mode(layer);
    if (!supportedBlendModes.has(blend) && blend !== 'pass through' && blend !== 'pass') diagnose(layer, `blend-${blend}`, `混合模式“${blend}”无法准确转换，请使用原稿保真预览核对。`);
    const original = props(layer).effects || layer.textStyle?.effects;
    const overrides = (objects.get(getPsdSourceKey(layer)) as unknown as PsdRecord | undefined)?._psdEffectOverrides;
    const fx = original && { ...original, ...overrides }; if (!fx || fx.disabled) return;
    if (layer.layerType === 'group' && (blend === 'pass through' || blend === 'pass')) diagnose(layer, 'pass-through-group-effects', '穿透组样式无法独立于背景准确还原；请使用原稿保真预览核对。');
    for (const name of ['bevel', 'satin', 'patternOverlay', 'stroke', 'dropShadow', 'outerGlow', 'innerGlow', 'innerShadow', 'gradientOverlay', 'solidFill']) {
      const list = Array.isArray(fx[name]) ? fx[name] : fx[name] ? [fx[name]] : [];
      for (const effect of list) if (effect.enabled !== false) {
        if (['bevel', 'satin', 'patternOverlay'].includes(name)) diagnose(layer, `effect-${name}`, `图层样式“${name}”暂不能准确合成；请使用原稿保真预览核对。`);
        if (['stroke', 'dropShadow', 'outerGlow', 'innerGlow', 'innerShadow'].includes(name)) diagnose(layer, 'effect-edge-approximation', '图层样式的扩张与模糊使用兼容算法，与 Photoshop 边缘可能存在细微差异。');
        if ((effect.fillType === 'gradient' || name === 'gradientOverlay') && (!effect.gradient || effect.gradient.type !== 'solid')) diagnose(layer, `${name}-gradient`, '噪声渐变无法准确还原；请使用原稿保真预览核对。');
        if (effect.fillType === 'pattern') diagnose(layer, `${name}-pattern`, '图案填充缺少可用图案像素；请使用原稿保真预览核对。');
        if (effect.contour || number(effect.noise) || number(effect.jitter) || effect.interpolationMethod && effect.interpolationMethod !== 'classic') diagnose(layer, `${name}-approximation`, '该图层样式的轮廓、噪点或渐变插值采用兼容绘制，与原稿可能存在差异。');
        const effectMode = normalizeBlendMode(effect.blendMode); if (!supportedBlendModes.has(effectMode)) diagnose(layer, `effect-blend-${effectMode}`, `图层样式混合模式“${effectMode}”无法准确转换。`);
      }
    }
  });
  const objectSignature = (object: SceneObject) => {
    const record = object as unknown as PsdRecord;
    return [identity(object), record._psdSourceKey, record._psdOwnVisible, ...object.calcTransformMatrix().map((v) => Math.round(v * 1e6) / 1e6), record.opacity,
      record.globalCompositeOperation, record.text, record.fill, record.stroke, record.strokeWidth, record.fontFamily, record.fontSize,
      record.fontWeight, record.fontStyle, record.charSpacing, record.lineHeight, record.textAlign, record.underline, record.linethrough,
      record.styles, record.shadow, record.cropX, record.cropY, record.width, record.height, record.filters, record.rx, record.ry,
      record._psdMask, record._psdEffectOverrides, record._psdClipBaseKey, typeof record.getElement === 'function' && record.getElement() ? identity(record.getElement()) : 0];
  };
  let initialFingerprint = '', sceneEdited = metadata.sourceEdited === true;
  const fingerprint = () => {
    const state: unknown[] = []; walk(metadata.layers, (layer) => {
      const p = props(layer);
      // Original text engine/vector provenance can be tens of MB. Only renderer
      // inputs belong in a per-frame fingerprint; their parameter edits still invalidate.
      state.push([getPsdSourceKey(layer), layer.visible, layer.opacity, layer.blendMode, layer.sortOrder,
        p.psdClipBaseKey, p.psdMask, p.psdUserMask, p.psdMaskIncludesVectorGeometry, p.fillOpacity,
        p.effects || layer.textStyle?.effects, p.psdAdjustment || p.adjustment, p.psdGlobalAngle,
        (layer.children || []).map(getPsdSourceKey)]);
    });
    return JSON.stringify([canvas.backgroundColor, canvas.getObjects().map((value) => objectSignature(value as SceneObject)), [...sceneOrder.keys()].map((value) => objectSignature(value as SceneObject)), state, target.__psdVisibilityOverrides]);
  };
  const sourcePreview = () => options.compositeImagePath && images.get(options.compositeImagePath);
  const needsInitialFallback = () => [...diagnostics.values()].some(({ code, severity }) => severity === 'error' || /unsupported|approx|effect-bevel|effect-satin|effect-pattern|effect-blend|pass-through-group-effects|clipping-pass-through-group|missing|failed|gradient|fallback|^blend-/.test(code));
  const showingSource = () => !!sourcePreview() && (budgetExceeded || metadata.sourcePreview === true || (metadata.sourcePreview !== false && !sceneEdited && needsInitialFallback()));
  let sourceComparisonDone = false;
  const updateEditState = () => {
    if (!sceneEdited && initialFingerprint && fingerprint() !== initialFingerprint) {
      sceneEdited = true; metadata.sourceEdited = true;
      if (needsInitialFallback() && metadata.layers[0]) diagnose(metadata.layers[0], 'edited-fidelity-boundary', '已切换到可编辑图层合成；不支持的样式与兼容颜色算法可能与原稿有差异，可切换原稿保真预览核对。');
    }
  };
  const renderer: typeof canvas._renderObjects = function(this: fabric.Canvas, context, values) {
    if (disposed || rendering) return originalRender.call(this, context, values);
    captureObjects();
    // Canvas temporarily replaces selected children with an ActiveSelection in its
    // render list. It is a controls/transform container, not a new scene layer.
    // Render its children through the authoritative PSD tree while retaining their
    // full calcTransformMatrix() (which includes the selection's current transform).
    const flattened = expandObjects(values);
    const included = flattened.some((object) => objects.has((object as SceneObject)._psdSourceKey || ''));
    if (!included && (objects.size || !sourcePreview())) return originalRender.call(this, context, values);
    rendering = true;
    try {
      updateEditState();
      if (budgetExceeded) { const preview = sourcePreview(); if (!preview) throw new Error('PSD scene exceeds the offscreen memory budget and has no source composite.'); context.drawImage(preview, 0, 0, width, height); return; }
      const pristinePreview = sourcePreview();
      if (pristinePreview && showingSource()) { context.drawImage(pristinePreview, 0, 0, width, height); return; }
      // Render native user objects below the imported scene into its backdrop, so pass-through
      // groups and adjustments also operate on subsequently inserted objects below the PSD.
      includedObjects = new Set(flattened);
      nativeParents = new Map();
      const groupParent = (siblings: ParsedLayer[], index: number, parent: string | null = null): string | null => {
        for (const layer of siblings) if (layer.layerType === 'group' && layer.children?.length) {
          const indices: number[] = []; walk(layer.children, (child) => { const value = order.get(getPsdSourceKey(child)); if (value !== undefined) indices.push(value); });
          if (indices.length && index > Math.min(...indices) && index < Math.max(...indices)) return groupParent(layer.children, index, getPsdSourceKey(layer));
        }
        return parent;
      };
      flattened.forEach((value) => {
        const object = value as SceneObject;
        if (objects.has(object._psdSourceKey || '')) return;
        const index = sceneOrder.get(value) ?? canvas.getObjects().indexOf(value), parent = groupParent(metadata.layers, index);
        const siblings = nativeParents.get(parent) || []; siblings.push({ object, index }); nativeParents.set(parent, siblings);
      });
      const signature = JSON.stringify([revision, fingerprint(), flattened.map(identity).sort((a, b) => a - b)]);
      if (!cached || cachedSignature !== signature) {
        const output = make(), context = ctx(output);
        if (typeof canvas.backgroundColor === 'string' && canvas.backgroundColor) { context.fillStyle = canvas.backgroundColor; context.fillRect(0, 0, width, height); }
        renderNodes(output, metadata.layers); cached = output;
        // Fabric rendering clears object.dirty. Cache the post-render state to avoid an extra frame.
        cachedSignature = JSON.stringify([revision, fingerprint(), flattened.map(identity).sort((a, b) => a - b)]);
      }
      const preview = sourcePreview();
      if (preview && !sceneEdited && metadata.sourcePreview === undefined && !sourceComparisonDone) {
        sourceComparisonDone = true;
        const reference = make(), referenceContext = ctx(reference);
        if (typeof canvas.backgroundColor === 'string' && canvas.backgroundColor) { referenceContext.fillStyle = canvas.backgroundColor; referenceContext.fillRect(0, 0, width, height); }
        referenceContext.drawImage(preview, 0, 0, width, height);
        const actual = pixels(cached).data, expected = pixels(reference).data;
        let total = 0, changed = 0;
        for (let i = 0; i < actual.length; i += 4) { let peak = 0; for (let c = 0; c < 4; c++) { const error = Math.abs(actual[i + c] - expected[i + c]); total += error; peak = Math.max(peak, error); } if (peak > 16) changed++; }
        const mean = total / actual.length, fraction = changed / (width * height);
        if ((mean > 3 || fraction > 0.02) && metadata.layers[0]) diagnose(metadata.layers[0], 'source-composite-fallback', `图层合成与原稿存在明显像素差异（平均通道误差 ${mean.toFixed(1)}/255），初始显示完整原稿；可切换图层合成继续编辑并核对差异。`);
      }
      if (preview && showingSource()) context.drawImage(preview, 0, 0, width, height);
      else context.drawImage(cached, 0, 0);
    } catch (error) {
      for (const layer of metadata.layers) diagnose(layer, 'scene-render-failed', `PSD 合成失败：${error instanceof Error ? error.message : String(error)}。`);
      const preview = sourcePreview();
      if (preview) context.drawImage(preview, 0, 0, width, height);
      else throw error;
    } finally { rendering = false; includedObjects = null; }
  };
  canvas._renderObjects = renderer;
  const originalToObject = canvas.toObject;
  const serialize: typeof canvas.toObject = function(this: fabric.Canvas, propertiesToInclude) { captureObjects(); updateEditState(); return originalToObject.call(this, propertiesToInclude); };
  canvas.toObject = serialize;
  target.__psdScene = metadata; target.__psdSceneVersion = 1;
  const session: PsdSceneSession = {
    refresh() { if (!disposed) { revision++; captureObjects(); canvas.requestRenderAll(); } },
    updateLayer(key, changes) {
      const node = nodes.get(key); if (!node || disposed) return;
      if (changes.visible !== undefined) {
        node.visible = changes.visible; target.__psdVisibilityOverrides ||= {}; target.__psdVisibilityOverrides[key] = changes.visible;
        const object = objects.get(key); if (object) object._psdOwnVisible = changes.visible;
      }
      if (changes.opacity !== undefined) { node.opacity = opacity(changes.opacity); const object = objects.get(key); if (object) object.set('opacity', node.opacity); }
      if (changes.blendMode !== undefined) node.blendMode = changes.blendMode;
      session.refresh();
    },
    dispose() {
      if (disposed) return; disposed = true;
      if (canvas._renderObjects === renderer) canvas._renderObjects = originalRender;
      if (canvas.toObject === serialize) canvas.toObject = originalToObject;
      if (target.__psdSceneSession === session) delete target.__psdSceneSession;
      for (const event of ['object:modified', 'object:moving', 'object:scaling', 'object:rotating', 'text:changed', 'object:added', 'object:removed']) canvas.off(event as any, refresh);
      images.clear();
      cached = null;
    },
    getDiagnostics() { return [...diagnostics.values()]; },
    getSourcePreview() { return showingSource(); },
    setSourcePreview(enabled) { metadata.sourcePreview = enabled; canvas.requestRenderAll(); },
  };
  const refresh = () => session.refresh();
  for (const event of ['object:modified', 'object:moving', 'object:scaling', 'object:rotating', 'text:changed', 'object:added', 'object:removed']) canvas.on(event as any, refresh);
  target.__psdSceneSession = session;
  options.onDiagnostics?.([...diagnostics.values()]);
  session.refresh();
  initialFingerprint = fingerprint();
  return session;
}
