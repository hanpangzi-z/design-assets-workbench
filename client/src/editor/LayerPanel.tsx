import React, { useEffect, useState } from 'react';
import * as fabric from 'fabric';
import { Folder, Type, Image, Square, Eye, EyeOff, ChevronDown, ChevronRight } from 'lucide-react';
import useEditorStore from '@/store/editorStore';
import { HISTORY_RESTORED_EVENT } from './history';
import { applyPsdVisibilityState, findPsdSceneLayer, movePsdSceneLayer, removePsdSceneLayer, psdEffectiveVisibility, psdLayerSourceKey, type PsdImportCanvas } from './psdImportState';

type LayerId = number | string;

interface LayerInfo {
  id: LayerId;
  layerName: string;
  layerType: string;
  visible: boolean;
  locked?: boolean;
  opacity: number;
  blendMode?: string;
  sortOrder?: number;
  properties?: Record<string, unknown>;
  children?: LayerInfo[];
}

type CanvasLayerObject = {
  _layerId?: LayerId;
  _pdfSourceTextActivation?: boolean;
  _pdfSourceTextActivated?: boolean;
  _pdfSourceTextBackgroundPatch?: boolean;
  _pdfMaskArtifact?: boolean;
  _pdfPreviewFallback?: boolean;
  _pdfVisualBacking?: boolean;
  _pdfImportPlaceholder?: boolean;
  set: (options: Record<string, unknown>) => void;
  setCoords: () => void;
  visible?: boolean;
  selectable?: boolean;
  evented?: boolean;
  _psdLocked?: boolean;
};

const TYPE_ICONS: Record<string, React.ElementType> = {
  group: Folder,
  text: Type,
  image: Image,
  shape: Square,
  adjustment: Square,
};

function LayerItem({
  layer,
  depth = 0,
  selectedLayerId,
  onSelect,
  onToggleVisible,
  onHover,
  onHoverEnd,
  getLayerVisible,
}: {
  layer: LayerInfo;
  depth?: number;
  selectedLayerId: string | null;
  onSelect: (layer: LayerInfo) => void;
  onToggleVisible: (layer: LayerInfo) => void;
  onHover: (layerId: LayerId) => void;
  onHoverEnd: (layerId: LayerId) => void;
  getLayerVisible: (layer: LayerInfo) => boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const [hovered, setHovered] = useState(false);
  const IconComp = TYPE_ICONS[layer.layerType] || Square;
  const hasChildren = layer.children && layer.children.length > 0;
  const isSelected = selectedLayerId === String(layer.id);
  const isVisible = getLayerVisible(layer);
  const panelOnly = isPanelOnlyLayer(layer);

  return (
    <div>
      <div
        onMouseEnter={() => {
          setHovered(true);
          if (isVisible && !panelOnly) onHover(layer.id);
        }}
        onMouseLeave={() => {
          setHovered(false);
          if (!panelOnly) onHoverEnd(layer.id);
        }}
        onClick={() => {
          if (!panelOnly) onSelect(layer);
        }}
        onDoubleClick={() => {
          if (!panelOnly) onSelect(layer);
        }}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '5px 8px',
          paddingLeft: 8 + depth * 16,
          cursor: panelOnly ? 'default' : 'pointer',
          background: isSelected ? 'var(--brand-teal-50)' : hovered ? 'var(--bg-hover)' : 'transparent',
          font: 'var(--type-caption)',
          color: isSelected ? 'var(--brand-teal-600)' : 'var(--fg-2)',
          fontWeight: isSelected ? 500 : 400,
          borderRight: isSelected ? '2px solid var(--brand-teal-500)' : '2px solid transparent',
          transition: 'background .08s',
        }}
      >
        {hasChildren ? (
          <span
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
            style={{ width: 14, flexShrink: 0, display: 'grid', placeItems: 'center' }}
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        ) : (
          <span style={{ width: 14, flexShrink: 0 }} />
        )}

        <IconComp size={13} style={{ color: isSelected ? 'var(--brand-teal-500)' : 'var(--fg-4)', flexShrink: 0 }} />

        <span
          style={{
            flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            opacity: isVisible ? 1 : 0.4,
          }}
        >
          {layer.layerName}
        </span>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (panelOnly) return;
            onToggleVisible(layer);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          title={panelOnly ? '面板汇总层' : isVisible ? '隐藏图层' : '显示图层'}
          style={{
            width: 18,
            height: 18,
            border: 0,
            padding: 0,
            display: 'grid',
            placeItems: 'center',
            color: isVisible ? 'var(--fg-4)' : 'var(--fg-5)',
            background: 'transparent',
            cursor: panelOnly ? 'default' : 'pointer',
            opacity: panelOnly ? 0.28 : hovered || !isVisible ? 1 : 0.72,
          }}
        >
          {isVisible ? <Eye size={12} /> : <EyeOff size={12} />}
        </button>
      </div>

      {expanded && hasChildren && layer.children!.map((child) => (
        <LayerItem
          key={child.id}
          layer={child}
          depth={depth + 1}
          selectedLayerId={selectedLayerId}
          onSelect={onSelect}
          onToggleVisible={onToggleVisible}
          onHover={onHover}
          onHoverEnd={onHoverEnd}
          getLayerVisible={getLayerVisible}
        />
      ))}
    </div>
  );
}

