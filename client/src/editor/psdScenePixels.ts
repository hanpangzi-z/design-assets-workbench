/** Pixel operations shared by the PSD scene renderer and its export path. */
export type PsdRecord = Record<string, any>;

export const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));
export const number = (value: unknown, fallback = 0): number => {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
};
export const unit = (value: unknown, fallback = 0) => number(
  value && typeof value === 'object' ? (value as PsdRecord).value : value, fallback,
);
export const opacity = (value: unknown, fallback = 1) => clamp(number(value, fallback));

export function psdColor(value: unknown): [number, number, number] | null {
  if (!value || typeof value !== 'object') return null;
  const color = value as PsdRecord;
  if ('r' in color) return [number(color.r), number(color.g), number(color.b)].map((v) => clamp(v, 0, 255)) as [number, number, number];
  if ('fr' in color) return [number(color.fr), number(color.fg), number(color.fb)].map((v) => clamp(v) * 255) as [number, number, number];
  if ('k' in color) return [color.c, color.m, color.y].map((v) => 255 * (1 - clamp(number(v) / 100)) * (1 - clamp(number(color.k) / 100))) as [number, number, number];
  return null;
}

export function interpolatePixels(before: ImageData, after: ImageData, amount: number, mask?: Uint8ClampedArray) {
  const result = new Uint8ClampedArray(before.data.length);
  for (let i = 0; i < result.length; i += 4) {
    const t = clamp(amount * (mask ? mask[i + 3] / 255 : 1));
    const a = before.data[i + 3] / 255, b = after.data[i + 3] / 255;
    const alpha = a + (b - a) * t;
    for (let channel = 0; channel < 3; channel++) {
      const premultiplied = before.data[i + channel] * a * (1 - t) + after.data[i + channel] * b * t;
      result[i + channel] = alpha ? premultiplied / alpha : 0;
    }
    result[i + 3] = alpha * 255;
  }
  return result;
}

const luminosity = (c: number[]) => c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
function clipColor(c: number[]): number[] {
  const l = luminosity(c), low = Math.min(...c), high = Math.max(...c);
  if (low < 0) c = c.map((v) => l + (v - l) * l / (l - low));
  if (high > 1) c = c.map((v) => l + (v - l) * (1 - l) / (high - l));
  return c.map((v) => clamp(v));
}
function setLum(c: number[], lum: number) { const diff = lum - luminosity(c); return clipColor(c.map((v) => v + diff)); }
function setSat(c: number[], sat: number) {
  const indices = [0, 1, 2].sort((a, b) => c[a] - c[b]);
  const [lo, mid, hi] = indices, result = [0, 0, 0];
  if (c[hi] > c[lo]) { result[mid] = (c[mid] - c[lo]) * sat / (c[hi] - c[lo]); result[hi] = sat; }
  return result;
}
const sat = (c: number[]) => Math.max(...c) - Math.min(...c);
const burn = (b: number, s: number) => s === 0 ? 0 : 1 - Math.min(1, (1 - b) / s);
const dodge = (b: number, s: number) => s === 1 ? 1 : Math.min(1, b / (1 - s));

export function blendColor(base: number[], source: number[], mode: string): number[] {
  if (mode === 'hue') return setLum(setSat(source, sat(base)), luminosity(base));
  if (mode === 'saturation') return setLum(setSat(base, sat(source)), luminosity(base));
  if (mode === 'color') return setLum(source, luminosity(base));
  if (mode === 'luminosity') return setLum(base, luminosity(source));
  return base.map((b, i) => {
    const s = source[i];
    switch (mode) {
      case 'multiply': return b * s;
      case 'screen': return b + s - b * s;
      case 'overlay': return b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
      case 'hard light': return s <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
      case 'soft light': return s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * ((b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b)) - b);
      case 'darken': return Math.min(b, s);
      case 'lighten': return Math.max(b, s);
      case 'color burn': return burn(b, s);
      case 'linear burn': return Math.max(0, b + s - 1);
      case 'color dodge': return dodge(b, s);
      case 'linear dodge': return Math.min(1, b + s);
      case 'vivid light': return s <= 0.5 ? burn(b, 2 * s) : dodge(b, 2 * s - 1);
      case 'linear light': return clamp(b + 2 * s - 1);
      case 'pin light': return s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1);
      case 'hard mix': return (s <= 0.5 ? burn(b, 2 * s) : dodge(b, 2 * s - 1)) < 0.5 ? 0 : 1;
      case 'difference': return Math.abs(b - s);
      case 'exclusion': return b + s - 2 * b * s;
      case 'subtract': return Math.max(0, b - s);
      case 'divide': return s === 0 ? 1 : Math.min(1, b / s);
      default: return s;
    }
  });
}

