/**
 * Diagnostic: parse a PSD with ag-psd and dump every layer's name/type/bbox/visibility/hasCanvas.
 * Usage: ts-node src/scripts/dumpPsdTree.ts <path-to-psd>
 */
import fs from 'fs';
import path from 'path';

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: ts-node dumpPsdTree.ts <psd>');
    process.exit(1);
  }
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) {
    console.error(`File not found: ${abs}`);
    process.exit(1);
  }

  try {
    const canvasMod = require('@napi-rs/canvas');
    require('ag-psd').initializeCanvas((w: number, h: number) => canvasMod.createCanvas(w, h));
  } catch {
    // ag-psd will still parse layer metadata without canvas init; we just won't have l.canvas
  }

  const { readPsd } = require('ag-psd');
  const buffer = fs.readFileSync(abs);
  const psd = readPsd(buffer);

  console.log(`PSD: ${path.basename(abs)}`);
  console.log(`  size: ${psd.width} × ${psd.height}`);
  console.log(`  colorMode: ${psd.colorMode}, bits: ${psd.bitsPerChannel}`);
  console.log('---');

  let counter = 0;
  let imageWithCanvas = 0;
  let textCount = 0;
  let groupCount = 0;
  let zeroSize = 0;
  let hidden = 0;

  function walk(layers: any[], depth: number, parentVisible: boolean) {
    if (!layers) return;
    for (const l of layers) {
      counter++;
      const indent = '  '.repeat(depth);
      const hasChildren = Array.isArray(l.children) && l.children.length > 0;
      const hasText = !!l.text;
      const type = hasChildren ? 'group' : hasText ? 'text' : 'image';
      const left = l.left || 0;
      const top = l.top || 0;
      const right = l.right || 0;
      const bottom = l.bottom || 0;
      const w = right - left;
      const h = bottom - top;
      const isVisible = l.hidden !== true;
      const effectiveVisible = parentVisible && isVisible;
      const hasCanvas = !!l.canvas;
      if (type === 'image') imageWithCanvas += hasCanvas ? 1 : 0;
      if (type === 'text') textCount++;
      if (type === 'group') groupCount++;
      if (w <= 0 || h <= 0) zeroSize++;
      if (!isVisible) hidden++;

      const flags: string[] = [];
      if (!isVisible) flags.push('HIDDEN');
      if (!effectiveVisible) flags.push('PARENT_HIDDEN');
      if (w <= 0 || h <= 0) flags.push('ZERO_SIZE');
      if (type === 'image' && !hasCanvas) flags.push('NO_CANVAS');
      if (l.clipping === true) flags.push('CLIP');
      const flagStr = flags.length ? ` [${flags.join(',')}]` : '';

      console.log(`${indent}${counter.toString().padStart(3)} ${type.padEnd(5)} "${l.name || '(unnamed)'}" ${w}×${h} @ (${left},${top}) opacity=${l.opacity ?? 1}${flagStr}`);

      if (hasChildren) walk(l.children, depth + 1, effectiveVisible);
    }
  }

  walk(psd.children || [], 0, true);

  console.log('---');
  console.log(`Total: ${counter}`);
  console.log(`  groups: ${groupCount}`);
  console.log(`  text: ${textCount}`);
  console.log(`  image-like with canvas: ${imageWithCanvas}`);
  console.log(`  zero-size: ${zeroSize}`);
  console.log(`  hidden (own flag): ${hidden}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