interface Props {
  layers: LayerInfo[];
  fileType?: string;
}

export default function LayerPanel({ layers, fileType }: Props) {
  const [search, setSearch] = useState('');
  const [visibilityOverrides, setVisibilityOverrides] = useState<Record<string, boolean>>({});
  const [selectedSceneKey, setSelectedSceneKey] = useState<string | null>(null);
  const [, setSceneRevision] = useState(0);
  const { canvas, selectedObjectIds, hoveredObjectId, setHoveredObjectId } = useEditorStore();
  const selectedLayerId = selectedObjectIds.length > 0 ? selectedObjectIds[0] : null;
  const layerSignature = getLayerSignature(layers);
  const isPsd = fileType === 'psd' || fileType === 'psb';
  const sceneLayers = isPsd ? getPsdSceneLayers(canvas) : null;
  const displayLayers = sceneLayers || layers;
  const selectedSceneLayer = selectedSceneKey && sceneLayers ? findPsdSceneLayer(sceneLayers, selectedSceneKey) : undefined;

  useEffect(() => {
    setVisibilityOverrides(isPsd ? { ...((canvas as PsdImportCanvas | null)?.__psdVisibilityOverrides || {}) } : {});
    setHoveredObjectId(null);
  }, [layerSignature, setHoveredObjectId, canvas, isPsd]);

  useEffect(() => {
    if (!canvas || !isPsd) return;
    const refresh = () => setVisibilityOverrides({ ...((canvas as PsdImportCanvas).__psdVisibilityOverrides || {}) });
    const refreshScene = () => { refresh(); setSceneRevision((revision) => revision + 1); };
    (canvas as any).on(HISTORY_RESTORED_EVENT, refreshScene);
    canvas.on('object:modified', refreshScene);
    return () => { (canvas as any).off(HISTORY_RESTORED_EVENT, refreshScene); canvas.off('object:modified', refreshScene); };
  }, [canvas, isPsd]);

  const effectivePsdVisibility = isPsd ? psdEffectiveVisibility(displayLayers, visibilityOverrides) : null;
  const getLayerVisible = (layer: LayerInfo) => effectivePsdVisibility?.get(String(layer.id)) ?? visibilityOverrides[String(layer.id)] ?? layer.visible;

  const handleSelectLayer = (layer: LayerInfo) => {
    if (isPanelOnlyLayer(layer)) return;
    if (!canvas) return;
    setSelectedSceneKey(isPsd && sceneLayers && ['group', 'adjustment'].includes(layer.layerType) ? psdLayerSourceKey(layer) : null);
    if (isPsd && layer.layerType === 'adjustment') { canvas.discardActiveObject(); canvas.requestRenderAll(); return; }
    const target = findCanvasLayerObject(canvas, layer.id, isPsd ? psdLayerSourceKey(layer) : undefined);
    if (target && target.visible !== false) {
      activateCanvasSelection(canvas, [target]);
      return;
    }

    const targets = findCanvasLayerObjects(canvas, collectLayerIds(layer), isPsd ? collectLayerKeys(layer) : [])
      .filter((object) => object.visible !== false && object.selectable !== false && object.evented !== false);
    if (targets.length === 1) {
      activateCanvasSelection(canvas, targets);
      return;
    }
    if (targets.length > 1) {
      activateCanvasSelection(canvas, targets);
    }
  };

  const handleHoverLayer = (layerId: LayerId) => {
    if (!canvas) return;
    const target = findCanvasLayerObject(canvas, layerId);
    if (target && target.visible !== false && target.selectable !== false && target.evented !== false) {
      setHoveredObjectId(String(layerId));
    }
  };

  const handleHoverLayerEnd = (layerId: LayerId) => {
    if (hoveredObjectId !== String(layerId)) return;
    setHoveredObjectId(null);
  };

  const handleToggleVisible = (layer: LayerInfo) => {
    if (isPanelOnlyLayer(layer)) return;
    if (isPsd && canvas) {
      const source = canvas as PsdImportCanvas;
      const key = psdLayerSourceKey(layer);
      const nextVisible = !(source.__psdVisibilityOverrides?.[key] ?? layer.visible !== false);
      source.__psdVisibilityOverrides = { ...(source.__psdVisibilityOverrides || {}), [key]: nextVisible };
      setVisibilityOverrides({ ...source.__psdVisibilityOverrides });
      applyPsdVisibilityState(source, displayLayers);
      const active = canvas.getActiveObject();
      if (active?.visible === false) canvas.discardActiveObject();
      canvas.requestRenderAll();
      const target = canvas.getObjects().find((object) => collectLayerIds(layer).map(String).includes(String((object as CanvasLayerObject)._layerId)));
      (canvas as any).fire('object:modified', { target });
      return;
    }
    const nextVisible = !getLayerVisible(layer);
    const layerIds = collectLayerIds(layer);

    setVisibilityOverrides((prev) => {
      const next = { ...prev };
      layerIds.forEach((id) => {
        next[String(id)] = nextVisible;
      });
      return next;
    });

    if (!canvas) return;

    const idSet = new Set(layerIds.map(String));
    let changed = false;
    canvas.getObjects().forEach((object) => {
      const layerObject = object as unknown as CanvasLayerObject;
      if (!idSet.has(String(layerObject._layerId))) return;
      const locked = layerObject._psdLocked === true || layer.locked === true;
      object.set({
        visible: nextVisible,
        selectable: nextVisible && !locked,
        evented: nextVisible && !locked,
      });
      object.setCoords();
      changed = true;
    });

    const active = canvas.getActiveObject() as unknown as CanvasLayerObject | undefined;
    if (active && idSet.has(String(active._layerId)) && !nextVisible) {
      canvas.discardActiveObject();
      useEditorStore.getState().setSelectedObjects([]);
    }
    if (hoveredObjectId && idSet.has(String(hoveredObjectId)) && !nextVisible) {
      setHoveredObjectId(null);
    }

    if (changed) {
      canvas.requestRenderAll();
      const modifiedTarget = canvas.getActiveObject()
        || canvas.getObjects().find((object) => idSet.has(String((object as unknown as CanvasLayerObject)._layerId)));
      if (modifiedTarget) {
        canvas.fire('object:modified', { target: modifiedTarget });
      }
    }
  };

  const filteredLayers = search
    ? displayLayers.filter((layer) => layer.layerName?.toLowerCase().includes(search.toLowerCase()))
    : displayLayers;

  const commitSceneChange = () => {
    if (!canvas) return;
    (canvas as PsdImportCanvas).__psdSceneSession?.refresh();
    (canvas as any).fire('object:modified', {});
    setSceneRevision((revision) => revision + 1);
  };
  const updateSceneLayer = (changes: { opacity?: number; blendMode?: string }) => {
    if (!canvas || !selectedSceneLayer) return;
    Object.assign(selectedSceneLayer, changes);
    commitSceneChange();
  };
  const adjustment = selectedSceneLayer?.properties?.psdAdjustment || selectedSceneLayer?.properties?.adjustment;
  const parameterFields = getPsdAdjustmentFields(adjustment);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '8px 8px 4px' }}>
        <input
          placeholder="搜索图层..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            width: '100%', height: 28, padding: '0 8px',
            border: '1px solid var(--border-1)', borderRadius: 4,
            font: 'var(--type-caption)', color: 'var(--fg-1)', outline: 'none',
            background: 'var(--n-50)',
          }}
        />
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {filteredLayers.length === 0 ? (
          <div style={{ padding: 16, textAlign: 'center', font: 'var(--type-caption)', color: 'var(--fg-4)' }}>
            暂无图层
          </div>
        ) : (
          toDisplayLayerOrder(filteredLayers).map((layer) => (
            <LayerItem
              key={layer.id}
              layer={layer}
              selectedLayerId={selectedSceneLayer ? String(selectedSceneLayer.id) : selectedLayerId}
              onSelect={handleSelectLayer}
              onToggleVisible={handleToggleVisible}
              onHover={handleHoverLayer}
              onHoverEnd={handleHoverLayerEnd}
              getLayerVisible={getLayerVisible}
            />
          ))
        )}
      </div>
      {selectedSceneLayer && canvas && sceneLayers && (
        <div style={{ padding: 10, borderTop: '1px solid var(--border-1)', display: 'grid', gap: 8, font: 'var(--type-caption)' }}>
          <strong>{selectedSceneLayer.layerName}</strong>
          <label>不透明度 <input aria-label="PSD 组或调整层不透明度" type="range" min={0} max={100}
            value={Math.round((selectedSceneLayer.opacity ?? 1) * 100)}
            onChange={(event) => updateSceneLayer({ opacity: Number(event.target.value) / 100 })} /></label>
          <label>混合模式 <select aria-label="PSD 组或调整层混合模式" value={selectedSceneLayer.blendMode || 'normal'}
            onChange={(event) => updateSceneLayer({ blendMode: event.target.value })}>
            {['normal', 'pass through', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color dodge', 'color burn', 'difference', 'hue', 'saturation', 'color', 'luminosity'].map((mode) => <option key={mode} value={mode}>{mode}</option>)}
          </select></label>
          {parameterFields.map((field) => <label key={field.key}>{field.label} <input type="number" aria-label={`PSD 调整 ${field.label}`}
            min={field.min} max={field.max} step={field.step || 1} value={field.value}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (!Number.isFinite(value)) return;
              field.set(Math.max(field.min, Math.min(field.max, value)));
              commitSceneChange();
            }} /></label>)}
          {selectedSceneLayer.layerType === 'adjustment' && parameterFields.length === 0 && <span>此调整层可修改显隐、顺序、混合模式和不透明度。</span>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={() => { if (movePsdSceneLayer(sceneLayers, psdLayerSourceKey(selectedSceneLayer), 1)) { reorderPsdCanvasSources(canvas, sceneLayers); commitSceneChange(); } }}>上移</button>
            <button type="button" onClick={() => { if (movePsdSceneLayer(sceneLayers, psdLayerSourceKey(selectedSceneLayer), -1)) { reorderPsdCanvasSources(canvas, sceneLayers); commitSceneChange(); } }}>下移</button>
            <button type="button" onClick={() => {
              const removed = removePsdSceneLayer(sceneLayers, psdLayerSourceKey(selectedSceneLayer));
              if (!removed) return;
              const keys = new Set(collectLayerKeys(removed));
              canvas.getObjects().filter((object) => keys.has(String((object as any)._psdSourceKey))).forEach((object) => canvas.remove(object));
              setSelectedSceneKey(null); canvas.discardActiveObject(); commitSceneChange();
            }}>删除</button>
          </div>
        </div>
      )}
    </div>
  );
}