export const supportedBlendModes = new Set([
  'normal', 'multiply', 'screen', 'overlay', 'soft light', 'hard light', 'darken', 'lighten',
  'color burn', 'linear burn', 'color dodge', 'linear dodge', 'vivid light', 'linear light',
  'pin light', 'hard mix', 'difference', 'exclusion', 'subtract', 'divide', 'hue', 'saturation', 'color', 'luminosity',
]);
export function normalizeBlendMode(value: unknown) {
  const mode = String(value || 'normal').toLowerCase().replace(/[-_]/g, ' ');
  if (mode === 'source over') return 'normal';
  if (mode === 'lighter' || mode === 'linear dodge (add)') return 'linear dodge';
  return mode;
}

/** Straight RGBA source-over, with blend color computed before alpha composition. */
export function blendPixels(destination: Uint8ClampedArray, source: Uint8ClampedArray, mode = 'normal', amount = 1) {
  const result = new Uint8ClampedArray(destination.length);
  for (let i = 0; i < result.length; i += 4) {
    const ab = destination[i + 3] / 255, as = source[i + 3] / 255 * amount;
    const alpha = as + ab * (1 - as);
    if (!alpha) continue;
    const b = [destination[i], destination[i + 1], destination[i + 2]].map((v) => v / 255);
    const s = [source[i], source[i + 1], source[i + 2]].map((v) => v / 255);
    const mixed = blendColor(b, s, mode);
    for (let channel = 0; channel < 3; channel++) {
      result[i + channel] = 255 * ((1 - as) * ab * b[channel] + as * ((1 - ab) * s[channel] + ab * mixed[channel])) / alpha;
    }
    result[i + 3] = alpha * 255;
  }
  return result;
}

function rgbToHsl(c: number[]) {
  const hi = Math.max(...c), lo = Math.min(...c), d = hi - lo, l = (hi + lo) / 2;
  let h = 0;
  if (d) {
    if (hi === c[0]) h = ((c[1] - c[2]) / d + (c[1] < c[2] ? 6 : 0)) / 6;
    else if (hi === c[1]) h = ((c[2] - c[0]) / d + 2) / 6;
    else h = ((c[0] - c[1]) / d + 4) / 6;
  }
  return [h, d ? d / (1 - Math.abs(2 * l - 1)) : 0, l];
}
function hslToRgb(h: number, s: number, l: number) {
  h = ((h % 1) + 1) % 1;
  const a = s * Math.min(l, 1 - l);
  return [0, 8, 4].map((n) => { const k = (n + h * 12) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); });
}
function hueWeight(hue: number, range: PsdRecord, center: number) {
  const unwrap = (v: number, start: number) => ((v - start) % 360 + 360) % 360;
  const a = number(range.a, center - 45), b = number(range.b, center - 15), c = number(range.c, center + 15), d = number(range.d, center + 45);
  const h = unwrap(hue, a), ub = unwrap(b, a), uc = unwrap(c, a), ud = unwrap(d, a);
  if (h > ud) return 0;
  if (h < ub) return ub ? h / ub : 1;
  if (h <= uc) return 1;
  return ud === uc ? 0 : (ud - h) / (ud - uc);
}

