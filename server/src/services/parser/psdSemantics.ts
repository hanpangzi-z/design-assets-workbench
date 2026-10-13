import type { Layer, LayerEffectsInfo, LayerMaskData, LayerVectorMask, Psd } from 'ag-psd';

export type PsdDiagnostic = {
  code: string;
  severity: 'warning' | 'error';
  message: string;
  layerKey?: string;
  layerName?: string;
};
export type PsdMaskRaster = {
  canvas: any;
  x: number;
  y: number;
  width: number;
  height: number;
  defaultColor: number;
};

function configuredLimit(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

export function inspectPsdHeader(buffer: Buffer, maxPixels = configuredLimit(process.env.PSD_MAX_PIXELS, 100_000_000)) {
  if (buffer.length < 26 || buffer.toString('ascii', 0, 4) !== '8BPS') throw new Error('无效或截断的 PSD/PSB 文件头');
  const version = buffer.readUInt16BE(4);
  const height = buffer.readUInt32BE(14);
  const width = buffer.readUInt32BE(18);
  const bitsPerChannel = buffer.readUInt16BE(22);
  const maxDimension = version === 2 ? 300_000 : 30_000;
  if (![1, 2].includes(version) || !width || !height || width > maxDimension || height > maxDimension || ![1, 8, 16, 32].includes(bitsPerChannel)) {
    throw new Error('PSD/PSB 文件尺寸、版本或位深无效');
  }
  if (width * height > maxPixels) throw new Error(`PSD/PSB 画布像素数超过解析预算 (${maxPixels})`);
  return { version, width, height, bitsPerChannel };
}

export function checkPsdSourceSize(size: number, maxBytes = configuredLimit(process.env.PSD_MAX_SOURCE_BYTES, 256 * 1024 * 1024)): void {
  if (!Number.isSafeInteger(size) || size < 26 || size > maxBytes) throw new Error(`PSD/PSB 源文件大小超过解析预算或文件已截断 (${Math.round(maxBytes / 1024 / 1024)} MiB)`);
}

export function checkPsdDecodedBudget(
  psd: Psd,
  maxBytes = configuredLimit(process.env.PSD_MAX_DECODED_BYTES, 1024 * 1024 * 1024),
  maxPixels = configuredLimit(process.env.PSD_MAX_PIXELS, 100_000_000),
  maxLayers = configuredLimit(process.env.PSD_MAX_LAYERS, 10_000),
  maxDepth = configuredLimit(process.env.PSD_MAX_LAYER_DEPTH, 128),
): number {
  // Decoder buffers, canvas storage and a temporary RGBA copy may coexist.
  let estimatedBytes = 0;
  const bytesPerPixel = (psd.bitsPerChannel || 8) > 16 ? 40 : (psd.bitsPerChannel || 8) > 8 ? 24 : 12;
  const account = (width: number, height: number) => {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) throw new Error('PSD/PSB 图层或蒙版边界无效');
    const pixels = width * height;
    if (!Number.isSafeInteger(pixels) || pixels > maxPixels) throw new Error(`PSD/PSB 图层或蒙版像素数超过解析预算 (${maxPixels})`);
    estimatedBytes += pixels * bytesPerPixel;
    if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes > maxBytes) throw new Error(`PSD/PSB 解码内存估算超过解析预算 (${Math.round(maxBytes / 1024 / 1024)} MiB)`);
  };
  account(psd.width, psd.height);
  const pending = [{ layers: psd.children || [], depth: 1 }];
  let layerCount = 0;
  while (pending.length) {
    const { layers, depth } = pending.pop()!;
    if (layers.length && depth > maxDepth) throw new Error(`PSD/PSB 图层嵌套超过解析预算 (${maxDepth})`);
    for (const layer of layers) {
      if (++layerCount > maxLayers) throw new Error(`PSD/PSB 图层数量超过解析预算 (${maxLayers})`);
      account((layer.right || 0) - (layer.left || 0), (layer.bottom || 0) - (layer.top || 0));
      for (const mask of [layer.mask, layer.realMask]) {
        if (mask) account((mask.right || 0) - (mask.left || 0), (mask.bottom || 0) - (mask.top || 0));
      }
      if (layer.children) pending.push({ layers: layer.children, depth: depth + 1 });
    }
  }
  return estimatedBytes;
}

