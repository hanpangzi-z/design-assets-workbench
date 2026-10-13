import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import * as fabric from 'fabric';
import useEditorStore, { type ActiveTool } from '@/store/editorStore';
import { createEditorEngine, getFabricCanvasFromEngine } from '@/editor/engine/createEditorEngine';
import { serializeFabricCanvasToFabricJson } from '@/editor/engine/fabricDocument';
import useFabricGuidelines from '@/editor/hooks/useFabricGuidelines';
import { installCanvasDragBoundsGuard } from '@/editor/canvasBounds';

type EditorCanvasWithFlags = fabric.Canvas & {
  __suspendHistory?: boolean;
  __bulkLoading?: boolean;
};

declare global {
  interface Window {
    __benlaiEditorCanvas?: fabric.Canvas;
  }
}

const selectionBlue = '#2557f6';
const selectionStyle = {
  borderColor: selectionBlue,
  cornerColor: '#ffffff',
  cornerStrokeColor: selectionBlue,
  cornerSize: 12,
  touchCornerSize: 20,
  cornerStyle: 'circle',
  borderScaleFactor: 2,
  padding: 0,
  editingBorderColor: selectionBlue,
  selectionColor: 'rgba(37, 87, 246, 0.18)',
};

installSelectionDefaults();
installDisposedCanvasGuards();