function curveTable(points: PsdRecord[] | undefined): number[] {
  if (!points?.length) return Array.from({ length: 256 }, (_, i) => i);
  const knots = points.map((p) => ({ x: clamp(number(p.input), 0, 255), y: clamp(number(p.output), 0, 255) }))
    .sort((a, b) => a.x - b.x).filter((p, i, all) => i === 0 || p.x !== all[i - 1].x);
  if (knots.length === 1) return Array(256).fill(knots[0].y);
  // Natural cubic interpolation; endpoints stay at their supplied output values.
  const n = knots.length, second = Array(n).fill(0), u = Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const sig = (knots[i].x - knots[i - 1].x) / (knots[i + 1].x - knots[i - 1].x), p = sig * second[i - 1] + 2;
    second[i] = (sig - 1) / p;
    const slope = (knots[i + 1].y - knots[i].y) / (knots[i + 1].x - knots[i].x) - (knots[i].y - knots[i - 1].y) / (knots[i].x - knots[i - 1].x);
    u[i] = (6 * slope / (knots[i + 1].x - knots[i - 1].x) - sig * u[i - 1]) / p;
  }
  for (let i = n - 2; i >= 0; i--) second[i] = second[i] * second[i + 1] + u[i];
  return Array.from({ length: 256 }, (_, x) => {
    if (x <= knots[0].x) return knots[0].y;
    if (x >= knots[n - 1].x) return knots[n - 1].y;
    let k = 0; while (knots[k + 1].x < x) k++;
    const h = knots[k + 1].x - knots[k].x, a = (knots[k + 1].x - x) / h, b = (x - knots[k].x) / h;
    return clamp(a * knots[k].y + b * knots[k + 1].y + ((a ** 3 - a) * second[k] + (b ** 3 - b) * second[k + 1]) * h * h / 6, 0, 255);
  });
}

export const supportedAdjustments = new Set(['levels', 'curves', 'hue/saturation', 'color balance', 'selective color', 'brightness/contrast', 'exposure', 'invert', 'threshold', 'posterize', 'black & white']);

export function adjustPixels(data: Uint8ClampedArray, settings: PsdRecord): Uint8ClampedArray {
  const result = new Uint8ClampedArray(data);
  const curve = settings.type === 'curves' ? ['rgb', 'red', 'green', 'blue'].map((key) => curveTable(settings[key])) : [];
  const level = (v: number, p: PsdRecord | undefined) => {
    if (!p) return v;
    const low = number(p.shadowInput), high = number(p.highlightInput, 255), gamma = Math.max(0.01, number(p.midtoneInput, 1));
    return number(p.shadowOutput) + (number(p.highlightOutput, 255) - number(p.shadowOutput)) * clamp((v - low) / Math.max(1, high - low)) ** (1 / gamma);
  };
  const colorNames = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'];
  for (let i = 0; i < result.length; i += 4) {
    if (!data[i + 3]) continue;
    const original = [data[i], data[i + 1], data[i + 2]].map((v) => v / 255);
    let color = [...original];
    switch (settings.type) {
      case 'levels': color = color.map((v, c) => level(level(v * 255, settings.rgb), settings[['red', 'green', 'blue'][c]]) / 255); break;
      case 'curves': color = color.map((v, c) => curve[c + 1][Math.round(clamp(curve[0][Math.round(v * 255)], 0, 255))] / 255); break;
      case 'hue/saturation': {
        const [h, s, l] = rgbToHsl(color), master = settings.master || {}, hue = h * 360;
        let dh = number(master.hue), ds = number(master.saturation), dl = number(master.lightness);
        colorNames.forEach((key, c) => {
          const p = settings[key]; if (!p) return;
          const w = hueWeight(hue, p, c * 60); dh += number(p.hue) * w; ds += number(p.saturation) * w; dl += number(p.lightness) * w;
        });
        const saturation = clamp(ds >= 0 ? s + (1 - s) * ds / 100 : s * (1 + ds / 100));
        const light = clamp(dl >= 0 ? l + (1 - l) * dl / 100 : l * (1 + dl / 100));
        color = hslToRgb(h + dh / 360, saturation, light); break;
      }
      case 'color balance': {
        const l = luminosity(color), shadow = clamp((0.5 - l) * 2), highlight = clamp((l - 0.5) * 2), mid = 1 - shadow - highlight;
        const values = [settings.shadows || {}, settings.midtones || {}, settings.highlights || {}], weights = [shadow, mid, highlight];
        color = color.map((v, c) => clamp(v + values.reduce((sum, p, k) => sum + number(p[['cyanRed', 'magentaGreen', 'yellowBlue'][c]]) * weights[k] / 100, 0)));
        if (settings.preserveLuminosity) color = setLum(color, luminosity(original));
        break;
      }
      case 'selective color': {
        const [r, g, b] = original, hi = Math.max(r, g, b), lo = Math.min(r, g, b);
        const weights: PsdRecord = { reds: clamp(r - Math.max(g, b)), yellows: clamp(Math.min(r, g) - b), greens: clamp(g - Math.max(r, b)), cyans: clamp(Math.min(g, b) - r), blues: clamp(b - Math.max(r, g)), magentas: clamp(Math.min(r, b) - g), whites: clamp((lo - 0.5) * 2), blacks: clamp((0.5 - hi) * 2), neutrals: clamp(1 - Math.abs(hi + lo - 1)) };
        for (const key of Object.keys(weights)) {
          const p = settings[key]; if (!p) continue;
          const w = weights[key], black = number(p.k) / 100;
          color = color.map((v, c) => {
            const ink = number(p[['c', 'm', 'y'][c]]) / 100;
            const delta = settings.mode === 'absolute' ? ink + black : ink * (1 - v) + black * v;
            return clamp(v - delta * w);
          });
        }
        break;
      }
      case 'brightness/contrast': {
        const brightness = number(settings.brightness) / 255, contrast = clamp(number(settings.contrast), -100, 100) / 100;
        const factor = contrast < 0 ? 1 + contrast : 1 / Math.max(0.01, 1 - contrast);
        color = color.map((v) => clamp((v - 0.5) * factor + 0.5 + brightness)); break;
      }
      case 'exposure': color = color.map((v) => clamp((v * 2 ** number(settings.exposure) + number(settings.offset)) ** (1 / Math.max(0.01, number(settings.gamma, 1))))); break;
      case 'invert': color = color.map((v) => 1 - v); break;
      case 'threshold': color = color.map(() => luminosity(original) * 255 >= number(settings.level, 128) ? 1 : 0); break;
      case 'posterize': { const levels = Math.max(2, number(settings.levels, 4)); color = color.map((v) => Math.round(v * (levels - 1)) / (levels - 1)); break; }
      case 'black & white': { const gray = luminosity(original); color = [gray, gray, gray]; break; }
    }
    for (let c = 0; c < 3; c++) result[i + c] = clamp(color[c]) * 255;
  }
  return result;
}