function isPanelOnlyLayer(layer: LayerInfo): boolean {
  return layer.properties?.panelOnly === true || layer.properties?.role === 'svg-vector-summary';
}

function getPsdSceneLayers(canvas: fabric.Canvas | null): LayerInfo[] | null {
  const scene = (canvas as PsdImportCanvas | null)?.__psdScene as { layers?: LayerInfo[] } | undefined;
  return Array.isArray(scene?.layers) ? scene.layers : null;
}

function collectLayerKeys(layer: LayerInfo): string[] {
  return [psdLayerSourceKey(layer), ...(layer.children || []).flatMap(collectLayerKeys)];
}

function reorderPsdCanvasSources(canvas: fabric.Canvas, layers: LayerInfo[]) {
  const original = canvas.getObjects();
  const byKey = new Map(original.map((object) => [String((object as any)._psdSourceKey), object]));
  const ordered = layers.flatMap(collectLayerKeys).map((key) => byKey.get(key)).filter((object): object is fabric.FabricObject => Boolean(object));
  let index = 0;
  const reordered = original.map((object) => (object as any)._psdSceneObject === true ? ordered[index++] || object : object);
  reordered.forEach((object, position) => canvas.moveObjectTo(object, position));
}

function getPsdAdjustmentFields(value: unknown): Array<{ key: string; label: string; min: number; max: number; step?: number; value: number; set(value: number): void }> {
  if (!value || typeof value !== 'object') return [];
  const setting = value as Record<string, any>;
  let target = setting;
  let fields: Array<[string, string, number, number, number?]> = [];
  switch (setting.type) {
    case 'brightness/contrast': fields = [['brightness', '亮度', -150, 150], ['contrast', '对比度', -100, 100]]; break;
    case 'exposure': fields = [['exposure', '曝光', -20, 20, 0.1], ['offset', '偏移', -0.5, 0.5, 0.01], ['gamma', '伽马', 0.01, 10, 0.01]]; break;
    case 'threshold': fields = [['level', '阈值', 0, 255]]; break;
    case 'posterize': fields = [['levels', '色阶数', 2, 255]]; break;
    case 'hue/saturation':
      target = setting.master && typeof setting.master === 'object' ? setting.master : {};
      fields = [['hue', '色相', -180, 180], ['saturation', '饱和度', -100, 100], ['lightness', '明度', -100, 100]];
      break;
  }
  return fields.map(([key, label, min, max, step]) => ({ key, label, min, max, step,
    value: Number(target[key] ?? (key === 'gamma' ? 1 : key === 'levels' ? 4 : 0)),
    set: (next: number) => { if (setting.type === 'hue/saturation' && setting.master !== target) setting.master = target; target[key] = next; },
  }));
}

