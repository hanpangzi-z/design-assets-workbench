import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as fabric from 'fabric';
import LayerPanel from '../src/editor/LayerPanel';
import useEditorStore from '../src/store/editorStore';
import { installPsdScene } from '../src/editor/psdSceneRenderer';
import { serializeFabricCanvasToFabricJson } from '../src/editor/engine/fabricDocument';
import { restoreHistorySnapshot } from '../src/editor/history';
import { PSD_SOURCE_CUSTOM_PROPERTIES } from '../src/editor/psdImportState';
import type { ParsedLayer } from 'shared/types';

fabric.FabricObject.customProperties = [...fabric.FabricObject.customProperties, '_layerId', ...PSD_SOURCE_CUSTOM_PROPERTIES];
const node = (id: number, layerName: string, overrides = {}): ParsedLayer => ({ id, fileId: 1, parentLayerId: null,
  layerType: 'image', layerName, sortOrder: id, visible: true, opacity: 1, blendMode: 'normal', x: 0, y: 0,
  width: 120, height: 100, properties: { psdSourceKey: `id:${id}` }, ...overrides });
const initial = [node(1, '隔离组 50%', { layerType: 'group', opacity: 0.5, children: [node(2, '红色'), node(3, '蓝色')] }),
  node(4, '柔边基底'), node(5, '剪贴内容', { properties: { psdSourceKey: 'id:5', psdClipBaseKey: 'id:4' } }),
  node(6, '色相调整', { layerType: 'adjustment', properties: { psdSourceKey: 'id:6', psdAdjustment: { type: 'hue/saturation', master: { hue: 0, saturation: 0, lightness: 0 } } } }),
  node(7, '原始隐藏层', { visible: false })];
function bind(object: fabric.FabricObject, id: number) {
  Object.assign(object, { _layerId: id, _psdSourceKey: `id:${id}`, _psdOwnVisible: id !== 7, _psdSceneObject: true });
  return object;
}
function Regression() {
  const [layers, setLayers] = useState(initial), [ready, setReady] = useState(false), [report, setReport] = useState('准备中');
  const [saved, setSaved] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    const element = document.createElement('canvas'); document.getElementById('scene-holder')!.appendChild(element);
    const canvas = new fabric.Canvas(element, { width: 380, height: 180, enableRetinaScaling: false, renderOnAddRemove: false });
    const group = [bind(new fabric.Rect({ left: 10, top: 20, width: 100, height: 100, fill: 'red', strokeWidth: 0 }), 2),
      bind(new fabric.Rect({ left: 60, top: 20, width: 100, height: 100, fill: 'blue', strokeWidth: 0 }), 3)];
    const bitmap = document.createElement('canvas'); bitmap.width = 120; bitmap.height = 80;
    const context = bitmap.getContext('2d')!, data = context.createImageData(120, 80);
    for (let y = 0; y < 80; y++) for (let x = 0; x < 120; x++) data.data[(y * 120 + x) * 4 + 3] = [255, 128, 32, 0][Math.floor(x / 30)];
    context.putImageData(data, 0, 0);
    canvas.add(...group, bind(new fabric.FabricImage(bitmap, { left: 200, top: 20 }), 4),
      bind(new fabric.Rect({ left: 200, top: 20, width: 120, height: 80, fill: '#ff0000', strokeWidth: 0 }), 5),
      bind(new fabric.Rect({ left: 10, top: 130, width: 150, height: 30, fill: '#00ff00', visible: false, strokeWidth: 0 }), 7));
    useEditorStore.getState().setCanvas(canvas);
    const refresh = () => {
      const output = canvas.getContext();
      const alpha = [215, 245, 275, 305].map((x) => output.getImageData(x, 50, 1, 1).data[3]);
      const overlap = [...output.getImageData(80, 50, 1, 1).data];
      setReport(`组重叠 RGBA: [${overlap.join(',')}]；剪贴 alpha: [${alpha.join(',')}]`);
      setLayers([...(canvas as any).__psdScene?.layers || initial]);
    };
    const history = () => { useEditorStore.getState().pushHistory(serializeFabricCanvasToFabricJson(canvas)); refresh(); };
    void installPsdScene(canvas, initial, { width: 380, height: 180 }).then(() => {
      canvas.renderAll(); refresh(); useEditorStore.getState().resetHistory(serializeFabricCanvasToFabricJson(canvas)); setReady(true);
      canvas.on('object:modified', history); canvas.on('object:added', history); canvas.on('object:removed', history);
      canvas.on('after:render', refresh);
    });
    return () => { (canvas as any).__psdSceneSession?.dispose(); void canvas.dispose(); };
  }, []);
  const canvas = useEditorStore((state) => state.canvas);
  const restore = async (state: any) => { if (canvas && state) { await restoreHistorySnapshot(canvas, state); canvas.renderAll(); setLayers([...(canvas as any).__psdScene.layers]); } };
  return <div style={{ fontFamily: 'sans-serif', padding: 20, color: '#243b45' }}>
    <h1>PSD 解析交互回归</h1><p>此页面使用正式合成器、图层面板、保存与撤销模块，操作仅作用于测试画布。</p>
    <div style={{ display: 'flex', gap: 24 }}><div>
      <div id="scene-holder" style={{ background: 'repeating-conic-gradient(#ddd 0% 25%, white 0% 50%) 0/20px 20px', width: 380, height: 180 }} />
      <p role="status">{ready ? report : '准备中'}</p>
      <button disabled={!ready} onClick={() => { const base = canvas!.getObjects().find((o: any) => o._psdSourceKey === 'id:4')!; base.set('left', base.left + 16); canvas!.fire('object:modified', { target: base }); canvas!.renderAll(); }}>移动基底</button>
      <button disabled={!ready} onClick={() => { setSaved(serializeFabricCanvasToFabricJson(canvas!)); }}>保存快照</button>
      <button disabled={!saved} onClick={() => void restore(saved)}>重新打开快照</button>
      <button disabled={!ready} onClick={() => void restore(useEditorStore.getState().undo())}>撤销</button>
      <button disabled={!ready} onClick={() => void restore(useEditorStore.getState().redo())}>重做</button>
    </div><div style={{ width: 290, border: '1px solid #ccc', '--bg-hover': '#eef6f7', '--fg-2': '#243b45' } as React.CSSProperties}>
      <LayerPanel layers={layers} fileType="psd" />
    </div></div>
  </div>;
}
const mount = import.meta.hot?.data.mount || createRoot(document.getElementById('root')!);
if (import.meta.hot) import.meta.hot.data.mount = mount;
mount.render(<Regression />);