/** Separable box passes approximate a Gaussian alpha blur without browser filter differences. */
export function blurAlpha(input: Uint8ClampedArray, width: number, height: number, radius: number) {
  radius = Math.max(0, Math.ceil(radius));
  if (!radius) return new Uint8ClampedArray(input);
  let source = new Uint8ClampedArray(input);
  const r = Math.max(1, Math.ceil(radius / 2));
  for (let pass = 0; pass < 3; pass++) {
    const horizontal = new Uint8ClampedArray(source.length), output = new Uint8ClampedArray(source.length);
    for (let y = 0; y < height; y++) {
      let sum = 0; for (let x = -r; x <= r; x++) if (x >= 0 && x < width) sum += source[y * width + x];
      for (let x = 0; x < width; x++) {
        horizontal[y * width + x] = sum / (2 * r + 1);
        if (x - r >= 0) sum -= source[y * width + x - r];
        if (x + r + 1 < width) sum += source[y * width + x + r + 1];
      }
    }
    for (let x = 0; x < width; x++) {
      let sum = 0; for (let y = -r; y <= r; y++) if (y >= 0 && y < height) sum += horizontal[y * width + x];
      for (let y = 0; y < height; y++) {
        output[y * width + x] = sum / (2 * r + 1);
        if (y - r >= 0) sum -= horizontal[(y - r) * width + x];
        if (y + r + 1 < height) sum += horizontal[(y + r + 1) * width + x];
      }
    }
    source = output;
  }
  return source;
}