function collectLayerIds(layer: LayerInfo): LayerId[] {
  return [
    layer.id,
    ...(layer.children || []).flatMap((child) => collectLayerIds(child)),
  ];
}

function findCanvasLayerObject(canvas: NonNullable<ReturnType<typeof useEditorStore.getState>['canvas']>, layerId: LayerId, sourceKey?: string) {
  return canvas.getObjects()
    .filter((object) => sourceKey ? (object as any)._psdSourceKey === sourceKey : String((object as CanvasLayerObject)._layerId) === String(layerId))
    .filter(isLayerPanelSelectionCandidate)
    .sort((left, right) => getLayerPanelSelectionPriority(right) - getLayerPanelSelectionPriority(left))[0];
}

function findCanvasLayerObjects(
  canvas: NonNullable<ReturnType<typeof useEditorStore.getState>['canvas']>,
  layerIds: LayerId[],
  sourceKeys: string[] = [],
) {
  const idSet = new Set(layerIds.map(String));
  return canvas.getObjects()
    .filter((object) => sourceKeys.length ? sourceKeys.includes(String((object as any)._psdSourceKey)) : idSet.has(String((object as CanvasLayerObject)._layerId)))
    .filter(isLayerPanelSelectionCandidate);
}

function isLayerPanelSelectionCandidate(object: fabric.FabricObject): boolean {
  const target = object as unknown as CanvasLayerObject;
  return target._pdfSourceTextBackgroundPatch !== true
    && target._pdfMaskArtifact !== true
    && target._pdfPreviewFallback !== true
    && target._pdfVisualBacking !== true
    && target._pdfImportPlaceholder !== true;
}

