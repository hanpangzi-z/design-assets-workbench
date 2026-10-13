import type * as fabric from 'fabric';

export type PsdLayerNode = {
  id: number | string;
  layerName?: string;
  layerType: string;
  visible: boolean;
  properties?: Record<string, unknown> | null;
  children?: PsdLayerNode[];
};

export type PsdImportDiagnostic = {
  code: string;
  severity: 'warning' | 'error';
  message: string;
  layerKey?: string;
  layerName?: string;
};

export type PsdImportCanvas = fabric.Canvas & {
  __psdScene?: unknown;
  __psdSceneVersion?: number;
  __psdVisibilityOverrides?: Record<string, boolean>;
  __psdSceneSession?: { updateLayer(key: string, patch: { visible: boolean }): void; refresh(): void; dispose(): void; setSourcePreview(enabled: boolean): void; getSourcePreview?(): boolean; getDiagnostics?(): PsdImportDiagnostic[] };
};

export const PSD_SOURCE_CUSTOM_PROPERTIES = [
  '_psdSourceKey', '_psdClipBaseKey', '_psdOwnVisible', '_psdSceneObject', '_psdMask', '_psdOriginalTransform', '_psdOriginalDimensions', '_psdEffectOverrides', '_psdSimpleShape', '_psdImagePath',
];

export function resetPsdCanvasScene(canvas: PsdImportCanvas) {
  canvas.__psdSceneSession?.dispose();
  delete canvas.__psdSceneSession;
  delete canvas.__psdScene;
  delete canvas.__psdSceneVersion;
  delete canvas.__psdVisibilityOverrides;
}

export function psdLayerSourceKey(layer: PsdLayerNode): string {
  return String(layer.properties?.psdSourceKey ?? layer.id);
}

export function collectPsdLeafLayers<T extends PsdLayerNode>(layers: T[]): T[] {
  return layers.flatMap((layer) => layer.children?.length
    ? collectPsdLeafLayers(layer.children as T[])
    : layer.layerType === 'group' ? [] : [layer]);
}

export function psdEffectiveVisibility(
  layers: PsdLayerNode[],
  overrides: Record<string, boolean> = {},
  parentVisible = true,
  result = new Map<string, boolean>(),
): Map<string, boolean> {
  for (const layer of layers) {
    const visible = parentVisible && (overrides[psdLayerSourceKey(layer)] ?? layer.visible !== false);
    result.set(String(layer.id), visible);
    if (layer.children?.length) psdEffectiveVisibility(layer.children, overrides, visible, result);
  }
  return result;
}

export function applyPsdVisibilityState(canvas: PsdImportCanvas, layers: PsdLayerNode[]) {
  const overrides = canvas.__psdVisibilityOverrides || {};
  const visibility = psdEffectiveVisibility(layers, overrides);
  const ownById = new Map<string, { id: number | string; key: string; visible: boolean }>();
  const ownByKey = new Map<string, { id: number | string; key: string; visible: boolean }>();
  const visit = (nodes: PsdLayerNode[]) => nodes.forEach((layer) => {
    const key = psdLayerSourceKey(layer);
    const visible = overrides[key] ?? layer.visible !== false;
    const own = { id: layer.id, key, visible };
    ownById.set(String(layer.id), own);
    ownByKey.set(key, own);
    if (layer.children?.length) visit(layer.children);
  });
  visit(layers);
  canvas.getObjects().forEach((object) => {
    const target = object as fabric.FabricObject & { _layerId?: unknown; _psdSourceKey?: string; _psdOwnVisible?: boolean; _psdLocked?: boolean };
    const own = (target._psdSourceKey ? ownByKey.get(target._psdSourceKey) : undefined) || ownById.get(String(target._layerId));
    if (!own) return;
    target._layerId = own.id;
    target._psdOwnVisible = own.visible;
    const visible = visibility.get(String(own.id)) !== false;
    target.set({ visible, selectable: visible && target._psdLocked !== true, evented: visible && target._psdLocked !== true });
    target.setCoords();
  });
  canvas.__psdSceneSession?.refresh();
}