export function classifyPsdLayer(layer: Layer): 'group' | 'text' | 'shape' | 'adjustment' | 'image' {
  if (Array.isArray(layer.children)) return 'group';
  if (layer.text) return 'text';
  if (layer.adjustment) return 'adjustment';
  if (layer.vectorFill || layer.vectorStroke) return 'shape';
  return 'image';
}

export function psdSourceKey(layer: Layer, treePath: number[]): string {
  return Number.isSafeInteger(layer.id) && (layer.id || 0) > 0 ? `id:${layer.id}` : `path:${treePath.join('.')}`;
}

export function createPsdSourceKeyResolver(layers: Layer[]) {
  const counts = new Map<number, number>();
  const walk = (items: Layer[]) => {
    for (const layer of items) {
      if (typeof layer.id === 'number') counts.set(layer.id, (counts.get(layer.id) || 0) + 1);
      if (layer.children) walk(layer.children);
    }
  };
  walk(layers);
  return (layer: Layer, treePath: number[]) => layer.id !== undefined && (counts.get(layer.id) || 0) > 1 ? `path:${treePath.join('.')}` : psdSourceKey(layer, treePath);
}

export function psdClippingBaseKeys(layers: Layer[], treePath: number[], keyOf = psdSourceKey): Array<string | undefined> {
  let base: string | undefined;
  return layers.map((layer, index) => {
    if (!layer.clipping) {
      base = keyOf(layer, [...treePath, index]);
      return undefined;
    }
    return base;
  });
}

export function normalizePsdOpacity(value: unknown, fallback = 1): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value > 1 ? value / 100 : value));
}

export function serializePsdEffects(effects: LayerEffectsInfo | undefined): Record<string, unknown> {
  if (!effects || effects.disabled) return {};
  const output: Record<string, unknown> = {};
  if (typeof effects.scale === 'number') output.scale = effects.scale;
  for (const [key, raw] of Object.entries(effects)) {
    if (key === 'disabled' || key === 'scale') continue;
    const items = (Array.isArray(raw) ? raw : [raw]).filter(item => item && typeof item === 'object' && item.enabled !== false && item.present !== false);
    const normalized = items.map(item => {
      const result = JSON.parse(JSON.stringify(item)) as Record<string, unknown>;
      for (const field of ['size', 'distance', 'choke', 'soften']) {
        const value = result[field];
        if (value && typeof value === 'object' && typeof (value as any).value === 'number') result[field] = (value as any).value;
      }
      if (result.opacity !== undefined) result.opacity = normalizePsdOpacity(result.opacity);
      return result;
    });
    if (normalized.length) output[key] = Array.isArray(raw) ? normalized : normalized[0];
  }
  return output;
}

export function firstPsdEffects(effects: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(effects).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));
}

function vectorColor(color: any): [number, number, number] | null {
  if (!color || typeof color !== 'object') return null;
  if (typeof color.r === 'number') return [byte(color.r), byte(color.g), byte(color.b)];
  if (typeof color.fr === 'number') return [byte(color.fr * 255), byte(color.fg * 255), byte(color.fb * 255)];
  if (typeof color.c === 'number') return [color.c, color.m, color.y].map(value => byte(255 * (1 - normalizePsdOpacity(value / 100)) * (1 - normalizePsdOpacity(color.k / 100)))) as [number, number, number];
  if (typeof color.k === 'number') return [byte(color.k), byte(color.k), byte(color.k)];
  return null;
}

