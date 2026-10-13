import type { DesignFile } from 'shared/types';
import { getAssetPreviewPath } from '../../utils/assetPreview';

export const CARD_GAP = 20;
export const CARD_INFO_HEIGHT = 72;
export const CARD_PADDING = 8;
export interface Placement { id: number; index: number; column: number; left: number; top: number; width: number; previewHeight: number; height: number }
export interface WaterfallLayout { width: number; columnCount: number; positions: Placement[]; height: number; shortestHeight: number }

export function previewKey(file: DesignFile): string {
  return `${getAssetPreviewPath(file) || ''}|${file.updatedAt || file.id}`;
}

export function previewHeight(file: DesignFile, width: number, ratios: ReadonlyMap<string, number>): number {
  const cached = ratios.get(previewKey(file));
  const w = Number(file.width), h = Number(file.height);
  const fontWithoutPreview = /^(ttf|otf|ttc|woff2?)$/i.test(file.fileType || '') && !file.thumbnailPath;
  const ratio = cached && Number.isFinite(cached) && cached > 0 ? cached
    : !fontWithoutPreview && Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? h / w : 0.75;
  return Math.round(Math.min(960, Math.max(80, Math.max(1, width - CARD_PADDING * 2) * ratio + CARD_PADDING * 2)));
}

export function buildLayout(files: readonly DesignFile[], width: number, ratios: ReadonlyMap<string, number>, previous?: WaterfallLayout | null): WaterfallLayout {
  width = Number.isFinite(width) && width > 0 ? width : 240;
  const columnCount = Math.max(1, Math.floor((width + CARD_GAP) / (240 + CARD_GAP)));
  const columnWidth = (width - CARD_GAP * (columnCount - 1)) / columnCount;
  // Reuse column membership when refreshing dimensions or appending a page.
  const reuse = previous?.columnCount === columnCount && previous.positions.length <= files.length
    && previous.positions.every((p, index) => p.id === files[index]?.id);
  const bottoms = Array<number>(columnCount).fill(0);
  const positions = files.map((file, index) => {
    const column = reuse && previous.positions[index] ? previous.positions[index].column : bottoms.indexOf(Math.min(...bottoms));
    const imageHeight = previewHeight(file, columnWidth, ratios);
    const height = imageHeight + CARD_INFO_HEIGHT;
    const position = { id: file.id, index, column, left: column * (columnWidth + CARD_GAP), top: bottoms[column], width: columnWidth, previewHeight: imageHeight, height };
    bottoms[column] += height + CARD_GAP;
    return position;
  });
  return { width, columnCount, positions, height: Math.max(0, ...bottoms) - (files.length ? CARD_GAP : 0), shortestHeight: Math.max(0, Math.min(...bottoms) - CARD_GAP) };
}

export function visiblePlacements(layout: WaterfallLayout, top: number, viewportHeight: number, pinned: ReadonlySet<number> = new Set()): Placement[] {
  const start = Math.max(0, top - viewportHeight), end = top + viewportHeight * 2;
  return layout.positions.filter(p => pinned.has(p.id) || p.top + p.height >= start && p.top <= end);
}

export function findAnchor(layout: WaterfallLayout, top: number, height: number): { id: number; offset: number } | null {
  const visible = layout.positions.filter(p => p.top + p.height > top && p.top < top + height);
  const first = visible.sort((a, b) => Math.max(a.top, top) - Math.max(b.top, top) || a.left - b.left)[0];
  return first ? { id: first.id, offset: first.top - top } : null;
}
