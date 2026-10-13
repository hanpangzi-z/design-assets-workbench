import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { SaxesParser } from 'saxes';
import sharp from 'sharp';

type XmlNode = { name: string; attributes: Record<string, string>; children: XmlNode[]; text?: string };
type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const DRAW_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line', 'image', 'text']);
const SKIP_TAGS = new Set(['defs', 'metadata', 'title', 'desc']);
const SOURCE_RGBA_DIFF_LIMIT = 0.005;

export interface PdfCairoSvgOptions {
  width: number;
  height: number;
  outputDirectory: string;
  artifactUrlPrefix: string;
  pageNumber?: number;
  allowSingleSourceImage?: boolean;
  sourceCrop?: { left: number; top: number; width: number; height: number; pageWidth: number; pageHeight: number };
}
export interface PdfCairoSvgResult {
  svgText: string;
  elementCount: number;
  rasterImageCount: number;
  editableVectorCount: number;
  editableRasterCount: number;
  visualDiffRatioToOriginal: number;
  normalizedCompositeCount: number;
  effectRasterCount: number;
  sourceImageOnly?: true;
}

function parseXml(text: string): XmlNode {
  if (text.length > 64 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('Unsupported Cairo SVG XML declarations');
  const parser = new SaxesParser({ xmlns: false });
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let count = 0;
  parser.on('opentag', (tag) => {
    if (++count > 100_000 || stack.length > 128) throw new Error('Cairo SVG exceeds XML complexity limits');
    const node: XmlNode = { name: tag.name, attributes: tag.attributes as Record<string, string>, children: [] };
    if (stack.length) stack[stack.length - 1].children.push(node);
    else if (root) throw new Error('Cairo SVG contains multiple document roots');
    else root = node;
    stack.push(node);
  });
  parser.on('text', (text) => {
    if (text.trim() && stack.length) stack[stack.length - 1].text = (stack[stack.length - 1].text || '') + text;
  });
  parser.on('closetag', () => { stack.pop(); });
  parser.write(text).close();
  if (!root || root.name !== 'svg') throw new Error('Cairo output is not an SVG document');
  return root;
}
function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function serialize(node: XmlNode): string {
  const attributes = Object.entries(node.attributes).map(([key, value]) => ` ${key}="${escapeXml(value)}"`).join('');
  return `<${node.name}${attributes}>${node.text ? escapeXml(node.text) : ''}${node.children.map(serialize).join('')}</${node.name}>`;
}
function clone(node: XmlNode): XmlNode {
  return { name: node.name, attributes: { ...node.attributes }, children: node.children.map(clone), text: node.text };
}
function visit(node: XmlNode, fn: (node: XmlNode) => void): void {
  fn(node);
  node.children.forEach(child => visit(child, fn));
}
function reference(value: string | undefined): string {
  const match = /^url\(#([\w.-]+)\)$/.exec(value || '');
  if (!match) throw new Error('Cairo SVG contains an unsupported effect reference');
  return match[1];
}
function href(node: XmlNode): string { return node.attributes.href || node.attributes['xlink:href'] || ''; }
function multiply(a: Matrix, b: Matrix): Matrix {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}
function inverse(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) throw new Error('Cairo SVG contains a singular transform');
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}
function transform(value?: string): Matrix {
  if (!value) return IDENTITY;
  let result: Matrix = IDENTITY;
  let consumed = '';
  for (const match of value.matchAll(/([A-Za-z]+)\s*\(([^)]*)\)/g)) {
    consumed += match[0];
    const n = match[2].trim().split(/[\s,]+/).map(Number);
    if (!n.length || n.some(x => !Number.isFinite(x))) throw new Error('Invalid Cairo SVG transform');
    let next: Matrix;
    switch (match[1]) {
      case 'matrix': if (n.length !== 6) throw new Error('Invalid Cairo SVG matrix'); next = n as Matrix; break;
      case 'translate': if (n.length > 2) throw new Error('Invalid Cairo SVG translate'); next = [1, 0, 0, 1, n[0], n[1] || 0]; break;
      case 'scale': if (n.length > 2) throw new Error('Invalid Cairo SVG scale'); next = [n[0], 0, 0, n[1] ?? n[0], 0, 0]; break;
      case 'rotate': {
        if (n.length !== 1 && n.length !== 3) throw new Error('Invalid Cairo SVG rotate');
        const angle = n[0] * Math.PI / 180;
        next = [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0];
        if (n.length === 3) next = multiply(multiply([1, 0, 0, 1, n[1], n[2]], next), [1, 0, 0, 1, -n[1], -n[2]]);
        break;
      }
      case 'skewX': if (n.length !== 1) throw new Error('Invalid Cairo SVG skew'); next = [1, 0, Math.tan(n[0] * Math.PI / 180), 1, 0, 0]; break;
      case 'skewY': if (n.length !== 1) throw new Error('Invalid Cairo SVG skew'); next = [1, Math.tan(n[0] * Math.PI / 180), 0, 1, 0, 0]; break;
      default: throw new Error('Unsupported Cairo SVG transform');
    }
    result = multiply(result, next);
  }
  if (consumed.replace(/\s/g, '') !== value.replace(/\s/g, '') || result.some(n => !Number.isFinite(n))) throw new Error('Unsupported Cairo SVG transform syntax');
  return result;
}
function assertSafeReferences(root: XmlNode): Map<string, XmlNode> {
  const ids = new Map<string, XmlNode>();
  visit(root, node => {
    if (node.attributes.id) {
      if (ids.has(node.attributes.id)) throw new Error('Duplicate Cairo SVG id');
      ids.set(node.attributes.id, node);
    }
    if (['script', 'foreignObject', 'style'].includes(node.name) || node.text && node.name !== 'text') throw new Error('Unsupported Cairo SVG content');
    // Fabric imports gradients and clips but has no SVG pattern/mesh paint
    // implementation. Sharp's successful render cannot establish editability.
    if (['pattern', 'meshgradient', 'meshrow', 'meshpatch'].includes(node.name.toLowerCase())) throw new Error('Cairo SVG contains paint elements unsupported by the editor');
    // Fabric clips compound paths with their fill rule and does not honor SVG's
    // separate evenodd clip-rule. Do not publish a clip whose holes will fill in.
    if (node.attributes['clip-rule'] && node.attributes['clip-rule'] !== 'nonzero') throw new Error('Cairo SVG contains clip rules unsupported by the editor');
    if ((node.name === 'linearGradient' || node.name === 'radialGradient') && node.attributes.spreadMethod && node.attributes.spreadMethod !== 'pad') throw new Error('Cairo SVG contains gradient spread unsupported by the editor');
    if (node.name === 'radialGradient' && node.attributes.fr !== undefined && Number(node.attributes.fr) !== 0) throw new Error('Cairo SVG contains radial focal radius unsupported by the editor');
    if (node.name === 'clipPath' && node.attributes.clipPathUnits && node.attributes.clipPathUnits !== 'userSpaceOnUse') throw new Error('Cairo SVG contains clip units unsupported by the editor');
    if (node.attributes.visibility && node.attributes.visibility !== 'visible') throw new Error('Cairo SVG contains visibility unsupported by the editor');
    if (node.name === 'g' && ['fill-opacity', 'stroke-opacity'].some(key => node.attributes[key] !== undefined && Number(node.attributes[key]) !== 1)) throw new Error('Cairo SVG contains inherited paint opacity unsupported by the editor');
    for (const [key, value] of Object.entries(node.attributes)) {
      if (/^on/i.test(key) || key === 'style') throw new Error('Unsupported Cairo SVG style or event attribute');
      if (/url\s*\(/i.test(value) && !/^url\(#[\w.-]+\)$/.test(value)) throw new Error('Cairo SVG contains an external or unsupported paint reference');
      if (key === 'href' || key === 'xlink:href') {
        if (!/^#[\w.-]+$/.test(value) && !/^data:image\/png;base64,[A-Za-z0-9+/=\s]+$/.test(value)) throw new Error('Cairo SVG contains an external image reference');
      }
    }
  });
  // Resolve every local reference before asking the native renderer to follow
  // feImage/filter/mask graphs; use-only cycle checks do not cover these edges.
  let references = 0;
  const active = new Set<XmlNode>();
  function validate(node: XmlNode, depth: number): void {
    if (++references > 100_000 || depth > 64 || active.has(node)) throw new Error('Invalid or cyclic Cairo SVG reference graph');
    active.add(node);
    for (const [key, value] of Object.entries(node.attributes)) {
      const id = (key === 'href' || key === 'xlink:href') && value.startsWith('#')
        ? value.slice(1) : /^url\(#([\w.-]+)\)$/.exec(value)?.[1];
      if (id) {
        const target = ids.get(id);
        if (!target) throw new Error('Cairo SVG reference target is missing');
        validate(target, depth + 1);
      }
    }
    node.children.forEach(child => validate(child, depth));
    active.delete(node);
  }
  validate(root, 0);
  return ids;
}
function expandUses(node: XmlNode, ids: Map<string, XmlNode>, active = new Set<string>(), budget = { count: 0 }): XmlNode {
  if (++budget.count > 100_000) throw new Error('Cairo SVG instance count exceeds limit');
  if (node.name !== 'use') {
    const result = clone(node);
    result.children = node.children.map(child => expandUses(child, ids, active, budget));
    return result;
  }
  const id = href(node).slice(1);
  if (!href(node).startsWith('#') || !ids.has(id) || active.has(id) || active.size > 64) throw new Error('Invalid or cyclic Cairo SVG use reference');
  const nextActive = new Set(active); nextActive.add(id);
  const referenced = clone(ids.get(id)!);
  delete referenced.attributes.id;
  const attributes = { ...node.attributes };
  delete attributes.href; delete attributes['xlink:href'];
  const x = Number(attributes.x || 0), y = Number(attributes.y || 0);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Invalid Cairo SVG use coordinates');
  delete attributes.x; delete attributes.y;
  attributes.transform = `${attributes.transform || ''} translate(${x},${y})`.trim();
  if (/^glyph-/.test(id)) attributes['data-pdf-cairo-glyph'] = 'true';
  return { name: 'g', attributes, children: [expandUses(referenced, ids, nextActive, budget)] };
}

// Cairo's knockout export adds complementary, masked source and destination in
// premultiplied space. An opaque source may instead cover the unmasked destination
// using the same source mask. The strict structure and final pixel check are both
// required: an arbitrary arithmetic blend must never silently become source-over.
async function expandKnockout(node: XmlNode, ids: Map<string, XmlNode>, width: number, height: number, root: XmlNode): Promise<boolean> {
  if (!node.attributes.filter) return false;
  const filter = ids.get(reference(node.attributes.filter));
  if (!filter || filter.name !== 'filter' || filter.children.length !== 3
    || filter.children[0].name !== 'feImage' || filter.children[1].name !== 'feImage' || filter.children[2].name !== 'feComposite') return false;
  const [sourceImage, destinationImage, composite] = filter.children;
  if (composite.attributes.operator !== 'arithmetic' || ['k1', 'k2', 'k3', 'k4'].some((k, i) => Number(composite.attributes[k]) !== [0, 1, 1, 0][i])
    || composite.attributes.in !== sourceImage.attributes.result || composite.attributes.in2 !== destinationImage.attributes.result) throw new Error('Unsupported Cairo SVG arithmetic compositing');
  if (node.children.length !== 1 || node.children[0].name !== 'rect') throw new Error('Unsupported Cairo SVG compositing surface');
  const rect = node.children[0];
  for (const image of [sourceImage, destinationImage]) {
    const w = Number(image.attributes.width), h = Number(image.attributes.height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0 || w > width * 4 || h > height * 4
      || Number(image.attributes.x || 0) !== Number(rect.attributes.x || 0) || Number(image.attributes.y || 0) !== Number(rect.attributes.y || 0)
      || Math.abs(w - Number(rect.attributes.width)) > 0.001 || Math.abs(h - Number(rect.attributes.height)) > 0.001) throw new Error('Unsupported Cairo SVG compositing bounds');
  }
  const source = ids.get(href(sourceImage).slice(1)), destination = ids.get(href(destinationImage).slice(1));
  if (!source || !destination || !href(sourceImage).startsWith('#') || !href(destinationImage).startsWith('#')) throw new Error('Invalid Cairo SVG compositing references');
  const sourceMask = ids.get(reference(source.attributes.mask)), destinationMask = ids.get(reference(destination.attributes.mask));
  if (!sourceMask || !destinationMask || sourceMask.children.length !== 1 || destinationMask.children.length !== 1
    || sourceMask.children[0].name !== 'use' || destinationMask.children[0].name !== 'use'
    || href(sourceMask.children[0]) !== href(destinationMask.children[0]) || sourceMask.children[0].attributes.filter) throw new Error('Cairo SVG compositing masks are not complementary');
  if ([sourceMask, destinationMask].some(mask => Object.keys(mask.attributes).some(key => key !== 'id'))
    || Object.keys(sourceMask.children[0].attributes).some(key => key !== 'href' && key !== 'xlink:href')
    || Object.keys(destinationMask.children[0].attributes).some(key => !['href', 'xlink:href', 'filter'].includes(key))) throw new Error('Unsupported Cairo SVG compositing mask coordinates');
  const inverted = ids.get(reference(destinationMask.children[0].attributes.filter));
  const invertValues = inverted?.children[0]?.attributes.values?.trim().split(/\s+/).map(Number);
  if (!inverted || inverted.children.length !== 1 || inverted.children[0].name !== 'feColorMatrix'
    || !invertValues || invertValues.length !== 20 || invertValues.some((n, i) => n !== [0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -1, 1][i])) throw new Error('Unsupported Cairo SVG complementary alpha filter');
  const background = clone(destination); delete background.attributes.mask; delete background.attributes.id;
  const foreground = clone(source); delete foreground.attributes.id;
  // feImage is bounded independently of its referenced drawings. Retain that
  // crop when replacing the filter so no source/destination pixels leak out.
  const boundsId = `pdf_cairo_composite_${randomUUID().replace(/-/g, '')}`;
  const bounds: XmlNode = { name: 'defs', attributes: {}, children: [{ name: 'clipPath', attributes: { id: boundsId },
    children: [{ name: 'rect', attributes: Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, rect.attributes[key] || '0'])), children: [] }] }] };
  const children: XmlNode[] = [{ name: 'g', attributes: { 'clip-path': `url(#${boundsId})` }, children: [background, foreground] }];
  // A composite source can contain several drawings or a nested blend. Prove
  // source-over equivalence in the filter's own bounds, including alpha; a white
  // page comparison alone can hide an incorrectly removed destination mask.
  const before = clone(node); delete before.attributes.transform; delete before.attributes.id;
  const after = clone(before); delete after.attributes.filter; after.children = children;
  const proofWidth = Math.ceil(Number(rect.attributes.width) * Number(root.attributes.width) / width);
  const proofHeight = Math.ceil(Number(rect.attributes.height) * Number(root.attributes.height) / height);
  if (proofWidth * proofHeight > 16_000_000) throw new Error('Cairo SVG compositing proof exceeds pixel limit');
  const attributes = { ...root.attributes, width: String(proofWidth), height: String(proofHeight),
    viewBox: `${Number(rect.attributes.x || 0)} ${Number(rect.attributes.y || 0)} ${rect.attributes.width} ${rect.attributes.height}` };
  const defs = [...root.children.filter(child => child.name === 'defs'), bounds];
  const render = (drawing: XmlNode) => sharp(Buffer.from(serialize({ name: 'svg', attributes,
    children: [...defs.map(clone), drawing] })), { unlimited: true, limitInputPixels: 32_000_000 }).ensureAlpha().raw().toBuffer();
  const [originalPixels, replacementPixels] = await Promise.all([render(before), render(after)]);
  if (alphaPixelDifference(originalPixels, replacementPixels) > 0.001) throw new Error('Cairo SVG knockout source contains alpha or non-equivalent coverage');
  root.children.unshift(bounds);
  delete node.attributes.filter;
  node.children = children;
  return true;
}

function alphaPixelDifference(a: Buffer, b: Buffer): number {
  if (a.length !== b.length) throw new Error('Cairo SVG fidelity dimensions differ');
  let count = 0;
  for (let i = 0; i < a.length; i += 4) {
    let delta = Math.abs(a[i + 3] - b[i + 3]);
    for (let k = 0; k < 3; k++) delta += Math.abs(a[i + k] * a[i + 3] / 255 - b[i + k] * b[i + 3] / 255);
    if (delta > 4) count++;
  }
  return count / (a.length / 4);
}

function hasMultipleDrawings(node: XmlNode): boolean {
  let count = 0;
  function collect(current: XmlNode): void {
    if (SKIP_TAGS.has(current.name) || count > 1) return;
    if (DRAW_TAGS.has(current.name)) count++;
    current.children.forEach(collect);
  }
  collect(node);
  return count > 1;
}

export async function normalizePdfCairoSvg(svgText: string, options: PdfCairoSvgOptions): Promise<PdfCairoSvgResult> {
  const width = Math.round(options.width), height = Math.round(options.height);
  if (width <= 0 || height <= 0 || width * height > 16_000_000 || !Number.isFinite(width) || !Number.isFinite(height)) throw new Error('Invalid Cairo SVG target dimensions');
  if (!/^\/uploads\/[\w/.-]+$/.test(options.artifactUrlPrefix) || options.artifactUrlPrefix.includes('..')) throw new Error('Invalid Cairo SVG artifact URL prefix');
  const root = parseXml(svgText);
  const ids = assertSafeReferences(root);
  const viewBox = (root.attributes.viewBox || '').trim().split(/[\s,]+/).map(Number);
  if (viewBox.length !== 4 || viewBox.some(x => !Number.isFinite(x)) || viewBox[0] !== 0 || viewBox[1] !== 0 || viewBox[2] <= 0 || viewBox[3] <= 0) throw new Error('Unsupported Cairo SVG page bounds');
  if (options.sourceCrop) {
    const crop = options.sourceCrop;
    if (Object.values(crop).some(value => !Number.isFinite(value))
      || crop.left < 0 || crop.top < 0 || crop.width <= 0 || crop.height <= 0
      || crop.left + crop.width > crop.pageWidth || crop.top + crop.height > crop.pageHeight
      || Math.abs(viewBox[2] - crop.pageWidth) > 0.51 || Math.abs(viewBox[3] - crop.pageHeight) > 0.51) {
      throw new Error('Cairo source bounds do not match the Illustrator artboard');
    }
    // Preserve the ArtBox coordinate system; never stretch a full page into it.
    root.attributes.viewBox = `0 0 ${crop.width} ${crop.height}`;
    const clipId = `ai-artbox-${randomUUID()}`;
    const definitions = root.children.filter(child => SKIP_TAGS.has(child.name));
    const drawings = root.children.filter(child => !SKIP_TAGS.has(child.name));
    root.children = [...definitions,
      { name: 'defs', attributes: {}, children: [{ name: 'clipPath', attributes: { id: clipId, clipPathUnits: 'userSpaceOnUse' },
        children: [{ name: 'rect', attributes: { x: '0', y: '0', width: String(crop.width), height: String(crop.height) }, children: [] }] }] },
      { name: 'g', attributes: { 'clip-path': `url(#${clipId})` }, children: [
        { name: 'g', attributes: { transform: `translate(${-crop.left} ${-crop.top})` }, children: drawings }] }];
    viewBox[2] = crop.width; viewBox[3] = crop.height;
  }
  const scaleX = width / viewBox[2], scaleY = height / viewBox[3];
  root.attributes.width = String(width); root.attributes.height = String(height);
  // Poppler rounds the target pixel height independently. Stretch this subpixel
  // rounding difference instead of introducing an implicit letterbox/offset.
  root.attributes.preserveAspectRatio = 'none';
  const original = serialize(root);
  const originalPixels = await sharp(Buffer.from(original), { unlimited: true, limitInputPixels: 32_000_000 }).resize(width, height).ensureAlpha().raw().toBuffer();
  let normalizedCompositeCount = 0;
  async function reconstruct(node: XmlNode): Promise<void> {
    if (SKIP_TAGS.has(node.name)) return;
    if (await expandKnockout(node, ids, viewBox[2], viewBox[3], root)) normalizedCompositeCount++;
    for (const child of node.children) await reconstruct(child);
  }
  await reconstruct(root);
  root.children = root.children.map(child => SKIP_TAGS.has(child.name) ? child : expandUses(child, ids));
  const expanded = serialize(root);
  if (alphaPixelDifference(originalPixels, await sharp(Buffer.from(expanded), { unlimited: true, limitInputPixels: 32_000_000 }).resize(width, height).ensureAlpha().raw().toBuffer()) > SOURCE_RGBA_DIFF_LIMIT) throw new Error('Cairo SVG compositing reconstruction differs from the source');
  const sourceDrawings: XmlNode[] = [];
  function collectSourceDrawings(node: XmlNode): void {
    if (SKIP_TAGS.has(node.name)) return;
    if (DRAW_TAGS.has(node.name)) sourceDrawings.push(node);
    node.children.forEach(collectSourceDrawings);
  }
  collectSourceDrawings(root);
  const sourceImageOnly = options.allowSingleSourceImage === true
    && sourceDrawings.length === 1 && sourceDrawings[0].name === 'image';
  let effectRasterCount = 0, editableVectorCount = 0, editableRasterCount = 0;
  let clusterCount = 0;
  const prefix = `pdf_cairo_${options.pageNumber || 1}_${randomUUID().replace(/-/g, '')}`;
  const created: string[] = [];
  const defs = root.children.filter(child => child.name === 'defs');
  await fs.mkdir(options.outputDirectory, { recursive: true });
  async function normalize(node: XmlNode, ancestors: XmlNode[], parentMatrix: Matrix, cluster?: string): Promise<XmlNode | null> {
    if (SKIP_TAGS.has(node.name)) return node;
    if (node.name === 'g' && node.attributes.opacity !== undefined) {
      const opacity = Number(node.attributes.opacity);
      if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error('Unsupported Cairo SVG group opacity');
      // SVG applies group opacity after its children are composited. Fabric
      // distributes it to individual objects, changing overlap colors/alpha.
      // A real mask/filter is baked below; otherwise this group must fail closed.
      if (opacity !== 1 && !node.attributes.mask && !node.attributes.filter && hasMultipleDrawings(node)) throw new Error('Cairo SVG group opacity cannot become independent editable elements');
    }
    if (node.name === 'g' && node.children.length > 1 && node.children.every(child => child.name === 'g'
      && child.attributes['data-pdf-cairo-glyph'] === 'true')) cluster = `cairo-text-${options.pageNumber || 1}-${++clusterCount}`;
    if (node.attributes.mask || node.attributes.filter) {
      // Render the real effect subtree with its existing inherited coordinates.
      // The replacement is positioned in page coordinates and transformed back
      // into its parent, so it retains the original drawing order and clipping.
      let isolated = clone(node);
      for (let i = ancestors.length - 1; i >= 0; i--) {
        const wrapper = clone(ancestors[i]); wrapper.children = [isolated]; delete wrapper.attributes.opacity; delete wrapper.attributes['clip-path'];
        isolated = wrapper;
      }
      const surface: XmlNode = { name: 'svg', attributes: { ...root.attributes }, children: [...defs.map(clone), isolated] };
      const rendered = await sharp(Buffer.from(serialize(surface)), { unlimited: true, limitInputPixels: 32_000_000 }).resize(width, height).ensureAlpha().raw().toBuffer();
      let left = width, top = height, right = 0, bottom = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (rendered[(y * width + x) * 4 + 3] > 0) {
        left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
      }
      if (right <= left || bottom <= top) return null;
      if ((right - left) * (bottom - top) > width * height * 0.9) {
        // A real, independently imported page-sized image may have its own mask.
        // Rasterizing that image's effect never flattens the other page objects.
        const drawings: XmlNode[] = [];
        let hasDrawingFilter = false;
        function collectDrawings(current: XmlNode): void {
          if (SKIP_TAGS.has(current.name)) return;
          // A filter can paint referenced feImage drawings from defs in place of
          // its sole image child. Only that original image's own mask qualifies.
          if (current.attributes.filter) hasDrawingFilter = true;
          if (DRAW_TAGS.has(current.name)) drawings.push(current);
          current.children.forEach(collectDrawings);
        }
        collectDrawings(node);
        if (hasDrawingFilter || drawings.length !== 1 || drawings[0].name !== 'image') throw new Error('Cairo SVG effect covers the page and cannot become independent editable elements');
      }
      const filename = `${prefix}_effect_${++effectRasterCount}.png`;
      const filePath = path.join(options.outputDirectory, filename);
      created.push(filePath);
      await sharp(rendered, { raw: { width, height, channels: 4 } }).extract({ left, top, width: right - left, height: bottom - top }).png().toFile(filePath);
      editableRasterCount++;
      return { name: 'image', attributes: { x: String(left / scaleX), y: String(top / scaleY), width: String((right - left) / scaleX), height: String((bottom - top) / scaleY),
        transform: `matrix(${inverse(parentMatrix).join(' ')})`, href: `${options.artifactUrlPrefix.replace(/\/$/, '')}/${filename}`,
        'xlink:href': `${options.artifactUrlPrefix.replace(/\/$/, '')}/${filename}`,
        'data-object-role': 'editable-raster', 'data-pdf-cairo-effect': 'true', 'aria-label': 'PDF effect object', preserveAspectRatio: 'none' }, children: [] };
    }
    const matrix = multiply(parentMatrix, transform(node.attributes.transform));
    const nextAncestors = node === root ? ancestors : [...ancestors, node];
    const children: XmlNode[] = [];
    for (const child of node.children) {
      const normalized = await normalize(child, nextAncestors, matrix, cluster);
      if (normalized) children.push(normalized);
    }
    node.children = children;
    if (DRAW_TAGS.has(node.name)) {
      if (node.name === 'image') { node.attributes['data-object-role'] = 'editable-raster'; editableRasterCount++; }
      else {
        node.attributes['data-object-role'] = cluster ? 'decoration-vector' : 'editable-vector';
        if (cluster) node.attributes['data-pdf-cluster-id'] = cluster;
        editableVectorCount++;
      }
    }
    return node;
  }
  try {
    const normalizedChildren: XmlNode[] = [];
    for (const child of root.children) {
      const node = await normalize(child, [], IDENTITY);
      if (node) normalizedChildren.push(node);
    }
    root.children = normalizedChildren;
    const result = serialize(root);
    const materialized = result.replace(/(?:href|xlink:href)="(\/uploads\/[^\"]+)"/g, (all, url: string) => {
      const filename = url.slice(url.lastIndexOf('/') + 1);
      const artifact = created.find(file => path.basename(file) === filename);
      if (!artifact) throw new Error('Unexpected Cairo SVG artifact reference');
      return `${all.slice(0, all.indexOf('=') + 1)}"data:image/png;base64,${require('fs').readFileSync(artifact).toString('base64')}"`;
    });
    const visualDiffRatioToOriginal = alphaPixelDifference(originalPixels, await sharp(Buffer.from(materialized), { unlimited: true, limitInputPixels: 32_000_000 }).resize(width, height).ensureAlpha().raw().toBuffer());
    if (visualDiffRatioToOriginal > SOURCE_RGBA_DIFF_LIMIT || editableVectorCount + editableRasterCount < (sourceImageOnly ? 1 : 2)) throw new Error('Cairo SVG normalization does not preserve independent faithful objects');
    return { svgText: result, elementCount: editableVectorCount + editableRasterCount, rasterImageCount: editableRasterCount,
      editableVectorCount, editableRasterCount, visualDiffRatioToOriginal, normalizedCompositeCount, effectRasterCount, ...(sourceImageOnly ? { sourceImageOnly: true as const } : {}) };
  } catch (error) {
    await Promise.all(created.map(file => fs.rm(file, { force: true }).catch(() => undefined)));
    throw error;
  }
}