export function findPsdSceneLayer<T extends PsdLayerNode>(layers: T[], sourceKey: string): T | undefined {
  for (const layer of layers) {
    if (psdLayerSourceKey(layer) === sourceKey) return layer;
    const found = layer.children?.length ? findPsdSceneLayer(layer.children as T[], sourceKey) : undefined;
    if (found) return found;
  }
  return undefined;
}

export function movePsdSceneLayer<T extends PsdLayerNode & { sortOrder?: number }>(layers: T[], sourceKey: string, delta: -1 | 1): boolean {
  const index = layers.findIndex((layer) => psdLayerSourceKey(layer) === sourceKey);
  if (index >= 0) {
    const target = index + delta;
    if (target < 0 || target >= layers.length) return false;
    const [layer] = layers.splice(index, 1);
    layers.splice(target, 0, layer);
    layers.forEach((item, order) => { item.sortOrder = order; });
    return true;
  }
  return layers.some((layer) => layer.children?.length && movePsdSceneLayer(layer.children as T[], sourceKey, delta));
}

export function removePsdSceneLayer<T extends PsdLayerNode>(layers: T[], sourceKey: string): T | undefined {
  const index = layers.findIndex((layer) => psdLayerSourceKey(layer) === sourceKey);
  if (index >= 0) return layers.splice(index, 1)[0];
  for (const layer of layers) {
    const removed = layer.children?.length ? removePsdSceneLayer(layer.children as T[], sourceKey) : undefined;
    if (removed) return removed;
  }
  return undefined;
}

export function copyPsdSourceMetadata(source: object, target: object) {
  const from = source as Record<string, unknown>;
  const to = target as Record<string, unknown>;
  PSD_SOURCE_CUSTOM_PROPERTIES.forEach((key) => {
    if (from[key] !== undefined) to[key] = from[key];
  });
}

export function markPsdNativeEffectOverride(object: object, effect: 'stroke' | 'dropShadow') {
  const target = object as Record<string, unknown>;
  if (target._psdSceneObject !== true) return;
  target._psdEffectOverrides = { ...((target._psdEffectOverrides || {}) as Record<string, unknown>), [effect]: false };
}

export function getPsdEditableSourceTextOptions(source: object, options: Record<string, unknown>): Record<string, unknown> {
  const target = source as Record<string, unknown>;
  if (target._psdSceneObject !== true) return options;
  const { shadow: _shadow, stroke: _stroke, strokeWidth: _strokeWidth, paintFirst: _paintFirst, effects: _effects, ...contentOptions } = options;
  const overrides = (target._psdEffectOverrides || {}) as Record<string, unknown>;
  const nativeStroke = options.psdNativeTextStroke && typeof options.psdNativeTextStroke === 'object'
    ? options.psdNativeTextStroke as Record<string, unknown> : {};
  return {
    ...contentOptions, ...nativeStroke,
    ...(overrides.stroke === false ? { stroke: target.stroke, strokeWidth: target.strokeWidth, paintFirst: target.paintFirst } : {}),
    ...(overrides.dropShadow === false ? { shadow: target.shadow } : {}),
  };
}

export function normalizePsdDiagnostics(value: unknown): PsdImportDiagnostic[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is PsdImportDiagnostic => Boolean(item)
    && typeof item === 'object' && typeof item.message === 'string'
    && typeof item.code === 'string' && ['warning', 'error'].includes(item.severity));
}

export function mergePsdDiagnostics(...groups: PsdImportDiagnostic[][]): PsdImportDiagnostic[] {
  const unique = new Map<string, PsdImportDiagnostic>();
  groups.flat().forEach((item) => unique.set(`${item.code}:${item.layerKey || (item as { sourceKey?: string }).sourceKey || ''}:${item.message}`, item));
  return [...unique.values()];
}