/** Alpha morphology with sliding windows, O(pixels), even for large PSD strokes. */
export function spreadAlpha(input: Uint8ClampedArray, width: number, height: number, radius: number, dilate = true) {
  const r = Math.max(0, Math.ceil(radius)); if (!r) return new Uint8ClampedArray(input);
  const horizontal = new Uint8ClampedArray(input.length), output = new Uint8ClampedArray(input.length);
  const extremum = (values: Uint8ClampedArray, result: Uint8ClampedArray, lines: number, length: number, step: number, start: (line: number) => number) => {
    for (let line = 0; line < lines; line++) {
      const queue: number[] = []; let head = 0, next = 0; const offset = start(line);
      for (let x = 0; x < length; x++) {
        while (next <= Math.min(length - 1, x + r)) {
          const v = values[offset + next * step];
          while (queue.length > head && (dilate ? values[offset + queue[queue.length - 1] * step] <= v : values[offset + queue[queue.length - 1] * step] >= v)) queue.pop();
          queue.push(next++);
        }
        while (queue[head] < x - r) head++;
        result[offset + x * step] = !dilate && (x < r || x + r >= length) ? 0 : values[offset + queue[head] * step];
      }
    }
  };
  extremum(input, horizontal, height, width, 1, (line) => line * width);
  extremum(horizontal, output, width, height, width, (line) => line);
  return output;
}

export function createGradientSampler(effect: PsdRecord, bounds: { x: number; y: number; width: number; height: number }): ((x: number, y: number) => [number, number, number, number]) | null {
  const gradient = effect.gradient;
  if (!gradient || gradient.type !== 'solid' || !gradient.colorStops?.length) return null;
  const angle = number(effect.angle) * Math.PI / 180, scale = Math.max(0.01, number(effect.scale, 1));
  const cos = Math.cos(angle), sin = -Math.sin(angle);
  const cx = bounds.x + bounds.width / 2 + number(effect.offset?.x) * bounds.width, cy = bounds.y + bounds.height / 2 + number(effect.offset?.y) * bounds.height;
  const extent = Math.max(1, Math.abs(bounds.width * cos) + Math.abs(bounds.height * sin)) * scale;
  const prepare = (stops: PsdRecord[], colorStop: boolean) => [...stops].map((stop) => ({
    location: number(stop.location) > 1 ? number(stop.location) / 4096 : number(stop.location),
    midpoint: clamp(number(stop.midpoint, 0.5), 0.001, 0.999),
    value: colorStop ? psdColor(stop.color) || [0, 0, 0] : [opacity(stop.opacity)],
  })).sort((a, b) => a.location - b.location);
  const colorStops = prepare(gradient.colorStops, true), alphaStops = gradient.opacityStops?.length ? prepare(gradient.opacityStops, false) : [];
  const sample = (stops: typeof colorStops, t: number): number[] => {
    let a = stops[0], b = stops[stops.length - 1];
    if (t <= a.location) b = a;
    else if (t >= b.location) a = b;
    else for (let i = 0; i < stops.length - 1; i++) if (t >= stops[i].location && t <= stops[i + 1].location) { a = stops[i]; b = stops[i + 1]; break; }
    let f = a === b ? 0 : (t - a.location) / Math.max(1e-8, b.location - a.location);
    f = f < a.midpoint ? f * 0.5 / a.midpoint : 0.5 + (f - a.midpoint) * 0.5 / (1 - a.midpoint);
    return a.value.map((v, c) => v + (b.value[c] - v) * f);
  };
  return (x, y) => {
  const dx = x - cx, dy = y - cy;
  let t: number;
  switch (effect.type || 'linear') {
    case 'radial': t = Math.hypot(dx, dy) / (Math.max(bounds.width, bounds.height) * scale / 2); break;
    case 'angle': t = ((Math.atan2(-dy, dx) - angle) / (Math.PI * 2) + 1) % 1; break;
    case 'reflected': t = Math.abs((dx * cos + dy * sin) / extent) * 2; break;
    case 'diamond': t = (Math.abs(dx * cos + dy * sin) + Math.abs(-dx * sin + dy * cos)) / (Math.max(bounds.width, bounds.height) * scale / 2); break;
    default: t = 0.5 + (dx * cos + dy * sin) / extent;
  }
  t = clamp(effect.reverse ? 1 - t : t);
  const rgb = sample(colorStops, t), alpha = alphaStops.length ? sample(alphaStops, t)[0] : 1;
  return [rgb[0], rgb[1], rgb[2], alpha];
  };
}

export function gradientColor(effect: PsdRecord, x: number, y: number, bounds: { x: number; y: number; width: number; height: number }): [number, number, number, number] | null {
  return createGradientSampler(effect, bounds)?.(x, y) ?? null;
}
