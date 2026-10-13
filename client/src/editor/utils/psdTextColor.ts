import * as fabric from 'fabric';

type ColorBucket = {
  r: number;
  g: number;
  b: number;
  weight: number;
};

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clampChannel(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

export function extractPsdRunFillColor(run: unknown): string | null {
  if (!run || typeof run !== 'object') return null;
  const fillColor = (run as Record<string, unknown>).fillColor;
  if (typeof fillColor === 'string' && fillColor.trim()) return fillColor.trim();
  if (!fillColor || typeof fillColor !== 'object') return null;

  const color = fillColor as Record<string, unknown>;
  const r = toFiniteNumber(color.r);
  const g = toFiniteNumber(color.g);
  const b = toFiniteNumber(color.b);
  if (r === null || g === null || b === null) return null;
  return `rgb(${clampChannel(r)},${clampChannel(g)},${clampChannel(b)})`;
}

export function getDominantPsdRunFillColor(runs: unknown): string | null {
  if (!Array.isArray(runs) || runs.length === 0) return null;
  const dominant = runs.reduce<Record<string, unknown> | null>((best, current) => {
    if (!current || typeof current !== 'object') return best;
    const run = current as Record<string, unknown>;
    if (!best) return run;
    return (toFiniteNumber(run.length) || 0) > (toFiniteNumber(best.length) || 0) ? run : best;
  }, null);
  return extractPsdRunFillColor(dominant);
}

export function sampleFabricImageDominantOpaqueColor(image: fabric.FabricImage): string | null {
  if (typeof document === 'undefined') return null;
  const element = typeof image.getElement === 'function'
    ? image.getElement() as HTMLImageElement | HTMLCanvasElement | HTMLVideoElement | null
    : null;
  if (!element) return null;

  const sourceWidth = Math.max(
    1,
    Math.round(
      Number(
        (element as HTMLImageElement).naturalWidth
        || (element as HTMLVideoElement).videoWidth
        || element.width
        || image.width
        || 1,
      ),
    ),
  );
  const sourceHeight = Math.max(
    1,
    Math.round(
      Number(
        (element as HTMLImageElement).naturalHeight
        || (element as HTMLVideoElement).videoHeight
        || element.height
        || image.height
        || 1,
      ),
    ),
  );
  const maxSide = 96;
  const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
  const sampleWidth = Math.max(1, Math.round(sourceWidth * scale));
  const sampleHeight = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = sampleWidth;
  canvas.height = sampleHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  try {
    ctx.drawImage(element, 0, 0, sampleWidth, sampleHeight);
    const data = ctx.getImageData(0, 0, sampleWidth, sampleHeight).data;
    const buckets = new Map<string, ColorBucket>();
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      if (alpha < 160) continue;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const key = `${r >> 4}:${g >> 4}:${b >> 4}`;
      const weight = alpha / 255;
      const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, weight: 0 };
      bucket.r += r * weight;
      bucket.g += g * weight;
      bucket.b += b * weight;
      bucket.weight += weight;
      buckets.set(key, bucket);
    }

    let best: ColorBucket | null = null;
    for (const bucket of buckets.values()) {
      if (!best || bucket.weight > best.weight) best = bucket;
    }
    if (!best || best.weight <= 0) return null;
    return `rgb(${clampChannel(best.r / best.weight)},${clampChannel(best.g / best.weight)},${clampChannel(best.b / best.weight)})`;
  } catch {
    return null;
  }
}