function getLayerPanelSelectionPriority(object: fabric.FabricObject): number {
  const target = object as unknown as CanvasLayerObject;
  if (target._pdfSourceTextActivated === true) return 4;
  if (target._pdfSourceTextActivation === true) return 3;
  if (target.visible !== false && target.selectable !== false && target.evented !== false) return 2;
  return 1;
}

function activateCanvasSelection(
  canvas: NonNullable<ReturnType<typeof useEditorStore.getState>['canvas']>,
  targets: fabric.FabricObject[],
) {
  if (targets.length === 0) return;
  canvas.discardActiveObject();
  if (targets.length === 1) {
    canvas.setActiveObject(targets[0]);
  } else {
    canvas.setActiveObject(new fabric.ActiveSelection(targets, { canvas }));
  }
  targets.forEach((object) => object.setCoords());
  canvas.requestRenderAll();
  useEditorStore.getState().setSelectedObjects(
    targets.map((object) => String((object as CanvasLayerObject)._layerId || '')).filter(Boolean),
  );
}

function getLayerSignature(layers: LayerInfo[]): string {
  return layers
    .map((layer) => `${String(layer.id)}:${layer.layerName}:${getLayerSignature(layer.children || [])}`)
    .join('|');
}

function toDisplayLayerOrder(layers: LayerInfo[]): LayerInfo[] {
  return [...layers].reverse().map((layer) => ({
    ...layer,
    children: layer.children ? toDisplayLayerOrder(layer.children) : undefined,
  }));
}