export function canRestorePsdVectorContent(layer: Layer): boolean {
  if (layer.vectorStroke?.strokeEnabled) return false;
  const fill = layer.vectorFill;
  if (fill?.type === 'color') return vectorColor(fill.color) !== null;
  return fill?.type === 'solid' && ['linear', 'radial', 'reflected', 'angle', 'diamond'].includes(fill.style || 'linear') && fill.colorStops.length > 0 && fill.colorStops.every(stop => vectorColor(stop.color));
}

/** Recreate the fill plane, leaving the intrinsic vector outline to psdMask. */
export function renderPsdVectorContent(layer: Layer, bounds: Pick<PsdMaskRaster, 'x' | 'y' | 'width' | 'height'>, psd: Pick<Psd, 'width' | 'height'>): any {
  if (!canRestorePsdVectorContent(layer)) return null;
  const { createCanvas } = require('@napi-rs/canvas');
  const canvas = createCanvas(bounds.width, bounds.height);
  const ctx = canvas.getContext('2d');
  const fill = layer.vectorFill!;
  if (fill.type === 'color') {
    ctx.fillStyle = `rgb(${vectorColor(fill.color)!.join(',')})`;
    ctx.fillRect(0, 0, bounds.width, bounds.height);
    return canvas;
  }
  if (fill.type !== 'solid') return null;
  const colors = fill.colorStops.map(stop => ({ ...stop, rgb: vectorColor(stop.color)! })).sort((a, b) => a.location - b.location);
  const opacities = (fill.opacityStops.length ? fill.opacityStops : [{ location: 0, opacity: 1, midpoint: 0.5 }]).slice().sort((a, b) => a.location - b.location);
  const interpolate = <T extends { location: number; midpoint: number }>(stops: T[], value: number, sample: (stop: T) => number): number => {
    if (value <= stops[0].location) return sample(stops[0]);
    for (let i = 1; i < stops.length; i++) {
      if (value > stops[i].location) continue;
      const previous = stops[i - 1], current = stops[i];
      let amount = (value - previous.location) / Math.max(0.000001, current.location - previous.location);
      const midpoint = Math.max(0.000001, Math.min(0.999999, previous.midpoint ?? 0.5));
      amount = amount <= midpoint ? amount / midpoint * 0.5 : 0.5 + (amount - midpoint) / (1 - midpoint) * 0.5;
      return sample(previous) + (sample(current) - sample(previous)) * amount;
    }
    return sample(stops[stops.length - 1]);
  };
  const box = fill.align === false ? { x: 0, y: 0, width: psd.width, height: psd.height } : { x: layer.left || 0, y: layer.top || 0, width: Math.max(1, (layer.right || 0) - (layer.left || 0)), height: Math.max(1, (layer.bottom || 0) - (layer.top || 0)) };
  const angle = (fill.angle || 0) * Math.PI / 180;
  const cos = Math.cos(angle), sin = -Math.sin(angle);
  const span = Math.max(1, Math.abs(cos) * box.width + Math.abs(sin) * box.height) * Math.max(0.0001, (fill.scale ?? 100) / 100);
  const centerX = box.x + box.width * (0.5 + (fill.offset?.x || 0) / 100);
  const centerY = box.y + box.height * (0.5 + (fill.offset?.y || 0) / 100);
  const image = ctx.createImageData(bounds.width, bounds.height);
  for (let row = 0; row < bounds.height; row++) for (let column = 0; column < bounds.width; column++) {
    const dx = bounds.x + column + 0.5 - centerX, dy = bounds.y + row + 0.5 - centerY;
    const along = (dx * cos + dy * sin) / span;
    const across = (-dx * sin + dy * cos) / span;
    let location = 0.5 + along;
    if (fill.style === 'radial') location = Math.hypot(dx, dy) * 2 / span;
    if (fill.style === 'reflected') location = Math.abs(along) * 2;
    if (fill.style === 'diamond') location = (Math.abs(along) + Math.abs(across)) * 2;
    if (fill.style === 'angle') location = ((Math.atan2(dy, dx) - Math.atan2(sin, cos)) / (Math.PI * 2) + 1) % 1;
    if (fill.reverse) location = 1 - location;
    const offset = (row * bounds.width + column) * 4;
    for (let channel = 0; channel < 3; channel++) image.data[offset + channel] = byte(interpolate(colors, location, stop => stop.rgb[channel]));
    image.data[offset + 3] = byte(interpolate(opacities, location, stop => normalizePsdOpacity(stop.opacity)) * 255);
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

export function releasePsdLayerPixels(layer: Layer): void {
  delete layer.canvas;
  delete layer.imageData;
  delete layer.rawData;
  for (const mask of [layer.mask, layer.realMask]) {
    if (mask) {
      delete mask.canvas;
      delete mask.imageData;
    }
  }
}

type MaskPart = {
  source: object;
  canvas: any;
  x: number;
  y: number;
  width: number;
  height: number;
  defaultColor: number;
  density: number;
  feather: number;
  pixels?: ArrayLike<number>;
  pixelScale?: number;
};
function byte(value: number): number { return Math.max(0, Math.min(255, Math.round(value))); }
function maskValue(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : value && typeof value === 'object' ? (value as any).value : NaN;
  return typeof number === 'number' && Number.isFinite(number) ? number : fallback;
}

function bitmapPart(mask: LayerMaskData, owner: Layer, parameters: LayerMaskData, vector: boolean): MaskPart | null {
  if (mask.disabled) return null;
  const canvas = mask.canvas as unknown as { width: number; height: number } | undefined;
  const width = canvas?.width || mask.imageData?.width || Math.max(0, (mask.right || 0) - (mask.left || 0));
  const height = canvas?.height || mask.imageData?.height || Math.max(0, (mask.bottom || 0) - (mask.top || 0));
  return {
    source: mask,
    canvas: mask.canvas || null,
    pixels: mask.imageData?.data,
    pixelScale: mask.imageData?.data instanceof Uint16Array ? 1 / 257 : mask.imageData?.data instanceof Float32Array ? 255 : 1,
    x: (mask.left || 0) + (mask.positionRelativeToLayer ? owner.left || 0 : 0),
    y: (mask.top || 0) + (mask.positionRelativeToLayer ? owner.top || 0 : 0),
    width,
    height,
    defaultColor: byte(mask.defaultColor ?? 255),
    density: normalizePsdOpacity(vector ? parameters.vectorMaskDensity : parameters.userMaskDensity),
    feather: Math.max(0, maskValue(vector ? parameters.vectorMaskFeather : parameters.userMaskFeather, 0)),
  };
}

function traceVectorPath(ctx: any, path: LayerVectorMask['paths'][number], x: number, y: number): void {
  const knots = path.knots;
  if (!knots.length || path.open) return;
  ctx.moveTo(knots[0].points[2] - x, knots[0].points[3] - y);
  for (let i = 1; i <= knots.length; i++) {
    const previous = knots[i - 1].points;
    const current = knots[i % knots.length].points;
    if (previous.length !== 6 || current.length !== 6 || [...previous, ...current].some(value => !Number.isFinite(value))) throw new Error('矢量蒙版包含无效曲线坐标');
    ctx.bezierCurveTo(previous[4] - x, previous[5] - y, current[0] - x, current[1] - y, current[2] - x, current[3] - y);
  }
  ctx.closePath();
}

function vectorPart(vector: LayerVectorMask, owner: Layer, psd: Pick<Psd, 'width' | 'height'>): MaskPart | null {
  if (vector.disable) return null;
  const { createCanvas } = require('@napi-rs/canvas');
  const points = vector.paths.flatMap(path => path.open ? [] : path.knots.flatMap(knot => knot.points));
  const xs = points.filter((_, index) => index % 2 === 0);
  const ys = points.filter((_, index) => index % 2 === 1);
  const x = xs.length ? Math.floor(Math.min(...xs)) : 0;
  const y = ys.length ? Math.floor(Math.min(...ys)) : 0;
  const width = Math.max(1, xs.length ? Math.ceil(Math.max(...xs)) - x : psd.width);
  const height = Math.max(1, ys.length ? Math.ceil(Math.max(...ys)) - y : psd.height);
  const maxPixels = configuredLimit(process.env.PSD_MAX_PIXELS, 100_000_000);
  if (width * height > maxPixels) throw new Error('矢量蒙版像素数超过解析预算');
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  if (vector.fillStartsWithAllPixels) ctx.fillRect(0, 0, width, height);
  const defaultPaths = vector.paths.filter(path => !path.operation);
  if (defaultPaths.length) {
    ctx.beginPath();
    for (const path of defaultPaths) traceVectorPath(ctx, path, x, y);
    ctx.fill(defaultPaths[0].fillRule === 'even-odd' ? 'evenodd' : 'nonzero');
  }
  for (const path of vector.paths.filter(path => path.operation)) {
    const part = createCanvas(width, height);
    const partCtx = part.getContext('2d');
    partCtx.fillStyle = '#fff';
    partCtx.beginPath();
    traceVectorPath(partCtx, path, x, y);
    partCtx.fill(path.fillRule === 'even-odd' ? 'evenodd' : 'nonzero');
    ctx.globalCompositeOperation = ({ combine: 'source-over', subtract: 'destination-out', intersect: 'destination-in', exclude: 'xor' } as const)[path.operation!];
    ctx.drawImage(part, 0, 0);
  }
  ctx.globalCompositeOperation = 'source-over';
  const image = ctx.getImageData(0, 0, width, height);
  // The vector raster already represents alpha; bitmap masks represent luminance.
  for (let i = 0; i < image.data.length; i += 4) {
    const alpha = image.data[i + 3];
    image.data[i] = image.data[i + 1] = image.data[i + 2] = vector.invert ? 255 - alpha : alpha;
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return {
    source: vector, canvas, x, y, width, height,
    defaultColor: vector.invert ? (vector.fillStartsWithAllPixels ? 0 : 255) : (vector.fillStartsWithAllPixels ? 255 : 0),
    density: normalizePsdOpacity(owner.mask?.vectorMaskDensity),
    feather: Math.max(0, maskValue(owner.mask?.vectorMaskFeather, 0)),
  };
}

export function createPsdMaskRenderer() {
  const cache = new WeakMap<object, Map<string, Promise<PsdMaskRaster>>>();
  const renderPart = (part: MaskPart): Promise<PsdMaskRaster> => {
    const key = [part.x, part.y, part.width, part.height, part.defaultColor, part.density, part.feather].join(':');
    let entries = cache.get(part.source);
    if (!entries) { entries = new Map(); cache.set(part.source, entries); }
    const previous = entries.get(key);
    if (previous) return previous;
    const work = (async () => {
      const padding = part.feather > 0 ? Math.max(2, Math.ceil(part.feather * 3)) : 0;
      const width = Math.max(1, part.width) + padding * 2;
      const height = Math.max(1, part.height) + padding * 2;
      if (width * height > configuredLimit(process.env.PSD_MAX_PIXELS, 100_000_000)) throw new Error('羽化蒙版像素数超过解析预算');
      const x = part.x - padding;
      const y = part.y - padding;
      let alpha = Buffer.alloc(width * height, part.defaultColor);
      const source = part.canvas?.getContext('2d').getImageData(0, 0, part.width, part.height).data || part.pixels;
      if (!source && part.width > 0 && part.height > 0) throw new Error('蒙版没有可用的解码像素');
      const pixelScale = part.canvas ? 1 : part.pixelScale || 1;
      if (source) {
        for (let row = 0; row < part.height; row++) {
          for (let column = 0; column < part.width; column++) {
            const offset = (row * part.width + column) * 4;
            const opacity = source[offset + 3] * pixelScale / 255;
            alpha[(row + padding) * width + column + padding] = byte((source[offset] + source[offset + 1] + source[offset + 2]) * pixelScale / 3 * opacity + part.defaultColor * (1 - opacity));
          }
        }
      }
      if (part.feather > 0) {
        const sharp = require('sharp');
        alpha = await sharp(alpha, { raw: { width, height, channels: 1 } }).blur(Math.min(1000, Math.max(0.3, part.feather))).extractChannel(0).raw().toBuffer();
      }
      const densityAlpha = (value: number) => byte(255 - (255 - value) * part.density);
      const { createCanvas } = require('@napi-rs/canvas');
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');
      const image = ctx.createImageData(width, height);
      for (let i = 0; i < alpha.length; i++) {
        image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = 255;
        image.data[i * 4 + 3] = densityAlpha(alpha[i]);
      }
      ctx.putImageData(image, 0, 0);
      return { canvas, x, y, width, height, defaultColor: densityAlpha(part.defaultColor) };
    })();
    entries.set(key, work);
    return work;
  };
  const render = async (layer: Layer, psd: Pick<Psd, 'width' | 'height'>, options: { skipVectorMask?: boolean } = {}): Promise<PsdMaskRaster | null> => {
    const parts: MaskPart[] = [];
    const primary = layer.mask;
    const vector = !options.skipVectorMask && layer.vectorMask && !layer.vectorMask.disable ? layer.vectorMask : undefined;
    const real = layer.realMask && !layer.realMask.disabled ? layer.realMask : undefined;
    const cachedVector = !options.skipVectorMask && primary?.fromVectorData === true && !primary.disabled && !real;
    if (cachedVector && (!layer.vectorMask || vector)) {
      const part = bitmapPart(primary!, layer, primary!, true);
      if (part) parts.push(part);
    } else {
      const user = real || (primary && !primary.fromVectorData ? primary : undefined);
      if (user) {
        const part = bitmapPart(user, layer, primary || user, false);
        if (part) parts.push(part);
      }
      if (vector) {
        const part = vectorPart(vector, layer, psd);
        if (part) parts.push(part);
      }
    }
    if (!parts.length) return null;
    const rasters = await Promise.all(parts.map(renderPart));
    if (rasters.length === 1) return rasters[0];
    const x = Math.min(...rasters.map(part => part.x));
    const y = Math.min(...rasters.map(part => part.y));
    const width = Math.max(...rasters.map(part => part.x + part.width)) - x;
    const height = Math.max(...rasters.map(part => part.y + part.height)) - y;
    if (width * height > configuredLimit(process.env.PSD_MAX_PIXELS, 100_000_000)) throw new Error('合成蒙版像素数超过解析预算');
    const { createCanvas } = require('@napi-rs/canvas');
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(width, height);
    const pixels = rasters.map(part => part.canvas.getContext('2d').getImageData(0, 0, part.width, part.height).data);
    for (let row = 0; row < height; row++) {
      for (let column = 0; column < width; column++) {
        let alpha = 1;
        for (let i = 0; i < rasters.length; i++) {
          const part = rasters[i];
          const localX = x + column - part.x;
          const localY = y + row - part.y;
          const value = localX >= 0 && localY >= 0 && localX < part.width && localY < part.height ? pixels[i][(localY * part.width + localX) * 4 + 3] : part.defaultColor;
          alpha *= value / 255;
        }
        const index = (row * width + column) * 4;
        image.data[index] = image.data[index + 1] = image.data[index + 2] = 255;
        image.data[index + 3] = byte(alpha * 255);
      }
    }
    ctx.putImageData(image, 0, 0);
    return { canvas, x, y, width, height, defaultColor: byte(rasters.reduce((alpha, part) => alpha * part.defaultColor / 255, 255)) };
  };
  return Object.assign(render, {
    release(layer: Layer) {
      for (const source of [layer.mask, layer.realMask, layer.vectorMask]) {
        if (source) cache.delete(source);
      }
    },
  });
}