export default function EditorCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const historyTimerRef = useRef<number | null>(null);
  const handPanCleanupRef = useRef<(() => void) | null>(null);
  const panOffsetRef = useRef({ x: 0, y: 0 });
  const panFrameRef = useRef<number | null>(null);
  const autoFitRef = useRef<{ key: string; zoom: number } | null>(null);
  const [isHandDragging, setIsHandDragging] = useState(false);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [workspaceSize, setWorkspaceSize] = useState({ width: 0, height: 0 });
  const fileId = useEditorStore((state) => state.fileId);
  const storeCanvas = useEditorStore((state) => state.canvas);
  const canvasWidth = useEditorStore((state) => state.canvasWidth);
  const canvasHeight = useEditorStore((state) => state.canvasHeight);
  const zoom = useEditorStore((state) => state.zoom);
  const activeTool = useEditorStore((state) => state.activeTool);
  const hoveredObjectId = useEditorStore((state) => state.hoveredObjectId);
  const setHoveredObjectId = useEditorStore((state) => state.setHoveredObjectId);
  const canvasScale = zoom / 100;
  const displayWidth = Math.max(1, Math.round(canvasWidth * canvasScale));
  const displayHeight = Math.max(1, Math.round(canvasHeight * canvasScale));

  useFabricGuidelines(storeCanvas);

  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;

    const engine = createEditorEngine({
      width: canvasWidth,
      height: canvasHeight,
      backgroundColor: '#ffffff',
      preserveObjectStacking: true,
      selection: true,
      selectionColor: 'rgba(95, 168, 255, 0.08)',
      selectionBorderColor: selectionBlue,
      selectionLineWidth: 1,
    });
    engine.mount(element);
    const canvas = getFabricCanvasFromEngine(engine) as EditorCanvasWithFlags | null;
    if (!canvas) {
      useEditorStore.getState().setEngine(engine);
      useEditorStore.getState().setCanvas(null);
      const updateNativeSelection = () => {
        const active = engine.getActiveObject();
        useEditorStore.getState().setSelectedObjects(active ? [active.id] : []);
      };
      const offSelectionChange = engine.on?.('selectionchange', updateNativeSelection);
      const offChange = engine.on?.('change', updateNativeSelection);
      updateNativeSelection();
      return () => {
        offSelectionChange?.();
        offChange?.();
        useEditorStore.getState().setSelectedObjects([]);
        useEditorStore.getState().setCanvas(null);
        useEditorStore.getState().setEngine(null);
        useEditorStore.getState().resetHistory();
        engine.dispose();
      };
    }
    (canvas as fabric.Canvas & { targetFindTolerance?: number }).targetFindTolerance = 0;
    const cleanupNativeDragGuard = installNativeCanvasDragGuard(canvas);
    const cleanupDragBoundsGuard = installCanvasDragBoundsGuard(canvas);
    const cleanupTextEditingClickShield = installTextEditingClickShield(canvas);

    useEditorStore.getState().setEngine(engine);
    useEditorStore.getState().setCanvas(canvas);
    if (import.meta.env.DEV) {
      window.__benlaiEditorCanvas = canvas;
    }

    const updateSelection = () => {
      const objects = canvas.getActiveObjects();
      objects.forEach(applySelectionStyle);
      const ids = objects.map(getSelectionId).filter(Boolean);
      useEditorStore.getState().setSelectedObjects(ids);
      canvas.requestRenderAll();
    };

    const clearSelection = () => {
      const active = canvas.getActiveObject() as fabric.FabricObject & {
        isEditing?: boolean;
        exitEditing?: () => void;
      } | undefined;
      if (active?.isEditing) active.exitEditing?.();
      if (active) {
        canvas.discardActiveObject();
        canvas.requestRenderAll();
      }
      useEditorStore.getState().setSelectedObjects([]);
    };

    const handleCanvasMouseDown = (event: fabric.TPointerEventInfo<fabric.TPointerEvent>) => {
      setHoveredCanvasObject(canvas, null);
      if (useEditorStore.getState().activeTool === 'hand') return;
      if (event.target) return;
      clearSelection();
    };

    const pushHistory = () => {
      if (canvas.__suspendHistory) return;
      if (historyTimerRef.current) window.clearTimeout(historyTimerRef.current);
      historyTimerRef.current = window.setTimeout(() => {
        if (canvas.__suspendHistory) return;
        useEditorStore.getState().pushHistory(serializeFabricCanvasToFabricJson(canvas));
      }, 180);
    };

    const handleObjectAdded = (event: { target: fabric.FabricObject }) => {
      const object = event.target;
      if (object && !canvas.__bulkLoading) applySelectionStyle(object);
      pushHistory();
    };

    const handleObjectModified = () => {
      pushHistory();
    };

    const handleHoverMouseMove = (event: fabric.TPointerEventInfo<fabric.TPointerEvent>) => {
      const state = useEditorStore.getState();
      if (state.activeTool !== 'select' || isEditingText(canvas) || hasPressedPointerButton(event.e)) {
        setHoveredCanvasObject(canvas, null);
        return;
      }
      setHoveredCanvasObject(
        canvas,
        (event.target as fabric.FabricObject | null | undefined) || findCanvasHoverTargetFromEvent(canvas, event.e),
      );
    };

    const handleHoverMouseOver = (event: fabric.TPointerEventInfo<fabric.TPointerEvent>) => {
      const state = useEditorStore.getState();
      if (state.activeTool !== 'select' || isEditingText(canvas)) return;
      setHoveredCanvasObject(
        canvas,
        (event.target as fabric.FabricObject | null | undefined) || findCanvasHoverTargetFromEvent(canvas, event.e),
      );
    };

    const handleHoverMouseOut = (event: fabric.TPointerEventInfo<fabric.TPointerEvent>) => {
      const currentId = useEditorStore.getState().hoveredObjectId;
      if (!currentId) return;
      const targetId = getObjectLayerId(event.target as fabric.FabricObject | null | undefined);
      if (!targetId || targetId === currentId) setHoveredCanvasObject(canvas, null);
    };

    const handleNativeHoverMove = (event: MouseEvent | PointerEvent) => {
      const state = useEditorStore.getState();
      if (state.activeTool !== 'select' || isEditingText(canvas) || hasPressedPointerButton(event)) {
        setHoveredCanvasObject(canvas, null);
        return;
      }
      setHoveredCanvasObject(canvas, findCanvasHoverTargetFromEvent(canvas, event));
    };

    const clearHover = () => {
      setHoveredCanvasObject(canvas, null);
    };

    const handleHoverObjectRemoved = (event: { target: fabric.FabricObject }) => {
      const currentId = useEditorStore.getState().hoveredObjectId;
      if (currentId && getObjectLayerId(event.target) === currentId) clearHover();
      pushHistory();
    };

    canvas.on('selection:created', updateSelection);
    canvas.on('selection:updated', updateSelection);
    canvas.on('selection:cleared', updateSelection);
    canvas.on('mouse:down', handleCanvasMouseDown);
    canvas.on('mouse:move', handleHoverMouseMove);
    canvas.on('mouse:out', clearHover);
    canvas.on('mouse:over', handleHoverMouseOver);
    canvas.on('mouse:out', handleHoverMouseOut);
    const cleanupNativeInteractionBridge = installNativeCanvasInteractionBridge(canvas, {
      onHoverMove: handleNativeHoverMove,
      onHoverClear: clearHover,
    });
    canvas.on('object:added', handleObjectAdded);
    canvas.on('object:modified', handleObjectModified);
    canvas.on('object:removed', handleHoverObjectRemoved);
    canvas.on('text:changed', pushHistory);

    return () => {
      if (historyTimerRef.current) window.clearTimeout(historyTimerRef.current);
      cleanupTextEditingClickShield();
      cleanupNativeInteractionBridge();
      cleanupDragBoundsGuard();
      cleanupNativeDragGuard();
      clearHover();
      canvas.off('selection:created', updateSelection);
      canvas.off('selection:updated', updateSelection);
      canvas.off('selection:cleared', updateSelection);
      canvas.off('mouse:down', handleCanvasMouseDown);
      canvas.off('mouse:move', handleHoverMouseMove);
      canvas.off('mouse:out', clearHover);
      canvas.off('mouse:over', handleHoverMouseOver);
      canvas.off('mouse:out', handleHoverMouseOut);
      canvas.off('object:added', handleObjectAdded);
      canvas.off('object:modified', handleObjectModified);
      canvas.off('object:removed', handleHoverObjectRemoved);
      canvas.off('text:changed', pushHistory);
      hideDomTextCaret(canvas);
      useEditorStore.getState().setSelectedObjects([]);
      useEditorStore.getState().setCanvas(null);
      useEditorStore.getState().setEngine(null);
      if (import.meta.env.DEV && window.__benlaiEditorCanvas === canvas) {
        delete window.__benlaiEditorCanvas;
      }
      useEditorStore.getState().resetHistory();
      engine.dispose();
    };
  }, []);

  useEffect(() => {
    if (activeTool !== 'select' && hoveredObjectId) setHoveredObjectId(null);
  }, [activeTool, hoveredObjectId, setHoveredObjectId]);

  useEffect(() => () => {
    handPanCleanupRef.current?.();
    handPanCleanupRef.current = null;
    if (panFrameRef.current !== null) window.cancelAnimationFrame(panFrameRef.current);
    panFrameRef.current = null;
  }, []);

  useEffect(() => {
    const workspace = wrapRef.current;
    if (!workspace) return undefined;

    let frame = 0;
    const readSize = () => {
      frame = 0;
      const size = getWorkspaceContentSize(workspace);
      setWorkspaceSize((previous) => (
        previous.width === size.width && previous.height === size.height ? previous : size
      ));
    };
    const scheduleRead = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(readSize);
    };

    scheduleRead();
    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(scheduleRead)
      : null;
    observer?.observe(workspace);
    window.addEventListener('resize', scheduleRead);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', scheduleRead);
    };
  }, []);

  useEffect(() => {
    if (!workspaceSize.width || !workspaceSize.height || !canvasWidth || !canvasHeight) return;
    const routeKey = typeof window !== 'undefined'
      ? `${window.location.pathname}${window.location.search}`
      : '';
    const fitKey = `${fileId ?? routeKey}:${canvasWidth}x${canvasHeight}`;
    const nextZoom = calculateFitZoom(workspaceSize.width, workspaceSize.height, canvasWidth, canvasHeight);
    const store = useEditorStore.getState();
    const previousFit = autoFitRef.current;
    const shouldApply =
      previousFit?.key !== fitKey ||
      Math.abs(store.zoom - previousFit.zoom) < 0.5;
    if (!shouldApply) return;

    autoFitRef.current = { key: fitKey, zoom: nextZoom };
    if (store.zoom !== nextZoom) store.setZoom(nextZoom);
    if (panFrameRef.current !== null) {
      window.cancelAnimationFrame(panFrameRef.current);
      panFrameRef.current = null;
    }
    if (panOffsetRef.current.x !== 0 || panOffsetRef.current.y !== 0) {
      const origin = { x: 0, y: 0 };
      panOffsetRef.current = origin;
      setPanOffset(origin);
    }
  }, [canvasHeight, canvasWidth, fileId, workspaceSize.height, workspaceSize.width]);

  useEffect(() => {
    if (!storeCanvas) return;
    const frame = window.requestAnimationFrame(() => {
      storeCanvas.calcOffset();
      storeCanvas.requestRenderAll();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [storeCanvas, panOffset.x, panOffset.y]);

  useEffect(() => {
    const canvas = useEditorStore.getState().canvas;
    const engine = useEditorStore.getState().engine;
    if (!canvas) {
      if (engine) {
        void engine.load({
          ...engine.serialize(),
          width: canvasWidth,
          height: canvasHeight,
        });
      }
      return;
    }
    canvas.setDimensions({ width: canvasWidth, height: canvasHeight });
    canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
    canvas.calcOffset();
    canvas.requestRenderAll();
  }, [canvasWidth, canvasHeight]);

  useEffect(() => {
    const canvas = useEditorStore.getState().canvas;
    const engine = useEditorStore.getState().engine;
    if (!canvas) {
      engine?.setZoom(zoom);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      canvas.calcOffset();
      canvas.requestRenderAll();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [zoom]);

  const clearByWorkspace = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const canvas = useEditorStore.getState().canvas;
    if (!canvas) return;
    const active = canvas.getActiveObject() as fabric.FabricObject & {
      isEditing?: boolean;
      exitEditing?: () => void;
    } | undefined;
    if (active?.isEditing) active.exitEditing?.();
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    useEditorStore.getState().setSelectedObjects([]);
  };

  type HandPanStartEvent = {
    button: number;
    target: EventTarget;
    clientX: number;
    clientY: number;
    preventDefault: () => void;
    stopPropagation: () => void;
  };
  type HandPanMoveHandler = (clientX: number, clientY: number, event: Event) => void;

  const beginHandPanCore = (
    event: HandPanStartEvent,
    bindDocumentDrag: (
      handleMove: HandPanMoveHandler,
      handleEnd: (event?: Event) => void,
    ) => () => void,
  ) => {
    const currentTool = useEditorStore.getState().activeTool;
    if (currentTool !== 'hand' || event.button !== 0 || isEditableDomTarget(event.target)) return;
    const workspace = wrapRef.current;
    const canvas = useEditorStore.getState().canvas;
    if (!workspace || !canvas || isEditingText(canvas)) return;

    event.preventDefault();
    event.stopPropagation();
    handPanCleanupRef.current?.();

    const startX = event.clientX;
    const startY = event.clientY;
    const startPan = panOffsetRef.current;
    let latestPan = startPan;
    let cleanupDocumentDrag = () => {};
    const toolCanvas = canvas as fabric.Canvas & { skipTargetFind?: boolean };
    toolCanvas.skipTargetFind = true;
    canvas.selection = false;
    setIsHandDragging(true);
    setHoveredObjectId(null);
    setCanvasCursor(canvas, 'grabbing');

    const commitPan = (nextPan: { x: number; y: number }) => {
      latestPan = nextPan;
      if (panFrameRef.current !== null) return;
      panFrameRef.current = window.requestAnimationFrame(() => {
        panFrameRef.current = null;
        panOffsetRef.current = latestPan;
        setPanOffset(latestPan);
        canvas.calcOffset();
        canvas.requestRenderAll();
      });
    };

    const endPan = () => {
      if (panFrameRef.current !== null) {
        window.cancelAnimationFrame(panFrameRef.current);
        panFrameRef.current = null;
        panOffsetRef.current = latestPan;
        setPanOffset(latestPan);
      }
      const active = useEditorStore.getState().activeTool;
      canvas.selection = active === 'select';
      toolCanvas.skipTargetFind = active === 'shape' || active === 'hand';
      canvas.calcOffset();
      canvas.requestRenderAll();
      setIsHandDragging(false);
      const nextCursor = active === 'hand'
        ? 'grab'
        : canvas.defaultCursor || 'default';
      setCanvasCursor(canvas, nextCursor);
      cleanupDocumentDrag();
      window.removeEventListener('blur', handlePointerEnd);
      handPanCleanupRef.current = null;
    };
    const handlePointerEnd = (pointerEvent?: Event) => {
      endPan();
    };
    const handlePointerMove: HandPanMoveHandler = (clientX, clientY, pointerEvent) => {
      pointerEvent.preventDefault();
      commitPan({
        x: startPan.x + clientX - startX,
        y: startPan.y + clientY - startY,
      });
    };

    handPanCleanupRef.current = endPan;
    cleanupDocumentDrag = bindDocumentDrag(handlePointerMove, handlePointerEnd);
    window.addEventListener('blur', handlePointerEnd);
  };

  const beginHandPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pointerId = event.pointerId;
    beginHandPanCore(event, (handleMove, handleEnd) => {
      const handlePointerMove = (pointerEvent: PointerEvent) => {
        if (pointerEvent.pointerId !== pointerId) return;
        handleMove(pointerEvent.clientX, pointerEvent.clientY, pointerEvent);
      };
      const handlePointerEnd = (pointerEvent: PointerEvent) => {
        if (pointerEvent.pointerId !== pointerId) return;
        handleEnd(pointerEvent);
      };
      document.addEventListener('pointermove', handlePointerMove, { passive: false });
      document.addEventListener('pointerup', handlePointerEnd);
      document.addEventListener('pointercancel', handlePointerEnd);
      return () => {
        document.removeEventListener('pointermove', handlePointerMove);
        document.removeEventListener('pointerup', handlePointerEnd);
        document.removeEventListener('pointercancel', handlePointerEnd);
      };
    });
  };

  const beginHandPanMouseFallback = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (typeof window !== 'undefined' && 'PointerEvent' in window) return;
    beginHandPanCore(event, (handleMove, handleEnd) => {
      const handleMouseMove = (mouseEvent: MouseEvent) => {
        handleMove(mouseEvent.clientX, mouseEvent.clientY, mouseEvent);
      };
      const handleMouseEnd = (mouseEvent: MouseEvent) => {
        handleEnd(mouseEvent);
      };
      document.addEventListener('mousemove', handleMouseMove, { passive: false });
      document.addEventListener('mouseup', handleMouseEnd);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseEnd);
      };
    });
  };

  const preventCanvasNativeDrag = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!isInsideFabricSurface(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const canvasViewportStyle: CSSProperties = {
    width: displayWidth,
    height: displayHeight,
    overflow: 'visible',
    flex: '0 0 auto',
    position: 'relative',
  };
  const effectiveWorkspaceStyle: CSSProperties = {
    ...workspaceStyle,
    ...(activeTool === 'hand'
      ? {
          cursor: isHandDragging ? 'grabbing' : 'grab',
          userSelect: 'none',
        }
      : {}),
  };
  const scaledCanvasShellStyle: CSSProperties = {
    ...canvasShellStyle,
    width: canvasWidth,
    height: canvasHeight,
    transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${canvasScale})`,
    transformOrigin: 'top left',
    willChange: activeTool === 'hand' || isHandDragging ? 'transform' : undefined,
  };
  const hoverOverlayStyle = getHoverOverlayStyle(storeCanvas, hoveredObjectId, activeTool);

  return (
    <main
      ref={wrapRef}
      style={effectiveWorkspaceStyle}
      onPointerDownCapture={beginHandPan}
      onMouseDownCapture={beginHandPanMouseFallback}
      onPointerDown={clearByWorkspace}
      onDragStartCapture={preventCanvasNativeDrag}
    >
      <div style={canvasViewportStyle}>
        <div style={scaledCanvasShellStyle}>
          <canvas ref={canvasRef} draggable={false} />
          <div aria-hidden="true" style={hoverOverlayStyle || hiddenHoverOverlayStyle} />
        </div>
      </div>
    </main>
  );
}

function installDisposedCanvasGuards() {
  const targets: Array<{ proto: Record<string, unknown>; method: string }> = [
    { proto: (fabric.Canvas as unknown as { prototype: Record<string, unknown> }).prototype, method: 'clear' },
    { proto: (fabric.Canvas as unknown as { prototype: Record<string, unknown> }).prototype, method: 'renderAll' },
    { proto: (fabric.Canvas as unknown as { prototype: Record<string, unknown> }).prototype, method: 'renderTop' },
    { proto: (fabric.Canvas as unknown as { prototype: Record<string, unknown> }).prototype, method: 'renderTopLayer' },
    { proto: (fabric.Canvas as unknown as { prototype: Record<string, unknown> }).prototype, method: 'requestRenderAll' },
    { proto: (fabric.StaticCanvas as unknown as { prototype: Record<string, unknown> }).prototype, method: 'clear' },
    { proto: (fabric.StaticCanvas as unknown as { prototype: Record<string, unknown> }).prototype, method: 'renderAll' },
    { proto: (fabric.StaticCanvas as unknown as { prototype: Record<string, unknown> }).prototype, method: 'requestRenderAll' },
    { proto: (fabric.StaticCanvas as unknown as { prototype: Record<string, unknown> }).prototype, method: 'clearContext' },
  ];
  for (const { proto, method } of targets) {
    if (!proto || typeof proto[method] !== 'function') continue;
    const flagKey = `__benlaiGuarded_${method}`;
    if (proto[flagKey]) continue;
    const original = proto[method] as (...args: unknown[]) => unknown;
    proto[method] = function (
      this: GuardedFabricCanvas,
      ...args: unknown[]
    ) {
      if (method === 'clearContext') {
        const [ctx] = args;
        if (!isCanvasContext(ctx)) return undefined;
        if (shouldUseAbsoluteContextClear(this, ctx)) {
          resetAndClearCanvasContext(ctx);
          return undefined;
        }
      } else if (method === 'renderTopLayer') {
        const topContext = isCanvasContext(args[0]) ? args[0] : ensureCanvasTopContext(this);
        if (!topContext) {
          markTopContextClean(this);
          return undefined;
        }
        args[0] = topContext;
        clearTopLayerBeforeTransientRender(this, topContext);
      } else if (method === 'renderTop') {
        if (this.destroyed || this.disposed) return undefined;
        if (!ensureCanvasTopContext(this)) {
          markTopContextClean(this);
          return undefined;
        }
      } else {
        if (this.destroyed || this.disposed) return undefined;
        const context = ensureCanvasMainContext(this);
        if (!context) return undefined;
        if (!ensureCanvasTopContext(this)) markTopContextClean(this);
      }
      try {
        return original.apply(this, args);
      } catch (error) {
        if (
          error instanceof TypeError
          && /Cannot read propert(y|ies) of (undefined|null)/.test(error.message)
        ) {
          return undefined;
        }
        throw error;
      }
    };
    proto[flagKey] = true;
  }
}

type GuardedFabricCanvas = fabric.Canvas & {
  disposed?: boolean;
  contextContainer?: unknown;
  contextTop?: unknown;
  contextTopDirty?: boolean;
  hasLostContext?: boolean;
  elements?: {
    upper?: { el?: unknown; ctx?: unknown };
    lower?: { el?: unknown; ctx?: unknown };
  };
};

function isCanvasContext(value: unknown): value is CanvasRenderingContext2D {
  const ctx = value as CanvasRenderingContext2D | null | undefined;
  return !!ctx
    && typeof ctx.clearRect === 'function'
    && typeof ctx.save === 'function'
    && typeof ctx.restore === 'function';
}

function isCanvasElement(value: unknown): value is HTMLCanvasElement {
  const element = value as HTMLCanvasElement | null | undefined;
  return !!element && typeof element.getContext === 'function';
}

function repairCanvasContexts(canvas: GuardedFabricCanvas) {
  const lower = canvas.elements?.lower;
  if (lower && !isCanvasContext(lower.ctx) && isCanvasElement(lower.el)) {
    const context = lower.el.getContext('2d');
    if (isCanvasContext(context)) lower.ctx = context;
  }

  const upper = canvas.elements?.upper;
  if (upper && !isCanvasContext(upper.ctx) && isCanvasElement(upper.el)) {
    const context = upper.el.getContext('2d');
    if (isCanvasContext(context)) upper.ctx = context;
  }
}

function ensureCanvasMainContext(canvas: GuardedFabricCanvas): CanvasRenderingContext2D | null {
  repairCanvasContexts(canvas);
  const context = getCanvasMainContext(canvas);
  return isCanvasContext(context) ? context : null;
}

function ensureCanvasTopContext(canvas: GuardedFabricCanvas): CanvasRenderingContext2D | null {
  repairCanvasContexts(canvas);
  const context = getCanvasTopContext(canvas);
  return isCanvasContext(context) ? context : null;
}

function getCanvasMainContext(canvas: GuardedFabricCanvas): unknown {
  repairCanvasContexts(canvas);
  if (isCanvasContext(canvas.contextContainer)) return canvas.contextContainer;
  if (isCanvasContext(canvas.elements?.lower?.ctx)) return canvas.elements?.lower?.ctx;
  try {
    return (canvas as fabric.Canvas & { getContext?: () => unknown }).getContext?.();
  } catch {
    return null;
  }
}

function getCanvasTopContext(canvas: GuardedFabricCanvas): unknown {
  repairCanvasContexts(canvas);
  if (isCanvasContext(canvas.elements?.upper?.ctx)) return canvas.elements?.upper?.ctx;
  try {
    return canvas.contextTop;
  } catch {
    return null;
  }
}

function markTopContextClean(canvas: GuardedFabricCanvas) {
  canvas.contextTopDirty = false;
  canvas.hasLostContext = false;
}

function shouldUseAbsoluteContextClear(
  canvas: GuardedFabricCanvas,
  context: CanvasRenderingContext2D,
) {
  const topContext = getCanvasTopContext(canvas);
  const upperCanvas = canvas.elements?.upper?.el;
  const internalCanvas = canvas as unknown as {
    pixelFindContext?: unknown;
    pixelFindCanvasEl?: unknown;
  };
  const pixelFindContext = internalCanvas.pixelFindContext;
  const pixelFindCanvas = internalCanvas.pixelFindCanvasEl;
  return context === topContext
    || context === pixelFindContext
    || context.canvas === upperCanvas
    || context.canvas === pixelFindCanvas;
}

function resetAndClearCanvasContext(context: CanvasRenderingContext2D) {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, context.canvas.width, context.canvas.height);
  context.beginPath();
}

function clearTopLayerBeforeTransientRender(
  canvas: GuardedFabricCanvas,
  context: CanvasRenderingContext2D,
) {
  resetAndClearCanvasContext(context);
}

type NativeDragGuardCanvas = fabric.Canvas & {
  upperCanvasEl?: HTMLCanvasElement;
  wrapperEl?: HTMLElement;
};

type NativeInteractionBridgeCanvas = NativeDragGuardCanvas & {
  _onMouseDown?: (event: MouseEvent | PointerEvent | TouchEvent) => void;
  _onMouseMove?: (event: MouseEvent | PointerEvent | TouchEvent) => void;
  _onMouseUp?: (event: MouseEvent | PointerEvent | TouchEvent) => void;
  _onClick?: (event: MouseEvent | PointerEvent | TouchEvent) => void;
};

function installNativeCanvasInteractionBridge(
  canvas: fabric.Canvas,
  handlers: {
    onHoverMove: (event: MouseEvent | PointerEvent) => void;
    onHoverClear: () => void;
  },
) {
  const targetCanvas = canvas as NativeInteractionBridgeCanvas;
  const eventElements = getCanvasEventElements(canvas);
  const handledEvents = new WeakSet<Event>();
  const markFabricEvent = (event: { e?: Event }) => {
    if (event.e) handledEvents.add(event.e);
  };
  const disposers = [
    canvas.on('mouse:down', markFabricEvent),
    canvas.on('mouse:move', markFabricEvent),
    canvas.on('mouse:up', markFabricEvent),
    canvas.on('mouse:dblclick', markFabricEvent),
  ];

  const forwardToFabricIfNeeded = (
    event: MouseEvent | PointerEvent | TouchEvent,
    method: '_onMouseDown' | '_onMouseMove' | '_onMouseUp' | '_onClick',
  ) => {
    if (!shouldForwardNativeEventToFabric(canvas, event)) return;
    if (!isNativeEventInsideCanvas(canvas, event)) return;
    if (isEditableDomTarget(event.target) && !isCanvasEventTarget(canvas, event.target)) return;
    window.setTimeout(() => {
      if (handledEvents.has(event)) return;
      if (!isNativeEventInsideCanvas(canvas, event)) return;
      const forward = targetCanvas[method] as
        | ((nextEvent: MouseEvent | PointerEvent | TouchEvent) => void)
        | undefined;
      forward?.(event);
      if (method === '_onMouseDown' && !handledEvents.has(event)) {
        selectCanvasObjectFromNativeEvent(canvas, event);
      }
    }, 0);
  };

  const handleNativeMove = (event: MouseEvent | PointerEvent) => {
    if (!isNativeEventInsideCanvas(canvas, event)) {
      handlers.onHoverClear();
      return;
    }
    handlers.onHoverMove(event);
    forwardToFabricIfNeeded(event, '_onMouseMove');
  };
  const handleNativeDown = (event: MouseEvent | PointerEvent | TouchEvent) => {
    forwardToFabricIfNeeded(event, '_onMouseDown');
  };
  const handleNativeUp = (event: MouseEvent | PointerEvent | TouchEvent) => {
    forwardToFabricIfNeeded(event, '_onMouseUp');
  };
  const handleNativeClick = (event: MouseEvent) => {
    forwardToFabricIfNeeded(event, '_onClick');
  };
  const handleNativeLeave = () => {
    handlers.onHoverClear();
  };

  document.addEventListener('pointermove', handleNativeMove, true);
  document.addEventListener('mousemove', handleNativeMove, true);
  document.addEventListener('pointerdown', handleNativeDown, true);
  document.addEventListener('mousedown', handleNativeDown, true);
  document.addEventListener('touchstart', handleNativeDown, true);
  document.addEventListener('pointerup', handleNativeUp, true);
  document.addEventListener('mouseup', handleNativeUp, true);
  document.addEventListener('touchend', handleNativeUp, true);
  document.addEventListener('pointercancel', handleNativeUp, true);
  document.addEventListener('click', handleNativeClick, true);
  eventElements.forEach((element) => {
    element.addEventListener('pointerleave', handleNativeLeave);
    element.addEventListener('mouseleave', handleNativeLeave);
  });

  return () => {
    disposers.forEach((dispose) => dispose());
    document.removeEventListener('pointermove', handleNativeMove, true);
    document.removeEventListener('mousemove', handleNativeMove, true);
    document.removeEventListener('pointerdown', handleNativeDown, true);
    document.removeEventListener('mousedown', handleNativeDown, true);
    document.removeEventListener('touchstart', handleNativeDown, true);
    document.removeEventListener('pointerup', handleNativeUp, true);
    document.removeEventListener('mouseup', handleNativeUp, true);
    document.removeEventListener('touchend', handleNativeUp, true);
    document.removeEventListener('pointercancel', handleNativeUp, true);
    document.removeEventListener('click', handleNativeClick, true);
    eventElements.forEach((element) => {
      element.removeEventListener('pointerleave', handleNativeLeave);
      element.removeEventListener('mouseleave', handleNativeLeave);
    });
  };
}

function shouldForwardNativeEventToFabric(
  canvas: fabric.Canvas,
  event: MouseEvent | PointerEvent | TouchEvent,
) {
  if (typeof PointerEvent !== 'undefined' && event instanceof PointerEvent) {
    return (canvas as fabric.Canvas & { enablePointerEvents?: boolean }).enablePointerEvents === true;
  }
  return true;
}

function selectCanvasObjectFromNativeEvent(
  canvas: fabric.Canvas,
  event: MouseEvent | PointerEvent | TouchEvent,
) {
  const state = useEditorStore.getState();
  if (state.activeTool !== 'select' || isEditingText(canvas)) return;
  const pointerEvent = event as MouseEvent | PointerEvent;
  if ('button' in pointerEvent && pointerEvent.button !== 0) return;
  const target = findCanvasHoverTargetFromEvent(canvas, event as MouseEvent | PointerEvent);
  if (!target) {
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    state.setSelectedObjects([]);
    return;
  }
  const selectableTarget = resolveCanvasSelectionTarget(canvas, target);
  const selectableObject = selectableTarget as fabric.FabricObject & {
    selectable?: boolean;
    evented?: boolean;
  };
  if (!selectableObject || selectableObject.selectable === false || selectableObject.evented === false) return;
  applySelectionStyle(selectableTarget);
  canvas.setActiveObject(selectableTarget);
  canvas.requestRenderAll();
}

function resolveCanvasSelectionTarget(canvas: fabric.Canvas, target: fabric.FabricObject): fabric.FabricObject {
  const objects = canvas.getObjects() as fabric.FabricObject[];
  if (objects.includes(target)) return target;
  const ancestors = (target as fabric.FabricObject & {
    getAncestors?: () => fabric.FabricObject[];
  }).getAncestors?.() || [];
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index] as fabric.FabricObject;
    if (objects.includes(ancestor)) return ancestor;
  }
  return target;
}

function getCanvasEventElements(canvas: fabric.Canvas) {
  const targetCanvas = canvas as NativeDragGuardCanvas;
  return uniqueElements([
    targetCanvas.upperCanvasEl,
    getLowerCanvasElement(canvas),
    targetCanvas.wrapperEl,
  ]);
}

function isNativeEventInsideCanvas(
  canvas: fabric.Canvas,
  event: MouseEvent | PointerEvent | TouchEvent,
) {
  const point = getClientPointFromNativeEvent(event);
  if (!point) return false;
  const elements = getCanvasEventElements(canvas);
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  if (path.some((item) => elements.includes(item as HTMLElement))) return true;
  return elements.some((element) => isClientPointInsideElement(point, element));
}

function isCanvasEventTarget(canvas: fabric.Canvas, target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const elements = getCanvasEventElements(canvas);
  if (elements.includes(target)) return true;
  return elements.some((element) => element.contains(target));
}

function getClientPointFromNativeEvent(event: MouseEvent | PointerEvent | TouchEvent) {
  if ('changedTouches' in event) {
    const touch = event.changedTouches[0] || event.touches[0];
    if (!touch) return null;
    return { x: touch.clientX, y: touch.clientY };
  }
  if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return null;
  return { x: event.clientX, y: event.clientY };
}

function isClientPointInsideElement(point: { x: number; y: number }, element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return point.x >= rect.left
    && point.x <= rect.right
    && point.y >= rect.top
    && point.y <= rect.bottom;
}

function installNativeCanvasDragGuard(canvas: fabric.Canvas) {
  const targetCanvas = canvas as NativeDragGuardCanvas;
  const lowerCanvas = getLowerCanvasElement(canvas);
  const elements = uniqueElements([
    targetCanvas.upperCanvasEl,
    lowerCanvas,
    targetCanvas.wrapperEl,
  ]);

  const previous = elements.map((element) => ({
    element,
    draggable: element.draggable,
    draggableAttribute: element.getAttribute('draggable'),
    userDrag: element.style.getPropertyValue('-webkit-user-drag'),
    userSelect: element.style.userSelect,
    webkitUserSelect: element.style.getPropertyValue('-webkit-user-select'),
  }));

  const preventNativeCanvasDrag = (event: DragEvent) => {
    if (!isCanvasDragEvent(event, elements)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const lockElement = (element: HTMLElement) => {
    element.draggable = false;
    element.setAttribute('draggable', 'false');
    element.style.setProperty('-webkit-user-drag', 'none');
    element.style.userSelect = 'none';
    element.style.setProperty('-webkit-user-select', 'none');
  };

  const observer = typeof MutationObserver !== 'undefined'
    ? new MutationObserver((records) => {
      records.forEach((record) => {
        if (record.type === 'attributes' && record.target instanceof HTMLElement) {
          lockElement(record.target);
        }
      });
    })
    : null;

  previous.forEach(({ element }) => {
    lockElement(element);
    element.addEventListener('dragstart', preventNativeCanvasDrag, { capture: true });
    observer?.observe(element, { attributes: true, attributeFilter: ['draggable'] });
  });
  document.addEventListener('dragstart', preventNativeCanvasDrag, { capture: true });

  return () => {
    observer?.disconnect();
    document.removeEventListener('dragstart', preventNativeCanvasDrag, { capture: true });
    previous.forEach(({ element, draggable, draggableAttribute, userDrag, userSelect, webkitUserSelect }) => {
      element.removeEventListener('dragstart', preventNativeCanvasDrag, { capture: true });
      element.draggable = draggable;
      if (draggableAttribute === null) {
        element.removeAttribute('draggable');
      } else {
        element.setAttribute('draggable', draggableAttribute);
      }
      restoreStyleProperty(element, '-webkit-user-drag', userDrag);
      element.style.userSelect = userSelect;
      restoreStyleProperty(element, '-webkit-user-select', webkitUserSelect);
    });
  };
}

function installTextEditingClickShield(canvas: fabric.Canvas) {
  const upperCanvas = (canvas as NativeDragGuardCanvas).upperCanvasEl;
  if (!upperCanvas) return () => {};

  const blockOutsideEditingClick = (event: MouseEvent | PointerEvent | TouchEvent) => {
    const editingText = findEditingTextObject(canvas);
    if (!editingText) return;
    if (isPointInsideObjectBounds(canvas, editingText, event)) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    editingText.exitEditing?.();
    canvas.setActiveObject(editingText);
    editingText.setCoords();
    canvas.requestRenderAll();
  };

  upperCanvas.addEventListener('pointerdown', blockOutsideEditingClick, true);
  upperCanvas.addEventListener('mousedown', blockOutsideEditingClick, true);
  upperCanvas.addEventListener('touchstart', blockOutsideEditingClick, true);

  return () => {
    upperCanvas.removeEventListener('pointerdown', blockOutsideEditingClick, true);
    upperCanvas.removeEventListener('mousedown', blockOutsideEditingClick, true);
    upperCanvas.removeEventListener('touchstart', blockOutsideEditingClick, true);
  };
}

function findEditingTextObject(canvas: fabric.Canvas) {
  const active = canvas.getActiveObject();
  if (isEditingFabricTextObject(active)) return active;

  const stack = [...canvas.getObjects()];
  while (stack.length > 0) {
    const object = stack.pop();
    if (!object) continue;
    if (isEditingFabricTextObject(object)) return object;
    const group = object as fabric.FabricObject & {
      forEachObject?: (callback: (child: fabric.FabricObject) => void) => void;
    };
    group.forEachObject?.((child) => stack.push(child));
  }
  return undefined;
}

function isEditingFabricTextObject(
  object: fabric.FabricObject | null | undefined,
): object is fabric.FabricObject & { exitEditing?: () => void } {
  const target = object as fabric.FabricObject & { isEditing?: boolean; type?: string } | null | undefined;
  return target?.isEditing === true
    && (
      target instanceof fabric.IText
      || target instanceof fabric.Textbox
      || target.type === 'i-text'
      || target.type === 'textbox'
    );
}

function isPointInsideObjectBounds(
  canvas: fabric.Canvas,
  object: fabric.FabricObject,
  event: MouseEvent | PointerEvent | TouchEvent,
) {
  const pointer = getCanvasScenePointFromEvent(canvas, event);
  if (!pointer) return false;
  const rect = object.getBoundingRect();
  const padding = Math.max(6, Number(object.padding || 0));
  return pointer.x >= rect.left - padding
    && pointer.x <= rect.left + rect.width + padding
    && pointer.y >= rect.top - padding
    && pointer.y <= rect.top + rect.height + padding;
}

function getLowerCanvasElement(canvas: fabric.Canvas): HTMLCanvasElement | null {
  try {
    const element = canvas.getElement();
    return element instanceof HTMLCanvasElement ? element : null;
  } catch {
    return null;
  }
}

function uniqueElements(elements: Array<HTMLElement | null | undefined>) {
  return Array.from(new Set(elements.filter(Boolean) as HTMLElement[]));
}

function restoreStyleProperty(element: HTMLElement, property: string, value: string) {
  if (value) {
    element.style.setProperty(property, value);
  } else {
    element.style.removeProperty(property);
  }
}

function isInsideFabricSurface(target: EventTarget | null) {
  return target instanceof HTMLElement
    && Boolean(target.closest('[data-fabric="wrapper"], canvas'));
}

function isEditableDomTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function setCanvasCursor(canvas: fabric.Canvas, cursor: string) {
  try {
    canvas.setCursor(cursor);
  } catch {
    // Cursor feedback is best-effort; Fabric may be mid-dispose.
  }
  const targetCanvas = canvas as NativeDragGuardCanvas;
  uniqueElements([
    targetCanvas.upperCanvasEl,
    getLowerCanvasElement(canvas),
    targetCanvas.wrapperEl,
  ]).forEach((element) => {
    element.style.cursor = cursor;
  });
}

function isCanvasDragEvent(event: DragEvent, guardedElements: HTMLElement[]) {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  if (path.some((item) => guardedElements.includes(item as HTMLElement))) return true;
  return isInsideFabricSurface(event.target);
}

function installSelectionDefaults() {
  patchFabricControlRendering();

  const classes = [
    fabric.FabricObject,
    (fabric as unknown as { InteractiveFabricObject?: typeof fabric.FabricObject }).InteractiveFabricObject,
    fabric.Textbox,
    fabric.IText,
    fabric.Rect,
    fabric.Ellipse,
    fabric.Triangle,
    fabric.Line,
    fabric.Path,
    fabric.FabricImage,
    fabric.Group,
  ].filter(Boolean);

  classes.forEach((klass) => {
    const target = klass as typeof fabric.FabricObject & {
      ownDefaults?: Record<string, unknown>;
      prototype: Record<string, unknown>;
    };
    if (target.ownDefaults) Object.assign(target.ownDefaults, selectionStyle);
    Object.assign(target.prototype, selectionStyle);
  });

  const groupTarget = fabric.Group as typeof fabric.Group & {
    ownDefaults?: Record<string, unknown>;
    prototype: Record<string, unknown>;
  };
  if (groupTarget.ownDefaults) {
    Object.assign(groupTarget.ownDefaults, {
      subTargetCheck: true,
      interactive: false,
    });
  }
  Object.assign(groupTarget.prototype, {
    subTargetCheck: true,
    interactive: false,
  });
}

function drawSelectionHalo(object: fabric.FabricObject, ctx: CanvasRenderingContext2D) {
  if (!object.canvas) return;
  const zoom = typeof object.canvas.getZoom === 'function' ? object.canvas.getZoom() : 1;
  const w = object.width * (object.scaleX || 1);
  const h = object.height * (object.scaleY || 1);
  const halfW = w / 2;
  const halfH = h / 2;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(37, 87, 246, 0.28)';
  ctx.lineWidth = 5 / zoom;
  ctx.setLineDash([]);
  ctx.strokeRect(-halfW, -halfH, w, h);
  ctx.restore();
}

function patchFabricControlRendering() {
  const controlProto = fabric.Control.prototype as fabric.Control & {
    __benlaiSelectionRenderPatched?: boolean;
  };
  if (!controlProto.__benlaiSelectionRenderPatched) {
    controlProto.__benlaiSelectionRenderPatched = true;
    controlProto.render = renderBenlaiControl;
  }

  [
    fabric.FabricObject,
    (fabric as unknown as { InteractiveFabricObject?: typeof fabric.FabricObject }).InteractiveFabricObject,
    fabric.Textbox,
    fabric.IText,
    fabric.Rect,
    fabric.Ellipse,
    fabric.Triangle,
    fabric.Line,
    fabric.Path,
    fabric.FabricImage,
    fabric.Group,
    (fabric as unknown as { ActiveSelection?: typeof fabric.FabricObject }).ActiveSelection,
  ].filter(Boolean).forEach((klass) => {
    const proto = (klass as typeof fabric.FabricObject).prototype as unknown as Record<string, unknown>;
    if (!proto || proto.__benlaiSelectionControlsPatched) return;
    const originalRenderControls = proto._renderControls as
      | ((ctx: CanvasRenderingContext2D, styleOverride?: Record<string, unknown>) => void)
      | undefined;
    if (originalRenderControls) {
      proto.__benlaiSelectionControlsPatched = true;
      proto._renderControls = function renderBenlaiSelectionControls(
        this: fabric.FabricObject,
        ctx: CanvasRenderingContext2D,
        styleOverride: Record<string, unknown> = {},
      ) {
        originalRenderControls.call(this, ctx, {
          ...styleOverride,
          ...selectionStyle,
          borderColor: selectionBlue,
          cornerColor: '#ffffff',
          cornerStrokeColor: selectionBlue,
          cornerStyle: 'circle',
        });
      };
    }
  });

  const iTextProto = fabric.IText.prototype as fabric.IText & {
    __benlaiEditingPatch?: boolean;
    __benlaiTextareaPositionPatch?: boolean;
    __benlaiTextareaFocusPatch?: boolean;
    __benlaiTextCaretPatch?: boolean;
    initHiddenTextarea?: () => void;
    exitEditing?: () => fabric.IText;
    renderCursorOrSelection?: () => void;
    _setEditingProps?: () => void;
    _calcTextareaPosition?: () => {
      left: string;
      top: string;
      fontSize?: string;
      charHeight?: number;
    };
  };
  if (!iTextProto.__benlaiEditingPatch && iTextProto._setEditingProps) {
    const originalSetEditingProps = iTextProto._setEditingProps;
    iTextProto.__benlaiEditingPatch = true;
    iTextProto._setEditingProps = function setBenlaiEditingProps(this: fabric.IText) {
      this.set({
        editingBorderColor: selectionBlue,
        borderColor: selectionBlue,
        cornerColor: '#ffffff',
        cornerStrokeColor: selectionBlue,
        cornerStyle: 'circle',
      } as Partial<fabric.IText>);
      originalSetEditingProps.call(this);
      this.borderColor = selectionBlue;
    };
  }
  if (!iTextProto.__benlaiTextareaPositionPatch && iTextProto._calcTextareaPosition) {
    const originalCalcTextareaPosition = iTextProto._calcTextareaPosition;
    iTextProto.__benlaiTextareaPositionPatch = true;
    (iTextProto as unknown as {
      _calcTextareaPosition: () => { left: string; top: string; fontSize?: string; charHeight?: number };
    })._calcTextareaPosition = function calcScaledTextareaPosition(this: fabric.IText) {
      const rectStyle = calcTextareaPositionFromCanvasRect(this);
      if (rectStyle) return rectStyle;
      const style = originalCalcTextareaPosition.call(this);
      return compensateTextareaPositionForCssScale(this, style);
    };
  }
  if (!iTextProto.__benlaiTextareaFocusPatch && iTextProto.initHiddenTextarea) {
    const originalInitHiddenTextarea = iTextProto.initHiddenTextarea;
    iTextProto.__benlaiTextareaFocusPatch = true;
    iTextProto.initHiddenTextarea = function initHiddenTextareaWithoutScroll(
      this: fabric.IText & { hiddenTextarea?: HTMLTextAreaElement | null; canvas?: fabric.Canvas },
    ) {
      originalInitHiddenTextarea.call(this);
      prepareHiddenTextareaForDomCaret(this.hiddenTextarea, this.canvas);
    };
  }
  if (!iTextProto.__benlaiTextCaretPatch && iTextProto.renderCursorOrSelection) {
    const originalRenderCursorOrSelection = iTextProto.renderCursorOrSelection;
    const originalExitEditing = iTextProto.exitEditing;
    iTextProto.__benlaiTextCaretPatch = true;
    iTextProto.renderCursorOrSelection = function renderDomTextCaret(this: fabric.IText) {
      if (!shouldUseDomTextCaretFallback(this.canvas)) {
        hideDomTextCaret(this.canvas);
        originalRenderCursorOrSelection.call(this);
        return;
      }
      clearFabricTopContextForDomCaret(this.canvas);
      syncDomTextEditingOverlay(this);
    };
    if (originalExitEditing) {
      iTextProto.exitEditing = function exitEditingWithDomCaretCleanup(this: fabric.IText) {
        hideDomTextCaret(this.canvas);
        return originalExitEditing.call(this);
      };
    }
  }
}

function shouldUseDomTextCaretFallback(canvas: fabric.Canvas | null | undefined) {
  const ownerWindow = canvas?.upperCanvasEl?.ownerDocument?.defaultView || window;
  const browserNavigator = ownerWindow.navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const platform = [
    browserNavigator.platform,
    browserNavigator.userAgentData?.platform,
    browserNavigator.userAgent,
  ].filter(Boolean).join(' ');
  return /\b(Mac|Macintosh|iPad|iPhone|iPod)\b/i.test(platform);
}

function hasActiveTextSelection(text: fabric.IText) {
  const target = text as fabric.IText & {
    selectionStart?: number;
    selectionEnd?: number;
    inCompositionMode?: boolean;
    hiddenTextarea?: HTMLTextAreaElement | null;
  };
  if (target.inCompositionMode && target.hiddenTextarea) {
    return target.hiddenTextarea.selectionStart !== target.hiddenTextarea.selectionEnd;
  }
  return Number(target.selectionStart || 0) !== Number(target.selectionEnd || 0);
}

function prepareHiddenTextareaForDomCaret(
  textarea: HTMLTextAreaElement | null | undefined,
  canvas: fabric.Canvas | null | undefined,
) {
  const target = textarea as (HTMLTextAreaElement & {
    __benlaiPreventScrollFocus?: boolean;
    focus: (options?: FocusOptions) => void;
  }) | null | undefined;
  if (!target) return;
  if (shouldUseDomTextCaretFallback(canvas)) {
    target.style.caretColor = 'transparent';
    target.style.color = 'transparent';
  }
  if (!target.__benlaiPreventScrollFocus) {
    const originalFocus = target.focus.bind(target);
    target.__benlaiPreventScrollFocus = true;
    target.focus = (options?: FocusOptions) => {
      originalFocus({ ...(options || {}), preventScroll: true });
    };
  }
}

type TextareaPositionStyle = {
  left: string;
  top: string;
  fontSize?: string;
  charHeight?: number;
};

function syncDomTextEditingOverlay(text: fabric.IText) {
  const canvas = text.canvas;
  if (!canvas || !isEditingFabricTextObject(text)) {
    hideDomTextCaret(canvas);
    return;
  }

  clearDomTextSelection(canvas);
  if (hasActiveTextSelection(text)) {
    const selectionStyles = calcDomTextSelectionStyles(text);
    if (selectionStyles.length === 0) {
      hideDomTextCaret(canvas);
      return;
    }
    const caret = getDomTextCaret(canvas);
    if (caret) caret.style.display = 'none';
    const ownerDocument = canvas.upperCanvasEl?.ownerDocument || document;
    for (const style of selectionStyles) {
      const selection = ownerDocument.createElement('div');
      selection.dataset.benlaiDomTextSelection = 'true';
      Object.assign(selection.style, style);
      ownerDocument.body.appendChild(selection);
    }
    return;
  }

  const style = calcDomTextCaretStyle(text);
  if (!style) {
    hideDomTextCaret(canvas);
    return;
  }

  const caret = ensureDomTextCaret(canvas);
  Object.assign(caret.style, style);
}

function hideDomTextCaret(canvas: fabric.Canvas | null | undefined) {
  const ownerDocument = canvas?.upperCanvasEl?.ownerDocument || document;
  const caret = ownerDocument.getElementById('benlai-dom-text-caret');
  if (caret) caret.style.display = 'none';
  clearDomTextSelection(canvas);
}

function getDomTextCaret(canvas: fabric.Canvas | null | undefined) {
  const ownerDocument = canvas?.upperCanvasEl?.ownerDocument || document;
  return ownerDocument.getElementById('benlai-dom-text-caret') as HTMLDivElement | null;
}

function clearDomTextSelection(canvas: fabric.Canvas | null | undefined) {
  const ownerDocument = canvas?.upperCanvasEl?.ownerDocument || document;
  ownerDocument
    .querySelectorAll('[data-benlai-dom-text-selection="true"]')
    .forEach((element) => element.remove());
}

function ensureDomTextCaret(canvas: fabric.Canvas) {
  const ownerDocument = canvas.upperCanvasEl?.ownerDocument || document;
  let caret = ownerDocument.getElementById('benlai-dom-text-caret') as HTMLDivElement | null;
  if (!caret) {
    caret = ownerDocument.createElement('div');
    caret.id = 'benlai-dom-text-caret';
    ownerDocument.body.appendChild(caret);
  }

  caret.style.position = 'absolute';
  caret.style.pointerEvents = 'none';
  caret.style.zIndex = '2147483647';
  caret.style.borderRadius = '1px';
  caret.style.mixBlendMode = 'normal';
  return caret;
}

function clearFabricTopContextForDomCaret(canvas: fabric.Canvas | null | undefined) {
  const targetCanvas = canvas as GuardedFabricCanvas | null | undefined;
  if (!targetCanvas) return;
  const context = ensureCanvasTopContext(targetCanvas);
  if (!context) return;
  resetAndClearCanvasContext(context);
  markTopContextClean(targetCanvas);
}

function calcDomTextSelectionStyles(text: fabric.IText): Array<Record<string, string>> {
  const canvas = text.canvas;
  const upperCanvas = canvas?.upperCanvasEl;
  if (!canvas || !upperCanvas) return [];

  const target = text as unknown as {
    selectionStart?: number;
    selectionEnd?: number;
    inCompositionMode?: boolean;
    hiddenTextarea?: HTMLTextAreaElement | null;
    compositionColor?: string;
    selectionColor?: string;
    textAlign?: string;
    direction?: string;
    width?: number;
    lineHeight?: number;
    __charBounds?: Array<Array<{ left: number; width: number }>>;
    _getCursorBoundaries?: (
      selectionStart?: number,
      skipCaching?: boolean,
    ) => { left: number; top: number; leftOffset: number; topOffset: number };
    get2DCursorLocation?: (selectionStart: number) => { lineIndex: number; charIndex: number };
    _getLineLeftOffset?: (lineIndex: number) => number;
    getHeightOfLine?: (lineIndex: number) => number;
    getLineWidth?: (lineIndex: number) => number;
    isEndOfWrapping?: (lineIndex: number) => boolean;
    _getWidthOfCharSpacing?: () => number;
    calcTransformMatrix?: () => fabric.TMat2D;
    initDimensions?: () => void;
  };
  if (
    !target._getCursorBoundaries
    || !target.get2DCursorLocation
    || !target.getHeightOfLine
    || !target.calcTransformMatrix
  ) {
    return [];
  }

  try {
    target.initDimensions?.();
  } catch {
    // ignore
  }

  const rawStart = target.inCompositionMode && target.hiddenTextarea
    ? target.hiddenTextarea.selectionStart
    : Number(target.selectionStart || 0);
  const rawEnd = target.inCompositionMode && target.hiddenTextarea
    ? target.hiddenTextarea.selectionEnd
    : Number(target.selectionEnd || 0);
  const selectionStart = Math.min(rawStart, rawEnd);
  const selectionEnd = Math.max(rawStart, rawEnd);
  if (selectionStart === selectionEnd) return [];

  const boundaries = target._getCursorBoundaries(selectionStart, true);
  const start = target.get2DCursorLocation(selectionStart);
  const end = target.get2DCursorLocation(selectionEnd);
  const startLine = start.lineIndex;
  const endLine = end.lineIndex;
  const startChar = Math.max(0, start.charIndex);
  const endChar = Math.max(0, end.charIndex);
  const isJustify = String(target.textAlign || '').includes('justify');
  const isRtl = target.direction === 'rtl';
  const textWidth = Number(target.width || text.width || 0);
  const lineHeightRatio = Number(target.lineHeight || 1);
  const charSpacing = Number(target._getWidthOfCharSpacing?.() || 0);
  const transform = fabric.util.multiplyTransformMatrices(
    canvas.viewportTransform || ([1, 0, 0, 1, 0, 0] as fabric.TMat2D),
    target.calcTransformMatrix(),
  );
  const color = target.inCompositionMode
    ? (target.compositionColor || 'black')
    : (target.selectionColor || selectionStyle.selectionColor);
  const styles: Array<Record<string, string>> = [];
  let topOffset = Number(boundaries.topOffset || 0);

  for (let lineIndex = startLine; lineIndex <= endLine; lineIndex += 1) {
    const lineOffset = Number(target._getLineLeftOffset?.(lineIndex) || 0);
    const lineBounds = target.__charBounds?.[lineIndex] || [];
    let lineHeight = Number(target.getHeightOfLine(lineIndex) || 0);
    const realLineHeight = lineHeight;
    let boxStart = 0;
    let boxEnd = 0;

    if (lineIndex === startLine) {
      boxStart = getDomTextCharLeft(lineBounds, startChar, Number(target.getLineWidth?.(lineIndex) || 0));
    }
    if (lineIndex >= startLine && lineIndex < endLine) {
      boxEnd = isJustify && !target.isEndOfWrapping?.(lineIndex)
        ? textWidth
        : Number(target.getLineWidth?.(lineIndex) || 5);
    } else if (lineIndex === endLine) {
      if (endChar === 0) {
        boxEnd = getDomTextCharLeft(lineBounds, 0, Number(target.getLineWidth?.(lineIndex) || 0));
      } else {
        const endBound = lineBounds[endChar - 1];
        boxEnd = endBound
          ? Number(endBound.left || 0) + Number(endBound.width || 0) - charSpacing
          : Number(target.getLineWidth?.(lineIndex) || 0);
      }
    }

    let drawStart = Number(boundaries.left || 0) + lineOffset + boxStart;
    let drawHeight = lineHeight;
    let extraTop = 0;
    const drawWidth = boxEnd - boxStart;
    if (target.inCompositionMode) {
      drawHeight = 1;
      extraTop = lineHeight;
    } else if (lineHeightRatio < 1 || (lineIndex === endLine && lineHeightRatio > 1)) {
      drawHeight = lineHeight / lineHeightRatio;
    }
    if (isRtl) {
      const align = String(target.textAlign || '');
      if (align === 'right' || align.includes('justify-right')) {
        drawStart = textWidth - drawStart - drawWidth;
      } else if (align === 'left' || align.includes('justify-left') || align === 'center' || align.includes('justify-center')) {
        drawStart = Number(boundaries.left || 0) + lineOffset - boxEnd;
      }
    }

    if (Number.isFinite(drawWidth) && drawWidth > 0 && Number.isFinite(drawHeight) && drawHeight > 0) {
      const style = calcDomRectStyleFromCanvasLocalRect(
        canvas,
        upperCanvas,
        transform,
        {
          left: drawStart,
          top: Number(boundaries.top || 0) + topOffset + extraTop,
          width: drawWidth,
          height: drawHeight,
        },
        color,
      );
      if (style) styles.push(style);
    }
    topOffset += realLineHeight;
  }

  return styles;
}

function getDomTextCharLeft(
  lineBounds: Array<{ left: number; width: number }>,
  charIndex: number,
  fallback: number,
) {
  const bound = lineBounds[charIndex];
  if (bound && Number.isFinite(bound.left)) return Number(bound.left);
  const previous = lineBounds[charIndex - 1];
  if (previous && Number.isFinite(previous.left) && Number.isFinite(previous.width)) {
    return Number(previous.left) + Number(previous.width);
  }
  return fallback;
}

function calcDomRectStyleFromCanvasLocalRect(
  canvas: fabric.Canvas,
  upperCanvas: HTMLCanvasElement,
  transform: fabric.TMat2D,
  localRect: { left: number; top: number; width: number; height: number },
  background: string,
): Record<string, string> | null {
  const rect = upperCanvas.getBoundingClientRect();
  const canvasWidth = canvas.getWidth();
  const canvasHeight = canvas.getHeight();
  if (!rect.width || !rect.height || !canvasWidth || !canvasHeight) return null;

  const topLeft = new fabric.Point(localRect.left, localRect.top).transform(transform);
  const topRight = new fabric.Point(localRect.left + localRect.width, localRect.top).transform(transform);
  const bottomLeft = new fabric.Point(localRect.left, localRect.top + localRect.height).transform(transform);
  const view = upperCanvas.ownerDocument.defaultView;
  const documentLeft = rect.left + (view?.scrollX ?? 0);
  const documentTop = rect.top + (view?.scrollY ?? 0);
  const scaleX = rect.width / canvasWidth;
  const scaleY = rect.height / canvasHeight;
  const cssTopLeft = {
    x: documentLeft + topLeft.x * scaleX,
    y: documentTop + topLeft.y * scaleY,
  };
  const cssTopRight = {
    x: documentLeft + topRight.x * scaleX,
    y: documentTop + topRight.y * scaleY,
  };
  const cssBottomLeft = {
    x: documentLeft + bottomLeft.x * scaleX,
    y: documentTop + bottomLeft.y * scaleY,
  };
  const width = Math.max(
    1,
    Math.hypot(cssTopRight.x - cssTopLeft.x, cssTopRight.y - cssTopLeft.y),
  );
  const height = Math.max(
    1,
    Math.hypot(cssBottomLeft.x - cssTopLeft.x, cssBottomLeft.y - cssTopLeft.y),
  );
  const angle = Math.atan2(cssTopRight.y - cssTopLeft.y, cssTopRight.x - cssTopLeft.x);

  return {
    position: 'absolute',
    pointerEvents: 'none',
    zIndex: '2147483646',
    display: 'block',
    left: `${cssTopLeft.x}px`,
    top: `${cssTopLeft.y}px`,
    width: `${width}px`,
    height: `${height}px`,
    background,
    transformOrigin: '0 0',
    transform: `rotate(${angle}rad)`,
  };
}

function calcDomTextCaretStyle(text: fabric.IText): Record<string, string> | null {
  const canvas = text.canvas;
  const upperCanvas = canvas?.upperCanvasEl;
  if (!canvas || !upperCanvas) return null;

  const rect = upperCanvas.getBoundingClientRect();
  const canvasWidth = canvas.getWidth();
  const canvasHeight = canvas.getHeight();
  if (!rect.width || !rect.height || !canvasWidth || !canvasHeight) return null;

  const target = text as unknown as {
    selectionStart?: number;
    selectionEnd?: number;
    _currentCursorOpacity?: number;
    _getCursorBoundaries?: (selectionStart?: number, skipCaching?: boolean) => unknown;
    getCursorRenderingData?: (
      selectionStart?: number,
      boundaries?: unknown,
    ) => {
      color?: string;
      opacity?: number;
      left: number;
      top: number;
      width: number;
      height: number;
    };
    calcTransformMatrix?: () => fabric.TMat2D;
  };
  if (!target._getCursorBoundaries || !target.getCursorRenderingData || !target.calcTransformMatrix) {
    return null;
  }

  const selectionStart = Number(target.selectionStart || 0);
  const selectionEnd = Number(target.selectionEnd || selectionStart);
  const caretIndex = Math.max(selectionStart, selectionEnd);
  const boundaries = target._getCursorBoundaries(caretIndex, true);
  const cursor = target.getCursorRenderingData(caretIndex, boundaries);
  if (
    !Number.isFinite(cursor.left)
    || !Number.isFinite(cursor.top)
    || !Number.isFinite(cursor.width)
    || !Number.isFinite(cursor.height)
  ) {
    return null;
  }

  const transform = fabric.util.multiplyTransformMatrices(
    canvas.viewportTransform || ([1, 0, 0, 1, 0, 0] as fabric.TMat2D),
    target.calcTransformMatrix(),
  );
  const cursorWidth = Math.max(1, Number(cursor.width || 1));
  const topLeft = new fabric.Point(cursor.left, cursor.top).transform(transform);
  const bottomLeft = new fabric.Point(cursor.left, cursor.top + cursor.height).transform(transform);
  const topRight = new fabric.Point(cursor.left + cursorWidth, cursor.top).transform(transform);
  const view = upperCanvas.ownerDocument.defaultView;
  const documentLeft = rect.left + (view?.scrollX ?? 0);
  const documentTop = rect.top + (view?.scrollY ?? 0);
  const scaleX = rect.width / canvasWidth;
  const scaleY = rect.height / canvasHeight;
  const cssTopLeft = {
    x: documentLeft + topLeft.x * scaleX,
    y: documentTop + topLeft.y * scaleY,
  };
  const cssBottomLeft = {
    x: documentLeft + bottomLeft.x * scaleX,
    y: documentTop + bottomLeft.y * scaleY,
  };
  const cssTopRight = {
    x: documentLeft + topRight.x * scaleX,
    y: documentTop + topRight.y * scaleY,
  };
  const width = Math.max(
    1,
    Math.hypot(cssTopRight.x - cssTopLeft.x, cssTopRight.y - cssTopLeft.y),
  );
  const height = Math.max(
    1,
    Math.hypot(cssBottomLeft.x - cssTopLeft.x, cssBottomLeft.y - cssTopLeft.y),
  );
  const angle = Math.atan2(-(cssBottomLeft.x - cssTopLeft.x), cssBottomLeft.y - cssTopLeft.y);
  const textFill = typeof text.fill === 'string' ? text.fill : '#111827';
  const color = typeof cursor.color === 'string' ? cursor.color : textFill;
  const opacity = clampNumber(cursor.opacity ?? target._currentCursorOpacity ?? 1, 0, 1);

  return {
    display: 'block',
    left: `${cssTopLeft.x}px`,
    top: `${cssTopLeft.y}px`,
    width: `${width}px`,
    height: `${height}px`,
    background: color,
    opacity: `${opacity}`,
    transformOrigin: '0 0',
    transform: `rotate(${angle}rad)`,
  };
}

function calcTextareaPositionFromCanvasRect(text: fabric.IText): TextareaPositionStyle | null {
  const canvas = text.canvas;
  const upperCanvas = canvas?.upperCanvasEl;
  if (!canvas || !upperCanvas) return null;

  const target = text as unknown as {
    inCompositionMode?: boolean;
    lineHeight?: number;
    selectionStart?: number;
    compositionStart?: number;
    get2DCursorLocation?: (selectionStart: number) => { lineIndex: number; charIndex: number };
    getValueOfPropertyAt?: (lineIndex: number, charIndex: number, property: string) => unknown;
    calcTransformMatrix?: () => fabric.TMat2D;
    _getCursorBoundaries?: (selectionStart: number) => {
      left: number;
      top: number;
      leftOffset: number;
      topOffset: number;
    };
  };
  if (!target._getCursorBoundaries || !target.get2DCursorLocation || !target.getValueOfPropertyAt) {
    return null;
  }

  const desiredPosition = target.inCompositionMode
    ? Number(target.compositionStart || 0)
    : Number(target.selectionStart || 0);
  const boundaries = target._getCursorBoundaries(desiredPosition);
  const cursorLocation = target.get2DCursorLocation(desiredPosition);
  const fontSize = Number(target.getValueOfPropertyAt(cursorLocation.lineIndex, cursorLocation.charIndex, 'fontSize'));
  const charHeight = fontSize * Number(target.lineHeight || 1);
  if (!Number.isFinite(charHeight) || charHeight <= 0) return null;

  const localPoint = new fabric.Point(
    Number(boundaries.left || 0) + Number(boundaries.leftOffset || 0),
    Number(boundaries.top || 0) + Number(boundaries.topOffset || 0) + charHeight,
  );
  const viewportTransform = canvas.viewportTransform || ([1, 0, 0, 1, 0, 0] as fabric.TMat2D);
  const viewportPoint = localPoint
    .transform(target.calcTransformMatrix?.() || ([1, 0, 0, 1, 0, 0] as fabric.TMat2D))
    .transform(viewportTransform);
  const canvasWidth = canvas.getWidth();
  const canvasHeight = canvas.getHeight();
  if (!canvasWidth || !canvasHeight) return null;

  const x = clampNumber(viewportPoint.x, 0, Math.max(0, canvasWidth - charHeight));
  const y = clampNumber(viewportPoint.y, 0, Math.max(0, canvasHeight - charHeight));
  const rect = upperCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;

  const view = upperCanvas.ownerDocument.defaultView;
  const scaleX = rect.width / canvasWidth;
  const scaleY = rect.height / canvasHeight;
  const documentLeft = rect.left + (view?.scrollX ?? 0);
  const documentTop = rect.top + (view?.scrollY ?? 0);

  return {
    left: `${documentLeft + x * scaleX}px`,
    top: `${documentTop + y * scaleY}px`,
    fontSize: `${Math.max(1, charHeight * scaleY)}px`,
    charHeight: charHeight * scaleY,
  };
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function getWorkspaceContentSize(workspace: HTMLElement) {
  const style = window.getComputedStyle(workspace);
  const paddingX = (parseCssPixel(style.paddingLeft) ?? 0) + (parseCssPixel(style.paddingRight) ?? 0);
  const paddingY = (parseCssPixel(style.paddingTop) ?? 0) + (parseCssPixel(style.paddingBottom) ?? 0);
  return {
    width: Math.max(1, workspace.clientWidth - paddingX),
    height: Math.max(1, workspace.clientHeight - paddingY),
  };
}

function calculateFitZoom(
  workspaceWidth: number,
  workspaceHeight: number,
  canvasWidth: number,
  canvasHeight: number,
) {
  if (!workspaceWidth || !workspaceHeight || !canvasWidth || !canvasHeight) return 100;
  const rawZoom = Math.min(workspaceWidth / canvasWidth, workspaceHeight / canvasHeight, 1) * 100;
  return clampNumber(Math.floor(rawZoom), 10, 100);
}

function compensateTextareaPositionForCssScale(
  text: fabric.IText,
  style: { left: string; top: string; fontSize?: string; charHeight?: number },
) {
  const canvas = text.canvas;
  const upperCanvas = canvas?.upperCanvasEl;
  if (!canvas || !upperCanvas) return style;

  const rect = upperCanvas.getBoundingClientRect();
  const layoutWidth = upperCanvas.clientWidth || rect.width;
  const layoutHeight = upperCanvas.clientHeight || rect.height;
  if (!rect.width || !rect.height || !layoutWidth || !layoutHeight) return style;

  const scaleX = rect.width / layoutWidth;
  const scaleY = rect.height / layoutHeight;
  if (Math.abs(scaleX - 1) < 0.001 && Math.abs(scaleY - 1) < 0.001) return style;

  const left = parseCssPixel(style.left);
  const top = parseCssPixel(style.top);
  if (left === null || top === null) return style;

  const view = upperCanvas.ownerDocument.defaultView;
  const documentLeft = rect.left + (view?.scrollX ?? 0);
  const documentTop = rect.top + (view?.scrollY ?? 0);
  const canvasOffset = (canvas as fabric.Canvas & { _offset?: { left?: number; top?: number } })._offset;
  const baseLeft = Number.isFinite(canvasOffset?.left) ? Number(canvasOffset?.left) : documentLeft;
  const baseTop = Number.isFinite(canvasOffset?.top) ? Number(canvasOffset?.top) : documentTop;
  const localLeft = left - baseLeft;
  const localTop = top - baseTop;
  const fontSize = parseCssPixel(style.fontSize);

  return {
    ...style,
    left: `${documentLeft + localLeft * scaleX}px`,
    top: `${documentTop + localTop * scaleY}px`,
    ...(fontSize !== null ? { fontSize: `${Math.max(1, fontSize * scaleY)}px` } : {}),
    ...(typeof style.charHeight === 'number' ? { charHeight: style.charHeight * scaleY } : {}),
  };
}

function parseCssPixel(value: unknown) {
  if (typeof value !== 'string') return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function renderBenlaiControl(
  this: fabric.Control,
  ctx: CanvasRenderingContext2D,
  left: number,
  top: number,
  _styleOverride: unknown,
  fabricObject: fabric.FabricObject,
) {
  const size = Math.max(9, Number(this.sizeX || this.sizeY || fabricObject.cornerSize || 10));
  ctx.save();
  ctx.beginPath();
  ctx.arc(left, top, size / 2, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = selectionBlue;
  ctx.stroke();
  ctx.restore();
}

function applySelectionStyle(object: fabric.FabricObject) {
  object.set({
    ...selectionStyle,
    hasBorders: true,
    hasControls: true,
  });
  if (object.type === 'group') {
    object.set({ subTargetCheck: true } as Partial<fabric.Group>);
  }
  restoreTransparentHitTesting(object);

  const selectable = object as fabric.FabricObject & {
    forEachControl?: (callback: (control: fabric.Control, key: string, target: fabric.FabricObject) => void) => void;
    controls?: Record<string, fabric.Control>;
    forEachObject?: (callback: (child: fabric.FabricObject) => void) => void;
  };

  const isTextSelection = isTextObject(object);
  const patchControl = (control: fabric.Control, key?: string) => {
    const nextControl = control as fabric.Control & {
      sizeX?: number;
      sizeY?: number;
      touchSizeX?: number;
      touchSizeY?: number;
      withConnection?: boolean;
      visible?: boolean;
    };
    nextControl.render = renderBenlaiControl;
    nextControl.sizeX = 10;
    nextControl.sizeY = 10;
    nextControl.touchSizeX = 18;
    nextControl.touchSizeY = 18;
    nextControl.visible = !(isTextSelection && key === 'mt');
    if (key === 'mtr') nextControl.withConnection = false;
  };

  if (selectable.forEachControl) {
    selectable.forEachControl((control, key) => patchControl(control, key));
  } else if (selectable.controls) {
    Object.entries(selectable.controls).forEach(([key, control]) => patchControl(control, key));
  }

  const group = object as fabric.FabricObject & {
    forEachObject?: (callback: (child: fabric.FabricObject) => void) => void;
  };
  group.forEachObject?.((child) => applySelectionStyle(child));
  object.setCoords();
}

function restoreTransparentHitTesting(object: fabric.FabricObject) {
  const target = object as fabric.FabricObject & {
    type?: string;
    perPixelTargetFind?: boolean;
    targetFindTolerance?: number;
  };
  if (target.type !== 'group' && target.type !== 'activeSelection') {
    const isText =
      object instanceof fabric.IText ||
      object instanceof fabric.Textbox ||
      target.type === 'i-text' ||
      target.type === 'textbox' ||
      target.type === 'text';
    target.perPixelTargetFind = false;
    target.targetFindTolerance = isText ? 8 : 0;
  }
}

function isSelectableCandidate(object: fabric.FabricObject) {
  return object.visible !== false
    && object.selectable !== false
    && object.evented !== false
    && object.opacity !== 0
    && object.type !== 'activeSelection';
}

function hasVisiblePaint(object: fabric.FabricObject) {
  if ((object.opacity ?? 1) <= 0.03) return false;
  if (object.type === 'group') return true;
  if (isImageObject(object) || isTextObject(object)) return true;

  const target = object as fabric.FabricObject & {
    fill?: unknown;
    stroke?: unknown;
    strokeWidth?: number;
  };
  const fillAlpha = paintAlpha(target.fill);
  const strokeAlpha = paintAlpha(target.stroke);
  return fillAlpha > 0.03 || (strokeAlpha > 0.03 && Number(target.strokeWidth || 0) > 0);
}

function paintAlpha(value: unknown) {
  if (!value || value === 'none' || value === 'transparent') return 0;
  if (typeof value !== 'string') return 1;
  const color = value.trim().toLowerCase();
  if (!color || color === 'none' || color === 'transparent') return 0;
  const rgba = /rgba\([^,]+,[^,]+,[^,]+,\s*([.\d]+)\s*\)/.exec(color);
  if (rgba) return Number(rgba[1]) || 0;
  if (color === 'rgba(0,0,0,0)' || color === 'rgb(0 0 0 / 0%)') return 0;
  return 1;
}

function isTextObject(object: fabric.FabricObject) {
  return object instanceof fabric.IText
    || object instanceof fabric.Textbox
    || object.type === 'i-text'
    || object.type === 'textbox'
    || object.type === 'text';
}

function isImageObject(object: fabric.FabricObject) {
  return object.type === 'image' || object instanceof fabric.FabricImage;
}

function setHoveredCanvasObject(canvas: fabric.Canvas, object: fabric.FabricObject | null | undefined) {
  const nextId = object && isSelectableCandidate(object) && hasVisiblePaint(object)
    ? getSelectionId(object)
    : null;
  const store = useEditorStore.getState();
  if (store.hoveredObjectId === nextId) return;
  store.setHoveredObjectId(nextId);
}

function findCanvasHoverTargetFromEvent(canvas: fabric.Canvas, event: MouseEvent | PointerEvent | fabric.TPointerEvent) {
  const pointer = getCanvasScenePointFromEvent(canvas, event);
  if (pointer) {
    const point = new fabric.Point(pointer.x, pointer.y);
    const objects = canvas.getObjects();
    for (let i = objects.length - 1; i >= 0; i -= 1) {
      const target = findHoverTargetInObject(objects[i], point);
      if (target) return target;
    }
  }

  const nativeTarget = tryFindFabricNativeTarget(canvas, event);
  if (nativeTarget && isSelectableCandidate(nativeTarget) && hasVisiblePaint(nativeTarget)) return nativeTarget;
  return null;
}

function getCanvasScenePointFromEvent(
  canvas: fabric.Canvas,
  event: MouseEvent | PointerEvent | TouchEvent | fabric.TPointerEvent,
) {
  const rectPoint = getCanvasScenePointFromElementRect(canvas, event as MouseEvent | PointerEvent | TouchEvent);
  if (rectPoint) return rectPoint;

  try {
    const pointer = canvas.getPointer(event as fabric.TPointerEvent);
    if (Number.isFinite(pointer.x) && Number.isFinite(pointer.y)) {
      return { x: pointer.x, y: pointer.y };
    }
  } catch {
    // Safari can fail Fabric's offset path when canvas ancestors are transformed.
  }

  return null;
}

function getCanvasScenePointFromElementRect(
  canvas: fabric.Canvas,
  event: MouseEvent | PointerEvent | TouchEvent,
) {
  const clientPoint = getClientPointFromNativeEvent(event);
  const element = (canvas as NativeDragGuardCanvas).upperCanvasEl || getLowerCanvasElement(canvas);
  if (!clientPoint || !element) return null;
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const viewportPoint = new fabric.Point(
    ((clientPoint.x - rect.left) / rect.width) * canvas.getWidth(),
    ((clientPoint.y - rect.top) / rect.height) * canvas.getHeight(),
  );
  const viewportTransform = canvas.viewportTransform;
  if (!viewportTransform) return { x: viewportPoint.x, y: viewportPoint.y };
  const scenePoint = viewportPoint.transform(fabric.util.invertTransform(viewportTransform));
  return { x: scenePoint.x, y: scenePoint.y };
}

function tryFindFabricNativeTarget(canvas: fabric.Canvas, event: MouseEvent | PointerEvent | fabric.TPointerEvent) {
  const targetCanvas = canvas as fabric.Canvas & {
    findTarget?: (e: MouseEvent | PointerEvent | fabric.TPointerEvent) => fabric.FabricObject | null;
  };
  try {
    return targetCanvas.findTarget?.(event) || null;
  } catch {
    return null;
  }
}

function findHoverTargetInObject(object: fabric.FabricObject, point: fabric.Point): fabric.FabricObject | null {
  if (!object || object.visible === false) return null;
  const children = getFabricObjectChildren(object);
  for (let i = children.length - 1; i >= 0; i -= 1) {
    const target = findHoverTargetInObject(children[i], point);
    if (target) return target;
  }
  if (!isSelectableCandidate(object) || !hasVisiblePaint(object)) return null;
  return isPointInsideObjectForHover(object, point) ? object : null;
}

function getFabricObjectChildren(object: fabric.FabricObject): fabric.FabricObject[] {
  const target = object as fabric.FabricObject & {
    getObjects?: () => fabric.FabricObject[];
  };
  return typeof target.getObjects === 'function' ? target.getObjects().filter(Boolean) : [];
}

function isPointInsideObjectForHover(object: fabric.FabricObject, point: fabric.Point) {
  try {
    object.setCoords();
    if (typeof object.containsPoint === 'function' && object.containsPoint(point)) return true;
  } catch {
    // Fall back to bounding rect below.
  }

  const rect = object.getBoundingRect();
  if (!isFiniteRect(rect) || rect.width <= 0 || rect.height <= 0) return false;
  const target = object as fabric.FabricObject & { targetFindTolerance?: number };
  const padding = Math.max(0, Number(target.targetFindTolerance || object.padding || 0));
  return point.x >= rect.left - padding
    && point.x <= rect.left + rect.width + padding
    && point.y >= rect.top - padding
    && point.y <= rect.top + rect.height + padding;
}

function getHoverOverlayStyle(
  canvas: fabric.Canvas | null,
  hoveredObjectId: string | null,
  activeTool: ActiveTool,
): CSSProperties | null {
  if (!canvas || activeTool !== 'select' || !hoveredObjectId || isCanvasInteractionBusy(canvas)) return null;
  const object = findCanvasObjectByLayerId(canvas, hoveredObjectId);
  if (!object || !isSelectableCandidate(object) || !hasVisiblePaint(object)) return null;
  if (canvas.getActiveObjects().includes(object) || isEditingText(canvas)) return null;

  const rect = object.getBoundingRect();
  if (!isFiniteRect(rect) || rect.width <= 0 || rect.height <= 0) return null;
  const canvasWidth = canvas.getWidth();
  const canvasHeight = canvas.getHeight();
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(canvasWidth, rect.left + rect.width);
  const bottom = Math.min(canvasHeight, rect.top + rect.height);
  if (right <= left || bottom <= top) return null;

  return {
    position: 'absolute',
    left,
    top,
    width: right - left,
    height: bottom - top,
    border: '1px dashed #5FA8FF',
    boxSizing: 'border-box',
    pointerEvents: 'none',
    zIndex: 4,
  };
}

function isFiniteRect(rect: { left: number; top: number; width: number; height: number }) {
  return Number.isFinite(rect.left)
    && Number.isFinite(rect.top)
    && Number.isFinite(rect.width)
    && Number.isFinite(rect.height);
}

function isCanvasInteractionBusy(canvas: fabric.Canvas) {
  const target = canvas as fabric.Canvas & {
    _currentTransform?: unknown;
    _groupSelector?: unknown;
    isDrawingMode?: boolean;
  };
  return !!target._currentTransform || !!target._groupSelector || target.isDrawingMode === true;
}

function findCanvasObjectByLayerId(canvas: fabric.Canvas, layerId: string) {
  const objects = canvas.getObjects();
  for (let i = objects.length - 1; i >= 0; i -= 1) {
    const object = findObjectByLayerId(objects[i], layerId);
    if (object) return object;
  }
  return null;
}

function findObjectByLayerId(object: fabric.FabricObject, layerId: string): fabric.FabricObject | null {
  if (getObjectLayerId(object) === layerId) return object;
  const children = getFabricObjectChildren(object);
  for (let i = children.length - 1; i >= 0; i -= 1) {
    const target = findObjectByLayerId(children[i], layerId);
    if (target) return target;
  }
  return null;
}

function getObjectLayerId(object: fabric.FabricObject | null | undefined) {
  return object ? String((object as fabric.FabricObject & { _layerId?: string | number })._layerId || '') : '';
}

function isEditingText(canvas: fabric.Canvas) {
  const active = canvas.getActiveObject() as fabric.FabricObject & { isEditing?: boolean } | undefined;
  return active?.isEditing === true;
}

function hasPressedPointerButton(event: fabric.TPointerEvent) {
  const pointerEvent = event as MouseEvent | PointerEvent;
  return typeof pointerEvent.buttons === 'number' && pointerEvent.buttons !== 0;
}

function getSelectionId(object: fabric.FabricObject) {
  const target = object as fabric.FabricObject & { _layerId?: string | number };
  if (!target._layerId) {
    target._layerId = `layer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
  return String(target._layerId);
}

const workspaceStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  overflow: 'auto',
  overflowAnchor: 'none',
  background: '#ecece5',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 48,
};

const canvasShellStyle: CSSProperties = {
  position: 'relative',
  flex: '0 0 auto',
  overflow: 'hidden',
  background: '#fff',
  boxShadow: [
    '0 0 0 1px rgba(15, 23, 42, 0.04)',
    '0 0 24px rgba(15, 23, 42, 0.12)',
    '0 14px 36px rgba(15, 23, 42, 0.16)',
  ].join(', '),
};

const hiddenHoverOverlayStyle: CSSProperties = {
  position: 'absolute',
  display: 'none',
  pointerEvents: 'none',
};
