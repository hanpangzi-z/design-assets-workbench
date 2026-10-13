import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Spin, message } from 'antd';
import { Circle as CircleIcon, Minus, Square, Triangle as TriangleIcon } from 'lucide-react';
import * as fabric from 'fabric';
import EditorToolbar from '@/editor/EditorToolbar';
import EditorCanvas from '@/editor/EditorCanvas';
import ToolRail, { type EditorPanelKey } from '@/editor/ToolRail';
import BoardSwitcher from '@/editor/BoardSwitcher';
import useEditorHotkeys from '@/editor/hooks/useEditorHotkeys';
import { DEFAULT_CN_EDIT_FONT_FAMILY, DEFAULT_CN_EDIT_FONT_NAME } from '@/editor/fontDefaults';
import {
  loadPersistedEditorStateIntoFabricCanvas,
  serializeFabricCanvasToFabricJson,
} from '@/editor/engine/fabricDocument';
import {
  isCanvasVisuallyLost,
  repairCanvasObjectsNearScene,
  validateCanvasStateBeforePersist,
} from '@/editor/canvasBounds';
import {
  extractPsdRunFillColor,
  getDominantPsdRunFillColor,
  sampleFabricImageDominantOpaqueColor,
} from '@/editor/utils/psdTextColor';
import useEditorStore, { type ActiveTool } from '@/store/editorStore';
import { HISTORY_RESTORED_EVENT } from '@/editor/history';
import useEditorWorkspaceStore, {
  createDraftId,
  getDraftBoardKey,
  getFileBoardKey,
  makeDraftOpenBoard,
  makeOpenBoardFromFile,
  readDraftCanvasState,
  removeDraftCanvasState,
  writeDraftCanvasState,
  type EditorOpenBoard,
} from '@/store/editorWorkspaceStore';
import { downloadFileBlob, getFileById, saveEditorState, submitClientParseAssist, useTemplate } from '@/api/files';
import api from '@/api/index';
import type { DesignFile, ParsedLayer } from 'shared/types';
import { canGenerateClientParseAssist, generateClientParseAssist } from '@/utils/clientParseAssist';
import { getParseAssetRevision, parseFreshnessMatches, refreshOwnedSavedAssetRevisions, shouldWaitForParseFreshness, withUploadAssetRevision } from '@/utils/parseFreshness';
import parserVersions from 'shared/parserVersions.json';
import { installPsdScene, restorePsdScene } from '@/editor/psdSceneRenderer';
import { createPsdSimpleShape } from '@/editor/psdSimpleShape';
import {
  applyPsdVisibilityState,
  collectPsdLeafLayers,
  copyPsdSourceMetadata,
  getPsdEditableSourceTextOptions,
  mergePsdDiagnostics,
  normalizePsdDiagnostics,
  psdLayerSourceKey,
  resetPsdCanvasScene,
  PSD_SOURCE_CUSTOM_PROPERTIES,
  type PsdImportCanvas,
  type PsdImportDiagnostic,
} from '@/editor/psdImportState';

const TemplatePanel = React.lazy(() => import('@/editor/TemplatePanel'));
const MyTemplatePanel = React.lazy(() => import('@/editor/MyTemplatePanel'));
const LayerPanel = React.lazy(() => import('@/editor/LayerPanel'));
const RightPanel = React.lazy(() => import('@/editor/RightPanel'));

const EDITOR_IMAGE_LOAD_TIMEOUT_MS = 12000;

const fabricObjectClass = fabric.FabricObject as unknown as { customProperties?: string[] };
fabricObjectClass.customProperties = Array.from(new Set([
  ...(fabricObjectClass.customProperties || []),
  ...PSD_SOURCE_CUSTOM_PROPERTIES,
  '_layerId',
  '_layerName',
  '_layerType',
  '_psdFontName',
  '_psdAutoScaleX',
  '_psdMissingFont',
  '_psdTextPreview',
  '_psdTextContent',
  '_psdTextIsAreaText',
  '_psdTextOrientation',
  '_psdTextOptions',
  '_psdLayerBounds',
  '_psdPreviewVisualBounds',
  '_psdClipping',
  '_psdInvisibleHitArea',
  '_psdImportedTextPreview',
  '_psdIgnorePreviewColor',
  '_psdCanvasBackground',
  '_psdLocked',
  '_pdfRasterBackground',
  '_pdfSourceRasterImage',
  '_pdfPageRasterUnderlay',
  '_pdfRasterFallbackEditable',
  '_pdfPageCompositeId',
  '_pdfPageCompositeRole',
  '_pdfPageCompositeBaseMatrix',
  '_pdfPageCompositeLastMatrix',
  '_pdfPageLocalBounds',
  '_pdfPreviewFallback',
  '_pdfPreviewOnlyBackground',
  '_pdfPreviewOnlyPage',
  '_pdfPreviewOnlyPath',
  '_pdfVisualBacking',
  '_pdfAuxiliaryImageRole',
  '_pdfImportPlaceholder',
  '_pdfMaskArtifact',
  '_pdfTextPath',
  '_pdfTextGlyphId',
  '_pdfTextBounds',
  '_pdfTextRunId',
  '_pdfTextGlyphIndex',
  '_pdfTextWritingMode',
  '_pdfTextMatrix',
  '_pdfTextRotation',
  '_pdfSourceTextActivation',
  '_pdfSourceTextActivated',
  '_pdfSourceTextBackgroundPatch',
  '_pdfSourceTextBackgroundPatchVersion',
  '_pdfSourceTextGlyphIds',
  '_pdfSourceTextHiddenByLayerIds',
  '_pdfSourceTextOptions',
  '_svgImportedAtom',
  '_svgObjectRole',
  '_svgDecorationClusterId',
  '_svgDecorationGroup',
  '_svgDecorationGroupId',
  '_svgDecorationGroupName',
  '_svgDecorationProxy',
  '_svgDecorationMember',
  '_svgDecorationMemberIndex',
  '_svgDecorationBaseOpacity',
  '_svgDecorationVisualOnly',
]));

type ShapeTool = 'rect' | 'ellipse' | 'triangle' | 'line';
type CanvasPoint = { x: number; y: number };
type FabricPointerInfo = fabric.TPointerEventInfo<fabric.TPointerEvent>;
type PendingImportImage = {
  src: string;
  name?: string;
  width?: number;
  height?: number;
};
type PsdLayerBounds = {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
};
type PsdTextPreviewImage = fabric.FabricImage & {
  _psdTextPreview?: boolean;
  _psdInvisibleHitArea?: boolean;
  _psdImportedTextPreview?: boolean;
  _psdIgnorePreviewColor?: boolean;
  _psdTextContent?: string;
  _psdTextIsAreaText?: boolean;
  _psdTextOrientation?: string;
  _psdTextOptions?: Record<string, unknown>;
  _psdLayerBounds?: PsdLayerBounds;
  _psdPreviewVisualBounds?: PixelBounds;
  _psdClipping?: boolean;
  _psdLocked?: boolean;
  _psdFontName?: string;
  _psdMissingFont?: boolean;
  _layerId?: unknown;
  _layerName?: unknown;
  _layerType?: unknown;
};
type PdfSourceTextActivationObject = fabric.Rect & {
  _pdfSourceTextActivation?: boolean;
  _pdfSourceTextActivated?: boolean;
  _pdfPageCompositeId?: string;
  _pdfPageCompositeRole?: PdfPageCompositeRole;
  _pdfPageLocalBounds?: PsdLayerBounds;
  _pdfSourceTextGlyphIds?: string[];
  _pdfSourceTextOptions?: Record<string, unknown>;
  _psdLocked?: boolean;
  _psdTextContent?: string;
  _psdTextOrientation?: string;
  _psdTextOptions?: Record<string, unknown>;
  _psdLayerBounds?: PsdLayerBounds;
  _psdPreviewVisualBounds?: PixelBounds;
  _psdFontName?: string;
  _layerId?: unknown;
  _layerName?: unknown;
};
type PdfPageCompositeRole = 'underlay' | 'text-activation' | 'activated-text' | 'background-patch';
type PdfPageCompositeObject = fabric.FabricObject & {
  _pdfPageCompositeId?: string;
  _pdfPageCompositeRole?: PdfPageCompositeRole;
  _pdfPageCompositeBaseMatrix?: number[];
  _pdfPageCompositeLastMatrix?: number[];
  _pdfPageLocalBounds?: PsdLayerBounds;
  _pdfPageRasterUnderlay?: boolean;
  _pdfRasterFallbackEditable?: boolean;
  _psdLayerBounds?: PsdLayerBounds;
  _psdPreviewVisualBounds?: PixelBounds;
  _psdLocked?: boolean;
};
type PsdClipBaseMap = Map<string, fabric.FabricObject>;
type HistoryAwareCanvas = fabric.Canvas & {
  __suspendHistory?: boolean;
};
type EditorCanvasOwner = {
  fileId: number | null;
  sourceFileId: number | null;
  pageNumber: number;
  generation: number;
  draftId: string | null;
};
type PendingTemplateSelection = {
  template: DesignFile;
  origin: 'marketplace' | 'mine';
};
type OwnedFabricCanvas = fabric.Canvas & {
  __suspendHistory?: boolean;
  __bulkLoading?: boolean;
  __benlaiCanvasOwner?: EditorCanvasOwner;
};
type SvgObjectRole =
  | 'editable-vector'
  | 'editable-raster'
  | 'visual-raster'
  | 'text-outline'
  | 'raster-reconstruction-strip'
  | 'mask-artifact'
  | 'decoration-vector'
  | 'decoration-gradient-strip'
  | 'decoration-texture-fill'
  | 'decoration-effect-raster'
  | 'preview-fallback'
  | 'raster-image';

type SvgDecorationLinkedObject = fabric.FabricObject & {
  _svgDecorationClusterId?: string;
  _svgDecorationGroupId?: string;
  _svgDecorationGroupName?: string;
  _svgDecorationProxy?: boolean;
  _svgDecorationMember?: boolean;
  _svgDecorationMemberIndex?: number;
  _svgDecorationBaseOpacity?: number;
  _svgDecorationVisualOnly?: boolean;
  _svgDecorationLastMatrix?: number[];
  _svgObjectRole?: SvgObjectRole;
  _svgLayerName?: string;
  _pdfSourceTextHiddenByLayerIds?: string[];
  _psdLocked?: boolean;
};

const MISSING_PSD_TEXT_EDIT_FONT_FAMILY = DEFAULT_CN_EDIT_FONT_FAMILY;
const CURRENT_AI_PARSER_VERSION = parserVersions.ai;
const CURRENT_PDF_PARSER_VERSION = parserVersions.pdf;
const IMPORTED_TEXT_PREVIEW_MODE_VERSION = 6;
const IMPORTED_SVG_ROLE_MODEL_VERSION = 39;
const EDITOR_STATE_OWNER_VERSION = 1;
const PDF_SOURCE_TEXT_BACKGROUND_PATCH_VERSION = 2;
const SVG_VECTOR_ATOM_ROLE = 'svg-vector-atom';
const SVG_VECTOR_SUMMARY_ROLE = 'svg-vector-summary';
const SVG_DECORATION_GROUP_ROLE = 'svg-decoration-group';
const SVG_VECTOR_ATOM_FOLD_THRESHOLD = 24;
const SVG_VECTOR_SUMMARY_LAYER_ID = -1000000002;

function toolCursor(tool: ActiveTool, shape: ShapeTool) {
  void shape;
  if (tool === 'text') return 'text';
  if (tool === 'shape') return 'crosshair';
  if (tool === 'hand') return 'grab';
  return 'default';
}

function applyCanvasCursor(canvas: fabric.Canvas, cursor: string, hoverCursor = cursor, moveCursor = cursor) {
  const target = canvas as fabric.Canvas & {
    hoverCursor?: string;
    moveCursor?: string;
    upperCanvasEl?: HTMLCanvasElement;
    wrapperEl?: HTMLElement;
  };
  canvas.defaultCursor = cursor;
  target.hoverCursor = hoverCursor;
  target.moveCursor = moveCursor;
  try {
    const lowerCanvas = canvas.getElement();
    if (lowerCanvas?.style) lowerCanvas.style.cursor = cursor;
  } catch {
    // Fabric may already have disposed the canvas while switching templates/routes.
  }
  if (target.upperCanvasEl?.style) target.upperCanvasEl.style.cursor = cursor;
  if (target.wrapperEl?.style) target.wrapperEl.style.cursor = cursor;
}

// 加载自定义字体 CSS
// 标记自定义字体 CSS 是否已经加载完成（@font-face 都进了 document.fonts），
// 后续任何 waitForCanvasFont / 文字渲染都会等这个 promise resolve 之后再开始测量。
let customFontsReady: Promise<void> | null = null;
function ensureCustomFontsLoaded(): Promise<void> {
  if (customFontsReady) return customFontsReady;
  customFontsReady = new Promise<void>((resolve) => {
    if (typeof document === 'undefined') {
      resolve();
      return;
    }
    const linkId = 'custom-fonts-css';
    const cssHref = '/api/v1/fonts/css';
    let link = document.getElementById(linkId) as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement('link');
      link.id = linkId;
      link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
    if (link.href !== new URL(cssHref, window.location.origin).href) {
      link.href = cssHref;
    }
    // 兜底：3 秒超时也算「ready」，否则字体下载慢会卡死渲染
    const timeout = window.setTimeout(() => resolve(), 3000);
    const onDone = () => {
      window.clearTimeout(timeout);
      // 让浏览器把 @font-face 真正解析进 FontFaceSet
      if ((document as Document).fonts && (document.fonts as FontFaceSet).ready) {
        (document.fonts as FontFaceSet).ready.then(() => resolve(), () => resolve());
      } else {
        resolve();
      }
    };
    if (link.sheet) {
      onDone();
    } else {
      link.addEventListener('load', onDone, { once: true });
      link.addEventListener('error', onDone, { once: true });
    }
  });
  return customFontsReady;
}

function useCustomFonts() {
  useEffect(() => {
    void ensureCustomFontsLoaded();
  }, []);
}

export default function EditorPage() {
  useCustomFonts();
  const navigate = useNavigate();
  const location = useLocation();
  const { fileId: fileIdParam } = useParams<{ fileId: string }>();
  const [searchParams] = useSearchParams();
  const generatedDraftIdRef = useRef(createDraftId());

  const setFileId = useEditorStore((s) => s.setFileId);
  const setCanvasSize = useEditorStore((s) => s.setCanvasSize);
  const setActiveTool = useEditorStore((s) => s.setActiveTool);
  const engine = useEditorStore((s) => s.engine);
  const canvas = useEditorStore((s) => s.canvas);
  const activeTool = useEditorStore((s) => s.activeTool);
  const zoom = useEditorStore((s) => s.zoom);
  const canvasWidth = useEditorStore((s) => s.canvasWidth);
  const canvasHeight = useEditorStore((s) => s.canvasHeight);
  const openBoards = useEditorWorkspaceStore((s) => s.boards);
  const upsertOpenBoard = useEditorWorkspaceStore((s) => s.upsertBoard);
  const updateOpenBoard = useEditorWorkspaceStore((s) => s.updateBoard);
  const removeOpenBoard = useEditorWorkspaceStore((s) => s.removeBoard);

  const [activePanel, setActivePanel] = useState<EditorPanelKey>('templates');
  const [layers, setLayers] = useState<ParsedLayer[]>([]);
  // PSD 解析时收集到的字体名 → 是否在已上传字体里命中。
  // null = 还没查 / 没解析出字体；空数组 = 都齐了；非空 = 这些 PSD 字体没装到画布端。
  const [missingFonts, setMissingFonts] = useState<string[] | null>(null);
  const [resolvedFontMap, setResolvedFontMap] = useState<Record<string, string>>({});
  const [fileName, setFileName] = useState('');
  const [fileData, setFileData] = useState<DesignFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [contentLoaded, setContentLoaded] = useState(false);
  const [previewLoadError, setPreviewLoadError] = useState<string | null>(null);
  const [emptyPdfStateReview, setEmptyPdfStateReview] = useState<{ fileId: number; sourceFileId: number | null; pageNumber: number; generation: number } | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [parseReloadKey, setParseReloadKey] = useState(0);
  const [parseRetrying, setParseRetrying] = useState(false);
  const [failedCanvasUnavailable, setFailedCanvasUnavailable] = useState(false);
  const [psdDiagnostics, setPsdDiagnostics] = useState<PsdImportDiagnostic[]>([]);
  const [psdSourcePreview, setPsdSourcePreview] = useState(false);
  const [textFontSize] = useState(28);
  const [textFill] = useState('#141413');
  const [shapeTool, setShapeTool] = useState<ShapeTool>('rect');
  const [shapeFill] = useState('#EAF4F2');
  const [shapeStroke] = useState('#1A6B6B');
  const [shapeStrokeWidth] = useState(0);
  const [shapeRadius] = useState(0);
  const [pendingTemplate, setPendingTemplate] = useState<PendingTemplateSelection | null>(null);
  const [templatePlacementLoading, setTemplatePlacementLoading] = useState<'replace' | 'append' | null>(null);
  const contentLoadingRef = useRef(false);
  const canvasGenerationRef = useRef(0);
  const canvasOwnerRef = useRef<EditorCanvasOwner | null>(null);
  const canvasLoadQueueRef = useRef<Promise<void>>(Promise.resolve());
  const ownerMismatchWarnedRef = useRef(false);
  const parseAssistSubmittedRef = useRef(new Set<string>());
  const drawingShapeRef = useRef<{ object: fabric.FabricObject; start: CanvasPoint; shape: ShapeTool } | null>(null);
  const verticalTextRepairKeyRef = useRef<string | null>(null);

  const activateShapeTool = useCallback((nextShape: ShapeTool) => {
    if (!canvas && engine) {
      engine.addShape(nextShape);
      setActiveTool('select');
      return;
    }
    setShapeTool(nextShape);
    setActiveTool('shape');
  }, [canvas, engine, setActiveTool]);

  const addNativeText = useCallback(() => {
    if (!canvas && engine) {
      engine.addText('双击编辑文字');
      setActiveTool('select');
      return;
    }
    setActiveTool('text');
  }, [canvas, engine, setActiveTool]);

  const isNewCanvas = fileIdParam === 'new';
  const numericFileId = isNewCanvas ? null : parseInt(fileIdParam || '', 10);
  const importImagesRequested = searchParams.get('importImages') === '1';
  const newCanvasWidth = searchParams.get('w') || '1080';
  const newCanvasHeight = searchParams.get('h') || '1080';
  const newCanvasName = searchParams.get('name') || '未命名画布';
  const draftIdParam = searchParams.get('draftId');
  const activeDraftId = isNewCanvas ? (draftIdParam || generatedDraftIdRef.current) : null;
  const routePageNumber = parsePositiveInt(searchParams.get('page') || '1', 1);
  const activeBoardKey = isNewCanvas && activeDraftId
    ? getDraftBoardKey(activeDraftId)
    : numericFileId && !isNaN(numericFileId)
      ? getFileBoardKey(numericFileId, routePageNumber)
      : null;

  useEffect(() => {
    if (!canvas) return;
    const refreshPsdState = () => {
      const source = canvas as PsdImportCanvas;
      setPsdSourcePreview(source.__psdSceneSession?.getSourcePreview?.() ?? Boolean((source.__psdScene as { sourcePreview?: boolean } | undefined)?.sourcePreview));
      const diagnostics = source.__psdSceneSession?.getDiagnostics?.();
      if (diagnostics) setPsdDiagnostics((previous) => mergePsdDiagnostics(previous, diagnostics));
    };
    const refreshPsdPreview = () => setPsdSourcePreview((canvas as PsdImportCanvas).__psdSceneSession?.getSourcePreview?.() ?? false);
    (canvas as any).on(HISTORY_RESTORED_EVENT, refreshPsdState);
    canvas.on('after:render', refreshPsdPreview);
    return () => { (canvas as any).off(HISTORY_RESTORED_EVENT, refreshPsdState); canvas.off('after:render', refreshPsdPreview); };
  }, [canvas]);

  useEffect(() => {
    if (!isNewCanvas || draftIdParam || !activeDraftId) return;
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('draftId', activeDraftId);
    navigate(`/editor/new?${nextParams.toString()}`, { replace: true });
  }, [activeDraftId, draftIdParam, isNewCanvas, navigate, searchParams]);

  // 1. 加载文件数据
  useEffect(() => {
    let cancelled = false;
    const pollAbort = new AbortController();
    let pollTimer: number | undefined;
    let cancelPollWait: (() => void) | undefined;
    const generation = ++canvasGenerationRef.current;
    const routeOwner: EditorCanvasOwner = {
      fileId: numericFileId && !isNaN(numericFileId) ? numericFileId : null,
      sourceFileId: null,
      pageNumber: routePageNumber,
      generation,
      draftId: activeDraftId,
    };
    canvasOwnerRef.current = routeOwner;
    ownerMismatchWarnedRef.current = false;
    const isCurrentGeneration = () => !cancelled && canvasGenerationRef.current === generation;

    // 切换模板时重置状态
    useEditorStore.getState().resetHistory();
    setContentLoaded(false);
    setPreviewLoadError(null);
    setEmptyPdfStateReview(null);
    setContentLoading(false);
    setParseRetrying(false);
    setFailedCanvasUnavailable(false);
    setPsdDiagnostics([]);
    setPsdSourcePreview(false);
    contentLoadingRef.current = false;
    setFileData(null);
    setLayers([]);
    setLoading(true);
    const liveCanvas = useEditorStore.getState().canvas as
      | (OwnedFabricCanvas & { contextContainer?: unknown })
      | null;
    if (liveCanvas && liveCanvas.contextContainer) {
      liveCanvas.__benlaiCanvasOwner = routeOwner;
      liveCanvas.__suspendHistory = true;
      resetPsdCanvasScene(liveCanvas as PsdImportCanvas);
      liveCanvas.clear();
      liveCanvas.backgroundColor = '#ffffff';
      liveCanvas.renderAll();
      window.setTimeout(() => {
        if (liveCanvas.__benlaiCanvasOwner?.generation === generation) {
          liveCanvas.__suspendHistory = false;
        }
      }, 0);
    }

    if (isNewCanvas) {
      const draftState = activeDraftId ? readDraftCanvasState(activeDraftId) : null;
      setCanvasSize(
        draftState?.width || parseInt(newCanvasWidth, 10),
        draftState?.height || parseInt(newCanvasHeight, 10)
      );
      setFileName(draftState?.name || newCanvasName);
      setFileId(null);
      setLoading(false);
      return;
    }
    if (!numericFileId || isNaN(numericFileId)) { setLoading(false); return; }
    setFileId(numericFileId);

    (async () => {
      try {
        const readFile = async (id: number) => {
          const response = await api.get<{ data: DesignFile }>(`/files/${id}`, { signal: pollAbort.signal });
          return response.data.data;
        };
        const waitForPoll = (delay: number) => new Promise<boolean>((resolve) => {
          cancelPollWait = () => resolve(false);
          pollTimer = window.setTimeout(() => {
            pollTimer = undefined;
            cancelPollWait = undefined;
            resolve(true);
          }, delay);
        });
        const waitForParsedFile = async (initialFile: DesignFile) => {
          let next = initialFile;
          const startedAt = Date.now();
          while (['psd', 'psb', 'ai', 'pdf'].includes(next.fileType) && shouldWaitForParseFreshness(next)) {
            if (!isCurrentGeneration()) return next;
            if (!await waitForPoll(Date.now() - startedAt < 210_000 ? 2000 : 5000)) return next;
            if (!isCurrentGeneration()) return next;
            next = await readFile(initialFile.id);
            if (!isCurrentGeneration()) return next;
            setFileData(next);
            const page = getParsedDocumentPage(next, routePageNumber);
            if (page?.width || next.width) {
              setCanvasSize(page?.width || next.width || 1080, page?.height || next.height || 1080);
            }
          }
          return next;
        };
        const editableFile = await readFile(numericFileId);
        if (!isCurrentGeneration()) return;
        if (!editableFile.isPersonalCopy && editableFile.parseStatus !== 'failed') {
          const personalCopy = await useTemplate(editableFile.id);
          if (isCurrentGeneration()) navigate(`/editor/${personalCopy.id}`, { replace: true });
          return;
        }

        const contentFileId = editableFile.id;
        const fileOwner: EditorCanvasOwner = {
          ...routeOwner,
          sourceFileId: editableFile.sourceFileId || null,
        };
        canvasOwnerRef.current = fileOwner;
        const currentCanvas = useEditorStore.getState().canvas as OwnedFabricCanvas | null;
        if (currentCanvas?.__benlaiCanvasOwner?.generation === generation) {
          currentCanvas.__benlaiCanvasOwner = fileOwner;
        }

        let file = editableFile;
        setFileData(file);
        setFileName(file.name);
        const initialPage = getParsedDocumentPage(file, routePageNumber);
        setCanvasSize(initialPage?.width || file.width || 1080, initialPage?.height || file.height || 1080);
        if (shouldSubmitClientParseAssist(file)) {
          submitClientParseAssistOnce(contentFileId, file, parseAssistSubmittedRef.current);
        }

        file = await waitForParsedFile(file);
        if (!isCurrentGeneration()) return;

        if (
          !file.parseFreshness && file.parseStatus === 'completed'
          && (
            (isPsdFileType(file.fileType) && !normalizeEditorState(file.editorState) && !hasPsdLayerEffectMetadata(file.parseResult))
            ||
            (file.fileType === 'ai' && !hasAiEditableMetadata(file.parseResult))
          )
        ) {
          try {
            submitClientParseAssistOnce(contentFileId, file, parseAssistSubmittedRef.current);
            await api.post(`/files/${contentFileId}/parse`, undefined, { signal: pollAbort.signal });
            if (!isCurrentGeneration()) return;
            file = await readFile(contentFileId);
            if (!isCurrentGeneration()) return;
            setFileData(file);
            file = await waitForParsedFile(file);
          } catch {
            // 没有编辑权限时沿用当前可解析图层，预览图层会在加载时过滤。
          }
        }

        if (!isCurrentGeneration()) return;
        let loadedLayers: ParsedLayer[] = [];
        while (isCurrentGeneration()) {
          if (file.parseStatus === 'failed' && file.parseResult?.hasRetainedResult !== true) break;
          const res = await api.get(`/files/${contentFileId}/layers`, {
            signal: pollAbort.signal,
            params: file.parseFreshness?.revision ? { expectedParseRevision: file.parseFreshness.revision } : undefined,
          });
          if (!isCurrentGeneration()) return;
          if (parseFreshnessMatches(file.parseFreshness, res.data?.parseFreshness)) {
            if (!Array.isArray(res.data?.data)) throw new Error('图层响应无效，请重新加载。');
            loadedLayers = res.data.data;
            break;
          }
          if (!await waitForPoll(250) || !isCurrentGeneration()) return;
          file = await readFile(contentFileId);
          if (!isCurrentGeneration()) return;
          setFileData(file);
          file = await waitForParsedFile(file);
        }
        if (!isCurrentGeneration()) return;
        setFileData(file);

        const loadedPage = getParsedDocumentPage(file, routePageNumber);
        setCanvasSize(loadedPage?.width || file.width || 1080, loadedPage?.height || file.height || 1080);

        // PSD 解析时存在 file.parseResult.usedFonts 里的字体名清单，
        // 这里跟服务端「已上传字体」做匹配，把缺失字体提示给用户。
        try {
          const parseResult = (file as DesignFile).parseResult as Record<string, unknown> | undefined;
          const usedFonts = Array.isArray(parseResult?.usedFonts)
            ? (parseResult!.usedFonts as string[])
            : [];
          if (usedFonts.length > 0) {
            const matchRes = await api
              .get(`/fonts/match`, { params: { names: usedFonts.join(',') } })
              .catch(() => null);
            if (!cancelled && matchRes?.data?.data) {
              const missing = (matchRes.data.data.missing as string[]) || [];
              const resolved = (matchRes.data.data.resolved as Record<string, string>) || {};
              setMissingFonts(missing);
              setResolvedFontMap(resolved);
              if (missing.length > 0) {
                console.warn('[Editor] PSD 用到但未上传的字体:', missing);
              }
            } else if (!cancelled) {
              setMissingFonts([]);
              setResolvedFontMap({});
            }
          } else {
            setMissingFonts([]);
            setResolvedFontMap({});
          }
        } catch (e) {
          console.warn('[Editor] 字体匹配失败（忽略）:', e);
          if (!cancelled) {
            setMissingFonts([]);
            setResolvedFontMap({});
          }
        }
        if (!cancelled) setLayers(loadedLayers);
      } catch (err) {
        if (!cancelled) {
          console.error('文件加载失败:', err);
          const status = (err as { response?: { status?: number } })?.response?.status;
          if (status === 404) {
            message.error('该文件不存在或已被删除');
            navigate('/', { replace: true });
            return;
          }
          if (status === 403) {
            message.error('没有权限访问此文件');
            navigate('/', { replace: true });
            return;
          }
          if (status === 409) {
            message.error((err as any)?.response?.data?.message || '文件加载失败，请稍后重试');
            navigate('/', { replace: true });
            return;
          }
          message.error('文件加载失败，请稍后重试');
          setFileData(null);
          setLayers([]);
          setPreviewLoadError('文件或图层读取失败，请重新加载。');
        }
      }
      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
      pollAbort.abort();
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
      cancelPollWait?.();
    };
  }, [fileIdParam, navigate, importImagesRequested, newCanvasWidth, newCanvasHeight, newCanvasName, activeDraftId, routePageNumber, parseReloadKey]);

  useEffect(() => {
    if (loading) return;
    const route = `${location.pathname}${location.search}`;
    if (fileData?.id) {
      if (!isNewCanvas && numericFileId === fileData.id) {
        const documentPages = getParsedDocumentPages(fileData);
        if (documentPages.length > 1) {
          documentPages.forEach((page) => {
            upsertOpenBoard(makeDocumentPageOpenBoard(fileData, page, documentPages.length));
          });
        } else {
          upsertOpenBoard(makeOpenBoardFromFile(fileData, route));
        }
      }
      return;
    }

    if (isNewCanvas && activeDraftId) {
      const draftState = readDraftCanvasState(activeDraftId);
      const width = draftState?.width || parsePositiveInt(newCanvasWidth, 1080);
      const height = draftState?.height || parsePositiveInt(newCanvasHeight, 1080);
      upsertOpenBoard(makeDraftOpenBoard({
        draftId: activeDraftId,
        route,
        name: draftState?.name || newCanvasName,
        width,
        height,
        previewDataUrl: draftState?.previewDataUrl,
      }));
    }
  }, [
    activeDraftId,
    fileData,
    isNewCanvas,
    loading,
    location.pathname,
    location.search,
    newCanvasHeight,
    newCanvasName,
    newCanvasWidth,
    numericFileId,
    routePageNumber,
    upsertOpenBoard,
  ]);

  // 2. 加载内容到画布 — 用 useCallback + 手动调用避免 ref 问题
  const loadContent = useCallback(async (expectedGeneration: number) => {
    if (!canvas || !fileData || contentLoaded) return;
    const expectedOwner = canvasOwnerRef.current;
    if (
      !expectedOwner
      || expectedOwner.generation !== expectedGeneration
      || expectedOwner.fileId !== fileData.id
      || expectedOwner.pageNumber !== routePageNumber
    ) return;
    if (contentLoadingRef.current) return;
    if (isPsdFileType(fileData.fileType) && missingFonts === null) return;
    contentLoadingRef.current = true;
    setContentLoading(true);
    const editorCanvas = canvas as OwnedFabricCanvas & {
      renderOnAddRemove?: boolean;
    };
    editorCanvas.__benlaiCanvasOwner = expectedOwner;
    const isCurrentLoad = () => {
      const owner = editorCanvas.__benlaiCanvasOwner;
      return canvasGenerationRef.current === expectedGeneration
        && owner?.generation === expectedGeneration
        && owner.fileId === fileData.id
        && owner.pageNumber === routePageNumber;
    };
    const previousRenderOnAddRemove = editorCanvas.renderOnAddRemove;
    editorCanvas.__suspendHistory = true;
    editorCanvas.__bulkLoading = true;
    editorCanvas.renderOnAddRemove = false;
    let initialLoadFinished = false;
    let initialLoadAborted = false;
    let previewOnlyLoadFailed = false;
    let pdfSceneCompletionVersion: 1 | 2 | undefined;
    const finishInitialCanvasLoad = () => {
      if (initialLoadFinished) return;
      initialLoadFinished = true;
      editorCanvas.renderOnAddRemove = previousRenderOnAddRemove ?? true;
      editorCanvas.__bulkLoading = false;
      if (!isCurrentLoad()) {
        contentLoadingRef.current = false;
        return;
      }
      editorCanvas.__suspendHistory = false;
      canvas.requestRenderAll();
      contentLoadingRef.current = false;
      if (['pdf', 'ai'].includes(fileData.fileType)) {
        if (!pdfSceneCompletionVersion) {
          previewOnlyLoadFailed = true;
          setPreviewLoadError('页面未完成有效加载，请手动重新解析。');
          setContentLoading(false);
          return;
        }
        (editorCanvas as any).__benlaiPdfSceneLoadedVersion = Number(fileData.parseResult?.pdfParserVersion ?? fileData.parseResult?.aiParserVersion) || undefined;
        (editorCanvas as any).__benlaiPdfSceneCompleteVersion = pdfSceneCompletionVersion;
      }
      setContentLoaded(true);
      setContentLoading(false);
      useEditorStore.getState().resetHistory(createHistorySnapshot(canvas));
      useEditorStore.getState().setDirty(false);
    };
    const finishVerifiedCanvasLoad = async () => {
      if (initialLoadFinished || initialLoadAborted) return;
      if (!isCurrentLoad()) { initialLoadAborted = true; return; }
      if (['psd', 'psb', 'ai', 'pdf'].includes(fileData.fileType)) {
        try {
          const response = await api.get(`/files/${fileData.id}/parse-status`);
          if (!isCurrentLoad()) { initialLoadAborted = true; return; }
          const status = response.data?.data;
          if (!status || shouldWaitForParseFreshness({ ...fileData, ...status })
            || !parseFreshnessMatches(fileData.parseFreshness, status.parseFreshness)) {
            initialLoadAborted = true;
            setParseReloadKey(key => key + 1);
            return;
          }
        } catch {
          initialLoadAborted = true;
          if (isCurrentLoad()) setPreviewLoadError('读取最新解析状态失败，请重新加载。');
          return;
        }
      }
      if (isCurrentLoad()) finishInitialCanvasLoad();
      else initialLoadAborted = true;
    };
    console.log('[Editor] 开始加载:', fileData.name, '| 图层:', layers.length);
    if (isPsdFileType(fileData.fileType)) setPsdDiagnostics((previous) => mergePsdDiagnostics(previous, normalizePsdDiagnostics(fileData.parseResult?.diagnostics)));
    try {

    // 清除画布
    resetPsdCanvasScene(canvas as PsdImportCanvas);
    canvas.clear();
    canvas.backgroundColor = '#ffffff';
    (editorCanvas as any).__benlaiPdfParserVersion = ['pdf', 'ai'].includes(fileData.fileType)
      ? Number(fileData.parseResult?.pdfParserVersion) || undefined
      : undefined;
    (editorCanvas as any).__benlaiPdfSceneLoadedVersion = undefined;
    (editorCanvas as any).__benlaiPdfSceneCompleteVersion = undefined;
    (editorCanvas as any).__benlaiPdfEmptySceneConfirmed = false;
    (editorCanvas as any).__benlaiImportedSvgRoleModelVersion = undefined;
    (editorCanvas as any).__benlaiAiParserVersion = fileData.fileType === 'ai'
      ? Number(fileData.parseResult?.aiParserVersion) || undefined
      : undefined;
    (editorCanvas as any).__benlaiImportedTextPreviewMode = false;
    canvas.renderAll();

    const activeDocumentPage = getParsedDocumentPage(fileData, routePageNumber);
    const parsedDocumentPages = getParsedDocumentPages(fileData);
    const savedEditorState = fileData.isPersonalCopy && (['pdf', 'ai'].includes(fileData.fileType) || fileData.parseStatus === 'failed' || parsedDocumentPages.length <= 1)
      ? getEditorStateForDocumentPage(fileData, routePageNumber)
      : null;
    let recoveredRejectedImportedStateUserObjects: Record<string, unknown>[] = [];
    if (savedEditorState) {
      const cleaned = stripDeadBlobImages(refreshOwnedSavedAssetRevisions(savedEditorState, fileData, window.location.origin));
      if (fileData.parseStatus !== 'failed' && shouldReviewEmptySavedPdfState(fileData, cleaned, routePageNumber)) {
        setEmptyPdfStateReview({ fileId: fileData.id, sourceFileId: fileData.sourceFileId || null, pageNumber: routePageNumber, generation: expectedGeneration });
        throw new Error('旧保存状态为空，需确认是否继续使用空白画布。');
      }
      const ownerMismatch = hasEditorStateOwnerMismatch(fileData, cleaned, routePageNumber);
      if (ownerMismatch || (fileData.parseStatus !== 'failed' && !shouldUseSavedEditorState(fileData, cleaned, layers, routePageNumber))) {
        recoveredRejectedImportedStateUserObjects = ownerMismatch
          ? []
          : extractRecoverableUserObjectsFromRejectedImportedState(fileData, cleaned);
        if (ownerMismatch && !ownerMismatchWarnedRef.current && isCurrentLoad()) {
          ownerMismatchWarnedRef.current = true;
          message.warning('旧编辑状态可能已损坏，已从当前文件重新加载');
        }
        console.warn('[Editor] PSD saved state is empty; falling back to parsed layers:', fileData.name);
      } else {
        const savedSvgRoleModelVersion = Number(cleaned.__importedSvgRoleModelVersion);
        if (Number.isFinite(savedSvgRoleModelVersion) && savedSvgRoleModelVersion > 0) {
          (editorCanvas as any).__benlaiImportedSvgRoleModelVersion = savedSvgRoleModelVersion;
        }
        await ensureCustomFontsLoaded();
        await loadPersistedEditorStateIntoFabricCanvas(canvas, cleaned);
        if (isPsdFileType(fileData.fileType)) {
          const sceneCanvas = canvas as PsdImportCanvas;
          sceneCanvas.__psdScene = cleaned.__psdScene;
          sceneCanvas.__psdSceneVersion = Number(cleaned.__psdSceneVersion) || undefined;
          sceneCanvas.__psdVisibilityOverrides = readPsdVisibilityOverrides(cleaned.__psdVisibilityOverrides);
          if (sceneCanvas.__psdScene) {
            await restorePsdScene(canvas, {
              isCurrent: isCurrentLoad,
              resolveAssetUrl: (assetPath: string) => `/uploads/${assetPath}?v=${encodeURIComponent(getParseAssetRevision(fileData))}`,
              onDiagnostics: (items: PsdImportDiagnostic[]) => { if (isCurrentLoad()) setPsdDiagnostics((previous) => mergePsdDiagnostics(previous, items)); },
            });
            if (!isCurrentLoad()) return;
            setPsdSourcePreview(sceneCanvas.__psdSceneSession?.getSourcePreview?.() ?? false);
          } else if (usesRawPsdScene(fileData)) {
            setPsdDiagnostics((previous) => mergePsdDiagnostics(previous, [{
              code: 'legacy-saved-state', severity: 'warning',
              message: '当前显示已保存的编辑内容。新建干净副本可使用改进后的图层还原。',
            }]));
          }
          const savedLayers = (sceneCanvas.__psdScene as { layers?: ParsedLayer[] } | undefined)?.layers;
          applyPsdVisibilityState(sceneCanvas, Array.isArray(savedLayers) ? savedLayers : layers);
        }
        if (['pdf', 'ai'].includes(fileData.fileType) && activeDocumentPage?.previewOnly) {
          canvas.getObjects().filter((object) => (object as any)._pdfPreviewOnlyBackground === true).forEach((object) => canvas.remove(object));
          const background = await loadPdfPreviewFallbackLayer(canvas, fileData, activeDocumentPage,
            (assetPath) => `/uploads/${assetPath}?v=${encodeURIComponent(getParseAssetRevision(fileData))}`,
            { previewOnly: true, locked: true, placement: 'back', layerName: '原页背景（锁定）' });
          if (!background) throw new Error('PDF 原页图像加载失败');
        }
        restoreSvgDecorationLinksForCanvas(canvas);
        restorePdfPageCompositeLinksForCanvas(canvas);
        normalizePdfSourceTextHistoryState(canvas, layers, resolvedFontMap);
        restoreTransparentHitTestingForCanvas(canvas);
        restorePsdLayerInteractivityForCanvas(canvas, layers);
        if (!isPsdFileType(fileData.fileType)) removeHiddenParsedLayerObjects(canvas, layers);
        normalizeLoadedPsdTextObjects(canvas, fileData.fileType, { preserveFontFamily: true });
        const repairedManualLineTexts = repairPsdManualLineHeightsFromSavedState(canvas, layers);
        const repairedVerticalTexts = await repairPsdVerticalTextsFromSavedState(canvas, layers);
        if (isCanvasVisuallyLost(canvas)) {
          console.warn('[Editor] saved PSD state is visually lost; falling back to parsed layers:', fileData.name);
          resetPsdCanvasScene(canvas as PsdImportCanvas);
          canvas.clear();
          canvas.backgroundColor = '#ffffff';
          canvas.renderAll();
        } else {
      // 已保存画布里的 DIN 数字字号常常是用 fallback 字体测出来的旧 scaleX，
      // 这里在自定义字体真正可测之后重做一次 fit，让 99 类数字回到 PSD 宽度。
          await refitDinTextsFromSavedState(canvas, layers);
          repairCanvasObjectsNearScene(canvas);
          const loadedStateValidation = validateCanvasStateBeforePersist(canvas);
          if (!loadedStateValidation.valid) {
            console.warn('[Editor] saved PSD state has unsafe bounds; falling back to parsed layers:', loadedStateValidation.reason);
            resetPsdCanvasScene(canvas as PsdImportCanvas);
            canvas.clear();
            canvas.backgroundColor = '#ffffff';
            canvas.renderAll();
          } else {
            if ((repairedManualLineTexts || repairedVerticalTexts) && fileData.id && fileData.isPersonalCopy && isCurrentLoad()) {
              const repairedState = createPersistableCanvasState(canvas, 'psd text repair');
              if (repairedState) {
                saveEditorState(fileData.id, repairedState).catch((error) => {
                  console.error('[Editor] PSD text repair save failed:', error);
                });
              }
            }
            setLayers(['pdf', 'ai'].includes(fileData.fileType) && !activeDocumentPage?.previewOnly
              ? restoreSavedEditablePdfLayerState(canvas, layers, fileData.id, activeDocumentPage?.page || routePageNumber)
              : mergePdfPageCompositeUnderlayLayerState(canvas, layers, fileData.id));
            canvas.renderAll();
            pdfSceneCompletionVersion = Number(cleaned.__pdfSceneCompleteVersion) === 2 ? 2 : 1;
            await finishVerifiedCanvasLoad();
            return;
          }
        }
      }
    }

    if (fileData.parseStatus === 'failed' && fileData.parseResult?.hasRetainedResult !== true) return;

    if (usesRawPsdScene(fileData)) {
      const resolveAssetUrl = (assetPath: string) => `/uploads/${assetPath}?v=${encodeURIComponent(getParseAssetRevision(fileData))}`;
      let importDiagnostics: PsdImportDiagnostic[] = [];
      const report = (items: PsdImportDiagnostic[]) => {
        importDiagnostics = mergePsdDiagnostics(importDiagnostics, items);
        if (isCurrentLoad()) setPsdDiagnostics((previous) => mergePsdDiagnostics(previous, items));
      };
      report(normalizePsdDiagnostics(fileData.parseResult?.diagnostics));
      const count = await loadRawPsdLayerObjects(canvas, layers, resolveAssetUrl, missingFonts || [], report, isCurrentLoad);
      if (!isCurrentLoad()) return;
      if (count > 0) {
        await installPsdScene(canvas, layers, {
          isCurrent: isCurrentLoad,
          width: fileData.width || canvas.getWidth(), height: fileData.height || canvas.getHeight(),
          compositeImagePath: typeof fileData.parseResult?.compositePath === 'string' ? fileData.parseResult.compositePath : undefined,
          externalDiagnostics: importDiagnostics,
          resolveAssetUrl, onDiagnostics: report,
        });
        if (!isCurrentLoad()) return;
        applyPsdVisibilityState(canvas as PsdImportCanvas, layers);
        setPsdSourcePreview((canvas as PsdImportCanvas).__psdSceneSession?.getSourcePreview?.() ?? false);
      } else {
        await loadPsdCompositeFallback(canvas, fileData, resolveAssetUrl, report, isCurrentLoad);
      }
      if (!isCurrentLoad()) return;
      await appendRecoveredImportedStateUserObjects(canvas, recoveredRejectedImportedStateUserObjects);
      restoreTransparentHitTestingForCanvas(canvas);
      await finishVerifiedCanvasLoad();
      return;
    }

    if (['pdf', 'ai'].includes(fileData.fileType) && activeDocumentPage?.previewOnly) {
      const background = await loadPdfPreviewFallbackLayer(canvas, fileData, activeDocumentPage,
        (assetPath) => `/uploads/${assetPath}?v=${encodeURIComponent(getParseAssetRevision(fileData))}`,
        { previewOnly: true, locked: true, placement: 'back', layerName: '原页背景（锁定）' });
      if (!background) throw new Error('PDF 原页图像加载失败');
      await appendRecoveredImportedStateUserObjects(canvas, recoveredRejectedImportedStateUserObjects);
      setLayers([background]);
      canvas.renderAll();
      pdfSceneCompletionVersion = 2;
      await finishVerifiedCanvasLoad();
      return;
    }

    // 图片文件
    if (['png', 'jpg', 'jpeg', 'svg', 'gif', 'webp'].includes(fileData.fileType)) {
      try {
        const img = await loadFabricImageWithAuth(`/api/v1/files/${fileData.id}/preview`);
        if (img.width && img.height) {
          const s = Math.min(canvas.getWidth() / img.width, canvas.getHeight() / img.height, 1);
          img.set({ scaleX: s, scaleY: s, left: (canvas.getWidth() - img.width * s) / 2, top: (canvas.getHeight() - img.height * s) / 2 });
        }
        canvas.add(img);
        restoreTransparentHitTestingForCanvas(canvas);
        canvas.renderAll();
      } catch (e) { console.error('图片加载失败:', e); }
      await finishVerifiedCanvasLoad();
      return;
    }

    // PSD/AI/PDF — 逐图层加载，PDF 只加载解析出的 SVG/文字对象，不把整页预览伪装成编辑层
    if (['psd', 'psb', 'ai', 'pdf'].includes(fileData.fileType)) {
      const canLoadSvgObjects = fileData.fileType === 'ai' || fileData.fileType === 'pdf';
      const pageSvgPath = canLoadSvgObjects
        ? getEditablePdfPageSvgPath(fileData, routePageNumber)
        : activeDocumentPage?.svgPath || fileData.parseResult?.svgPath;
      const vectorSvgPath = canLoadSvgObjects && typeof pageSvgPath === 'string' ? pageSvgPath : null;
      const shouldOverlayParsedTextLayers = canLoadSvgObjects && fileData.parseResult?.explicitTextOverlay === true;
      const shouldOverlayParsedRasterLayers = canLoadSvgObjects && fileData.parseResult?.explicitRasterOverlay === true;
      const shouldOverlayParsedLayers = shouldOverlayParsedTextLayers || shouldOverlayParsedRasterLayers;
      let svgLoadedCount = 0;
      let svgVisualLoadedCount = 0;
      let syntheticSvgLayers: ParsedLayer[] = [];
      const uploadAssetVersion = ['psd', 'psb', 'ai', 'pdf'].includes(fileData.fileType)
        ? getParseAssetRevision(fileData)
        : '';
      const resolveUploadUrl = (assetPath: string) => {
        const url = `/uploads/${assetPath}`;
        return withUploadAssetRevision(url, uploadAssetVersion, window.location.origin);
      };
      const shouldUseImportedVisualBacking = shouldLoadImportedVisualBacking(fileData);
      let visualBackingLayer: ParsedLayer | null = null;
      let sourceTextActivationLayers: ParsedLayer[] = [];
      const loadVisualBackingIfNeeded = async () => {
        if (visualBackingLayer || !shouldUseImportedVisualBacking) return;
        visualBackingLayer = await loadPdfPreviewFallbackLayer(
          canvas,
          fileData,
          activeDocumentPage,
          resolveUploadUrl,
          {
            locked: true,
            placement: 'back',
            role: 'visual-backing',
            layerName: `${fileData.name || fileData.originalFilename || 'PDF'} 视觉底图`,
          },
        );
        if (visualBackingLayer) {
          console.log('[Editor] imported visual backing loaded for high-diff SVG');
        }
      };

      if (vectorSvgPath) {
        const { count: svgCount, visualCount: svgVisualCount, layers: svgLayers } = await loadAiSvgObjects(
          canvas,
          resolveUploadUrl(vectorSvgPath),
          fileData.name,
          setCanvasSize,
          {
            lockRasterImages: true,
            hideLockedRasterLayers: true,
            skipPdfRasterImages: false,
            skipImageObjects: false,
            pageNumber: activeDocumentPage?.page,
            hasSourceTextLayers: filterParsedLayersForPage(
              removePreviewLayers(layers),
              activeDocumentPage?.page,
            ).some(isSourceTextLayer),
            requireEditableObjects: true,
          },
        );
        svgLoadedCount = svgCount;
        svgVisualLoadedCount = svgVisualCount;
        syntheticSvgLayers = svgLayers;
        if (svgVisualCount > 0) {
          const pageSourceLayers = fileData.fileType === 'ai' || fileData.fileType === 'pdf'
            ? filterParsedLayersForPage(removePreviewLayers(layers), activeDocumentPage?.page)
            : layers;
          sourceTextActivationLayers = createSourceTextActivationLayers(
            canvas,
            pageSourceLayers.filter(isSourceTextLayer),
            resolvedFontMap,
          );
          if (canLoadSvgObjects && svgCount + sourceTextActivationLayers.length === 0) {
            throw new Error('PDF 页面未加载任何可编辑元素，请手动重新解析。');
          }
          if (!shouldOverlayParsedLayers && !shouldUseImportedVisualBacking) {
            await appendRecoveredImportedStateUserObjects(canvas, recoveredRejectedImportedStateUserObjects);
            setLayers([...svgLayers, ...sourceTextActivationLayers]);
            restoreTransparentHitTestingForCanvas(canvas);
            canvas.renderAll();
            console.log('[Editor] SVG loaded as editable objects:', svgCount);
            pdfSceneCompletionVersion = 2;
            await finishVerifiedCanvasLoad();
            return;
          }
          console.log('[Editor] SVG loaded, continuing with editable text layers:', svgCount);
        }
      }

      await loadVisualBackingIfNeeded();

      const sourceLayers = fileData.fileType === 'ai' || fileData.fileType === 'pdf'
        ? filterParsedLayersForPage(removePreviewLayers(layers), activeDocumentPage?.page)
        : layers;
      let sourceLayersForCanvas = sourceLayers;
      if (canLoadSvgObjects && (shouldOverlayParsedLayers || svgVisualLoadedCount > 0)) {
        sourceLayersForCanvas = filterImportedSvgOverlayLayers(sourceLayersForCanvas, {
          includeText: shouldOverlayParsedTextLayers,
          includeImages: shouldOverlayParsedRasterLayers,
        });
      }
      if (canLoadSvgObjects && syntheticSvgLayers.some((layer) => layer.layerType === 'text')) {
        sourceLayersForCanvas = sourceLayersForCanvas.filter((layer) => layer.layerType !== 'text');
      }
      const editableLayers = getCanvasRenderableLayers(sourceLayersForCanvas, isPsdFileType(fileData.fileType));
      const importedTextPreviewBackings = collectImportedTextPreviewBackings(fileData, sourceLayersForCanvas, syntheticSvgLayers);
      const importedTextPreviewSource = await loadImportedTextPreviewSource(
        canvas,
        fileData,
        activeDocumentPage,
        resolveUploadUrl,
        importedTextPreviewBackings,
        sourceLayersForCanvas,
      );
      (editorCanvas as any).__benlaiImportedTextPreviewMode = Boolean(importedTextPreviewSource);
      let loadedCount = 0;
      const clipBases: PsdClipBaseMap = new Map();

      // PSD blendMode -> Canvas globalCompositeOperation 映射
      const BLEND_MAP: Record<string, string> = {
        'normal': 'source-over',
        'multiply': 'multiply',
        'screen': 'screen',
        'overlay': 'overlay',
        'darken': 'darken',
        'lighten': 'lighten',
        'color dodge': 'color-dodge',
        'color burn': 'color-burn',
        'hard light': 'hard-light',
        'soft light': 'soft-light',
        'difference': 'difference',
        'exclusion': 'exclusion',
        'hue': 'hue',
        'saturation': 'saturation',
        'color': 'color',
        'luminosity': 'luminosity',
      };

      for (const layer of editableLayers) {
        try {
          const blendMode = BLEND_MAP[layer.blendMode || 'normal'] || 'source-over';
          const layerProps = layer.properties as Record<string, unknown> | null;
          const locked = layerProps?.locked === true;

          if (isPsdGroupEffectOverlayLayer(layer)) {
            const groupEffect = await buildPsdGroupEffectOverlay(layer, resolveUploadUrl);
            if (groupEffect) {
              canvas.add(groupEffect.image);
              loadedCount++;
            }
            continue;
          }

          if (layer.layerType === 'text' && layer.textContent) {
            const style = layer.textStyle as Record<string, unknown> | null;
            const textFontMissing = isPsdFileType(fileData.fileType)
              && isTextLayerUsingMissingFont(layer, missingFonts || []);
            const textScale = toFiniteNumber(style?.textScale) || 1;
            const textScaleX = toFiniteNumber(style?.textScaleX) || textScale;
            const textScaleY = toFiniteNumber(style?.textScaleY) || textScale;

            // 多 run 混排（PSD 里同一图层不同字号 / 装饰）— 选「主样式」作为 fabric 基底，
            // 其余 run 字符级补打，避免「99」的样式被复制到全部字符上。
            const psdRuns = (style?.runs as Array<Record<string, unknown>> | undefined) || [];
            const dominantRun =
              psdRuns.length > 0
                ? psdRuns.reduce((best, cur) =>
                    (toFiniteNumber(cur.length) || 0) > (toFiniteNumber(best?.length) || 0) ? cur : best,
                  psdRuns[0])
                : null;

            // baseFontSize 必须**优先取 style.fontSize**（PSD 文字图层默认字号），
            // 而不是 dominantRun.fontSize —— 否则单 run 标题（「鲜果上新啦」之类）会
            // 拿 run 自己声明的字号（有些 PSD 这两个值不一致），导致系统性放大/缩小。
            // 真正的多字号混排靠 per-run setSelectionStyles 单独设置，不需要 base 跟着变。
            const baseFontSize =
              toFiniteNumber(style?.fontSize) ||
              toFiniteNumber(dominantRun?.fontSize) ||
              24;
            const textBoxWidth = Math.max(1, toFiniteNumber(layer.width) || 0);
            const textBoxHeight = Math.max(1, toFiniteNumber(layer.height) || 0);
            const isVerticalText = isPsdVerticalTextLayer(
              layer,
              style,
              baseFontSize * textScaleY,
              textBoxWidth,
              textBoxHeight,
            );
            const textScaleForFabric = textScaleY;
            const fontSize = baseFontSize * textScaleForFabric; // 实际渲染字号

            // 主 run 的颜色（如果存在）优先于默认 style 的 fillColor
            const solidFillColor = getPsdTextSolidFillColor(style);
            const dominantRunFillColor = extractPsdRunFillColor(dominantRun);
            const baseFillColor = (() => {
              if (solidFillColor) return solidFillColor;
              if (dominantRunFillColor) return dominantRunFillColor;
              const styleFillColor = extractColor(style);
              if (styleFillColor) return styleFillColor;
              const fc = dominantRun?.fillColor as { r?: number; g?: number; b?: number } | undefined;
              if (fc && typeof fc.r === 'number') {
                return `rgb(${Math.round(fc.r)},${Math.round(fc.g!)},${Math.round(fc.b!)})`;
              }
              return '#141413';
            })();

            // 解析字体信息
            const font = style?.font as Record<string, unknown> | undefined;
            const baseFontName =
              (typeof dominantRun?.fontName === 'string' ? (dominantRun.fontName as string) : '') ||
              (font?.name as string) ||
              '';
            const importedVectorText = isImportedVectorType(fileData.fileType);
            const fontFamily = importedVectorText
              ? mapImportedTextFont(baseFontName)
              : mapPsdFont(baseFontName);
            const fontWeight = importedVectorText
              ? '400'
              : getPsdFontWeight(baseFontName, {
                  ...(style || {}),
                  fauxBold: dominantRun?.fauxBold === true || style?.fauxBold === true,
                });
            const isItalic = dominantRun?.fauxItalic === true || style?.fauxItalic === true;
            const tracking = toFiniteNumber(dominantRun?.tracking) || toFiniteNumber(style?.tracking) || 0;
            const charSpacing = Math.round(tracking);
            const hasManualLineBreak = /[\r\n]/.test(layer.textContent || '');
            const rawLineHeight = getPsdLineHeight(style, baseFontSize, dominantRun);
            const lineHeight = isVerticalText
              ? getPsdVerticalLineHeight(layer.textContent || '', fontSize, textBoxHeight, rawLineHeight, tracking)
              : hasManualLineBreak
                ? getPsdManualLineHeight(layer.textContent || '', fontSize, textBoxHeight, rawLineHeight)
              : rawLineHeight;
            const contentOpacity = getPsdLayerContentOpacity(layer);
            const inheritedSolidFillColor = getPsdInheritedSolidFillColor(layer);
            const textAlign = getPsdTextAlign(style);
            // 主样式自身是否带装饰（分段装饰由 runs 处理）
            const isUnderline =
              dominantRun?.underline === true || style?.underline === true;
            const isLinethrough =
              dominantRun?.strikethrough === true ||
              style?.strikethrough === true ||
              style?.['lineThrough'] === true;

            await waitForCanvasFont(fontFamily, fontSize, fontWeight);
            const psdBaselineY = toFiniteNumber(style?.textBaselineY);
            const FABRIC_FONT_SIZE_MULT = 1.13;
            const FABRIC_FONT_SIZE_FRACTION = 0.222;
            const FABRIC_BASELINE_RATIO =
              FABRIC_FONT_SIZE_MULT * (1 - FABRIC_FONT_SIZE_FRACTION);
            const firstLineEnd = (() => {
              const idx = (layer.textContent || '').search(/\r\n|\r|\n/);
              return idx === -1 ? (layer.textContent || '').length : idx;
            })();
            let maxFontSizeInFirstLine = fontSize;
            for (const run of psdRuns) {
              const runFrom = toFiniteNumber(run.from) ?? 0;
              const runLen = toFiniteNumber(run.length) ?? 0;
              if (runFrom >= firstLineEnd) continue;
              const runFontSize = toFiniteNumber(run.fontSize);
              if (runFontSize !== null && runFontSize > 0) {
                const scaledRunFontSize = runFontSize * textScaleForFabric;
                if (scaledRunFontSize > maxFontSizeInFirstLine) {
                  maxFontSizeInFirstLine = scaledRunFontSize;
                }
              }
              if (runFrom + runLen >= firstLineEnd) break;
            }
            const psdBaselineX = toFiniteNumber(style?.textBaselineX);
            const baselineTop = psdBaselineY !== null
              ? psdBaselineY - maxFontSizeInFirstLine * FABRIC_BASELINE_RATIO
              : null;
            const computedTextLeft = psdBaselineX ?? (layer.x || 0);
            const computedTextTop = baselineTop ?? (layer.y || 0);
            // 图层特效描边
            const fx = style?.effects as Record<string, unknown> | undefined;
            const strokeOpts = importedVectorText
              ? { stroke: undefined, strokeWidth: 0, paintFirst: 'fill' }
              : buildPsdTextStrokeOptions(style, textScale);

            // 投影
            const shadowObj = importedVectorText ? null : buildPsdFabricShadow(fx);

            await waitForCanvasFont(fontFamily, fontSize, fontWeight);

            const textBaseOptions = {
              left: computedTextLeft,
              top: computedTextTop,
              fontSize,
              fill: baseFillColor,
              fontFamily,
              fontWeight,
              fontStyle: isItalic ? 'italic' : 'normal',
              underline: isUnderline,
              linethrough: isLinethrough,
              charSpacing,
              lineHeight,
              textAlign,
              opacity: contentOpacity,
              editable: !textFontMissing,
              objectCaching: false,
              splitByGrapheme: true,
              selectable: !locked,
              evented: !locked,
              globalCompositeOperation: blendMode as GlobalCompositeOperation,
              ...strokeOpts,
              ...(shadowObj ? { shadow: shadowObj } : {}),
            };
            const fabricTextContent = isVerticalText
              ? formatPsdVerticalTextContent(layer.textContent || '')
              : layer.textContent;
            // PSD line breaks are intentional manual lines. Do not put them in
            // Textbox auto-wrap mode, otherwise editing can turn 2 lines into 3.
            const isAreaText =
              !isVerticalText &&
              !hasManualLineBreak &&
              textBoxHeight > fontSize * lineHeight * 1.9;
            const horizontalTextScale = textScaleY > 0 ? textScaleX / textScaleY : 1;
            const shouldApplyHorizontalTextScale =
              !isVerticalText &&
              !isAreaText &&
              !isDinNumericTextLayer(baseFontName, layer.textContent) &&
              Number.isFinite(horizontalTextScale) &&
              horizontalTextScale > 0 &&
              Math.abs(horizontalTextScale - 1) > 0.01;
            const textSnapshotOptions = {
              fontSize,
              fill: baseFillColor,
              fontFamily,
              fontWeight,
              fontStyle: isItalic ? 'italic' : 'normal',
              underline: isUnderline,
              linethrough: isLinethrough,
              charSpacing,
              lineHeight,
              textAlign,
              opacity: contentOpacity,
              width: textBoxWidth,
              ...(textBoxHeight > 1 ? { minHeight: textBoxHeight } : {}),
              ...(isVerticalText ? { textOrientation: 'vertical' } : {}),
              runs: psdRuns,
              psdBaseFontName: baseFontName,
              psdTextScaleY: textScaleForFabric,
              psdFileType: fileData.fileType,
              psdSolidFillColor: solidFillColor,
              ...strokeOpts,
              ...(shadowObj ? { shadow: serializePsdTextShadow(shadowObj) } : {}),
              ...(shouldApplyHorizontalTextScale ? { scaleX: horizontalTextScale } : {}),
            };
            const layerBounds = {
              left: layer.x || 0,
              top: layer.y || 0,
              width: layer.width || 0,
              height: layer.height || 0,
            };
            const shouldUseImportedTextPreview =
              false
              && importedVectorText
              && Boolean(importedTextPreviewSource)
              && (
                Boolean(importedTextPreviewSource?.clearedImage)
                || isParsedTextLayerCoveredByBacking(layer, importedTextPreviewBackings)
              );
            if (shouldUseImportedTextPreview && importedTextPreviewSource) {
              const preview = await buildImportedTextCropPreviewLayer(
                importedTextPreviewSource,
                layer,
                layerBounds,
                fabricTextContent || layer.textContent || '',
                {
                  ...textSnapshotOptions,
                  fontFamily: MISSING_PSD_TEXT_EDIT_FONT_FAMILY,
                  fontWeight: '400',
                  importedSourceFontName: baseFontName || fontFamily,
                },
                locked,
                blendMode as GlobalCompositeOperation,
              );
              const previewClipApplied = await applyPsdLayerClipPath(preview, layer, clipBases);
              if (isPsdClippingLayer(layer) && !previewClipApplied) continue;
              canvas.add(preview);
              registerPsdClipBase(layer, preview, clipBases);
              loadedCount++;
              continue;
            }
            const shouldUseRasterTextPreview =
              isPsdFileType(fileData.fileType)
              && Boolean(layer.imagePath)
              && shouldUsePsdRasterTextPreview(style, isAreaText, layer);
            if ((textFontMissing || shouldUseRasterTextPreview) && layer.imagePath) {
              const previewUrl = resolveUploadUrl(layer.imagePath);
              const basePreview = await loadFabricImageFromUrl(
                previewUrl,
                { crossOrigin: 'anonymous' },
              );
              const previewScaleX = (layer.width || basePreview.width || 1) / (basePreview.width || 1);
              const previewScaleY = (layer.height || basePreview.height || 1) / (basePreview.height || 1);
              const previewWithStroke = await buildPsdTextPreviewImage(
                previewUrl,
                basePreview,
                strokeOpts,
                previewScaleX,
                previewScaleY,
                inheritedSolidFillColor,
                null,
              );
              const preview = previewWithStroke.image;
              preview.set({
                left: (layer.x || 0) - previewWithStroke.padX,
                top: (layer.y || 0) - previewWithStroke.padY,
                scaleX: previewScaleX,
                scaleY: previewScaleY,
                opacity: contentOpacity,
                objectCaching: false,
                globalCompositeOperation: blendMode as GlobalCompositeOperation,
                selectable: !locked,
                evented: !locked,
              });
              (preview as any)._layerId = layer.id;
              (preview as any)._layerName = layer.layerName;
              (preview as any)._layerType = 'text';
              (preview as any)._psdFontName = baseFontName;
              (preview as any)._psdMissingFont = textFontMissing;
              (preview as any)._psdTextPreview = true;
              (preview as any)._psdTextContent = layer.textContent;
              (preview as any)._psdTextIsAreaText = isAreaText;
              (preview as any)._psdTextOrientation = isVerticalText ? 'vertical' : undefined;
              (preview as any)._psdTextOptions = {
                ...textSnapshotOptions,
                fontFamily: textFontMissing ? MISSING_PSD_TEXT_EDIT_FONT_FAMILY : fontFamily,
                fontWeight: textFontMissing ? '400' : fontWeight,
              };
              (preview as any)._psdLayerBounds = layerBounds;
              (preview as any)._psdLocked = locked;
              const previewClipApplied = await applyPsdLayerClipPath(preview, layer, clipBases);
              if (isPsdClippingLayer(layer) && !previewClipApplied) continue;
              canvas.add(preview);
              registerPsdClipBase(layer, preview, clipBases);
              loadedCount++;
              continue;
            }
            const text = isAreaText
              ? new fabric.Textbox(fabricTextContent, {
                  ...textBaseOptions,
                  width: textBoxWidth,
                  ...(textBoxHeight > 1 ? { minHeight: textBoxHeight } : {}),
                })
              : new fabric.IText(fabricTextContent, textBaseOptions);

            (text as any)._layerId = layer.id;
            (text as any)._layerName = layer.layerName;
            (text as any)._layerType = 'text';
            (text as any)._psdFontName = baseFontName;
            (text as any)._psdMissingFont = textFontMissing;
            (text as any)._psdTextIsAreaText = isAreaText;
            (text as any)._psdTextOrientation = isVerticalText ? 'vertical' : undefined;
            (text as any)._psdLayerBounds = layerBounds;
            (text as any)._psdLocked = locked;
            if (shouldApplyHorizontalTextScale) {
              text.set('scaleX', horizontalTextScale);
              (text as fabric.FabricObject & { _psdAutoScaleX?: number })._psdAutoScaleX = horizontalTextScale;
            }

            // 先把基础文字加到画布，确保即使后续 per-run 上样式出错也不会让整段文字消失。
            const textClipApplied = await applyPsdLayerClipPath(text, layer, clipBases);
            if (isPsdClippingLayer(layer) && !textClipApplied) continue;
            canvas.add(text);
            registerPsdClipBase(layer, text, clipBases);
            loadedCount++;

            // 字符级补打：必须在 canvas.add 之后，否则 fabric v6 在未挂载状态下做
            // setSelectionStyles + initDimensions 会让对象进入半构造状态而抛错。
            // 此外要打两遍 —— preventSpuriousWrap 调宽之后 fabric 内部会按新的
            // wrap 重映射 styles，第一遍设的「105 linethrough」会失效，所以第二遍补回。
            applyRunStylesToText(
              text,
              layer,
              psdRuns,
              baseFontName,
              textScaleForFabric,
              fileData.fileType,
              solidFillColor,
              { verticalText: isVerticalText },
            );

            // 解决「105」被字符级 wrap 切成「10 / 5」的问题：
            // 在 fabric 应用完所有样式（含 per-run）之后，再做一次防御性的
            // 行宽校正——逻辑行数对得上就什么都不动，多出来才扩宽 textbox.
            if (isAreaText) {
              preventSpuriousWrap(text, layer, textBoxWidth);
              // 调宽后 fabric 重排了 wrap，per-run 样式会按 wrapped line 错位 —— 重打一次。
              applyRunStylesToText(
                text,
                layer,
                psdRuns,
                baseFontName,
                textScaleForFabric,
                fileData.fileType,
                solidFillColor,
                { verticalText: isVerticalText },
              );
            }

            if (isVerticalText) {
              await fitPsdVerticalTextToVisualHeight(canvas, text, textBoxHeight);
            }
            await fitTextToPsdBounds(canvas, text, layer, isAreaText);
          } else if (layer.imagePath) {
            const url = resolveUploadUrl(layer.imagePath);
            const baseImg = await loadFabricImageFromUrl(url, { crossOrigin: 'anonymous' });
            const renderedImage = await buildPsdImageWithInheritedFill(url, baseImg, layer);
            const img = renderedImage.image;
            const backgroundLike = isLikelyCanvasBackgroundLayer(layer, canvas, editableLayers.length);
            const layerImageScale = getLayerImageScale(layer, img, renderedImage.padX, renderedImage.padY);
            img.set({
              originX: 'left',
              originY: 'top',
              left: (layer.x || 0) - renderedImage.padX,
              top: (layer.y || 0) - renderedImage.padY,
              scaleX: layerImageScale.scaleX,
              scaleY: layerImageScale.scaleY,
              opacity: getPsdLayerContentOpacity(layer),
              objectCaching: false,
              globalCompositeOperation: blendMode as GlobalCompositeOperation,
              selectable: !locked,
              evented: !locked,
            });
            (img as any)._layerId = layer.id;
            (img as any)._layerName = layer.layerName;
            (img as any)._layerType = 'image';
            (img as any)._psdCanvasBackground = backgroundLike;
            (img as any)._psdLocked = locked;
            const imageClipApplied = await applyPsdLayerClipPath(img, layer, clipBases);
            if (isPsdClippingLayer(layer) && !imageClipApplied) continue;
            canvas.add(img);
            registerPsdClipBase(layer, img, clipBases);
            loadedCount++;
          }
        } catch (e) {
          console.warn('[Editor] 图层加载失败:', layer.layerName, e);
          if (isPsdFileType(fileData.fileType)) setPsdDiagnostics((previous) => mergePsdDiagnostics(previous, [{
            code: 'layer-load-failed', severity: 'error', layerKey: psdLayerSourceKey(layer),
            layerName: layer.layerName, message: '图层图像加载失败，未能还原此图层。',
          }]));
        }
      }

      if (canLoadSvgObjects && svgLoadedCount + loadedCount + sourceTextActivationLayers.length === 0) {
        throw new Error('PDF 页面未加载任何可编辑元素，请手动重新解析。');
      }

      if (isPsdFileType(fileData.fileType) && loadedCount === 0 && (fileData.parseResult?.compositePath || fileData.thumbnailPath)) {
        try {
          const img = await loadFabricImageFromUrl(
            resolveUploadUrl(String(fileData.parseResult?.compositePath || fileData.thumbnailPath)),
            { crossOrigin: 'anonymous' }
          );
          img.set({ left: 0, top: 0, scaleX: (fileData.width || canvas.getWidth()) / (img.width || 1), scaleY: (fileData.height || canvas.getHeight()) / (img.height || 1) });
          (img as any)._layerId = fileData.id;
          (img as any)._layerName = fileData.name;
          (img as any)._layerType = 'image';
          canvas.add(img);
          loadedCount = 1;
          console.log('[Editor] 无图层数据，加载缩略图作为可编辑图片');
        } catch (e) {
          console.error('[Editor] 缩略图加载失败:', e);
        }
      }

      normalizeLoadedPsdTextObjects(canvas, fileData.fileType);
      if (isPsdFileType(fileData.fileType)) applyPsdVisibilityState(canvas as PsdImportCanvas, sourceLayersForCanvas);
      repairPsdManualLineHeightsFromSavedState(canvas, sourceLayersForCanvas);
      await repairPsdVerticalTextsFromSavedState(canvas, sourceLayersForCanvas);
      await appendRecoveredImportedStateUserObjects(canvas, recoveredRejectedImportedStateUserObjects);
      restoreTransparentHitTestingForCanvas(canvas);
      restorePsdLayerInteractivityForCanvas(canvas, sourceLayersForCanvas);
      sendVisualBackingLayerToBack(canvas, visualBackingLayer);
      canvas.renderAll();
      if (svgVisualLoadedCount > 0 || visualBackingLayer) {
        setLayers([
          ...syntheticSvgLayers,
          ...sourceTextActivationLayers,
          ...sourceLayersForCanvas,
        ]);
      }
      restoreTransparentHitTestingForCanvas(canvas);
      console.log('[Editor] 加载完成: %d 个可编辑图层', loadedCount + svgLoadedCount);
      pdfSceneCompletionVersion = 2;
      await finishVerifiedCanvasLoad();
      return;
    }

    // 其他格式 — 按图层加载
    const visibleLayers = getCanvasRenderableLayers(layers);
    if (visibleLayers.length > 0) {
      for (const layer of visibleLayers) {
        try {
          if (layer.imagePath) {
            const url = `/uploads/${layer.imagePath}`;
            const baseImg = await loadFabricImageFromUrl(url, { crossOrigin: 'anonymous' });
            const renderedImage = await buildPsdImageWithInheritedFill(url, baseImg, layer);
            const img = renderedImage.image;
            const layerProps = layer.properties as Record<string, unknown> | null;
            const locked = layerProps?.locked === true;
            const backgroundLike = isLikelyCanvasBackgroundLayer(layer, canvas, visibleLayers.length);
            const layerImageScale = getLayerImageScale(layer, img, renderedImage.padX, renderedImage.padY);
            img.set({
              originX: 'left',
              originY: 'top',
              left: (layer.x || 0) - renderedImage.padX,
              top: (layer.y || 0) - renderedImage.padY,
              scaleX: layerImageScale.scaleX,
              scaleY: layerImageScale.scaleY,
              opacity: getPsdLayerContentOpacity(layer),
              selectable: !locked,
              evented: !locked,
            });
            (img as any)._psdCanvasBackground = backgroundLike;
            canvas.add(img);
          } else if (layer.layerType === 'text' && layer.textContent) {
            canvas.add(new fabric.IText(layer.textContent, {
              left: layer.x || 0, top: layer.y || 0, fontSize: 24, fill: '#141413', opacity: getPsdLayerContentOpacity(layer),
            }));
          }
        } catch {}
      }
      restoreTransparentHitTestingForCanvas(canvas);
      canvas.renderAll();
      await finishVerifiedCanvasLoad();
      return;
    }

    // 空文件
    canvas.add(new fabric.IText(`${fileData.name}\n\n打开文件或拖入图片开始编辑`, {
      left: canvas.getWidth() / 2, top: canvas.getHeight() / 2,
      fontSize: 22, fill: '#A3A399', textAlign: 'center', originX: 'center', originY: 'center',
    }));
    canvas.renderAll();
    await finishVerifiedCanvasLoad();
    } catch (error) {
      if (['pdf', 'ai'].includes(fileData.fileType)) {
        previewOnlyLoadFailed = true;
        if (isCurrentLoad()) setPreviewLoadError(error instanceof Error ? error.message : '页面或已有编辑内容加载失败，请重新加载后再编辑或导出。');
      } else if (isPsdFileType(fileData.fileType)) {
        previewOnlyLoadFailed = true;
        if (isCurrentLoad()) setPreviewLoadError(error instanceof Error ? error.message : 'PSD 图层加载失败，请重新加载后再编辑。');
      } else if (fileData.parseStatus !== 'failed') throw error;
      console.error('[Editor] failed parse saved state could not be loaded:', error);
    } finally {
      if ((initialLoadAborted || fileData.parseStatus === 'failed' || previewOnlyLoadFailed) && !initialLoadFinished) {
        if (isCurrentLoad()) {
          editorCanvas.renderOnAddRemove = previousRenderOnAddRemove ?? true;
          editorCanvas.__bulkLoading = false;
          editorCanvas.__suspendHistory = false;
          contentLoadingRef.current = false;
          setContentLoading(false);
          if (!previewOnlyLoadFailed && !initialLoadAborted) setFailedCanvasUnavailable(true);
        }
      } else {
        await finishVerifiedCanvasLoad();
      }
    }
  }, [canvas, fileData, layers, contentLoaded, missingFonts, resolvedFontMap, routePageNumber, setCanvasSize]);

  // 3. canvas ready 或 data ready 后触发加载
  useEffect(() => {
    if (!canvas) return;
    restoreSvgDecorationLinksForCanvas(canvas);
    restorePdfPageCompositeLinksForCanvas(canvas);

    const handleProxyTransform = (event: { target?: fabric.FabricObject }) => {
      syncSvgDecorationProxyMembers(canvas, event.target, { requestRender: false });
      syncPdfPageCompositeMembers(canvas, event.target, { requestRender: false });
    };
    const handleProxyModified = (event: { target?: fabric.FabricObject }) => {
      syncSvgDecorationProxyMembers(canvas, event.target);
      syncPdfPageCompositeMembers(canvas, event.target);
    };
    const handleProxyRemoved = (event: { target?: fabric.FabricObject }) => {
      removeSvgDecorationMembersForProxy(canvas, event.target);
    };
    const handleHistoryRestored = () => {
      restoreSvgDecorationLinksForCanvas(canvas);
      restorePdfPageCompositeLinksForCanvas(canvas);
      canvas.requestRenderAll();
    };

    canvas.on('object:moving', handleProxyTransform);
    canvas.on('object:scaling', handleProxyTransform);
    canvas.on('object:rotating', handleProxyTransform);
    canvas.on('object:modified', handleProxyModified);
    canvas.on('object:removed', handleProxyRemoved);
    (canvas as fabric.Canvas & {
      on: (eventName: string, handler: () => void) => void;
      off: (eventName: string, handler: () => void) => void;
    }).on(HISTORY_RESTORED_EVENT, handleHistoryRestored);

    return () => {
      canvas.off('object:moving', handleProxyTransform);
      canvas.off('object:scaling', handleProxyTransform);
      canvas.off('object:rotating', handleProxyTransform);
      canvas.off('object:modified', handleProxyModified);
      canvas.off('object:removed', handleProxyRemoved);
      (canvas as fabric.Canvas & {
        off: (eventName: string, handler: () => void) => void;
      }).off(HISTORY_RESTORED_EVENT, handleHistoryRestored);
    };
  }, [canvas]);

  useEffect(() => {
    if (canvas && fileData && !loading && !contentLoaded && !isNewCanvas) {
      if (fileData.parseStatus === 'failed' && ((fileData.parseResult?.hasRetainedResult !== true && !normalizeEditorState(fileData.editorState)) || failedCanvasUnavailable)) return;
      const owner = canvasOwnerRef.current;
      if (!owner || owner.fileId !== fileData.id || owner.pageNumber !== routePageNumber) return;
      (canvas as OwnedFabricCanvas).__benlaiCanvasOwner = owner;
      const generation = owner.generation;
      canvasLoadQueueRef.current = canvasLoadQueueRef.current
        .catch(() => undefined)
        .then(() => loadContent(generation));
    }
  }, [canvas, fileData, loading, contentLoaded, isNewCanvas, loadContent, routePageNumber, failedCanvasUnavailable]);

  useEffect(() => {
    if (!canvas || !isNewCanvas || importImagesRequested || loading || contentLoaded) return;
    const editorCanvas = canvas as OwnedFabricCanvas;
    const expectedOwner = canvasOwnerRef.current;
    if (!expectedOwner || expectedOwner.fileId !== null || expectedOwner.draftId !== activeDraftId) return;
    editorCanvas.__benlaiCanvasOwner = expectedOwner;
    let cancelled = false;
    const isCurrentDraftOwner = () => {
      const owner = editorCanvas.__benlaiCanvasOwner;
      return !cancelled
        && canvasGenerationRef.current === expectedOwner.generation
        && owner?.generation === expectedOwner.generation
        && owner.draftId === activeDraftId
        && owner.fileId === null;
    };

    const loadDraftOrBlank = async () => {
      if (!isCurrentDraftOwner()) return;
      editorCanvas.__suspendHistory = true;
      try {
        const draftState = activeDraftId ? readDraftCanvasState(activeDraftId) : null;
        if (!isCurrentDraftOwner()) return;
        resetPsdCanvasScene(canvas as PsdImportCanvas);
        canvas.clear();
        canvas.backgroundColor = '#ffffff';
        if (draftState?.canvas) {
          await loadPersistedEditorStateIntoFabricCanvas(canvas, draftState.canvas);
          if (!isCurrentDraftOwner()) return;
          await restorePsdScene(canvas, { isCurrent: isCurrentDraftOwner, resolveAssetUrl: (assetPath) => `/uploads/${assetPath}` });
          if (!isCurrentDraftOwner()) return;
          setPsdSourcePreview((canvas as PsdImportCanvas).__psdSceneSession?.getSourcePreview?.() ?? false);
          restoreSvgDecorationLinksForCanvas(canvas);
          restoreTransparentHitTestingForCanvas(canvas);
        }
        if (!isCurrentDraftOwner()) return;
        canvas.requestRenderAll();
        useEditorStore.getState().resetHistory(createHistorySnapshot(canvas));
        useEditorStore.getState().setDirty(false);
        setActiveTool('select');
        setContentLoaded(true);
      } finally {
        window.setTimeout(() => {
          if (isCurrentDraftOwner()) editorCanvas.__suspendHistory = false;
        }, 0);
      }
    };

    canvasLoadQueueRef.current = canvasLoadQueueRef.current
      .catch(() => undefined)
      .then(loadDraftOrBlank);

    return () => {
      cancelled = true;
    };
  }, [activeDraftId, canvas, isNewCanvas, importImagesRequested, loading, contentLoaded, setActiveTool]);

  useEffect(() => {
    if (!canvas || !isNewCanvas || !importImagesRequested || loading || contentLoaded) return;

    let cancelled = false;
    const editorCanvas = canvas as OwnedFabricCanvas;
    const expectedOwner = canvasOwnerRef.current;
    if (!expectedOwner || expectedOwner.fileId !== null || expectedOwner.draftId !== activeDraftId) return;
    editorCanvas.__benlaiCanvasOwner = expectedOwner;
    const isCurrentDraftOwner = () => {
      const owner = editorCanvas.__benlaiCanvasOwner;
      return !cancelled
        && canvasGenerationRef.current === expectedOwner.generation
        && owner?.generation === expectedOwner.generation
        && owner.draftId === activeDraftId
        && owner.fileId === null;
    };

    const loadPendingImages = async () => {
      if (!isCurrentDraftOwner()) return;
      editorCanvas.__suspendHistory = true;
      const draftState = activeDraftId ? readDraftCanvasState(activeDraftId) : null;
      if (draftState?.canvas) {
        try {
          if (!isCurrentDraftOwner()) return;
          canvas.clear();
          canvas.backgroundColor = '#ffffff';
          await loadPersistedEditorStateIntoFabricCanvas(canvas, draftState.canvas);
          if (!isCurrentDraftOwner()) return;
          restoreSvgDecorationLinksForCanvas(canvas);
          restoreTransparentHitTestingForCanvas(canvas);
          canvas.requestRenderAll();
          useEditorStore.getState().resetHistory(createHistorySnapshot(canvas));
          useEditorStore.getState().setDirty(false);
          setActiveTool('select');
        } finally {
          if (isCurrentDraftOwner()) {
            editorCanvas.__suspendHistory = false;
            setContentLoaded(true);
          }
        }
        return;
      }

      if (!isCurrentDraftOwner()) return;
      const images = takePendingImportImages();
      if (images.length === 0) {
        if (!isCurrentDraftOwner()) return;
        useEditorStore.getState().resetHistory(createHistorySnapshot(canvas));
        useEditorStore.getState().setDirty(false);
        editorCanvas.__suspendHistory = false;
        setContentLoaded(true);
        return;
      }

      try {
        const targetWidth = parsePositiveInt(newCanvasWidth, 1080);
        const targetHeight = parsePositiveInt(newCanvasHeight, 1080);
        if (!isCurrentDraftOwner()) return;
        canvas.clear();
        canvas.backgroundColor = '#ffffff';
        canvas.renderAll();

        const columns = Math.ceil(Math.sqrt(images.length));
        const rows = Math.ceil(images.length / columns);
        const cellWidth = targetWidth / columns;
        const cellHeight = targetHeight / rows;

        for (let index = 0; index < images.length; index += 1) {
          if (!isCurrentDraftOwner()) return;
          const pending = images[index];
          const img = await loadFabricImageWithAuth(pending.src);
          if (!isCurrentDraftOwner()) return;

          const naturalWidth = img.width || pending.width || targetWidth;
          const naturalHeight = img.height || pending.height || targetHeight;
          const maxWidth = images.length === 1 ? targetWidth * 0.92 : cellWidth * 0.82;
          const maxHeight = images.length === 1 ? targetHeight * 0.92 : cellHeight * 0.82;
          const scale = Math.min(maxWidth / naturalWidth, maxHeight / naturalHeight, 1);
          const col = index % columns;
          const row = Math.floor(index / columns);
          const left = images.length === 1
            ? (targetWidth - naturalWidth * scale) / 2
            : col * cellWidth + (cellWidth - naturalWidth * scale) / 2;
          const top = images.length === 1
            ? (targetHeight - naturalHeight * scale) / 2
            : row * cellHeight + (cellHeight - naturalHeight * scale) / 2;

          img.set({
            left,
            top,
            scaleX: scale,
            scaleY: scale,
            selectable: true,
            evented: true,
          });
          stampEditorObject(img, pending.name || `图片${index + 1}`, 'image');
          restoreTransparentHitTesting(img);
          canvas.add(img);
          if (images.length === 1) canvas.setActiveObject(img);
        }

        if (!isCurrentDraftOwner()) return;
        canvas.renderAll();
        useEditorStore.getState().resetHistory(createHistorySnapshot(canvas));
        useEditorStore.getState().setDirty(false);
        setActiveTool('select');
      } catch (error) {
        console.error('[Editor] 导入图片失败:', error);
        if (isCurrentDraftOwner()) message.error('图片打开失败');
      } finally {
        if (isCurrentDraftOwner()) {
          editorCanvas.__suspendHistory = false;
          setContentLoaded(true);
        }
      }
    };

    canvasLoadQueueRef.current = canvasLoadQueueRef.current
      .catch(() => undefined)
      .then(loadPendingImages);

    return () => {
      cancelled = true;
    };
  }, [activeDraftId, canvas, isNewCanvas, importImagesRequested, loading, contentLoaded, newCanvasWidth, newCanvasHeight, setActiveTool]);

  useEffect(() => {
    if (!canvas || !fileData?.id || !fileData.isPersonalCopy || !contentLoaded) return;
    if (getParsedDocumentPages(fileData).length > 1 && !['pdf', 'ai'].includes(fileData.fileType)) return;

    const editorCanvas = canvas as OwnedFabricCanvas;
    const saveFileId = fileData.id;
    const activeOwner = editorCanvas.__benlaiCanvasOwner;
    if (
      !activeOwner
      || activeOwner.fileId !== saveFileId
      || activeOwner.pageNumber !== routePageNumber
      || activeOwner.generation !== canvasGenerationRef.current
    ) return;
    const saveGeneration = activeOwner.generation;
    let autosaveTimer: number | null = null;
    let pendingSnapshot: { fileId: number; state: Record<string, unknown> } | null = null;

    const flushAutosave = () => {
      const snapshot = pendingSnapshot;
      pendingSnapshot = null;
      if (!snapshot) return;
      saveEditorState(snapshot.fileId, snapshot.state).catch((error) => {
        console.error('[Editor] autosave failed:', error);
      });
    };

    const scheduleAutosave = () => {
      if (editorCanvas.__suspendHistory) return;
      const owner = editorCanvas.__benlaiCanvasOwner;
      if (
        !owner
        || owner.fileId !== saveFileId
        || owner.generation !== saveGeneration
        || owner.pageNumber !== routePageNumber
        || (['pdf', 'ai'].includes(fileData.fileType) && owner.sourceFileId !== (fileData.sourceFileId || null))
      ) return;
      const state = createPersistableCanvasState(canvas, 'autosave snapshot');
      if (!state) return;
      pendingSnapshot = { fileId: saveFileId, state };
      if (autosaveTimer) window.clearTimeout(autosaveTimer);
      autosaveTimer = window.setTimeout(() => {
        autosaveTimer = null;
        flushAutosave();
      }, 800);
    };
    const scheduleRemovalAutosave = () => {
      const owner = editorCanvas.__benlaiCanvasOwner;
      if (['pdf', 'ai'].includes(fileData.fileType) && !editorCanvas.__suspendHistory
        && owner?.fileId === saveFileId && owner.sourceFileId === (fileData.sourceFileId || null)
        && owner.generation === saveGeneration && owner.pageNumber === routePageNumber
        && canvasGenerationRef.current === saveGeneration
        && canvas.getObjects().length === 0) {
        (editorCanvas as any).__benlaiPdfEmptySceneConfirmed = true;
      }
      scheduleAutosave();
    };

    canvas.on('object:added', scheduleAutosave);
    canvas.on('object:modified', scheduleAutosave);
    canvas.on('object:removed', scheduleRemovalAutosave);
    canvas.on('text:changed', scheduleAutosave);

    return () => {
      canvas.off('object:added', scheduleAutosave);
      canvas.off('object:modified', scheduleAutosave);
      canvas.off('object:removed', scheduleRemovalAutosave);
      canvas.off('text:changed', scheduleAutosave);
      if (autosaveTimer) {
        window.clearTimeout(autosaveTimer);
        autosaveTimer = null;
      }
      flushAutosave();
    };
  }, [canvas, fileData?.id, fileData?.isPersonalCopy, contentLoaded, routePageNumber]);

  useEffect(() => {
    if (!canvas || !fileData || !contentLoaded || !isPsdFileType(fileData.fileType) || layers.length === 0) return;
    const repairKey = `${fileData.id || 'draft'}:${layers.length}`;
    if (verticalTextRepairKeyRef.current === repairKey) return;
    verticalTextRepairKeyRef.current = repairKey;

    let cancelled = false;
    const editorCanvas = canvas as fabric.Canvas & { __suspendHistory?: boolean };
    const previousSuspendHistory = editorCanvas.__suspendHistory;
    editorCanvas.__suspendHistory = true;

    const repairedManualLineTexts = repairPsdManualLineHeightsFromSavedState(canvas, layers);

    void repairPsdVerticalTextsFromSavedState(canvas, layers)
      .then((repairedVerticalTexts) => {
        const changed = repairedManualLineTexts || repairedVerticalTexts;
        if (cancelled || !changed) return;
        canvas.renderAll();
        const owner = (canvas as OwnedFabricCanvas).__benlaiCanvasOwner;
        if (
          fileData?.id
          && fileData.isPersonalCopy
          && getParsedDocumentPages(fileData).length <= 1
          && owner?.fileId === fileData.id
          && owner.generation === canvasGenerationRef.current
        ) {
          const repairedState = createPersistableCanvasState(canvas, 'psd text repair');
          if (repairedState) {
            saveEditorState(fileData.id, repairedState).catch((error) => {
              console.error('[Editor] PSD text repair save failed:', error);
            });
          }
        }
        useEditorStore.getState().resetHistory(createHistorySnapshot(canvas));
        useEditorStore.getState().setDirty(false);
      })
      .catch((error) => {
        console.warn('[Editor] PSD vertical text repair failed:', error);
      })
      .finally(() => {
        if (cancelled) return;
        window.setTimeout(() => {
          editorCanvas.__suspendHistory = previousSuspendHistory;
        }, 0);
      });

    return () => {
      cancelled = true;
      editorCanvas.__suspendHistory = previousSuspendHistory;
    };
  }, [canvas, contentLoaded, fileData, layers]);

  const updateCurrentBoardSnapshot = useCallback((targetCanvas: fabric.Canvas | null | undefined) => {
    if (!targetCanvas || !activeBoardKey) return null;
    const owner = (targetCanvas as OwnedFabricCanvas).__benlaiCanvasOwner;
    const ownerBoardKey = owner?.fileId
      ? getFileBoardKey(owner.fileId, owner.pageNumber)
      : owner?.draftId
        ? getDraftBoardKey(owner.draftId)
        : null;
    if (!owner || ownerBoardKey !== activeBoardKey || owner.generation !== canvasGenerationRef.current) {
      console.warn('[Editor] skipped board snapshot for stale canvas owner', { owner, activeBoardKey });
      return null;
    }

    const canvasState = createPersistableCanvasState(targetCanvas, 'board state snapshot');
    if (!canvasState) return null;

    const previewDataUrl = createBoardPreview(targetCanvas, canvasWidth, canvasHeight);
    const boardName = fileName || newCanvasName || '未命名画布';
    updateOpenBoard(activeBoardKey, {
      name: boardName,
      route: `${location.pathname}${location.search}`,
      width: canvasWidth,
      height: canvasHeight,
      previewDataUrl: previewDataUrl || undefined,
    });

    if (activeDraftId && canvasState) {
      writeDraftCanvasState(activeDraftId, {
        name: boardName,
        width: canvasWidth,
        height: canvasHeight,
        canvas: canvasState,
        previewDataUrl: previewDataUrl || undefined,
        updatedAt: Date.now(),
      });
    }

    return canvasState;
  }, [
    activeBoardKey,
    activeDraftId,
    canvasHeight,
    canvasWidth,
    fileName,
    location.pathname,
    location.search,
    newCanvasName,
    updateOpenBoard,
  ]);

  const persistCurrentBoard = useCallback(() => {
    if (!contentLoaded && (['pdf', 'ai'].includes(fileData?.fileType || '') || fileData?.parseStatus === 'failed')) return;
    const currentCanvas = useEditorStore.getState().canvas;
    const owner = (currentCanvas as OwnedFabricCanvas | null)?.__benlaiCanvasOwner;
    if (
      !currentCanvas
      || !owner
      || owner.generation !== canvasGenerationRef.current
      || (fileData?.id && owner.fileId !== fileData.id)
    ) return;
    const canvasState = updateCurrentBoardSnapshot(currentCanvas);
    const isMultiPage = getParsedDocumentPages(fileData).length > 1;
    if (currentCanvas && fileData?.id && fileData.isPersonalCopy && canvasState && (!isMultiPage || ['pdf', 'ai'].includes(fileData.fileType))) {
      saveEditorState(fileData.id, canvasState).catch((error) => {
        console.error('[Editor] save before board switch failed:', error);
      });
    }
  }, [fileData, routePageNumber, contentLoaded, updateCurrentBoardSnapshot]);

  const handleCreateCleanCopy = useCallback(async () => {
    if (!fileData?.sourceFileId) return;
    persistCurrentBoard();
    try {
      const cleanCopy = await useTemplate(fileData.sourceFileId);
      message.success('已从源模板创建干净副本');
      navigate(`/editor/${cleanCopy.id}`);
    } catch (error: any) {
      console.error('[Editor] create clean copy failed:', error);
      message.error(error?.response?.data?.message || '创建干净副本失败');
    }
  }, [fileData?.sourceFileId, navigate, persistCurrentBoard]);

  useEffect(() => {
    if (!canvas || !contentLoaded || !activeBoardKey) return;
    let timer: number | null = null;
    const refresh = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        updateCurrentBoardSnapshot(canvas);
      }, 360);
    };

    refresh();
    canvas.on('object:added', refresh);
    canvas.on('object:modified', refresh);
    canvas.on('object:removed', refresh);
    canvas.on('text:changed', refresh);

    return () => {
      if (timer) window.clearTimeout(timer);
      canvas.off('object:added', refresh);
      canvas.off('object:modified', refresh);
      canvas.off('object:removed', refresh);
      canvas.off('text:changed', refresh);
    };
  }, [activeBoardKey, canvas, contentLoaded, updateCurrentBoardSnapshot]);

  const handleSwitchBoard = useCallback((board: EditorOpenBoard) => {
    if (board.key === activeBoardKey) return;
    persistCurrentBoard();
    navigate(resolveBoardRoute(board));
  }, [activeBoardKey, navigate, persistCurrentBoard]);

  const handleCloseBoard = useCallback((board: EditorOpenBoard) => {
    if (board.key === activeBoardKey && !board.isNew) {
      persistCurrentBoard();
    }
    if (board.draftId) removeDraftCanvasState(board.draftId);

    const index = openBoards.findIndex((item) => item.key === board.key);
    const remaining = openBoards.filter((item) => item.key !== board.key);
    removeOpenBoard(board.key);

    if (board.key !== activeBoardKey) return;
    const nextBoard = remaining[index] || remaining[index - 1];
    if (nextBoard) {
      navigate(resolveBoardRoute(nextBoard));
    } else {
      navigate('/');
    }
  }, [activeBoardKey, navigate, openBoards, persistCurrentBoard, removeOpenBoard]);

  const handleCreateBoard = useCallback(() => {
    persistCurrentBoard();
    const draftId = createDraftId();
    const width = canvasWidth || 1080;
    const height = canvasHeight || 1080;
    const name = '未命名画布';
    const route = `/editor/new?w=${width}&h=${height}&name=${encodeURIComponent(name)}&draftId=${draftId}`;
    upsertOpenBoard(makeDraftOpenBoard({ draftId, route, name, width, height }));
    navigate(route);
  }, [canvasHeight, canvasWidth, navigate, persistCurrentBoard, upsertOpenBoard]);

  // 4. 拖拽文件到编辑器
  const handleMarketplaceTemplateSelect = useCallback((template: DesignFile) => {
    setPendingTemplate({ template, origin: 'marketplace' });
  }, []);

  const handleMyTemplateSelect = useCallback((template: DesignFile) => {
    setPendingTemplate({ template, origin: 'mine' });
  }, []);

  const closeTemplatePlacementPrompt = useCallback(() => {
    if (templatePlacementLoading) return;
    setPendingTemplate(null);
  }, [templatePlacementLoading]);

  const applyTemplatePlacement = useCallback(async (mode: 'replace' | 'append') => {
    if (!pendingTemplate || templatePlacementLoading) return;
    setTemplatePlacementLoading(mode);
    try {
      persistCurrentBoard();
      const targetFile = pendingTemplate.origin === 'marketplace'
        ? await useTemplate(pendingTemplate.template.id)
        : pendingTemplate.template;
      const route = `/editor/${targetFile.id}`;

      if (mode === 'replace' && activeBoardKey) {
        const activeBoard = openBoards.find((board) => board.key === activeBoardKey);
        if (activeBoard?.draftId) removeDraftCanvasState(activeBoard.draftId);
        removeOpenBoard(activeBoardKey);
      } else if (mode === 'append') {
        upsertOpenBoard(makeOpenBoardFromFile(targetFile, route));
      }

      setPendingTemplate(null);
      navigate(route, { replace: mode === 'replace' });
    } catch (error: any) {
      console.error('[Editor] apply template failed:', error);
      message.error(error?.response?.data?.message || '应用模板失败');
    } finally {
      setTemplatePlacementLoading(null);
    }
  }, [
    activeBoardKey,
    navigate,
    openBoards,
    pendingTemplate,
    persistCurrentBoard,
    removeOpenBoard,
    templatePlacementLoading,
    upsertOpenBoard,
  ]);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    if (!canvas) return;
    const file = e.dataTransfer.files[0];
    if (!file) return;

    const ext = file.name.split('.').pop()?.toLowerCase() || '';

    if (['png', 'jpg', 'jpeg', 'svg', 'gif', 'webp'].includes(ext)) {
      // 图片直接加到画布
      const url = URL.createObjectURL(file);
      try {
        const img = await loadFabricImageFromUrl(url);
        if (img.width && img.height) {
          const s = Math.min(canvas.getWidth() / img.width, canvas.getHeight() / img.height, 0.8);
          img.set({
            scaleX: s, scaleY: s,
            left: (canvas.getWidth() - img.width * s) / 2,
            top: (canvas.getHeight() - img.height * s) / 2,
          });
        }
        canvas.add(img);
        restoreTransparentHitTesting(img);
        canvas.setActiveObject(img);
        canvas.renderAll();
      } finally {
        URL.revokeObjectURL(url);
      }
    } else if (['psd', 'psb', 'ai', 'pdf'].includes(ext)) {
      // PSD/AI/PDF — 上传到服务器解析，然后跳转编辑器
      const form = new FormData();
      form.append('file', file);
      try {
        const res = await api.post('/files/upload', form);
        const uploaded = res.data?.data;
        if (uploaded?.id) {
          window.location.href = `/editor/${uploaded.id}`;
        }
      } catch (err) {
        console.error('文件上传失败:', err);
      }
    }
  }, [canvas]);

  useEffect(() => {
    if (!canvas) return;

    const previousSelection = canvas.selection;
    const previousCursor = canvas.defaultCursor;
    const toolCanvas = canvas as fabric.Canvas & {
      hoverCursor?: string;
      moveCursor?: string;
      skipTargetFind?: boolean;
    };
    const previousHoverCursor = toolCanvas.hoverCursor || previousCursor;
    const previousMoveCursor = toolCanvas.moveCursor || previousCursor;
    const previousSkipTargetFind = toolCanvas.skipTargetFind || false;
    const isDrawingTool = activeTool === 'text' || activeTool === 'shape';
    const isHandTool = activeTool === 'hand';
    const cursor = toolCursor(activeTool, shapeTool);
    canvas.selection = !isDrawingTool && activeTool === 'select';
    toolCanvas.skipTargetFind = activeTool === 'shape' || isHandTool;
    if (activeTool === 'shape') canvas.discardActiveObject();
    applyCanvasCursor(
      canvas,
      cursor,
      cursor,
      activeTool === 'select' ? previousMoveCursor : cursor,
    );

    const handleMouseDown = (event: FabricPointerInfo) => {
      if (activeTool === 'text') {
        const target = (
          isEditableFabricTextObject(event.target)
            ? event.target
            : findEditableTextTargetAtPointer(canvas, event)
        ) as fabric.FabricObject & {
          enterEditing?: () => void;
          selectAll?: () => void;
          isEditing?: boolean;
        } | undefined;
        if (target && (target.type === 'i-text' || target.type === 'textbox') && typeof target.enterEditing === 'function') {
          canvas.setActiveObject(target);
          target.enterEditing();
          target.selectAll?.();
          canvas.requestRenderAll();
          setActiveTool('select');
          return;
        }

        const point = getCanvasPoint(canvas, event);
        if (!point) return;
        const text = createTextToolObject(point, textFontSize, textFill);
        canvas.add(text);
        canvas.setActiveObject(text);
        setActiveTool('select');
        canvas.requestRenderAll();
        window.setTimeout(() => {
          text.enterEditing();
          text.selectAll();
          canvas.requestRenderAll();
        }, 0);
        return;
      }

      if (activeTool !== 'shape') return;
      const start = getCanvasPoint(canvas, event);
      if (!start) return;
      const object = createShapeToolObject(shapeTool, start, {
        fill: shapeFill,
        stroke: shapeStroke,
        strokeWidth: shapeStrokeWidth,
        radius: shapeRadius,
      });
      drawingShapeRef.current = { object, start, shape: shapeTool };
      canvas.add(object);
      canvas.setActiveObject(object);
      canvas.requestRenderAll();
    };

    const handleMouseMove = (event: FabricPointerInfo) => {
      const draft = drawingShapeRef.current;
      if (!draft) return;
      const pointer = getCanvasPoint(canvas, event);
      if (!pointer) return;
      updateShapeToolObject(draft.object, draft.shape, draft.start, pointer);
      draft.object.setCoords();
      canvas.requestRenderAll();
    };

    const handleMouseUp = () => {
      const draft = drawingShapeRef.current;
      if (!draft) return;
      finalizeShapeToolObject(draft.object, draft.shape, draft.start);
      draft.object.setCoords();
      canvas.setActiveObject(draft.object);
      canvas.fire('object:modified', { target: draft.object });
      setActiveTool('select');
      canvas.requestRenderAll();
      drawingShapeRef.current = null;
    };

    canvas.on('mouse:down', handleMouseDown);
    canvas.on('mouse:move', handleMouseMove);
    canvas.on('mouse:up', handleMouseUp);

    return () => {
      drawingShapeRef.current = null;
      canvas.selection = previousSelection;
      toolCanvas.skipTargetFind = previousSkipTargetFind;
      applyCanvasCursor(canvas, previousCursor, previousHoverCursor, previousMoveCursor);
      canvas.off('mouse:down', handleMouseDown);
      canvas.off('mouse:move', handleMouseMove);
      canvas.off('mouse:up', handleMouseUp);
    };
  }, [
    canvas,
    activeTool,
    textFontSize,
    textFill,
    shapeTool,
    shapeFill,
    shapeStroke,
    shapeStrokeWidth,
    shapeRadius,
    setActiveTool,
  ]);

  const beginPreviewTextEditing = useCallback(async (target: fabric.FabricObject | null | undefined) => {
    const currentCanvas = useEditorStore.getState().canvas;
    if (!currentCanvas) return;
    if (enterFabricTextEditing(currentCanvas, target)) return;
    if (isPdfSourceTextActivationObject(target)) {
      try {
        const text = await enterPdfSourceTextEditing(currentCanvas, target);
        currentCanvas.fire('object:modified', { target: text });
      } catch (error) {
        console.error('[Editor] PDF/AI source text edit failed:', error);
        message.error('源文件文字编辑初始化失败');
      }
      return;
    }
    if (!isPsdTextPreviewObject(target)) return;
    try {
      const text = await enterPsdTextPreviewEditing(currentCanvas, target);
      currentCanvas.fire('object:modified', { target: text });
    } catch (error) {
      console.error('[Editor] PSD text preview edit failed:', error);
      message.error('文字编辑初始化失败');
    }
  }, []);

  // 5. 双击进入文字编辑（快捷键统一在 useEditorHotkeys）
  useEffect(() => {
    if (!canvas) return;
    let lastHandledAt = 0;
    const runDoubleClickTextLogic = (event: FabricPointerInfo) => {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (now - lastHandledAt < 120) return;
      lastHandledAt = now;

      const target = event.target as fabric.FabricObject | null | undefined;
      const subTarget = target?.type === 'group' ? getGroupSubTarget(event) : null;

      const textTargetAtPointer = findEditableTextTargetAtPointer(canvas, event);
      if (enterDoubleClickTextTarget(canvas, event, textTargetAtPointer, beginPreviewTextEditing)) return;
      if (enterDoubleClickTextTarget(canvas, event, subTarget, beginPreviewTextEditing)) return;
      if (enterDoubleClickTextTarget(canvas, event, target, beginPreviewTextEditing)) return;

      if (target?.type === 'group') {
        if (subTarget && activateGroupSubTarget(canvas, event, subTarget)) {
          return;
        }
      }
      void beginPreviewTextEditing(target);
    };
    const handleMouseDoubleClick = (event: FabricPointerInfo) => {
      runDoubleClickTextLogic(event);
    };
    const handleNativeDoubleClick = (event: MouseEvent) => {
      if (!isNativeEventInsideEditorCanvas(canvas, event)) return;
      runDoubleClickTextLogic({
        e: event,
        target: null,
        subTargets: [],
      } as unknown as FabricPointerInfo);
    };
    const eventElements = getEditorCanvasEventElements(canvas);
    (canvas as any).on('mouse:dblclick', handleMouseDoubleClick);
    eventElements.forEach((element) => element.addEventListener('dblclick', handleNativeDoubleClick, true));
    document.addEventListener('dblclick', handleNativeDoubleClick, true);
    return () => {
      (canvas as any).off('mouse:dblclick', handleMouseDoubleClick);
      eventElements.forEach((element) => element.removeEventListener('dblclick', handleNativeDoubleClick, true));
      document.removeEventListener('dblclick', handleNativeDoubleClick, true);
    };
  }, [canvas, beginPreviewTextEditing]);

  useEditorHotkeys({ onBeginPreviewTextEdit: beginPreviewTextEditing });

  useEffect(() => {
    if (!canvas) return;
    const handleHistoryRestored = () => {
      normalizePdfSourceTextHistoryState(canvas, layers, resolvedFontMap);
    };
    (canvas as any).on(HISTORY_RESTORED_EVENT, handleHistoryRestored);
    return () => {
      (canvas as any).off(HISTORY_RESTORED_EVENT, handleHistoryRestored);
    };
  }, [canvas, layers, resolvedFontMap]);

  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();

      const store = useEditorStore.getState();
      const step = Math.abs(event.deltaY) > 80 ? 10 : 5;
      store.setZoom(store.zoom + (event.deltaY < 0 ? step : -step));
    };

    document.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => document.removeEventListener('wheel', onWheel, true);
  }, []);

  const handleRetryParse = useCallback(async () => {
    if (!fileData?.id || parseRetrying) return;
    const retryFileId = fileData.id;
    const generation = canvasGenerationRef.current;
    setParseRetrying(true);
    try {
      if (canvas && contentLoaded && fileData.isPersonalCopy) {
        const owner = (canvas as OwnedFabricCanvas).__benlaiCanvasOwner;
        if (owner?.fileId !== retryFileId || owner.generation !== generation) return;
        const state = createPersistableCanvasState(canvas, 'manual parse retry');
        if (state) await saveEditorState(retryFileId, state);
      }
      if (canvasGenerationRef.current !== generation) return;
      await api.post(`/files/${retryFileId}/parse`);
      if (canvasGenerationRef.current === generation) setParseReloadKey((value) => value + 1);
    } catch (error: any) {
      if (canvasGenerationRef.current === generation) {
        message.error(error?.response?.data?.message || '重新解析失败，请稍后重试');
      }
    } finally {
      if (canvasGenerationRef.current === generation) setParseRetrying(false);
    }
  }, [fileData, parseRetrying, canvas, contentLoaded]);

  const handleKeepReviewedEmptyPdfState = useCallback(async () => {
    if (!canvas || !fileData || !emptyPdfStateReview || parseRetrying) return;
    const state = createConfirmedEmptyPdfState(canvas, fileData, routePageNumber, canvasGenerationRef.current, emptyPdfStateReview);
    if (!state) return;
    setParseRetrying(true);
    try {
      await saveEditorState(fileData.id, state);
      if (canvasGenerationRef.current !== emptyPdfStateReview.generation) return;
      setEmptyPdfStateReview(null);
      setPreviewLoadError(null);
      setContentLoaded(true);
      useEditorStore.getState().resetHistory(createHistorySnapshot(canvas));
      useEditorStore.getState().setDirty(false);
    } catch (error) {
      message.error((error as { response?: { data?: { message?: string } } })?.response?.data?.message || '空白画布保存失败，原保存记录仍保留。');
    } finally {
      if (canvasGenerationRef.current === emptyPdfStateReview.generation) setParseRetrying(false);
    }
  }, [canvas, fileData, routePageNumber, emptyPdfStateReview, parseRetrying]);

  const parseFailed = fileData?.parseStatus === 'failed' || fileData?.parseFreshness?.state === 'failed' || fileData?.sourceParseStatus === 'failed';
  const parseFailureReason = fileData?.sourceParseError || (typeof fileData?.parseResult?.error === 'string'
    ? fileData.parseResult.error
    : '文件未能完成解析，请手动重新解析或重新上传。');
  const failureSavedState = parseFailed && fileData ? getEditorStateForDocumentPage(fileData, routePageNumber) : null;
  const canOpenFailureSavedState = Boolean(
    fileData?.isPersonalCopy
    && failureSavedState
    && !hasEditorStateOwnerMismatch(fileData, failureSavedState, routePageNumber)
    && !failedCanvasUnavailable
  );
  const canOpenRetainedResult = fileData?.parseResult?.hasRetainedResult === true && layers.length > 0 && !failedCanvasUnavailable;

  const activePanelPage = getParsedDocumentPage(fileData, routePageNumber);
  const rawPanelLayers = fileData?.fileType === 'ai' || fileData?.fileType === 'pdf'
    ? filterParsedLayersForPage(removePreviewLayers(layers), activePanelPage?.page)
    : layers;
  const panelLayers = foldSvgVectorAtomPanelLayers(rawPanelLayers);
  const parsedLayerCount = !parseFailed && fileData?.parseResult
    ? isImportedVectorType(fileData.fileType) && contentLoaded
      ? panelLayers.length
      : panelLayers.length || Number((fileData.parseResult as Record<string, unknown>).layerCount ?? 0)
    : null;

  if (loading) {
    return (
      <div style={{ height: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg-app)' }}>
        <div style={{ textAlign: 'center' }}>
          <Spin size="large" />
          <div style={{ marginTop: 16, font: 'var(--type-body)', color: 'var(--fg-3)' }}>
            {fileData && shouldWaitForParseFreshness(fileData)
              ? `正在更新 ${fileData.fileType.toUpperCase()} 的解析结果，请稍候...`
              : '加载中...'}
          </div>
        </div>
      </div>
    );
  }

  if (parseFailed && !canOpenFailureSavedState && !canOpenRetainedResult) {
    return (
      <div role="alert" style={{ height: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg-app)' }}>
        <div style={{ maxWidth: 600, padding: 24, textAlign: 'center' }}>
          <h2 style={{ color: '#B42318' }}>文件解析失败</h2>
          <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{parseFailureReason}</p>
          <p>本次解析未完成，无法打开新的编辑内容；原文件和已保存的编辑内容仍保留。</p>
          <button type="button" disabled={parseRetrying} onClick={() => void handleRetryParse()}>
            {parseRetrying ? '正在加入解析队列...' : '手动重新解析'}
          </button>
          <button type="button" style={{ marginLeft: 12 }} onClick={() => navigate('/')}>
            返回资源库
          </button>
        </div>
      </div>
    );
  }

  if (previewLoadError && !emptyPdfStateReview) {
    return <div role="alert" style={{ padding: 32, textAlign: 'center' }}>
      <p>{previewLoadError}</p>
      <button type="button" onClick={() => setParseReloadKey((key) => key + 1)}>重新加载</button>
      <button type="button" disabled={parseRetrying} style={{ marginLeft: 12 }} onClick={() => void handleRetryParse()}>手动重新解析</button>
      <button type="button" style={{ marginLeft: 12 }} onClick={() => navigate('/')}>返回资源库</button>
    </div>;
  }

  return (
    <div
      style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      <EditorToolbar
        fileName={fileName}
        sourceFileType={fileData?.fileType}
        canCreateCleanCopy={Boolean(fileData?.isPersonalCopy && fileData.sourceFileId)}
        onCreateCleanCopy={handleCreateCleanCopy}
      />
      {emptyPdfStateReview && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'grid', placeItems: 'center', background: 'rgba(17,24,39,0.58)' }}>
          <div role="dialog" aria-modal="true" aria-label="确认已保存的空白画布" style={{ maxWidth: 560, padding: 32, borderRadius: 12, background: '#fff', textAlign: 'center' }}>
            <h2>确认已保存的空白画布</h2>
            <p>这个画板的旧保存记录为空，无法确认是否曾主动清空。原记录仍保留，请选择继续使用空白画布，或从原件新建副本。</p>
            <button type="button" autoFocus disabled={parseRetrying} onClick={() => void handleKeepReviewedEmptyPdfState()}>继续使用已保存空白</button>
            {fileData?.sourceFileId && <button type="button" disabled={parseRetrying} style={{ marginLeft: 12 }} onClick={() => void handleCreateCleanCopy()}>从原件新建副本</button>}
            <button type="button" style={{ marginLeft: 12 }} onClick={() => navigate('/')}>返回资源库</button>
          </div>
        </div>
      )}
      {parseFailed && (
        <div role="alert" style={{ padding: '8px 16px', background: '#FEF3F2', color: '#B42318', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ flex: 1, overflowWrap: 'anywhere' }}>
            原文件解析失败：{parseFailureReason} {canOpenFailureSavedState ? '当前显示已保存的编辑内容。' : '当前显示上次成功解析的内容。'}
          </span>
          <button type="button" disabled={parseRetrying} onClick={() => void handleRetryParse()}>
            {parseRetrying ? '正在加入解析队列...' : '手动重新解析'}
          </button>
        </div>
      )}
      {!parseFailed && ['pdf', 'ai'].includes(fileData?.fileType || '') && activePanelPage?.previewOnly && (
        <div role="status" style={{ padding: '8px 16px', background: '#FFF8E6', color: '#8A6300' }}>
          已保留原页完整外观。可添加文字和图片；部分原有元素暂不能单独修改。
        </div>
      )}
      {!parseFailed && ['pdf', 'ai'].includes(fileData?.fileType || '') && activePanelPage && activePanelPage.page === routePageNumber
        && !activePanelPage.previewOnly && activePanelPage.svgFidelityMethod === 'cairo-source'
        && Boolean(activePanelPage.svgPath?.trim()) && (
        <div role="status" style={{ padding: '8px 16px', background: '#FFF8E6', color: '#8A6300' }}>
          转曲文字和复合效果可移动、缩放，不能直接修改字词；细密纹理可能有少量显示差异。
        </div>
      )}
      {isPsdFileType(fileData?.fileType) && psdDiagnostics.length > 0 && (
        <details role="status" style={{ padding: '8px 16px', background: '#FFF8E6', color: '#8A6300', maxHeight: 180, overflowY: 'auto' }}>
          <summary style={{ cursor: 'pointer' }}>部分图层需要注意（{psdDiagnostics.length} 项）</summary>
          <ul style={{ margin: '8px 0', paddingLeft: 20 }}>
            {psdDiagnostics.map((item) => <li key={`${item.code}:${item.layerKey || ''}:${item.message}`}>
              {item.layerName ? `${item.layerName}：` : ''}{item.message}
            </li>)}
          </ul>
        </details>
      )}
      {isPsdFileType(fileData?.fileType) && contentLoaded && Boolean(((canvas as PsdImportCanvas | null)?.__psdScene as { compositeImagePath?: string } | undefined)?.compositeImagePath) && (
        <div style={{ padding: '6px 16px', display: 'flex', alignItems: 'center', gap: 12, background: 'var(--bg-panel)' }}>
          <button type="button" onClick={() => {
            const session = (canvas as PsdImportCanvas | null)?.__psdSceneSession;
            if (!session) return;
            const next = !(session.getSourcePreview?.() ?? psdSourcePreview);
            session.setSourcePreview(next);
            setPsdSourcePreview(session.getSourcePreview?.() ?? next);
            (canvas as any).fire('object:modified', {});
          }}>{psdSourcePreview ? '返回编辑结果' : '查看原稿对照'}</button>
          {psdSourcePreview && <span style={{ font: 'var(--type-caption)', color: 'var(--fg-3)' }}>原稿对照不包含后续编辑。</span>}
        </div>
      )}
      {missingFonts && missingFonts.length > 0 && (
        <div
          style={{
            background: '#FFF8E6',
            borderBottom: '1px solid #F5D78F',
            padding: '8px 16px',
            font: '500 13px var(--font-sans)',
            color: '#8A6300',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <span>
            ⚠️ 此 PSD 用到 {missingFonts.length} 个字体未上传到画布，对应文字层已锁定直接编辑；请先替换为可用字体：
            <span style={{ marginLeft: 6, color: '#5C4500', fontWeight: 600 }}>
              {missingFonts.slice(0, 5).join(' / ')}
              {missingFonts.length > 5 ? ` … 等 ${missingFonts.length} 个` : ''}
            </span>
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => setActivePanel('text')}
            style={{
              background: '#F5D78F',
              border: 'none',
              borderRadius: 4,
              padding: '4px 12px',
              font: '500 12px var(--font-sans)',
              color: '#5C4500',
              cursor: 'pointer',
            }}
          >
            上传字体 →
          </button>
          <button
            type="button"
            onClick={() => setMissingFonts([])}
            title="知道了"
            style={{
              background: 'transparent',
              border: 'none',
              color: '#8A6300',
              cursor: 'pointer',
              fontSize: 16,
              lineHeight: 1,
              padding: 0,
            }}
          >
            ×
          </button>
        </div>
      )}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <ToolRail activePanel={activePanel} onPanelChange={setActivePanel} />
        {activePanel === 'templates' ? (
          <React.Suspense fallback={<PanelLoading />}>
            <TemplatePanel libraryId={fileData?.libraryId} onTemplateSelect={handleMarketplaceTemplateSelect} />
          </React.Suspense>
        ) : activePanel === 'mine' ? (
          <React.Suspense fallback={<PanelLoading />}>
            <MyTemplatePanel onTemplateSelect={handleMyTemplateSelect} />
          </React.Suspense>
        ) : (
          <div style={editorSidePanelStyle}>
            {activePanel === 'text' ? (
              <div style={toolPanelStyle}>
                <div style={toolPanelTitleStyle}>文字</div>
                {!canvas && engine ? (
                  <button type="button" onClick={addNativeText} style={nativePanelButtonStyle}>
                    添加文字
                  </button>
                ) : null}
              </div>
            ) : activePanel === 'shapes' ? (
              <div style={toolPanelStyle}>
                <div style={toolPanelTitleStyle}>形状</div>
                <div style={shapeGridStyle}>
                  <button type="button" onClick={() => activateShapeTool('rect')} style={shapeButtonStyle(activeTool === 'shape' && shapeTool === 'rect')}>
                    <Square size={24} />
                    <span>矩形</span>
                  </button>
                  <button type="button" onClick={() => activateShapeTool('ellipse')} style={shapeButtonStyle(activeTool === 'shape' && shapeTool === 'ellipse')}>
                    <CircleIcon size={24} />
                    <span>椭圆</span>
                  </button>
                  <button type="button" onClick={() => activateShapeTool('triangle')} style={shapeButtonStyle(activeTool === 'shape' && shapeTool === 'triangle')}>
                    <TriangleIcon size={24} />
                    <span>三角形</span>
                  </button>
                  <button type="button" onClick={() => activateShapeTool('line')} style={shapeButtonStyle(activeTool === 'shape' && shapeTool === 'line')}>
                    <Minus size={24} />
                    <span>线条</span>
                  </button>
                </div>
              </div>
            ) : activePanel === 'images' ? (
              <div style={{ padding: 18, color: '#525b66', font: '600 13px var(--font-sans)', lineHeight: 1.7 }}>
                图片可以直接拖入画布，或从顶部文件入口添加。
              </div>
            ) : activePanel === 'layers' ? (
              <React.Suspense fallback={<PanelLoading compact />}>
                <LayerPanel layers={panelLayers as never[]} fileType={fileData?.fileType} />
              </React.Suspense>
            ) : (
              <div style={{ padding: 18, color: '#525b66', font: '600 13px var(--font-sans)', lineHeight: 1.7 }}>
                请选择左侧工具开始编辑。
              </div>
            )}
          </div>
        )}
        <div style={canvasStageWrapStyle}>
          <EditorCanvas />
          {contentLoading && !contentLoaded && (
            <div style={contentLoadingOverlayStyle}>
              <Spin size="large" />
              <div style={contentLoadingTextStyle}>正在加载图层...</div>
            </div>
          )}
          <BoardSwitcher
            boards={openBoards}
            activeKey={activeBoardKey}
            onSwitch={handleSwitchBoard}
            onClose={handleCloseBoard}
            onCreate={handleCreateBoard}
          />
        </div>
        <React.Suspense fallback={<RightPanelLoading />}>
          <RightPanel />
        </React.Suspense>
      </div>
      {pendingTemplate && (
        <TemplatePlacementPrompt
          loadingMode={templatePlacementLoading}
          onClose={closeTemplatePlacementPrompt}
          onReplace={() => void applyTemplatePlacement('replace')}
          onAppend={() => void applyTemplatePlacement('append')}
        />
      )}
      <div style={{
        height: 32, padding: '0 16px', background: '#fff', borderTop: '1px solid var(--border-1)',
        display: 'flex', alignItems: 'center', gap: 12, font: 'var(--type-caption)', color: 'var(--fg-3)',
      }}>
        <span>{fileName}</span>
        {fileData && <span style={{ padding: '1px 6px', borderRadius: 3, background: 'var(--n-100)', font: '500 10px var(--font-sans)', textTransform: 'uppercase' }}>{fileData.fileType}</span>}
        {isNewCanvas && <span style={{ padding: '1px 6px', borderRadius: 3, background: 'var(--brand-teal-50)', color: 'var(--brand-teal-600)', font: '500 10px var(--font-sans)' }}>新建</span>}
        {parsedLayerCount !== null && <span style={{ padding: '1px 6px', borderRadius: 3, background: 'var(--color-success-bg)', color: 'var(--color-success-fg)', font: '500 10px var(--font-sans)' }}>{parsedLayerCount} 图层</span>}
        <div style={{ flex: 1 }} />
        <span>{canvasWidth} x {canvasHeight}</span>
        <span>{zoom}%</span>
      </div>
    </div>
  );
}

function PanelLoading({ compact = false }: { compact?: boolean }) {
  return (
    <div style={compact ? sidePanelLoadingStyle : panelLoadingStyle}>
      <Spin size="small" />
    </div>
  );
}

function RightPanelLoading() {
  return (
    <div style={rightPanelLoadingStyle}>
      <Spin size="small" />
    </div>
  );
}

function TemplatePlacementPrompt({
  loadingMode,
  onClose,
  onReplace,
  onAppend,
}: {
  loadingMode: 'replace' | 'append' | null;
  onClose: () => void;
  onReplace: () => void;
  onAppend: () => void;
}) {
  return (
    <div style={templatePromptOverlayStyle} role="presentation">
      <div style={templatePromptCardStyle} role="dialog" aria-modal="true" aria-label="添加到作品">
        <div style={templatePromptHeaderStyle}>
          <span style={templatePromptIconStyle}>?</span>
          <div>
            <div style={templatePromptTitleStyle}>添加到作品</div>
            <div style={templatePromptDescStyle}>使用模板后，模板内容将添加到作品</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={loadingMode !== null}
            aria-label="关闭"
            style={templatePromptCloseStyle}
          >
            ×
          </button>
        </div>
        <div style={templatePromptActionsStyle}>
          <button
            type="button"
            onClick={onReplace}
            disabled={loadingMode !== null}
            style={templatePromptSecondaryButtonStyle}
          >
            {loadingMode === 'replace' ? '替换中...' : '替换当前画板'}
          </button>
          <button
            type="button"
            onClick={onAppend}
            disabled={loadingMode !== null}
            style={templatePromptPrimaryButtonStyle}
          >
            {loadingMode === 'append' ? '添加中...' : '添加为新画板'}
          </button>
        </div>
      </div>
    </div>
  );
}

const templatePromptOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 50,
  display: 'grid',
  placeItems: 'start center',
  paddingTop: 80,
  background: 'rgba(17, 24, 39, 0.58)',
};

const templatePromptCardStyle: React.CSSProperties = {
  width: 320,
  minHeight: 118,
  borderRadius: 12,
  background: '#fff',
  boxShadow: '0 18px 46px rgba(15, 23, 42, 0.22)',
  padding: '20px 20px 14px',
};

const templatePromptHeaderStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '20px minmax(0, 1fr) 22px',
  alignItems: 'start',
  gap: 10,
};

const templatePromptIconStyle: React.CSSProperties = {
  width: 16,
  height: 16,
  marginTop: 2,
  borderRadius: '50%',
  display: 'grid',
  placeItems: 'center',
  background: '#ff9f2d',
  color: '#fff',
  font: '800 11px var(--font-sans)',
};

const templatePromptTitleStyle: React.CSSProperties = {
  color: '#111827',
  font: '700 14px var(--font-sans)',
};

const templatePromptDescStyle: React.CSSProperties = {
  marginTop: 9,
  color: '#8b949e',
  font: '500 12px var(--font-sans)',
};

const templatePromptCloseStyle: React.CSSProperties = {
  width: 22,
  height: 22,
  border: 0,
  padding: 0,
  background: 'transparent',
  color: '#9aa1aa',
  cursor: 'pointer',
  font: '400 20px/20px var(--font-sans)',
};

const templatePromptActionsStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  marginTop: 32,
};

const templatePromptSecondaryButtonStyle: React.CSSProperties = {
  height: 32,
  border: 0,
  borderRadius: 8,
  padding: '0 14px',
  background: '#f1f3f5',
  color: '#4b5563',
  cursor: 'pointer',
  font: '700 12px var(--font-sans)',
};

const templatePromptPrimaryButtonStyle: React.CSSProperties = {
  height: 32,
  border: 0,
  borderRadius: 8,
  padding: '0 14px',
  background: '#14171c',
  color: '#fff',
  cursor: 'pointer',
  font: '700 12px var(--font-sans)',
};

const editorSidePanelStyle: React.CSSProperties = {
  width: 260,
  background: '#fff',
  borderRight: '1px solid #eceff3',
  display: 'flex',
  flexDirection: 'column',
  flexShrink: 0,
};

const panelLoadingStyle: React.CSSProperties = {
  width: 280,
  height: '100%',
  display: 'grid',
  placeItems: 'center',
  background: '#fff',
  borderRight: '1px solid #eceff3',
  flexShrink: 0,
};

const sidePanelLoadingStyle: React.CSSProperties = {
  minHeight: 120,
  display: 'grid',
  placeItems: 'center',
};

const rightPanelLoadingStyle: React.CSSProperties = {
  width: 300,
  height: '100%',
  display: 'grid',
  placeItems: 'center',
  background: '#fff',
  borderLeft: '1px solid var(--border-1)',
  flexShrink: 0,
};

const canvasStageWrapStyle: React.CSSProperties = {
  position: 'relative',
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: 'flex',
};

const contentLoadingOverlayStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 20,
  display: 'grid',
  placeItems: 'center',
  alignContent: 'center',
  gap: 12,
  background: 'rgba(244, 245, 240, 0.78)',
  pointerEvents: 'auto',
};

const contentLoadingTextStyle: React.CSSProperties = {
  color: '#6b7280',
  font: '600 13px var(--font-sans)',
};

const toolPanelStyle: React.CSSProperties = {
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const toolPanelTitleStyle: React.CSSProperties = {
  color: '#111827',
  font: '800 14px var(--font-sans)',
  marginBottom: 4,
};

const nativePanelButtonStyle: React.CSSProperties = {
  height: 38,
  border: '1px solid #d6dae1',
  borderRadius: 8,
  background: '#fff',
  color: '#111827',
  cursor: 'pointer',
  font: '800 13px var(--font-sans)',
};

const shapeGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 10,
};

function shapeButtonStyle(active: boolean): React.CSSProperties {
  return {
    height: 76,
    border: active ? '1px solid #2f62f6' : '1px solid #e5e7eb',
    borderRadius: 8,
    background: active ? '#eef4ff' : '#fff',
    color: active ? '#2557f6' : '#111827',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    cursor: 'pointer',
    font: '800 12px var(--font-sans)',
  };
}

function stripDeadBlobImages(state: Record<string, unknown>): Record<string, unknown> {
  const objects = Array.isArray(state.objects) ? state.objects : [];
  const filtered = objects.filter((object: unknown) => {
    if (!object || typeof object !== 'object') return true;
    const obj = object as Record<string, unknown>;
    const type = String(obj.type || '').toLowerCase();
    if (type !== 'image') return true;
    const src = typeof obj.src === 'string' ? obj.src : '';
    if (src.startsWith('blob:')) {
      console.warn('[Editor] 跳过失效的 blob URL 图层:', obj._layerName || src.slice(0, 64));
      return false;
    }
    return true;
  });
  return { ...state, objects: filtered };
}

function normalizeEditorState(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record.objects)) return sanitizePersistedPdfRasterVisualObjects(record);
  if (record.canvas && typeof record.canvas === 'object') {
    const nested = record.canvas as Record<string, unknown>;
    if (!Array.isArray(nested.objects)) return null;
    return sanitizePersistedPdfRasterVisualObjects({
      ...nested,
      __editorStateOwnerVersion: nested.__editorStateOwnerVersion ?? record.__editorStateOwnerVersion,
      __fileId: nested.__fileId ?? record.__fileId,
      __sourceFileId: nested.__sourceFileId ?? record.__sourceFileId,
      __pageNumber: nested.__pageNumber ?? record.__pageNumber,
    });
  }
  return null;
}

function hasEditorStateOwnerMismatch(
  fileData: DesignFile,
  state: Record<string, unknown>,
  pageNumber: number,
): boolean {
  const ownerVersion = Number(state.__editorStateOwnerVersion);
  if (!Number.isFinite(ownerVersion) || ownerVersion < 1) return false;
  const stateFileId = Number(state.__fileId);
  const statePageNumber = Number(state.__pageNumber);
  const rawSourceFileId = state.__sourceFileId;
  const stateSourceFileId = rawSourceFileId === null || rawSourceFileId === undefined
    ? null
    : Number(rawSourceFileId);
  const expectedSourceFileId = fileData.sourceFileId || null;
  return stateFileId !== fileData.id
    || statePageNumber !== pageNumber
    || stateSourceFileId !== expectedSourceFileId;
}

function getEditorStateForDocumentPage(fileData: DesignFile, pageNumber: number): Record<string, unknown> | null {
  // Normalization repairs preview flags. Keep those repairs off the existing
  // PDF snapshot until the user explicitly saves the recovered current page.
  const value = ['pdf', 'ai'].includes(fileData.fileType) && fileData.editorState && typeof fileData.editorState === 'object'
    ? cloneSerializedRecord(fileData.editorState as Record<string, unknown>) : fileData.editorState;
  const root = normalizeEditorState(value);
  if (!root) return null;
  if (['pdf', 'ai'].includes(fileData.fileType) && (fileData.parseStatus === 'failed' || getParsedDocumentPages(fileData).length > 1 || Boolean(root.__pageStates))) {
    const pages = root.__pageStates;
    if (pages && typeof pages === 'object' && !Array.isArray(pages)) {
      const saved = normalizeEditorState((pages as Record<string, unknown>)[String(pageNumber)]);
      if (saved && Number.isFinite(Number(saved.__editorStateOwnerVersion)) && Number(saved.__editorStateOwnerVersion) >= 1
        && !hasEditorStateOwnerMismatch(fileData, saved, pageNumber)) return saved;
    }
    return Number.isFinite(Number(root.__editorStateOwnerVersion)) && Number(root.__editorStateOwnerVersion) >= 1
      && !hasEditorStateOwnerMismatch(fileData, root, pageNumber) ? root : null;
  }
  return root;
}

function shouldUseSavedEditorState(
  fileData: DesignFile,
  state: Record<string, unknown>,
  layers: ParsedLayer[],
  pageNumber: number,
) {
  if (hasEditorStateOwnerMismatch(fileData, state, pageNumber)) return false;
  const objects = Array.isArray(state.objects) ? state.objects : [];
  const pdfParserVersion = Number(fileData.parseResult?.pdfParserVersion);
  const aiParserVersion = Number(fileData.parseResult?.aiParserVersion);
  const importedSvgRoleModelVersion = Number(state.__importedSvgRoleModelVersion);
  const usesCurrentSvgRoleModel = importedSvgRoleModelVersion >= IMPORTED_SVG_ROLE_MODEL_VERSION;
  if (
    fileData.fileType === 'ai'
    && (!Number.isFinite(aiParserVersion) || aiParserVersion < CURRENT_AI_PARSER_VERSION)
  ) {
    return false;
  }
  if (
    fileData.fileType === 'pdf'
    && (!Number.isFinite(pdfParserVersion) || pdfParserVersion < CURRENT_PDF_PARSER_VERSION)
    && !hasReliableLegacyEditablePdfMetadata(fileData.parseResult)
    && !isCompatibleLegacyPdfEditorState(fileData, state, pageNumber)
  ) {
    return false;
  }
  const page = getParsedDocumentPage(fileData, pageNumber);
  if (['pdf', 'ai'].includes(fileData.fileType) && page?.previewOnly) {
    return Number(fileData.fileType === 'ai' ? state.__aiParserVersion : state.__pdfParserVersion) === (fileData.fileType === 'ai' ? aiParserVersion : pdfParserVersion) && objects.some((object) => {
      const record = object as Record<string, unknown>;
      return record?._pdfPreviewOnlyBackground === true
        && Number(record._pdfPreviewOnlyPage) === pageNumber
        && record._pdfPreviewOnlyPath === page.previewPath;
    });
  }
  if (['pdf', 'ai'].includes(fileData.fileType) && collectSerializedCanvasObjects(state).some((record) => record._pdfPreviewOnlyBackground === true)) {
    return false;
  }
  if (isImportedVectorType(fileData.fileType) && savedStateUsesStaleImportedTextPreviewMode(state)) {
    return false;
  }
  if (isImportedVectorType(fileData.fileType) && savedStateHasOcrImportedTextObject(state)) {
    return false;
  }
  if (isImportedVectorType(fileData.fileType) && savedStateHasInteractivePdfRasterVisualObject(state)) {
    return false;
  }
  if (isImportedVectorType(fileData.fileType) && savedStateHasPdfAuxiliaryPreviewObject(state)) {
    return false;
  }
  // A complete, owned current PDF snapshot can intentionally remove source
  // objects. Legacy snapshots still pass the import-completeness checks below.
  if (isCompleteCurrentPdfEditorState(fileData, state, pageNumber)) {
    return !savedStateHasPdfImportedTextObject(state);
  }
  if (isCompatibleLegacyPdfEditorState(fileData, state, pageNumber)) {
    return !savedStateHasPdfImportedTextObject(state);
  }
  if (isImportedVectorType(fileData.fileType) && savedStateLooksLikeLegacyImportedSvgFragments(state)) {
    return false;
  }
  if (
    isImportedVectorType(fileData.fileType)
    && !usesCurrentSvgRoleModel
    && savedStateHasUnpairedSvgDecorationMembers(state)
  ) {
    return false;
  }
  if (
    isImportedVectorType(fileData.fileType)
    && fileData.parseResult?.textLayersAreMetadata === true
    && savedStateHasPdfImportedTextObject(state)
  ) {
    return false;
  }
  if (fileData.fileType === 'ai' && aiParserVersion >= CURRENT_AI_PARSER_VERSION) {
    // Owned editable AI52 history is authoritative, including removed source vectors.
    if (Number(state.__aiParserVersion) >= 52 && Number(state.__aiParserVersion) < aiParserVersion
      && Number(state.__editorStateOwnerVersion) >= 1 && usesCurrentSvgRoleModel
      && objects.length > 0 && hasTrustedSavedPdfContent(state)) return true;
    if (getExpectedSvgInteractiveVectorCount(fileData, pageNumber) > 0 && !savedStateHasSvgInteractiveVectorObject(state)) {
      return false;
    }
    return (Number(state.__aiParserVersion) === aiParserVersion
        || (Number(state.__aiParserVersion) >= 52 && Number(state.__aiParserVersion) < aiParserVersion
          && Number(state.__editorStateOwnerVersion) >= 1))
      && usesCurrentSvgRoleModel
      && !savedStateHasPdfImportedTextObject(state)
      && objects.length > 0
      && savedStateHasPdfEditableObject(state);
  }
  if (fileData.fileType === 'pdf' && pdfParserVersion >= CURRENT_PDF_PARSER_VERSION) {
    const expectedRasterCount = getExpectedPdfExportableRasterCount(fileData, layers, pageNumber);
    if (expectedRasterCount > 0 && countSavedStatePdfExportableImageObjects(state) < expectedRasterCount) {
      return false;
    }
    if (getExpectedSvgInteractiveVectorCount(fileData, pageNumber) > 0 && !savedStateHasSvgInteractiveVectorObject(state)) {
      return false;
    }
    return Number(state.__pdfParserVersion) === pdfParserVersion
      && usesCurrentSvgRoleModel
      && !savedStateHasPdfImportedTextObject(state)
      && savedStateHasPdfEditableObject(state);
  }
  if (fileData.fileType === 'pdf' && hasPdfPageRasterLayer(layers)) {
    return savedStateHasPdfPageRasterObject(state, layers) && !savedStateHasPdfImportedTextObject(state);
  }
  if (isImportedVectorType(fileData.fileType)) return false;
  if (objects.length > 0) return true;
  return !(isPsdFileType(fileData.fileType) && getCanvasRenderableLayers(layers).length > 0);
}

function isCompleteCurrentPdfEditorState(fileData: DesignFile, state: Record<string, unknown>, pageNumber: number): boolean {
  const isAi = fileData.fileType === 'ai';
  const parserVersion = Number(isAi ? fileData.parseResult?.aiParserVersion : fileData.parseResult?.pdfParserVersion);
  return ['pdf', 'ai'].includes(fileData.fileType)
    && parserVersion >= (isAi ? CURRENT_AI_PARSER_VERSION : CURRENT_PDF_PARSER_VERSION)
    && Number.isFinite(Number(state.__editorStateOwnerVersion))
    && Number(state.__editorStateOwnerVersion) >= 1
    && !hasEditorStateOwnerMismatch(fileData, state, pageNumber)
    && (Number(state.__pdfSceneCompleteVersion) === 2
      || (Number(state.__pdfSceneCompleteVersion) === 1 && hasTrustedSavedPdfContent(state)))
    && Number(isAi ? state.__aiParserVersion : state.__pdfParserVersion) === parserVersion
    && Number(state.__importedSvgRoleModelVersion) >= IMPORTED_SVG_ROLE_MODEL_VERSION;
}

function isCompatibleLegacyPdfEditorState(fileData: DesignFile, state: Record<string, unknown>, pageNumber: number): boolean {
  const parserVersion = Number(fileData.parseResult?.pdfParserVersion);
  return fileData.fileType === 'pdf'
    && parserVersion >= 77
    && Number.isFinite(Number(state.__editorStateOwnerVersion))
    && Number(state.__editorStateOwnerVersion) >= 1
    && !hasEditorStateOwnerMismatch(fileData, state, pageNumber)
    && Number(state.__pdfParserVersion) >= 77
    && Number(state.__pdfParserVersion) <= parserVersion
    && (Number(state.__pdfParserVersion) === 77 || [1, 2].includes(Number(state.__pdfSceneCompleteVersion)))
    && Number(state.__importedSvgRoleModelVersion) >= IMPORTED_SVG_ROLE_MODEL_VERSION
    && (Number(state.__pdfSceneCompleteVersion) === 2 || hasTrustedSavedPdfContent(state));
}

function hasTrustedSavedPdfContent(state: Record<string, unknown>): boolean {
  return collectSerializedCanvasObjects(state).some((record) => {
    if (isRecoverableUserSerializedObject(record)) return true;
    if (isSerializedPdfAuxiliaryPreviewObject(record) || isPdfRasterVisualRecord(record)
      || record._pdfMaskArtifact === true || record._pdfTextPath === true
      || record._svgDecorationMember === true || record._svgDecorationVisualOnly === true) return false;
    const role = readSerializedSvgObjectRole(record);
    return Boolean((role && isInteractiveSvgObjectRole(role))
      || record._pdfSourceTextActivation === true || record._pdfSourceTextActivated === true
      || (!role && record._svgImportedAtom === true && Number(record._layerId) < 0));
  });
}

function shouldReviewEmptySavedPdfState(file: DesignFile, state: Record<string, unknown>, pageNumber: number): boolean {
  return ['pdf', 'ai'].includes(file.fileType) && Boolean(file.isPersonalCopy)
    && (file.fileType === 'pdf' || Number(state.__importedSvgRoleModelVersion) >= IMPORTED_SVG_ROLE_MODEL_VERSION)
    && !hasEditorStateOwnerMismatch(file, state, pageNumber)
    && !getParsedDocumentPage(file, pageNumber)?.previewOnly
    && Array.isArray(state.objects) && state.objects.length === 0
    && !(Number(state.__pdfSceneCompleteVersion) === 2
      && (isCompleteCurrentPdfEditorState(file, state, pageNumber) || isCompatibleLegacyPdfEditorState(file, state, pageNumber)));
}

function createConfirmedEmptyPdfState(
  canvas: fabric.Canvas, file: DesignFile, pageNumber: number, generation: number,
  review: { fileId: number; sourceFileId: number | null; pageNumber: number; generation: number },
): Record<string, unknown> | null {
  const owner = (canvas as OwnedFabricCanvas).__benlaiCanvasOwner;
  const parserVersion = Number(file.parseResult?.pdfParserVersion ?? file.parseResult?.aiParserVersion);
  if (!['pdf', 'ai'].includes(file.fileType) || !file.isPersonalCopy || !Number.isFinite(parserVersion) || parserVersion < (file.fileType === 'ai' ? CURRENT_AI_PARSER_VERSION : 77) || !owner
    || review.fileId !== file.id || review.sourceFileId !== (file.sourceFileId || null)
    || review.pageNumber !== pageNumber || review.generation !== generation
    || owner.fileId !== file.id || owner.sourceFileId !== review.sourceFileId
    || owner.pageNumber !== pageNumber || owner.generation !== generation
    || canvas.getObjects().length !== 0) return null;
  if (file.fileType === 'ai') (canvas as any).__benlaiAiParserVersion = Number(file.parseResult?.aiParserVersion);
  (canvas as any).__benlaiPdfParserVersion = parserVersion;
  (canvas as any).__benlaiPdfSceneLoadedVersion = parserVersion;
  (canvas as any).__benlaiPdfSceneCompleteVersion = 2;
  (canvas as any).__benlaiImportedSvgRoleModelVersion = IMPORTED_SVG_ROLE_MODEL_VERSION;
  (canvas as any).__benlaiPdfEmptySceneConfirmed = true;
  return createPersistableCanvasState(canvas, 'confirmed empty PDF');
}

function getEditablePdfPageSvgPath(file: DesignFile, pageNumber: number): string {
  const pages = getParsedDocumentPages(file);
  const page = pages.length ? pages.find((entry) => entry.page === pageNumber) : pageNumber === 1 ? getParsedDocumentPage(file, 1) : null;
  if (!page || typeof page.svgPath !== 'string' || !page.svgPath.trim()) {
    throw new Error('当前页面缺少可编辑 SVG，请手动重新解析。');
  }
  return page.svgPath;
}

function getExpectedPdfExportableRasterCount(fileData: DesignFile, layers: ParsedLayer[], pageNumber?: number): number {
  const parseResult = fileData.parseResult as Record<string, unknown> | null | undefined;
  const pages = Array.isArray(parseResult?.pages) ? parseResult.pages : [];
  const activePage = pageNumber && pages.length > 1
    ? pages.find((page, index) => page && typeof page === 'object'
      && Number((page as Record<string, unknown>).page ?? (page as Record<string, unknown>).index ?? index + 1) === pageNumber) as Record<string, unknown> | undefined
    : undefined;
  const parsedCount = countPdfLayerTreeExportableRasters(activePage ? filterParsedLayersForPage(layers, pageNumber) : layers);
  const parseResultCount = Math.max(0, Number((activePage || parseResult)?.rasterImageLayerCount) || 0);
  return Math.max(parsedCount, parseResultCount);
}

function getExpectedSvgInteractiveVectorCount(fileData: DesignFile, pageNumber?: number): number {
  const parseResult = fileData.parseResult as Record<string, unknown> | null | undefined;
  if (!parseResult) return 0;
  const directCount = Math.max(0, Number(parseResult.editableVectorCount) || 0)
    + Math.max(0, Number(parseResult.decorationVectorCount) || 0);
  const pages = Array.isArray(parseResult.pages) ? parseResult.pages : [];
  if (pageNumber && pages.length > 1) {
    const page = pages.find((entry, index) => entry && typeof entry === 'object'
      && Number((entry as Record<string, unknown>).page ?? (entry as Record<string, unknown>).index ?? index + 1) === pageNumber) as Record<string, unknown> | undefined;
    return Math.max(0, Number(page?.editableVectorCount) || 0)
      + Math.max(0, Number(page?.decorationVectorCount) || 0);
  }
  const pageCount = pages.reduce((sum, page) => {
    if (!page || typeof page !== 'object') return sum;
    const record = page as Record<string, unknown>;
    return sum
      + Math.max(0, Number(record.editableVectorCount) || 0)
      + Math.max(0, Number(record.decorationVectorCount) || 0);
  }, 0);
  return Math.max(directCount, pageCount);
}

function savedStateHasSvgInteractiveVectorObject(state: Record<string, unknown>): boolean {
  return collectSerializedCanvasObjects(state).some((record) => {
    const type = String(record.type || '').toLowerCase();
    const role = readSerializedSvgObjectRole(record);
    const props = record.properties as Record<string, unknown> | null | undefined;
    const panelRole = props?.role;
    return role === 'editable-vector'
      || role === 'decoration-vector'
      || role === 'decoration-texture-fill'
      || record._svgDecorationProxy === true
      || panelRole === SVG_DECORATION_GROUP_ROLE
      || panelRole === SVG_VECTOR_ATOM_ROLE
      || (record._svgImportedAtom === true && (type === 'path' || type === 'group'));
  });
}

function countPdfLayerTreeExportableRasters(layers: ParsedLayer[]): number {
  return layers.reduce((count, layer) => {
    const props = layer.properties as Record<string, unknown> | null | undefined;
    const selfCount = layer.layerType === 'image' && layer.imagePath && !isPdfAuxiliaryImageRole(props?.role) ? 1 : 0;
    const childCount = layer.children ? countPdfLayerTreeExportableRasters(layer.children) : 0;
    return count + selfCount + childCount;
  }, 0);
}

function isPdfAuxiliaryImageRole(role: unknown): boolean {
  return role === 'page-raster'
    || role === 'visual-backing'
    || role === 'page-preview'
    || role === 'preview-fallback';
}

function readSerializedObjectProperty(record: Record<string, unknown>, key: string): unknown {
  const direct = record[key];
  if (direct !== undefined) return direct;
  const props = record.properties as Record<string, unknown> | null | undefined;
  return props?.[key];
}

function readSerializedPdfAuxiliaryRole(record: Record<string, unknown>): string {
  const role = readSerializedObjectProperty(record, '_pdfAuxiliaryImageRole')
    ?? readSerializedObjectProperty(record, 'role')
    ?? readSerializedObjectProperty(record, 'editableAs');
  return typeof role === 'string' ? role : '';
}

function isSerializedPdfAuxiliaryPreviewObject(record: Record<string, unknown>): boolean {
  if (record._pdfPreviewOnlyBackground === true) return false;
  const layerId = Number(record._layerId);
  const role = readSerializedPdfAuxiliaryRole(record);
  const type = String(record.type || '').toLowerCase();
  return record._pdfPreviewFallback === true
    || record._pdfVisualBacking === true
    || record._pdfImportPlaceholder === true
    || isPdfAuxiliaryImageRole(role)
    || (type === 'image' && Number.isFinite(layerId) && layerId <= -1000000000);
}

function savedStateHasPdfAuxiliaryPreviewObject(state: Record<string, unknown>): boolean {
  return collectSerializedCanvasObjects(state).some(isSerializedPdfAuxiliaryPreviewObject);
}

function savedStateHasOcrImportedTextObject(state: Record<string, unknown>): boolean {
  return collectSerializedCanvasObjects(state).some((record) => {
    const props = record.properties as Record<string, unknown> | null | undefined;
    const pdfOptions = record._pdfSourceTextOptions as Record<string, unknown> | null | undefined;
    const psdOptions = record._psdTextOptions as Record<string, unknown> | null | undefined;
    return props?.textSource === 'ocr'
      || props?.source === 'ocr'
      || pdfOptions?.source === 'ocr'
      || psdOptions?.source === 'ocr'
      || props?.textRecoveryVersion !== undefined
      || pdfOptions?.textRecoveryVersion !== undefined
      || psdOptions?.textRecoveryVersion !== undefined
      || record.textRecoveryVersion !== undefined;
  });
}

function isPdfRasterVisualRecord(record: Record<string, unknown>): boolean {
  const role = readSerializedSvgObjectRole(record);
  return record._pdfPreviewOnlyBackground === true
    || isSerializedPdfAuxiliaryPreviewObject(record)
    || record._pdfRasterBackground === true
    || record._pdfSourceRasterImage === true
    || (record._pdfPageRasterUnderlay === true && record._pdfRasterFallbackEditable !== true)
    || record._pdfSourceTextBackgroundPatch === true
    || role === 'visual-raster'
    || role === 'raster-image';
}

function applySerializedNonInteractiveVisualObject(record: Record<string, unknown>) {
  record.selectable = false;
  record.evented = false;
  record.hasControls = false;
  record.lockMovementX = false;
  record.lockMovementY = false;
  record.lockScalingX = false;
  record.lockScalingY = false;
  record.lockRotation = false;
  record._psdLocked = false;
  record.hoverCursor = 'default';
  delete record._svgVisualOnlyAtom;
  delete record._svgAtomReason;
}

function collectSerializedCanvasObjects(state: Record<string, unknown>): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.type === 'string') result.push(record);
    visit(record.objects);
  };
  visit(state.objects);
  return result;
}

function extractRecoverableUserObjectsFromRejectedImportedState(
  fileData: DesignFile,
  state: Record<string, unknown>,
): Record<string, unknown>[] {
  if (!isImportedVectorType(fileData.fileType)) return [];
  const objects = Array.isArray(state.objects) ? state.objects : [];
  const recovered: Record<string, unknown>[] = [];
  objects.forEach((object) => {
    if (!object || typeof object !== 'object') return;
    const record = object as Record<string, unknown>;
    if (!isRecoverableUserSerializedObject(record)) return;
    const cloned = cloneSerializedRecord(record);
    if (!cloned) return;
    sanitizeRecoveredUserSerializedRecord(cloned);
    recovered.push(cloned);
  });
  if (recovered.length > 0) {
    console.info('[Editor] preserving user objects from rejected imported state:', recovered.length);
  }
  return recovered;
}

function isRecoverableUserSerializedObject(record: Record<string, unknown>): boolean {
  const type = String(record.type || '').toLowerCase();
  if (!type || type === 'activeselection' || type === 'active-selection') return false;
  if (serializedRecordHasImportedPdfAiMarkers(record)) return false;
  const layerId = record._layerId;
  if (typeof layerId !== 'string') return false;
  const trimmedLayerId = layerId.trim();
  if (!trimmedLayerId || /^-?\d+$/.test(trimmedLayerId)) return false;
  return trimmedLayerId.startsWith('local-')
    || trimmedLayerId.startsWith('layer-')
    || trimmedLayerId.startsWith('group-');
}

function serializedRecordHasImportedPdfAiMarkers(record: Record<string, unknown>): boolean {
  if (isSerializedPdfAuxiliaryPreviewObject(record)) return true;
  if (readSerializedSvgObjectRole(record)) return true;
  if (isSkippedSvgObjectRole(readSerializedSvgObjectRole(record))) return true;
  if (record._pdfMaskArtifact === true) return true;
  if (record._svgImportedAtom === true || record._svgDecorationProxy === true || record._svgDecorationMember === true) return true;
  if (record._svgDecorationVisualOnly === true || record._pdfSourceTextActivation === true) return true;
  if (record._pdfSourceTextActivated === true || record._pdfTextPath === true) return true;
  if (Object.keys(record).some((key) => key.startsWith('_pdf') || key.startsWith('_svg'))) return true;
  const props = record.properties as Record<string, unknown> | null | undefined;
  const propsRole = props?.role;
  if (
    propsRole === SVG_DECORATION_GROUP_ROLE
    || propsRole === SVG_VECTOR_ATOM_ROLE
    || propsRole === SVG_VECTOR_SUMMARY_ROLE
    || isPdfAuxiliaryImageRole(propsRole)
  ) {
    return true;
  }
  if (props?.svgObjectRole || props?.svgObjectType || props?.panelOnly === true) return true;
  if (Array.isArray(record.objects)) {
    if (record.objects.some((child) => child && typeof child === 'object' && serializedRecordHasImportedPdfAiMarkers(child as Record<string, unknown>))) {
      return true;
    }
  }
  if (record.clipPath && typeof record.clipPath === 'object') {
    return serializedRecordHasImportedPdfAiMarkers(record.clipPath as Record<string, unknown>);
  }
  return false;
}

function cloneSerializedRecord(record: Record<string, unknown>): Record<string, unknown> | null {
  try {
    return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function sanitizeRecoveredUserSerializedRecord(record: Record<string, unknown>) {
  record.selectable = record.selectable !== false;
  record.evented = record.evented !== false;
  record.lockMovementX = false;
  record.lockMovementY = false;
  record.lockScalingX = false;
  record.lockScalingY = false;
  record.lockRotation = false;
  record._psdLocked = false;
  delete record._pdfPreviewFallback;
  delete record._pdfVisualBacking;
  delete record._pdfAuxiliaryImageRole;
  delete record._pdfImportPlaceholder;
  delete record._pdfRasterBackground;
  delete record._pdfSourceRasterImage;
  delete record._pdfMaskArtifact;
  delete record._pdfTextPath;
  delete record._svgImportedAtom;
  delete record._svgObjectRole;
  delete record._svgDecorationProxy;
  delete record._svgDecorationMember;
  delete record._svgDecorationVisualOnly;
  delete record._svgDecorationGroupId;
  delete record._svgDecorationGroupName;
  delete record._svgDecorationClusterId;
  if (Array.isArray(record.objects)) {
    record.objects.forEach((child) => {
      if (child && typeof child === 'object') {
        sanitizeRecoveredUserSerializedRecord(child as Record<string, unknown>);
      }
    });
  }
  if (record.clipPath && typeof record.clipPath === 'object') {
    sanitizeRecoveredUserSerializedRecord(record.clipPath as Record<string, unknown>);
  }
}

async function appendRecoveredImportedStateUserObjects(
  canvas: fabric.Canvas,
  serializedObjects: Record<string, unknown>[],
): Promise<number> {
  if (serializedObjects.length === 0 || typeof document === 'undefined') return 0;
  const tempElement = document.createElement('canvas');
  const tempCanvas = new fabric.StaticCanvas(tempElement, {
    width: canvas.getWidth(),
    height: canvas.getHeight(),
  });
  try {
    await tempCanvas.loadFromJSON({
      version: '6.0.0',
      objects: serializedObjects,
    });
    const objects = tempCanvas.getObjects().slice();
    objects.forEach((object) => {
      tempCanvas.remove(object);
      normalizeRecoveredUserCanvasObject(object);
      canvas.add(object);
    });
    if (objects.length > 0) {
      console.info('[Editor] restored user objects after imported SVG rebuild:', objects.length);
    }
    return objects.length;
  } catch (error) {
    console.warn('[Editor] failed to restore user objects from rejected imported state:', error);
    throw error;
  } finally {
    try {
      tempCanvas.dispose();
    } catch {
      // Nothing to clean up beyond the detached element.
    }
    tempElement.remove();
  }
}

function normalizeRecoveredUserCanvasObject(object: fabric.FabricObject) {
  const custom = object as fabric.FabricObject & {
    _psdLocked?: boolean;
    forEachObject?: (callback: (child: fabric.FabricObject) => void) => void;
  };
  custom._psdLocked = false;
  object.set({
    selectable: object.selectable !== false,
    evented: object.evented !== false,
    lockMovementX: false,
    lockMovementY: false,
    lockScalingX: false,
    lockScalingY: false,
    lockRotation: false,
    objectCaching: false,
  });
  custom.forEachObject?.((child) => normalizeRecoveredUserCanvasObject(child));
  restoreTransparentHitTesting(object);
  object.setCoords();
}

function savedStateHasInteractivePdfRasterVisualObject(state: Record<string, unknown>): boolean {
  const objects = Array.isArray(state.objects) ? state.objects : [];
  return objects.some((object) => {
    if (!object || typeof object !== 'object') return false;
    const record = object as Record<string, unknown>;
    return isPdfRasterVisualRecord(record)
      && record.visible !== false
      && (record.selectable !== false || record.evented !== false);
  });
}

function savedStateLooksLikeLegacyImportedSvgFragments(state: Record<string, unknown>): boolean {
  const objects = collectSerializedCanvasObjects(state);
  if (objects.length < 80) return false;
  let importedAtoms = 0;
  let userObjects = 0;
  let proxiesOrGroups = 0;

  objects.forEach((record) => {
    const layerId = Number(record._layerId);
    const type = String(record.type || '').toLowerCase();
    const role = readSerializedSvgObjectRole(record);
    const imported = (
      (Number.isFinite(layerId) && layerId < 0)
      || record._svgImportedAtom === true
      || Boolean(role)
    );
    if (record._svgDecorationProxy === true || record._svgDecorationMember === true || role === 'decoration-vector') {
      proxiesOrGroups++;
    }
    if (imported && (type === 'path' || type === 'image' || type === 'group')) {
      importedAtoms++;
      return;
    }
    if (!imported && record._pdfSourceTextActivation !== true) {
      userObjects++;
    }
  });

  if (userObjects > 0) return false;
  if (proxiesOrGroups > 0) return false;
  return importedAtoms >= 80 && importedAtoms / Math.max(1, objects.length) >= 0.9;
}

function savedStateHasUnpairedSvgDecorationMembers(state: Record<string, unknown>): boolean {
  const objects = collectSerializedCanvasObjects(state);
  let hasDecorationMember = false;
  let hasDecorationProxy = false;
  objects.forEach((record) => {
    if (record._svgDecorationMember === true) hasDecorationMember = true;
    if (record._svgDecorationProxy === true) hasDecorationProxy = true;
  });
  return hasDecorationMember && !hasDecorationProxy;
}

function hasPdfPageRasterLayer(layers: ParsedLayer[]): boolean {
  return layers.some((layer) => {
    const props = layer.properties as Record<string, unknown> | null | undefined;
    if (layer.layerType === 'image' && layer.imagePath && props?.role === 'page-raster') return true;
    return layer.children ? hasPdfPageRasterLayer(layer.children) : false;
  });
}

function countSavedStatePdfExportableImageObjects(state: Record<string, unknown>): number {
  const objects = collectSerializedCanvasObjects(state);
  return objects.reduce((count, object) => {
    if (!object || typeof object !== 'object') return count;
    const record = object as Record<string, unknown>;
    if (String(record.type || '').toLowerCase() !== 'image') return count;
    if (isSerializedPdfAuxiliaryPreviewObject(record)) return count;
    if (isPdfRasterVisualRecord(record)) return count;
    const props = record.properties as Record<string, unknown> | undefined;
    if (isPdfAuxiliaryImageRole(props?.role)) return count;
    return record.visible !== false ? count + 1 : count;
  }, 0);
}

function savedStateHasPdfPageRasterObject(
  state: Record<string, unknown>,
  layers: ParsedLayer[],
): boolean {
  const rasterLayerIds = new Set<string>();
  const collect = (items: ParsedLayer[]) => {
    items.forEach((layer) => {
      const props = layer.properties as Record<string, unknown> | null | undefined;
      if (layer.layerType === 'image' && layer.imagePath && props?.role === 'page-raster') {
        rasterLayerIds.add(String(layer.id));
      }
      if (layer.children) collect(layer.children);
    });
  };
  collect(layers);
  const objects = Array.isArray(state.objects) ? state.objects : [];
  return objects.some((object) => {
    if (!object || typeof object !== 'object') return false;
    const record = object as Record<string, unknown>;
    return rasterLayerIds.has(String(record._layerId));
  });
}

function savedStateHasPdfImportedTextObject(state: Record<string, unknown>): boolean {
  const objects = Array.isArray(state.objects) ? state.objects : [];
  return objects.some((object) => {
    if (!object || typeof object !== 'object') return false;
    const record = object as Record<string, unknown>;
    return record._layerType === 'text'
      && record._layerId !== undefined
      && !isRecoverableUserSerializedObject(record)
      && record._pdfSourceTextActivation !== true
      && record._pdfSourceTextActivated !== true;
  });
}

function savedStateHasPdfEditableObject(state: Record<string, unknown>): boolean {
  const objects = Array.isArray(state.objects) ? state.objects : [];
  return objects.some((object) => {
    if (!object || typeof object !== 'object') return false;
    const record = object as Record<string, unknown>;
    if (isSerializedPdfAuxiliaryPreviewObject(record)) return false;
    if (isPdfRasterVisualRecord(record)) return false;
    const svgRole = readSerializedSvgObjectRole(record);
    if (svgRole && !isInteractiveSvgObjectRole(svgRole)) return false;
    if (record._pdfTextPath === true) return false;
    if (record._layerType === 'text' && record._layerId !== undefined) return true;
    const layerId = Number(record._layerId);
    if (!Number.isFinite(layerId) || layerId >= 0) return false;
    const type = String(record.type || '').toLowerCase();
    if (type === 'image' && record.selectable === false && record.evented === false) return false;
    return true;
  });
}

function readSerializedSvgObjectRole(record: Record<string, unknown>): SvgObjectRole | null {
  return normalizeSvgObjectRole(record._svgObjectRole);
}

function isInteractiveSvgObjectRole(role: SvgObjectRole): boolean {
  return role === 'editable-vector'
    || role === 'editable-raster'
    || role === 'decoration-vector'
    || role === 'decoration-texture-fill';
}

function isSkippedSvgObjectRole(role: SvgObjectRole | null): boolean {
  return role === 'raster-reconstruction-strip'
    || role === 'mask-artifact'
    || role === 'visual-raster'
    || role === 'preview-fallback';
}

function normalizeSvgObjectRole(value: unknown): SvgObjectRole | null {
  switch (value) {
    case 'editable-vector':
    case 'editable-raster':
    case 'visual-raster':
    case 'text-outline':
    case 'raster-reconstruction-strip':
    case 'mask-artifact':
    case 'decoration-vector':
    case 'decoration-gradient-strip':
    case 'decoration-texture-fill':
    case 'decoration-effect-raster':
    case 'preview-fallback':
    case 'raster-image':
      return value;
    default:
      return null;
  }
}

function savedStateUsesImportedTextPreviewMode(state: Record<string, unknown>): boolean {
  const version = Number(state.__importedTextPreviewModeVersion);
  if (state.__importedTextPreviewMode === true && version >= IMPORTED_TEXT_PREVIEW_MODE_VERSION) return true;
  const objects = Array.isArray(state.objects) ? state.objects : [];
  return objects.some((object) => {
    if (!object || typeof object !== 'object') return false;
    const record = object as Record<string, unknown>;
    return record._layerType === 'text'
      && record._psdTextPreview === true
      && record._psdImportedTextPreview === true;
  });
}

function savedStateUsesStaleImportedTextPreviewMode(state: Record<string, unknown>): boolean {
  const version = Number(state.__importedTextPreviewModeVersion);
  if (state.__importedTextPreviewMode === true) {
    return !Number.isFinite(version) || version < IMPORTED_TEXT_PREVIEW_MODE_VERSION;
  }
  return savedStateUsesImportedTextPreviewMode(state);
}

function parsedFileUsesImportedTextPreviewMode(fileData: DesignFile, layers: ParsedLayer[]): boolean {
  if (!isImportedVectorType(fileData.fileType)) return false;
  const parseResult = fileData.parseResult as Record<string, unknown> | undefined;
  if (parseResult?.textLayersAreMetadata === true && parseResult?.explicitTextOverlay !== true) return false;
  const renderableLayers = getCanvasRenderableLayers(removePreviewLayers(layers));
  if (!renderableLayers.some((layer) => layer.layerType === 'text' && layer.textContent)) return false;
  const backings = collectImportedTextPreviewBackings(fileData, renderableLayers, []);
  return backings.length > 0 || Boolean(resolvePdfPreviewFallbackPath(fileData, getParsedDocumentPage(fileData, 1)));
}

function canvasHasImportedTextPreviewHitAreas(canvas: fabric.Canvas): boolean {
  return canvas.getObjects().some((object) => {
    const record = object as fabric.FabricObject & {
      _psdTextPreview?: unknown;
      _psdInvisibleHitArea?: unknown;
      _psdImportedTextPreview?: unknown;
    };
    return record._psdTextPreview === true
      && (record._psdImportedTextPreview === true || record._psdInvisibleHitArea === true);
  });
}

function collectImportedTextPreviewBackings(
  fileData: DesignFile,
  layers: ParsedLayer[],
  syntheticSvgLayers: ParsedLayer[] = [],
): PixelBounds[] {
  if (!isImportedVectorType(fileData.fileType)) return [];
  const pageBounds = getImportedFilePageBounds(fileData);
  const candidates = [...layers, ...syntheticSvgLayers];
  const backings: PixelBounds[] = [];
  for (const layer of candidates) {
    if (!isLayerVisibleValue(layer.visible)) continue;
    const bounds = parsedLayerToPixelBounds(layer);
    if (!bounds) continue;
    if (
      isImportedTextVisualBackingLayer(fileData, layer, bounds, pageBounds)
      && isTextClearedImportedBackingLayer(layer)
    ) {
      backings.push(bounds);
    }
  }
  return backings;
}

function getImportedFilePageBounds(fileData: DesignFile): { width: number; height: number } {
  const parseResult = fileData.parseResult as Record<string, unknown> | undefined;
  return {
    width: positivePsdNumber(parseResult?.width, positivePsdNumber(fileData.width, 1)),
    height: positivePsdNumber(parseResult?.height, positivePsdNumber(fileData.height, 1)),
  };
}

function isImportedTextVisualBackingLayer(
  fileData: DesignFile,
  layer: ParsedLayer,
  bounds: PixelBounds,
  pageBounds: { width: number; height: number },
): boolean {
  if (layer.layerType !== 'image' || !layer.imagePath) return false;
  const props = layer.properties as Record<string, unknown> | null | undefined;
  const source = String(props?.source || '').toLowerCase();
  const editableAs = String(props?.editableAs || '').toLowerCase();
  const extractedFrom = String(props?.extractedFrom || props?.role || '').toLowerCase();
  const fullPageLike = isFullPageLikeBacking(bounds, pageBounds);
  if (fileData.fileType === 'pdf') {
    return fullPageLike && (
      source === 'pdf'
      || editableAs === 'preview'
      || editableAs === 'image'
      || extractedFrom.includes('pdf')
      || extractedFrom.includes('page')
    );
  }
  if (fileData.fileType === 'ai') {
    return fullPageLike && (
      source === 'ai'
      || editableAs === 'preview'
      || editableAs === 'image'
      || extractedFrom.includes('raster')
      || extractedFrom.includes('preview')
    );
  }
  return false;
}

function isTextClearedImportedBackingLayer(layer: ParsedLayer): boolean {
  const props = layer.properties as Record<string, unknown> | null | undefined;
  const imagePath = String(layer.imagePath || '').toLowerCase();
  const extractedFrom = String(props?.extractedFrom || '').toLowerCase();
  return props?.textCleared === true
    || imagePath.includes('_text_cleared')
    || extractedFrom.includes('text-cleared');
}

function isFullPageLikeBacking(bounds: PixelBounds, pageBounds: { width: number; height: number }): boolean {
  const pageWidth = Math.max(1, pageBounds.width);
  const pageHeight = Math.max(1, pageBounds.height);
  const areaRatio = (bounds.width * bounds.height) / Math.max(1, pageWidth * pageHeight);
  const coversPage =
    bounds.left <= pageWidth * 0.06
    && bounds.top <= pageHeight * 0.06
    && bounds.right >= pageWidth * 0.94
    && bounds.bottom >= pageHeight * 0.94;
  return coversPage || areaRatio >= 0.65;
}

function isParsedTextLayerCoveredByBacking(layer: ParsedLayer, backings: PixelBounds[]): boolean {
  if (backings.length === 0) return false;
  const textBounds = parsedLayerToPixelBounds(layer);
  if (!textBounds) return false;
  const textArea = Math.max(1, textBounds.width * textBounds.height);
  return backings.some((backing) => {
    const left = Math.max(textBounds.left, backing.left);
    const top = Math.max(textBounds.top, backing.top);
    const right = Math.min(textBounds.right, backing.right);
    const bottom = Math.min(textBounds.bottom, backing.bottom);
    if (right <= left || bottom <= top) return false;
    const intersectionArea = (right - left) * (bottom - top);
    return intersectionArea / textArea >= 0.8;
  });
}

function parsedLayerToPixelBounds(layer: ParsedLayer): PixelBounds | null {
  const left = toFiniteNumber(layer.x) ?? 0;
  const top = toFiniteNumber(layer.y) ?? 0;
  const width = toFiniteNumber(layer.width) ?? 0;
  const height = toFiniteNumber(layer.height) ?? 0;
  if (width <= 0 || height <= 0) return null;
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

function createPersistableCanvasState(canvas: fabric.Canvas, context: string): Record<string, unknown> | null {
  const pdfParserVersion = Number((canvas as any).__benlaiPdfParserVersion);
  const loadedPdfVersion = Number((canvas as any).__benlaiPdfSceneLoadedVersion);
  const completionVersion = Number((canvas as any).__benlaiPdfSceneCompleteVersion);
  if (pdfParserVersion >= 77
    && (loadedPdfVersion !== pdfParserVersion || !(completionVersion === 1 || completionVersion === 2))) {
    console.warn(`[Editor] ${context} skipped: PDF scene has not finished loading`);
    return null;
  }
  const validation = validateCanvasStateBeforePersist(canvas);
  if (!validation.valid) {
    console.warn(`[Editor] ${context} skipped: ${validation.reason || 'invalid canvas state'}`);
    return null;
  }
  try {
    const state = serializeFabricCanvasToFabricJson(canvas);
    sanitizePersistedPdfRasterVisualObjects(state, { dropDecorationProxy: true });
    if (pdfParserVersion >= 77 && Array.isArray(state.objects) && state.objects.length === 0
      && completionVersion < 2 && (canvas as any).__benlaiPdfEmptySceneConfirmed !== true) {
      console.warn(`[Editor] ${context} skipped: empty legacy PDF needs confirmation`);
      return null;
    }
    const owner = (canvas as OwnedFabricCanvas).__benlaiCanvasOwner;
    if (owner?.fileId) {
      state.__editorStateOwnerVersion = EDITOR_STATE_OWNER_VERSION;
      state.__fileId = owner.fileId;
      state.__sourceFileId = owner.sourceFileId;
      state.__pageNumber = owner.pageNumber;
    }
    if (Number.isFinite(pdfParserVersion) && pdfParserVersion > 0) {
      state.__pdfParserVersion = pdfParserVersion;
      if (loadedPdfVersion === pdfParserVersion) {
        state.__pdfSceneCompleteVersion = (canvas as any).__benlaiPdfEmptySceneConfirmed === true ? 2 : completionVersion;
      }
    }
    const aiParserVersion = Number((canvas as any).__benlaiAiParserVersion);
    if (Number.isFinite(aiParserVersion) && aiParserVersion > 0) {
      state.__aiParserVersion = aiParserVersion;
      if ([1, 2].includes(completionVersion)) state.__pdfSceneCompleteVersion = completionVersion;
    }
    if ((canvas as any).__benlaiImportedTextPreviewMode === true || canvasHasImportedTextPreviewHitAreas(canvas)) {
      state.__importedTextPreviewMode = true;
      state.__importedTextPreviewModeVersion = IMPORTED_TEXT_PREVIEW_MODE_VERSION;
    }
    const importedSvgRoleModelVersion = Number((canvas as any).__benlaiImportedSvgRoleModelVersion);
    if (Number.isFinite(importedSvgRoleModelVersion) && importedSvgRoleModelVersion >= IMPORTED_SVG_ROLE_MODEL_VERSION) {
      state.__importedSvgRoleModelVersion = IMPORTED_SVG_ROLE_MODEL_VERSION;
    }
    return state;
  } catch (error) {
    console.warn(`[Editor] ${context} failed:`, error);
    return null;
  }
}

function createHistorySnapshot(canvas: fabric.Canvas): Record<string, unknown> {
  const state = serializeFabricCanvasToFabricJson(canvas);
  sanitizePersistedPdfRasterVisualObjects(state, { dropDecorationProxy: false });
  return state;
}

type PersistedSanitizeOptions = {
  dropDecorationProxy?: boolean;
};

function sanitizePersistedPdfRasterVisualObjects(
  state: Record<string, unknown>,
  options: PersistedSanitizeOptions = { dropDecorationProxy: true },
): Record<string, unknown> {
  if (Array.isArray(state.objects)) {
    state.objects = sanitizePersistedObjectArray(state.objects, options);
  } else {
    sanitizePersistedRecord(state, options);
  }
  return state;
}

function sanitizePersistedObjectArray(objects: unknown[], options: PersistedSanitizeOptions): unknown[] {
  const result: unknown[] = [];
  objects.forEach((object) => {
    if (!object || typeof object !== 'object') {
      result.push(object);
      return;
    }
    const record = object as Record<string, unknown>;
    if (options.dropDecorationProxy && record._svgDecorationProxy === true) {
      return;
    }
    if (isSerializedPdfAuxiliaryPreviewObject(record)) {
      return;
    }
    if (isSkippedSvgObjectRole(readSerializedSvgObjectRole(record)) || record._pdfMaskArtifact === true) {
      return;
    }
    sanitizePersistedRecord(record, options);
    result.push(record);
  });
  return result;
}

function sanitizePersistedRecord(record: Record<string, unknown>, options: PersistedSanitizeOptions) {
  if (isSerializedPdfAuxiliaryPreviewObject(record)) {
    applySerializedNonInteractiveVisualObject(record);
    record.excludeFromExport = true;
  }
  if (isPdfRasterVisualRecord(record)) {
    applySerializedNonInteractiveVisualObject(record);
  }
  if (record._pdfPreviewOnlyBackground === true) {
    record.excludeFromExport = false;
    record.visible = true;
    record.opacity = 1;
    record.lockMovementX = record.lockMovementY = record.lockScalingX = record.lockScalingY = record.lockRotation = true;
    record._psdLocked = true;
  }
  const svgRole = readSerializedSvgObjectRole(record);
  if (
    svgRole === 'text-outline'
    || svgRole === 'decoration-gradient-strip'
    || svgRole === 'decoration-effect-raster'
    || record._svgDecorationMember === true
    || record._svgDecorationVisualOnly === true
  ) {
    applySerializedNonInteractiveVisualObject(record);
  }
  if (record._svgDecorationProxy === true) {
    if (options.dropDecorationProxy) {
      record.excludeFromExport = true;
      record.visible = false;
      applySerializedNonInteractiveVisualObject(record);
    } else {
      record.lockMovementX = false;
      record.lockMovementY = false;
      record.lockScalingX = false;
      record.lockScalingY = false;
      record.lockRotation = false;
      record._psdLocked = false;
    }
  }
  if (record._pdfSourceTextActivation === true) {
    record.lockMovementX = false;
    record.lockMovementY = false;
    record.lockScalingX = false;
    record.lockScalingY = false;
    record.lockRotation = false;
    record._psdLocked = false;
  }
  delete record._svgVisualOnlyAtom;
  delete record._svgAtomReason;
  delete record._svgDecorationLastMatrix;
  delete record._pdfPageCompositeLastMatrix;

  if (Array.isArray(record.objects)) {
    record.objects = sanitizePersistedObjectArray(record.objects, options);
  }
  if (record.clipPath && typeof record.clipPath === 'object') {
    sanitizePersistedRecord(record.clipPath as Record<string, unknown>, options);
  }
}

function createBoardPreview(canvas: fabric.Canvas, canvasWidth: number, canvasHeight: number): string | undefined {
  try {
    const longestSide = Math.max(1, canvasWidth, canvasHeight);
    const multiplier = Math.max(0.08, Math.min(0.22, 160 / longestSide));
    return canvas.toDataURL({
      format: 'png',
      multiplier,
    });
  } catch {
    return undefined;
  }
}

function resolveBoardRoute(board: EditorOpenBoard): string {
  if (board.route) return board.route;
  if (typeof board.fileId === 'number' && Number.isFinite(board.fileId)) {
    return `/editor/${board.fileId}`;
  }
  if (board.draftId) {
    const params = new URLSearchParams();
    params.set('w', String(board.width || 1080));
    params.set('h', String(board.height || 1080));
    params.set('name', board.name || '未命名画布');
    params.set('draftId', board.draftId);
    return `/editor/new?${params.toString()}`;
  }
  return board.route || '/editor/new';
}

interface ParsedDocumentPage {
  page: number;
  name?: string;
  width?: number;
  height?: number;
  svgPath?: string;
  previewPath?: string;
  textlessPreviewPath?: string;
  thumbnailPath?: string;
  previewOnly?: boolean;
  svgFidelityMethod?: string;
}

function getParsedDocumentPages(file?: DesignFile | null): ParsedDocumentPage[] {
  const parseResult = file?.parseResult as Record<string, unknown> | undefined;
  const rawPages = Array.isArray(parseResult?.pages) ? parseResult.pages : [];
  return rawPages
    .map((item, index): ParsedDocumentPage | null => {
      if (!item || typeof item !== 'object') return null;
      const page = item as Record<string, unknown>;
      const pageNumber = parsePositiveInt(String(page.page ?? page.index ?? index + 1), index + 1);
      return {
        page: pageNumber,
        name: typeof page.name === 'string' && page.name.trim() ? page.name.trim() : undefined,
        width: typeof page.width === 'number' ? page.width : undefined,
        height: typeof page.height === 'number' ? page.height : undefined,
        svgPath: typeof page.svgPath === 'string' ? page.svgPath : undefined,
        previewPath: typeof page.previewPath === 'string' ? page.previewPath : undefined,
        textlessPreviewPath: typeof page.textlessPreviewPath === 'string' ? page.textlessPreviewPath : undefined,
        thumbnailPath: typeof page.thumbnailPath === 'string' ? page.thumbnailPath : undefined,
        previewOnly: page.previewOnly === true || (file?.fileType === 'ai' && !page.svgPath && Number(page.previewLayerCount || parseResult?.previewLayerCount) > 0),
        svgFidelityMethod: typeof page.svgFidelityMethod === 'string' ? page.svgFidelityMethod : undefined,
      };
    })
    .filter(Boolean) as ParsedDocumentPage[];
}

function getParsedDocumentPage(file: DesignFile | null | undefined, pageNumber: number): ParsedDocumentPage | null {
  const pages = getParsedDocumentPages(file);
  if (pages.length > 0) {
    return pages.find((page) => page.page === pageNumber) || null;
  }
  if (!file) return null;
  const parseResult = file.parseResult as Record<string, unknown> | undefined;
  return {
    page: 1,
    width: file.width,
    height: file.height,
    svgPath: typeof parseResult?.svgPath === 'string' ? parseResult.svgPath : undefined,
    previewPath: typeof parseResult?.previewPath === 'string' ? parseResult.previewPath : undefined,
    textlessPreviewPath: typeof parseResult?.textlessPreviewPath === 'string' ? parseResult.textlessPreviewPath : undefined,
    thumbnailPath: file.thumbnailPath,
    previewOnly: parseResult?.previewOnly === true || (file.fileType === 'ai' && !parseResult?.svgPath && Number(parseResult?.previewLayerCount) > 0),
    svgFidelityMethod: typeof parseResult?.svgFidelityMethod === 'string' ? parseResult.svgFidelityMethod : undefined,
  };
}

function makeDocumentPageOpenBoard(file: DesignFile, page: ParsedDocumentPage, total: number): EditorOpenBoard {
  const pageName = page.name || `画板 ${page.page}`;
  return {
    key: getFileBoardKey(file.id, page.page),
    route: `/editor/${file.id}?page=${page.page}`,
    name: total > 1 ? `${file.name || file.originalFilename} ${page.page}/${total}` : (file.name || file.originalFilename || pageName),
    fileId: file.id,
    draftId: null,
    fileType: file.fileType,
    thumbnailPath: page.thumbnailPath || page.previewPath || file.thumbnailPath || null,
    width: page.width || file.width,
    height: page.height || file.height,
    isNew: false,
    updatedAt: Date.now(),
  };
}

function filterParsedLayersForPage(layers: ParsedLayer[], pageNumber?: number): ParsedLayer[] {
  if (!pageNumber || pageNumber <= 1) {
    return layers.filter((layer) => {
      const props = layer.properties as Record<string, unknown> | null | undefined;
      const layerPage = Number(props?.page ?? 1);
      return !Number.isFinite(layerPage) || layerPage === 1;
    });
  }
  return layers.filter((layer) => {
    const props = layer.properties as Record<string, unknown> | null | undefined;
    return Number(props?.page) === pageNumber;
  });
}

function takePendingImportImages(): PendingImportImage[] {
  const host = window as Window & { __createImportImages?: { images?: PendingImportImage[] } };
  const fromWindow = host.__createImportImages?.images;
  if (Array.isArray(fromWindow)) {
    delete host.__createImportImages;
    window.sessionStorage.removeItem('create-import-images');
    return normalizePendingImportImages(fromWindow);
  }

  const raw = window.sessionStorage.getItem('create-import-images');
  window.sessionStorage.removeItem('create-import-images');
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as { images?: PendingImportImage[] };
    return normalizePendingImportImages(Array.isArray(parsed.images) ? parsed.images : []);
  } catch {
    return [];
  }
}

function normalizePendingImportImages(images: PendingImportImage[]) {
  return images
    .filter((image) => typeof image?.src === 'string' && image.src.length > 0)
    .map((image) => ({
      src: image.src,
      name: typeof image.name === 'string' && image.name.trim() ? image.name.trim() : undefined,
      width: typeof image.width === 'number' && Number.isFinite(image.width) ? image.width : undefined,
      height: typeof image.height === 'number' && Number.isFinite(image.height) ? image.height : undefined,
    }));
}

function parsePositiveInt(value: string, fallback: number) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function loadFabricImageWithAuth(src: string) {
  if (src.startsWith('/api/v1/')) {
    const apiPath = src.slice('/api/v1'.length);
    const response = await api.get<Blob>(apiPath, { responseType: 'blob' });
    return loadFabricImageFromUrl(await blobToDataUrl(response.data));
  }

  if (src.startsWith('/api/')) {
    const response = await api.get<Blob>(src.replace(/^\/api/, ''), { responseType: 'blob' });
    return loadFabricImageFromUrl(await blobToDataUrl(response.data));
  }

  if (src.startsWith('blob:')) {
    const response = await fetch(src);
    return loadFabricImageFromUrl(await blobToDataUrl(await response.blob()));
  }

  if (src.startsWith('data:')) {
    return loadFabricImageFromUrl(src);
  }

  return loadFabricImageFromUrl(src, { crossOrigin: 'anonymous' });
}

type FabricImageLoadOptions = Parameters<typeof fabric.FabricImage.fromURL>[1];

function loadFabricImageFromUrl(
  src: string,
  options?: FabricImageLoadOptions,
  timeoutMs = EDITOR_IMAGE_LOAD_TIMEOUT_MS,
) {
  return withTimeout(
    fabric.FabricImage.fromURL(src, options),
    timeoutMs,
    'image_load_timeout',
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) window.clearTimeout(timer);
  });
}

function resolvePdfPreviewFallbackPath(fileData: DesignFile, activeDocumentPage: ParsedDocumentPage | null): string | null {
  const parseResult = fileData.parseResult as Record<string, unknown> | undefined;
  const candidates = [
    activeDocumentPage?.previewPath,
    typeof parseResult?.previewPath === 'string' ? parseResult.previewPath : undefined,
    activeDocumentPage?.thumbnailPath,
    fileData.thumbnailPath,
  ];
  const path = candidates.find((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return path?.trim() || null;
}

function shouldLoadImportedVisualBacking(fileData: DesignFile): boolean {
  void fileData;
  return false;
}

async function loadPdfPreviewFallbackLayer(
  canvas: fabric.Canvas,
  fileData: DesignFile,
  activeDocumentPage: ParsedDocumentPage | null,
  resolveUploadUrl: (assetPath: string) => string,
  options: { locked?: boolean; placement?: 'front' | 'back'; role?: string; layerName?: string; previewOnly?: boolean } = {},
): Promise<ParsedLayer | null> {
  const previewPath = options.previewOnly
    ? activeDocumentPage?.previewPath || null
    : resolvePdfPreviewFallbackPath(fileData, activeDocumentPage);
  if (!previewPath) return null;

  try {
    const fallbackLayerId = -1000000000 - Math.abs(fileData.id);
    const auxiliaryRole = options.previewOnly ? 'preview-only-background' : options.role || 'preview-fallback';
    const img = await loadFabricImageFromUrl(resolveUploadUrl(previewPath), { crossOrigin: 'anonymous' });
    const imageWidth = img.width || canvas.getWidth();
    const imageHeight = img.height || canvas.getHeight();
    const scaleX = canvas.getWidth() / Math.max(1, imageWidth);
    const scaleY = canvas.getHeight() / Math.max(1, imageHeight);

    img.set({
      originX: 'left',
      originY: 'top',
      left: 0,
      top: 0,
      scaleX,
      scaleY,
      opacity: 1,
      selectable: !options.locked,
      evented: !options.locked,
      objectCaching: false,
      lockMovementX: options.previewOnly === true,
      lockMovementY: options.previewOnly === true,
      lockScalingX: options.previewOnly === true,
      lockScalingY: options.previewOnly === true,
      lockRotation: options.previewOnly === true,
      hoverCursor: options.locked ? 'default' : undefined,
      excludeFromExport: options.previewOnly !== true,
    });
    (img as any)._layerId = fallbackLayerId;
    (img as any)._layerName = options.layerName || `${fileData.name || fileData.originalFilename || '导入文件'} 预览`;
    (img as any)._layerType = 'image';
    (img as any)._psdLocked = options.previewOnly === true;
    (img as any)._pdfPreviewOnlyBackground = options.previewOnly === true;
    if (options.previewOnly) {
      (img as any)._pdfPreviewOnlyPage = activeDocumentPage?.page || 1;
      (img as any)._pdfPreviewOnlyPath = previewPath;
    }
    (img as any)._pdfPreviewFallback = true;
    (img as any)._pdfVisualBacking = auxiliaryRole === 'visual-backing';
    (img as any)._pdfAuxiliaryImageRole = auxiliaryRole;
    canvas.add(img);
    if (options.placement === 'front') {
      canvas.bringObjectToFront(img);
    } else if (options.placement === 'back' || options.locked) {
      canvas.sendObjectToBack(img);
    }

    return {
      id: fallbackLayerId,
      fileId: fileData.id,
      layerName: options.layerName || `${fileData.name || fileData.originalFilename || '导入文件'} 预览`,
      layerType: 'image',
      parentLayerId: null,
      sortOrder: 1,
      visible: true,
      opacity: 1,
      blendMode: 'normal',
      x: 0,
      y: 0,
      width: canvas.getWidth(),
      height: canvas.getHeight(),
      imagePath: previewPath,
      properties: {
        source: fileData.fileType,
        editableAs: options.previewOnly ? 'preview-only-background' : 'preview-fallback',
        role: auxiliaryRole,
        ...(options.previewOnly ? { locked: true, panelOnly: true, page: activeDocumentPage?.page || 1 } : {}),
      },
    };
  } catch (error) {
    console.warn('[Editor] PDF 预览兜底图加载失败:', previewPath, error);
    return null;
  }
}

function sendVisualBackingLayerToBack(canvas: fabric.Canvas, visualBackingLayer: ParsedLayer | null) {
  if (!visualBackingLayer) return;
  const visualBackingObject = canvas.getObjects().find((object) =>
    String((object as fabric.FabricObject & { _layerId?: unknown })._layerId) === String(visualBackingLayer.id)
  );
  if (!visualBackingObject) return;

  visualBackingObject.set({
    selectable: false,
    evented: false,
    lockMovementX: false,
    lockMovementY: false,
    lockScalingX: false,
    lockScalingY: false,
    lockRotation: false,
    hoverCursor: 'default',
  });
  (visualBackingObject as fabric.FabricObject & { _psdLocked?: boolean })._psdLocked = false;
  canvas.sendObjectToBack(visualBackingObject);
}

type ImportedTextPreviewSource = {
  image: HTMLImageElement;
  clearedImage?: HTMLImageElement;
  sourceWidth: number;
  sourceHeight: number;
  canvasWidth: number;
  canvasHeight: number;
};

async function loadImportedTextPreviewSource(
  canvas: fabric.Canvas,
  fileData: DesignFile,
  activeDocumentPage: ParsedDocumentPage | null,
  resolveUploadUrl: (assetPath: string) => string,
  backings: PixelBounds[],
  layers: ParsedLayer[],
): Promise<ImportedTextPreviewSource | null> {
  if (!isImportedVectorType(fileData.fileType)) return null;
  const parseResult = fileData.parseResult as Record<string, unknown> | undefined;
  if (parseResult?.textLayersAreMetadata === true && parseResult?.explicitTextOverlay !== true) return null;
  const hasTextLayers = layers.some((layer) => layer.layerType === 'text' && Boolean(layer.textContent));
  if (!hasTextLayers) return null;
  const previewPath = resolvePdfPreviewFallbackPath(fileData, activeDocumentPage);
  if (!previewPath) return null;
  const textlessPreviewPath =
    activeDocumentPage?.textlessPreviewPath
    || (typeof parseResult?.textlessPreviewPath === 'string' ? parseResult.textlessPreviewPath : null);
  const backingImagePath = findImportedTextBackingImagePath(fileData, layers);
  const clearedPreviewPath = textlessPreviewPath || backingImagePath;
  if (!clearedPreviewPath && backings.length === 0) return null;

  try {
    const [image, clearedImage] = await Promise.all([
      loadHtmlImage(resolveUploadUrl(previewPath)),
      clearedPreviewPath && clearedPreviewPath !== previewPath
        ? loadHtmlImage(resolveUploadUrl(clearedPreviewPath)).catch(() => null)
        : Promise.resolve(null),
    ]);
    return {
      image,
      ...(clearedImage ? { clearedImage } : {}),
      sourceWidth: image.naturalWidth || image.width || canvas.getWidth(),
      sourceHeight: image.naturalHeight || image.height || canvas.getHeight(),
      canvasWidth: canvas.getWidth(),
      canvasHeight: canvas.getHeight(),
    };
  } catch (error) {
    console.warn('[Editor] 导入文件文字预览源图加载失败:', previewPath, error);
    return null;
  }
}

function findImportedTextBackingImagePath(fileData: DesignFile, layers: ParsedLayer[]): string | null {
  if (!isImportedVectorType(fileData.fileType)) return null;
  const pageBounds = getImportedFilePageBounds(fileData);
  const candidates = layers
    .map((layer) => ({ layer, bounds: parsedLayerToPixelBounds(layer) }))
    .filter((item): item is { layer: ParsedLayer; bounds: PixelBounds } =>
      Boolean(
        item.bounds
        && isImportedTextVisualBackingLayer(fileData, item.layer, item.bounds, pageBounds)
        && isTextClearedImportedBackingLayer(item.layer)
      )
    )
    .sort((a, b) => (b.bounds.width * b.bounds.height) - (a.bounds.width * a.bounds.height));
  const imagePath = candidates[0]?.layer.imagePath;
  return typeof imagePath === 'string' && imagePath.trim() ? imagePath.trim() : null;
}

async function buildImportedTextCropPreviewLayer(
  source: ImportedTextPreviewSource,
  layer: ParsedLayer,
  layerBounds: PsdLayerBounds,
  content: string,
  options: Record<string, unknown>,
  locked: boolean,
  blendMode: GlobalCompositeOperation,
): Promise<fabric.FabricImage> {
  const left = toFiniteNumber(layerBounds.left) ?? (layer.x || 0);
  const top = toFiniteNumber(layerBounds.top) ?? (layer.y || 0);
  const width = positivePsdNumber(layerBounds.width, positivePsdNumber(options.width, 8));
  const fallbackHeight =
    positivePsdNumber(options.fontSize, 16) * positivePsdNumber(options.lineHeight, 1.2);
  const height = positivePsdNumber(layerBounds.height, fallbackHeight);
  const cropBounds = getImportedTextPreviewCropBounds(
    { left, top, width, height },
    source.canvasWidth,
    source.canvasHeight,
    positivePsdNumber(options.fontSize, 16),
  );
  const previewTextColor =
    typeof options.fill === 'string' ? options.fill
      : typeof options.psdSolidFillColor === 'string' ? options.psdSolidFillColor
        : null;
  const dataUrl = cropImportedTextPreviewSource(source, cropBounds, previewTextColor);
  const storedOptions = {
    ...options,
    runs: stripImportedVectorRunFontNames(options.runs),
  };
  const preview = await fabric.FabricImage.fromURL(dataUrl);
  preview.set({
    originX: 'left',
    originY: 'top',
    left: cropBounds.left,
    top: cropBounds.top,
    scaleX: cropBounds.width / Math.max(1, preview.width || cropBounds.width),
    scaleY: cropBounds.height / Math.max(1, preview.height || cropBounds.height),
    opacity: Math.max(0, Math.min(1, toFiniteNumber(options.opacity) ?? 1)),
    selectable: !locked,
    evented: !locked,
    objectCaching: false,
    perPixelTargetFind: false,
    targetFindTolerance: 8,
    hoverCursor: 'text',
    globalCompositeOperation: blendMode,
  });
  (preview as any)._layerId = layer.id;
  (preview as any)._layerName = layer.layerName;
  (preview as any)._layerType = 'text';
  (preview as any)._psdFontName = String(options.psdBaseFontName || '');
  (preview as any)._psdMissingFont = true;
  (preview as any)._psdTextPreview = true;
  (preview as any)._psdImportedTextPreview = true;
  (preview as any)._psdIgnorePreviewColor = true;
  (preview as any)._psdTextContent = content;
  (preview as any)._psdTextIsAreaText = options.psdTextIsAreaText === true;
  (preview as any)._psdTextOrientation = options.textOrientation === 'vertical' ? 'vertical' : undefined;
  (preview as any)._psdTextOptions = storedOptions;
  (preview as any)._psdLayerBounds = { left, top, width, height };
  (preview as any)._psdPreviewVisualBounds = psdLayerBoundsToPixelBounds({ left, top, width, height });
  (preview as any)._psdLocked = locked;
  return preview;
}

function getImportedTextPreviewCropBounds(
  bounds: Required<PsdLayerBounds>,
  canvasWidth: number,
  canvasHeight: number,
  fontSize: number,
): Required<PsdLayerBounds> {
  // PDF.js text item width is often tighter than the painted glyphs,
  // especially for serif Latin text and CJK fonts converted through AI/PDF.
  const padX = Math.max(4, Math.min(28, Math.round(fontSize * 0.58)));
  const padY = Math.max(2, Math.min(10, Math.round(fontSize * 0.22)));
  const left = Math.max(0, bounds.left - padX);
  const top = Math.max(0, bounds.top - padY);
  const right = Math.min(Math.max(1, canvasWidth), bounds.left + bounds.width + padX);
  const bottom = Math.min(Math.max(1, canvasHeight), bounds.top + bounds.height + padY);
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

function cropImportedTextPreviewSource(
  source: ImportedTextPreviewSource,
  bounds: Required<PsdLayerBounds>,
  expectedTextColor: string | null,
): string {
  const scaleX = source.sourceWidth / Math.max(1, source.canvasWidth);
  const scaleY = source.sourceHeight / Math.max(1, source.canvasHeight);
  const sx = Math.max(0, Math.floor(bounds.left * scaleX));
  const sy = Math.max(0, Math.floor(bounds.top * scaleY));
  const sw = Math.max(1, Math.ceil(bounds.width * scaleX));
  const sh = Math.max(1, Math.ceil(bounds.height * scaleY));
  if (source.clearedImage) {
    const textOnly = cropImportedTextOnlyPreviewSource(source, sx, sy, sw, sh, expectedTextColor);
    if (textOnly) return textOnly;
  }
  const out = document.createElement('canvas');
  out.width = sw;
  out.height = sh;
  const ctx = out.getContext('2d');
  if (!ctx) return '';
  ctx.drawImage(source.image, sx, sy, sw, sh, 0, 0, sw, sh);
  return out.toDataURL('image/png');
}

function cropImportedTextOnlyPreviewSource(
  source: ImportedTextPreviewSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  expectedTextColor: string | null,
): string | null {
  if (!source.clearedImage) return null;
  const original = document.createElement('canvas');
  const cleared = document.createElement('canvas');
  original.width = sw;
  original.height = sh;
  cleared.width = sw;
  cleared.height = sh;
  const originalCtx = original.getContext('2d');
  const clearedCtx = cleared.getContext('2d');
  if (!originalCtx || !clearedCtx) return null;

  originalCtx.drawImage(source.image, sx, sy, sw, sh, 0, 0, sw, sh);
  clearedCtx.drawImage(source.clearedImage, sx, sy, sw, sh, 0, 0, sw, sh);

  const originalData = originalCtx.getImageData(0, 0, sw, sh);
  const clearedData = clearedCtx.getImageData(0, 0, sw, sh);
  const out = originalCtx.createImageData(sw, sh);
  const mask = new Uint8Array(sw * sh);
  let maskedPixels = 0;

  for (let i = 0; i < sw * sh; i++) {
    const idx = i * 4;
    const alpha = originalData.data[idx + 3] ?? 255;
    if (alpha <= 4) continue;
    const diff = colorDistance(
      originalData.data[idx] ?? 0,
      originalData.data[idx + 1] ?? 0,
      originalData.data[idx + 2] ?? 0,
      clearedData.data[idx] ?? 0,
      clearedData.data[idx + 1] ?? 0,
      clearedData.data[idx + 2] ?? 0,
    );
    if (diff <= 7) continue;
    mask[i] = Math.min(255, Math.max(24, Math.round((diff - 4) * 8)));
    maskedPixels++;
  }

  if (maskedPixels < 2) return null;
  let activeMask: Uint8Array<ArrayBufferLike> = mask;
  const diffCoverage = maskedPixels / Math.max(1, sw * sh);
  if (diffCoverage > 0.32) {
    const colorMask = buildImportedTextColorMask(originalData, sw, sh, expectedTextColor);
    if (colorMask.maskedPixels >= 2) {
      activeMask = colorMask.mask;
      maskedPixels = colorMask.maskedPixels;
    }
  }
  const radius = Math.max(1, Math.min(2, Math.round(Math.max(sw, sh) * 0.015)));
  const alphaMask = dilateAlphaMask(activeMask, sw, sh, radius);
  for (let i = 0; i < sw * sh; i++) {
    const idx = i * 4;
    const alpha = alphaMask[i] ?? 0;
    out.data[idx] = originalData.data[idx] ?? 0;
    out.data[idx + 1] = originalData.data[idx + 1] ?? 0;
    out.data[idx + 2] = originalData.data[idx + 2] ?? 0;
    out.data[idx + 3] = Math.min(originalData.data[idx + 3] ?? 255, alpha);
  }

  const result = document.createElement('canvas');
  result.width = sw;
  result.height = sh;
  const resultCtx = result.getContext('2d');
  if (!resultCtx) return null;
  resultCtx.putImageData(out, 0, 0);
  return result.toDataURL('image/png');
}

function buildImportedTextColorMask(
  imageData: ImageData,
  width: number,
  height: number,
  expectedTextColor: string | null,
): { mask: Uint8Array; maskedPixels: number } {
  const expected = parseCssRgbColor(expectedTextColor);
  const mask = new Uint8Array(width * height);
  if (!expected) return { mask, maskedPixels: 0 };

  let maskedPixels = 0;
  const threshold = 96;
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    const alpha = imageData.data[idx + 3] ?? 255;
    if (alpha <= 4) continue;
    const dist = colorDistance(
      imageData.data[idx] ?? 0,
      imageData.data[idx + 1] ?? 0,
      imageData.data[idx + 2] ?? 0,
      expected.r,
      expected.g,
      expected.b,
    );
    if (dist > threshold) continue;
    mask[i] = Math.max(32, Math.min(255, Math.round(255 - dist * 1.8)));
    maskedPixels++;
  }
  return { mask, maskedPixels };
}

function parseCssRgbColor(value: string | null): { r: number; g: number; b: number } | null {
  if (!value) return null;
  const raw = value.trim();
  const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const body = hex[1];
    const full = body.length === 3
      ? body.split('').map((char) => `${char}${char}`).join('')
      : body;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
    };
  }
  const rgb = raw.match(/^rgba?\(\s*([.\d]+)\s*,\s*([.\d]+)\s*,\s*([.\d]+)/i);
  if (!rgb) return null;
  return {
    r: Math.max(0, Math.min(255, Math.round(Number(rgb[1])))),
    g: Math.max(0, Math.min(255, Math.round(Number(rgb[2])))),
    b: Math.max(0, Math.min(255, Math.round(Number(rgb[3])))),
  };
}

function dilateAlphaMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask;
  const out = new Uint8Array(mask.length);
  const radiusSq = radius * radius;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = mask[y * width + x] ?? 0;
      if (!value) continue;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dy * dy > radiusSq) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const outIdx = yy * width + xx;
          if ((out[outIdx] ?? 0) < value) out[outIdx] = value;
        }
      }
    }
  }
  return out;
}

function colorDistance(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
): number {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function stripImportedVectorRunFontNames(runs: unknown): unknown {
  if (!Array.isArray(runs)) return runs;
  return runs.map((run) => {
    if (!run || typeof run !== 'object') return run;
    const next = { ...(run as Record<string, unknown>) };
    delete next.fontName;
    delete next.fontFamily;
    delete next.postScriptName;
    delete next.family;
    return next;
  });
}

async function buildPsdTextPreviewImage(
  src: string,
  basePreview: fabric.FabricImage,
  strokeOptions: Record<string, unknown>,
  scaleX: number,
  scaleY: number,
  fillColor?: string | null,
  effects?: Record<string, unknown> | null,
): Promise<{ image: fabric.FabricImage; padX: number; padY: number }> {
  const textFillColor = typeof fillColor === 'string' && fillColor.trim() ? fillColor.trim() : '';
  const strokeColor = typeof strokeOptions.stroke === 'string' ? strokeOptions.stroke : '';
  const strokeWidth = toFiniteNumber(strokeOptions.strokeWidth);
  const hasStroke = Boolean(strokeColor && strokeWidth !== null && strokeWidth > 0);
  if (!textFillColor && !hasStroke) {
    return { image: basePreview, padX: 0, padY: 0 };
  }

  const safeScaleX = Number.isFinite(scaleX) && scaleX > 0 ? scaleX : 1;
  const safeScaleY = Number.isFinite(scaleY) && scaleY > 0 ? scaleY : safeScaleX;
  const imageStrokeWidth = hasStroke
    ? Math.max(1, Math.ceil((strokeWidth || 0) / Math.max(safeScaleX, safeScaleY, 0.01)))
    : 0;
  const outlined = await rasterizeAlphaStyle(
    src,
    textFillColor || null,
    hasStroke ? strokeColor : null,
    imageStrokeWidth,
    effects,
  ).catch(() => null);
  if (!outlined) return { image: basePreview, padX: 0, padY: 0 };

  const image = await fabric.FabricImage.fromURL(outlined.dataUrl);
  return {
    image,
    padX: outlined.padX * safeScaleX,
    padY: outlined.padY * safeScaleY,
  };
}

async function buildPsdImageWithInheritedFill(
  src: string,
  baseImage: fabric.FabricImage,
  layer: ParsedLayer,
): Promise<{ image: fabric.FabricImage; padX: number; padY: number }> {
  const fillColor = getPsdInheritedSolidFillColor(layer);
  if (!fillColor) return { image: baseImage, padX: 0, padY: 0 };
  const rasterized = await rasterizeAlphaStyle(
    src,
    fillColor,
    null,
    0,
    null,
  ).catch(() => null);
  if (!rasterized) return { image: baseImage, padX: 0, padY: 0 };
  const image = await fabric.FabricImage.fromURL(rasterized.dataUrl);
  return { image, padX: rasterized.padX, padY: rasterized.padY };
}

function getLayerImageScale(
  layer: ParsedLayer,
  image: fabric.FabricImage,
  padX = 0,
  padY = 0,
): { scaleX: number; scaleY: number } {
  const layerWidth = toFiniteNumber(layer.width);
  const layerHeight = toFiniteNumber(layer.height);
  const imageWidth = Math.max(1, toFiniteNumber(image.width) ?? 1);
  const imageHeight = Math.max(1, toFiniteNumber(image.height) ?? 1);
  const targetWidth = layerWidth !== null && layerWidth > 0 ? layerWidth + padX * 2 : imageWidth;
  const targetHeight = layerHeight !== null && layerHeight > 0 ? layerHeight + padY * 2 : imageHeight;
  return {
    scaleX: targetWidth / imageWidth,
    scaleY: targetHeight / imageHeight,
  };
}

async function buildPsdGroupEffectOverlay(
  groupLayer: ParsedLayer,
  resolveAssetUrl: (assetPath: string) => string = assetPath => `/uploads/${assetPath}`,
): Promise<{ image: fabric.FabricImage } | null> {
  if (typeof document === 'undefined' || !groupLayer.children?.length) return null;
  const effects = getParsedLayerEffects(groupLayer);
  const stroke = getPsdEffect(effects, 'stroke');
  const strokeColor = extractCssColor(stroke?.color, stroke?.opacity);
  const strokeWidth = toFiniteNumber(stroke?.size);
  const hasStroke = Boolean(strokeColor && strokeWidth !== null && strokeWidth > 0);
  const hasShadow = buildPsdAlphaShadows(effects).length > 0;
  if (!hasStroke && !hasShadow) return null;

  const sourceLayers = collectPsdGroupImageLayers(groupLayer.children);
  if (sourceLayers.length === 0) return null;
  const bounds = unionParsedLayerBounds(sourceLayers);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;

  const mask = document.createElement('canvas');
  mask.width = Math.max(1, Math.ceil(bounds.width));
  mask.height = Math.max(1, Math.ceil(bounds.height));
  const ctx = mask.getContext('2d');
  if (!ctx) return null;

  for (const layer of sourceLayers) {
    if (!layer.imagePath) continue;
    try {
      const img = await loadHtmlImage(resolveAssetUrl(layer.imagePath));
      const left = (toFiniteNumber(layer.x) ?? 0) - bounds.left;
      const top = (toFiniteNumber(layer.y) ?? 0) - bounds.top;
      const width = toFiniteNumber(layer.width) || img.naturalWidth || img.width;
      const height = toFiniteNumber(layer.height) || img.naturalHeight || img.height;
      ctx.globalAlpha = getPsdLayerContentOpacity(layer);
      ctx.drawImage(img, left, top, width, height);
    } catch {
      // ignore a missing child preview; the editable child itself still loads below
    }
  }
  ctx.globalAlpha = 1;

  const rasterized = await rasterizeAlphaStyle(
    mask.toDataURL('image/png'),
    null,
    hasStroke ? strokeColor : null,
    strokeWidth !== null ? strokeWidth : 0,
    effects,
    false,
  ).catch(() => null);
  if (!rasterized) return null;

  const image = await fabric.FabricImage.fromURL(rasterized.dataUrl);
  image.set({
    left: bounds.left - rasterized.padX,
    top: bounds.top - rasterized.padY,
    selectable: false,
    evented: false,
    objectCaching: false,
  });
  (image as any)._layerId = `${groupLayer.id}-group-effects`;
  (image as any)._layerName = `${groupLayer.layerName || 'Group'} effects`;
  (image as any)._layerType = 'group-effect';
  return { image };
}

async function rasterizeAlphaStyle(
  src: string,
  fillColor: string | null,
  strokeColor: string | null,
  strokeWidth: number,
  effects?: Record<string, unknown> | null,
  drawSource = true,
): Promise<{ dataUrl: string; padX: number; padY: number } | null> {
  if (typeof document === 'undefined') return null;

  const img = await loadHtmlImage(src);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  if (!width || !height) return null;

  const shadows = buildPsdAlphaShadows(effects);
  const shadowPad = shadows.reduce((max, shadow) => Math.max(
    max,
    Math.ceil(Math.abs(shadow.offsetX) + Math.abs(shadow.offsetY) + shadow.blur * 2),
  ), 0);
  const strokePad = strokeColor ? Math.max(1, Math.ceil(strokeWidth)) : 0;
  const pad = Math.max(strokePad, shadowPad);
  const mask = document.createElement('canvas');
  mask.width = width;
  mask.height = height;
  const maskCtx = mask.getContext('2d');
  if (!maskCtx) return null;
  maskCtx.drawImage(img, 0, 0);
  maskCtx.globalCompositeOperation = 'source-in';
  maskCtx.fillStyle = strokeColor || '#000';
  maskCtx.fillRect(0, 0, width, height);

  const out = document.createElement('canvas');
  out.width = width + pad * 2;
  out.height = height + pad * 2;
  const ctx = out.getContext('2d');
  if (!ctx) return null;

  for (const shadow of shadows) {
    ctx.save();
    ctx.shadowColor = shadow.color;
    ctx.shadowBlur = shadow.blur;
    ctx.shadowOffsetX = shadow.offsetX;
    ctx.shadowOffsetY = shadow.offsetY;
    ctx.drawImage(mask, pad, pad);
    ctx.restore();
  }

  if (strokeColor) {
    for (let y = -pad; y <= pad; y += 1) {
      for (let x = -pad; x <= pad; x += 1) {
        if (x === 0 && y === 0) continue;
        if (x * x + y * y > strokePad * strokePad) continue;
        ctx.drawImage(mask, pad + x, pad + y);
      }
    }
  }
  if (fillColor) {
    const fill = document.createElement('canvas');
    fill.width = width;
    fill.height = height;
    const fillCtx = fill.getContext('2d');
    if (!fillCtx) return null;
    fillCtx.drawImage(img, 0, 0);
    fillCtx.globalCompositeOperation = 'source-in';
    fillCtx.fillStyle = fillColor;
    fillCtx.fillRect(0, 0, width, height);
    ctx.drawImage(fill, pad, pad);
  } else if (drawSource) {
    ctx.drawImage(img, pad, pad);
  }
  return { dataUrl: out.toDataURL('image/png'), padX: pad, padY: pad };
}

function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('psd_text_preview_image_load_failed'));
    img.src = src;
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('blob_to_data_url_failed'));
    };
    reader.onerror = () => reject(reader.error || new Error('blob_to_data_url_failed'));
    reader.readAsDataURL(blob);
  });
}

function restoreTransparentHitTestingForCanvas(canvas: fabric.Canvas) {
  canvas.getObjects().forEach(restoreTransparentHitTesting);
}

function restorePsdLayerInteractivityForCanvas(canvas: fabric.Canvas, layers: ParsedLayer[]) {
  const savedLayers = ((canvas as PsdImportCanvas).__psdScene as { layers?: ParsedLayer[] } | undefined)?.layers;
  if (Array.isArray(savedLayers)) { applyPsdVisibilityState(canvas as PsdImportCanvas, savedLayers); return; }
  const statusByLayerId = collectPsdLayerInteractionStatus(layers);
  canvas.getObjects().forEach((object) => {
    const target = object as fabric.FabricObject & {
      _layerId?: unknown;
      _psdClipping?: boolean;
      _psdLocked?: boolean;
    };
    if (isPdfRasterVisualFabricObject(target)) {
      enforcePdfRasterVisualOnlyObject(target);
      return;
    }
    const layerId = target._layerId;
    if (layerId === undefined || layerId === null) return;

    const status = statusByLayerId.get(String(layerId));
      const locked = status ? status.locked === true : target._psdLocked === true;
    const clipped = target._psdClipping === true || status?.clipping === true;

    if (status) target._psdLocked = locked;
    if (locked) {
      target.set({ selectable: false, evented: false });
    } else if (clipped) {
      target.set({ selectable: true, evented: true });
      target._psdClipping = true;
    }
    target.setCoords();
  });
}

function collectPsdLayerInteractionStatus(
  layers: ParsedLayer[],
  result: Map<string, { locked: boolean; clipping: boolean }> = new Map(),
) {
  layers.forEach((layer) => {
    const props = layer.properties as Record<string, unknown> | null | undefined;
    result.set(String(layer.id), {
      locked: props?.locked === true,
      clipping: isPsdClippingLayer(layer),
    });
    if (layer.children?.length) collectPsdLayerInteractionStatus(layer.children, result);
  });
  return result;
}

function normalizeLoadedPsdTextObjects(
  canvas: fabric.Canvas,
  fileType?: string,
  options: { preserveFontFamily?: boolean } = {},
) {
  if ((canvas as PsdImportCanvas).__psdScene) return;
  const importedVectorText = isImportedVectorType(fileType);
  canvas.getObjects().forEach((object) => {
    const target = object as fabric.FabricObject & {
      _layerType?: string;
      _psdFontName?: string;
      type?: string;
      fontFamily?: string;
      fontWeight?: string | number;
      lineHeight?: number;
      scaleX?: number;
      _psdAutoScaleX?: number;
      text?: string;
      set?: (key: string | Record<string, unknown>, value?: unknown) => void;
    };
    const objectType = typeof target.type === 'string' ? target.type.toLowerCase() : '';
    const isTextObject =
      target._layerType === 'text' ||
      object instanceof fabric.IText ||
      object instanceof fabric.Textbox ||
      objectType.includes('text');
    if (!isTextObject) return;

    const psdFontName = typeof target._psdFontName === 'string' ? target._psdFontName : '';
    if (!options.preserveFontFamily && importedVectorText) {
      target.set?.({
        fontFamily: MISSING_PSD_TEXT_EDIT_FONT_FAMILY,
        fontWeight: '400',
      });
    } else if (!options.preserveFontFamily && psdFontName) {
      target.set?.({
        fontFamily: mapPsdFont(psdFontName),
        fontWeight: getPsdFontWeight(psdFontName, null),
      });
    }
    if (typeof target.lineHeight === 'number' && (!Number.isFinite(target.lineHeight) || target.lineHeight <= 0)) {
      target.set?.('lineHeight', 1.2);
    }
    // 之前这里强制 DIN scaleX=1（防御老存档里被压坏的 0.72），
    // 但代价是 fabric 把 DIN 渲得 ~36% 比 PS 宽，重新打开就显宽。
    // 改成：把可能不合理的 scaleX 拉回安全带 [0.65, 1.10]，否则不动；
    // 真正的补偿由 refitDinTextsFromSavedState 重测后再下。
    if (isDinNumericTextTarget(target)) {
      const sx = typeof target.scaleX === 'number' ? target.scaleX : 1;
      if (!Number.isFinite(sx) || (target._psdAutoScaleX !== undefined && sx < 1) || sx > 1.10) {
        target.set?.('scaleX', 1);
        target._psdAutoScaleX = undefined;
      }
    }
  });
}

function repairPsdManualLineHeightsFromSavedState(
  canvas: fabric.Canvas,
  layers: ParsedLayer[],
): boolean {
  if ((canvas as PsdImportCanvas).__psdScene) return false;
  const textLayers = flattenLayers(layers).filter((layer) =>
    layer.layerType === 'text' && /[\r\n]/.test(layer.textContent || ''),
  );
  if (textLayers.length === 0) return false;

  const objects = [...canvas.getObjects()];
  for (let i = 0; i < objects.length; i += 1) {
    objects.push(...getFabricObjectChildren(objects[i]));
  }

  let changed = false;
  for (const object of objects) {
    const target = object as fabric.FabricObject & {
      _layerId?: unknown;
      _layerName?: unknown;
      _layerType?: string;
      _psdTextIsAreaText?: boolean;
      _psdTextOptions?: Record<string, unknown>;
      _psdTextOrientation?: unknown;
      _psdPreviewVisualBounds?: Partial<PixelBounds>;
      fontSize?: number;
      lineHeight?: number;
      text?: string;
      type?: string;
      width?: number;
      set?: (key: string | Record<string, unknown>, value?: unknown) => void;
    };
    const objectType = String(target.type || '').toLowerCase();
    const isTextObject =
      target._layerType === 'text' ||
      object instanceof fabric.IText ||
      object instanceof fabric.Textbox ||
      objectType.includes('text');
    if (!isTextObject || isPsdTextPreviewObject(object)) continue;
    if (isPsdVerticalTextTarget(target)) continue;

    const layer = findMatchingPsdTextLayerForObject(target, textLayers);
    if (!layer) continue;
    const content = layer.textContent || target.text || '';
    if (!/[\r\n]/.test(content)) continue;

    const style = layer.textStyle as Record<string, unknown> | null;
    const dominantRun = getDominantPsdTextRun(style);
    const rawFontSize =
      toFiniteNumber(style?.fontSize) ||
      toFiniteNumber(dominantRun?.fontSize) ||
      toFiniteNumber(target.fontSize) ||
      24;
    const textScaleY = toFiniteNumber(style?.textScaleY) || toFiniteNumber(style?.textScale) || 1;
    const renderedFontSize = toFiniteNumber(target.fontSize) || rawFontSize * textScaleY;
    const layerHeight = positivePsdNumber(
      getStoredPsdTextVisualBounds(target)?.height ?? layer.height,
      positivePsdNumber(layer.height, renderedFontSize),
    );
    const rawLineHeight = getPsdLineHeight(style, rawFontSize, dominantRun);
    const lineHeight = getPsdManualLineHeight(content, renderedFontSize, layerHeight, rawLineHeight);
    if (!Number.isFinite(lineHeight) || lineHeight <= 0) continue;

    const currentLineHeight = toFiniteNumber(target.lineHeight);
    if (currentLineHeight === null || Math.abs(currentLineHeight - lineHeight) > 0.001) {
      target.set?.('lineHeight', lineHeight);
      changed = true;
    }

    if (target._psdTextIsAreaText !== false) {
      target._psdTextIsAreaText = false;
      changed = true;
    }

    const existingOptions = target._psdTextOptions || {};
    if (Math.abs((toFiniteNumber(existingOptions.lineHeight) || 0) - lineHeight) > 0.001) {
      target._psdTextOptions = { ...existingOptions, lineHeight };
      changed = true;
    }

    if (object instanceof fabric.Textbox) {
      preventTextboxManualLineWrap(
        object,
        content,
        positivePsdNumber(layer.width, positivePsdNumber(target.width, object.getScaledWidth())),
      );
    }
    resetPsdEditableTextDimensions(object);
    object.setCoords();
  }

  if (changed) canvas.requestRenderAll();
  return changed;
}

async function repairPsdVerticalTextsFromSavedState(
  canvas: fabric.Canvas,
  layers: ParsedLayer[],
): Promise<boolean> {
  if ((canvas as PsdImportCanvas).__psdScene) return false;
  const textLayers = flattenLayers(layers).filter((layer) => layer.layerType === 'text');
  if (textLayers.length === 0) return false;

  const activeObject = canvas.getActiveObject();
  const objects = [...canvas.getObjects()];
  let changed = false;

  for (const object of objects) {
    const target = object as fabric.FabricObject & {
      _layerId?: unknown;
      _layerName?: unknown;
      _layerType?: string;
      _psdPreviewVisualBounds?: Partial<PixelBounds>;
      _psdTextOrientation?: unknown;
      charSpacing?: number;
      editable?: boolean;
      fontFamily?: string;
      fontSize?: number;
      fontStyle?: string;
      fontWeight?: string | number;
      lineHeight?: number;
      linethrough?: boolean;
      text?: string;
      textAlign?: string;
      type?: string;
      underline?: boolean;
    };
    const objectType = String(target.type || '').toLowerCase();
    const isTextObject =
      target._layerType === 'text' ||
      object instanceof fabric.IText ||
      object instanceof fabric.Textbox ||
      objectType.includes('text');
    if (!isTextObject) continue;

    const layer = findMatchingPsdTextLayerForObject(target, textLayers);
    if (!layer) continue;
    const style = layer.textStyle as Record<string, unknown> | null;
    const rawFontSize =
      toFiniteNumber(style?.fontSize) ||
      toFiniteNumber((style?.runs as Array<Record<string, unknown>> | undefined)?.[0]?.fontSize) ||
      toFiniteNumber(target.fontSize) ||
      24;
    const textScaleY = toFiniteNumber(style?.textScaleY) || toFiniteNumber(style?.textScale) || 1;
    const fontSize = toFiniteNumber(target.fontSize) || rawFontSize * textScaleY;
    const layerWidth = positivePsdNumber(layer.width, 1);
    const storedBounds = getStoredPsdTextVisualBounds(target);
    const layerHeight = positivePsdNumber(storedBounds?.height ?? layer.height, positivePsdNumber(layer.height, 1));
    if (!isPsdVerticalTextLayer(layer, style, fontSize, layerWidth, layerHeight)) continue;

    const content = layer.textContent || target.text || '';
    const formattedContent = formatPsdVerticalTextContent(content);
    if (!formattedContent) continue;
    const tracking = toFiniteNumber(target.charSpacing) || toFiniteNumber(style?.tracking) || 0;
    const lineHeight = getPsdVerticalLineHeight(content, fontSize, layerHeight, toFiniteNumber(target.lineHeight) || 1, tracking);
    const wasActive = activeObject === object;
    let repaired: fabric.FabricObject = object;

    if (object instanceof fabric.Textbox || objectType === 'textbox') {
      const replacement = new fabric.IText(formattedContent, {
        left: target.left,
        top: target.top,
        angle: target.angle || 0,
        scaleX: target.scaleX || 1,
        scaleY: target.scaleY || 1,
        fill: target.fill,
        fontFamily: target.fontFamily,
        fontSize,
        fontStyle: target.fontStyle || 'normal',
        fontWeight: target.fontWeight || '400',
        underline: target.underline === true,
        linethrough: target.linethrough === true,
        charSpacing: Math.round(toFiniteNumber(target.charSpacing) || 0),
        lineHeight,
        textAlign: (target.textAlign as fabric.IText['textAlign']) || 'left',
        opacity: target.opacity ?? 1,
        editable: target.editable !== false,
        selectable: target.selectable !== false,
        evented: target.evented !== false,
        objectCaching: false,
        splitByGrapheme: true,
        globalCompositeOperation: target.globalCompositeOperation as GlobalCompositeOperation,
        ...(target.clipPath ? { clipPath: target.clipPath } : {}),
        ...(target.shadow ? { shadow: target.shadow } : {}),
        ...(target.stroke ? { stroke: target.stroke } : {}),
        ...(target.strokeWidth ? { strokeWidth: target.strokeWidth } : {}),
      } as Partial<fabric.IText>);
      copyPsdTextCustomProperties(target, replacement);
      const index = canvas.getObjects().indexOf(object);
      canvas.remove(object);
      if (index >= 0) {
        canvas.insertAt(index, replacement);
      } else {
        canvas.add(replacement);
      }
      repaired = replacement;
      changed = true;
    } else {
      const editable = object as fabric.IText;
      if (editable.text !== formattedContent || Math.abs((toFiniteNumber(editable.lineHeight) || 1) - lineHeight) > 0.001) {
        editable.set({ text: formattedContent, lineHeight } as Partial<fabric.IText>);
        changed = true;
      }
    }

    const custom = repaired as fabric.FabricObject & Record<string, unknown>;
    custom._psdTextOrientation = 'vertical';
    custom._psdLayerBounds = {
      left: layer.x || 0,
      top: layer.y || 0,
      width: layer.width || 0,
      height: layer.height || 0,
    };
    custom._psdPreviewVisualBounds = storedBounds || psdLayerBoundsToPixelBounds(custom._psdLayerBounds as Required<PsdLayerBounds>);
    await waitForCanvasFont(
      String((repaired as fabric.IText).fontFamily || 'sans-serif'),
      Number((repaired as fabric.IText).fontSize) || fontSize,
      String((repaired as fabric.IText).fontWeight || '400'),
    );
    resetPsdEditableTextDimensions(repaired);
    await fitPsdVerticalTextToVisualHeight(canvas, repaired, layerHeight);
    await fitTextToPsdBounds(canvas, repaired, layer, false);
    if (wasActive) canvas.setActiveObject(repaired);
  }

  if (changed) canvas.requestRenderAll();
  return changed;
}

function findMatchingPsdTextLayerForObject(
  object: fabric.FabricObject & { _layerId?: unknown; _layerName?: unknown; text?: string },
  layers: ParsedLayer[],
): ParsedLayer | null {
  const layerId = object._layerId;
  if (layerId !== undefined && layerId !== null) {
    const byId = layers.find((layer) => String(layer.id) === String(layerId));
    if (byId) return byId;
  }
  const objectName = String(object._layerName || '').trim();
  const objectText = normalizePsdTextForMatch(object.text);
  return layers.find((layer) =>
    String(layer.layerName || '').trim() === objectName &&
    normalizePsdTextForMatch(layer.textContent) === objectText,
  ) || layers.find((layer) => normalizePsdTextForMatch(layer.textContent) === objectText) || null;
}

function normalizePsdTextForMatch(value: unknown): string {
  return String(value || '').replace(/\s+/g, '');
}

function getStoredPsdTextVisualBounds(object: { _psdPreviewVisualBounds?: Partial<PixelBounds> }): PixelBounds | null {
  const bounds = object._psdPreviewVisualBounds;
  if (!bounds) return null;
  const left = toFiniteNumber(bounds.left);
  const top = toFiniteNumber(bounds.top);
  const width = toFiniteNumber(bounds.width);
  const height = toFiniteNumber(bounds.height);
  if (left === null || top === null || width === null || height === null || width <= 0 || height <= 0) return null;
  return {
    left,
    top,
    width,
    height,
    right: toFiniteNumber(bounds.right) ?? left + width - 1,
    bottom: toFiniteNumber(bounds.bottom) ?? top + height - 1,
  };
}

function copyPsdTextCustomProperties(source: object, target: object) {
  for (const key of fabricObjectClass.customProperties || []) {
    (target as Record<string, unknown>)[key] = (source as Record<string, unknown>)[key];
  }
}

function isPsdTextPreviewObject(object: fabric.FabricObject | null | undefined): object is PsdTextPreviewImage {
  return Boolean(object && (object as PsdTextPreviewImage)._psdTextPreview === true);
}

function isPdfSourceTextActivationObject(
  object: fabric.FabricObject | null | undefined,
): object is PdfSourceTextActivationObject {
  return Boolean(object && (object as PdfSourceTextActivationObject)._pdfSourceTextActivation === true);
}

function isEditableFabricTextObject(
  object: fabric.FabricObject | null | undefined,
): object is fabric.IText | fabric.Textbox {
  return Boolean(object && (
    object instanceof fabric.IText
    || object instanceof fabric.Textbox
    || object.type === 'i-text'
    || object.type === 'textbox'
  ));
}

function isDoubleClickEditableTextTarget(
  object: fabric.FabricObject | null | undefined,
): object is fabric.IText | fabric.Textbox | PsdTextPreviewImage | PdfSourceTextActivationObject {
  return isEditableFabricTextObject(object) || isPsdTextPreviewObject(object) || isPdfSourceTextActivationObject(object);
}

function normalizeManualLineTextboxBeforeEditing(object: fabric.FabricObject) {
  if (!(object instanceof fabric.Textbox)) return;
  const target = object as fabric.Textbox & {
    _layerType?: string;
    _psdLayerBounds?: PsdLayerBounds;
    _psdTextIsAreaText?: boolean;
    text?: string;
    width?: number;
  };
  const content = String(target.text || '');
  if (!/[\r\n]/.test(content) || isPsdVerticalTextTarget(target)) return;
  if (target._layerType !== 'text' && !target._psdLayerBounds) return;
  target._psdTextIsAreaText = false;
  preventTextboxManualLineWrap(
    object,
    content,
    positivePsdNumber(target.width, object.getScaledWidth()),
  );
}

function enterDoubleClickTextTarget(
  canvas: fabric.Canvas,
  event: FabricPointerInfo,
  target: fabric.FabricObject | null | undefined,
  beginPreviewTextEditing: (target: fabric.FabricObject | null | undefined) => Promise<void> | void,
) {
  if (!isDoubleClickEditableTextTarget(target)) return false;
  activateTextTargetAncestorsForEditing(canvas, target);
  if (enterFabricTextEditing(canvas, target, event.e)) return true;
  if (!isPsdTextPreviewObject(target) && !isPdfSourceTextActivationObject(target)) return false;
  void beginPreviewTextEditing(target);
  return true;
}

function findEditableTextTargetAtPointer(
  canvas: fabric.Canvas,
  event: FabricPointerInfo,
): fabric.FabricObject | null {
  const point = getCanvasPointFromNativeEvent(canvas, event.e);
  if (!point) return null;
  const objects = canvas.getObjects();
  for (let i = objects.length - 1; i >= 0; i--) {
    const target = findEditableTextTargetInObject(objects[i], point);
    if (target) return target;
  }
  return null;
}

function findEditableTextTargetInObject(
  object: fabric.FabricObject,
  point: CanvasPoint,
): fabric.FabricObject | null {
  if (!object || object.visible === false) return null;
  const children = getFabricObjectChildren(object);
  for (let i = children.length - 1; i >= 0; i--) {
    const target = findEditableTextTargetInObject(children[i], point);
    if (target) return target;
  }
  if (!isDoubleClickEditableTextTarget(object)) return null;
  if (!isTextTargetAvailableForDoubleClick(object)) return null;
  return isPointInTextEditingHitBounds(object, point) ? object : null;
}

function getFabricObjectChildren(object: fabric.FabricObject): fabric.FabricObject[] {
  const target = object as fabric.FabricObject & {
    getObjects?: () => fabric.FabricObject[];
  };
  return typeof target.getObjects === 'function' ? target.getObjects().filter(Boolean) : [];
}

function isTextTargetAvailableForDoubleClick(object: fabric.FabricObject) {
  const target = object as fabric.FabricObject & {
    _psdLocked?: boolean;
    editable?: boolean;
  };
  if (target._psdLocked || target.visible === false) return false;
  if (target.evented === false && target.selectable === false) return false;
  if (isEditableFabricTextObject(object) && target.editable === false) return false;
  return true;
}

function isPointInTextEditingHitBounds(object: fabric.FabricObject, point: CanvasPoint) {
  try {
    object.setCoords();
  } catch {
    // ignore stale object coordinates during route/template switches
  }
  const padding = Math.max(8, Number(object.padding || 0));
  if (isPointInBounds(point, object.getBoundingRect(), padding)) return true;

  const previewBounds = (object as PsdTextPreviewImage)._psdPreviewVisualBounds;
  if (previewBounds && isPointInBounds(point, previewBounds, padding)) return true;

  const layerBounds = (object as fabric.FabricObject & { _psdLayerBounds?: PsdLayerBounds })._psdLayerBounds;
  if (!layerBounds) return false;
  const left = toFiniteNumber(layerBounds.left);
  const top = toFiniteNumber(layerBounds.top);
  const width = toFiniteNumber(layerBounds.width);
  const height = toFiniteNumber(layerBounds.height);
  if (left === null || top === null || width === null || height === null) return false;
  return isPointInBounds(point, { left, top, width, height }, padding);
}

function isPointInBounds(
  point: CanvasPoint,
  bounds: Partial<PixelBounds> & { left?: number; top?: number; width?: number; height?: number },
  padding = 0,
) {
  const left = toFiniteNumber(bounds.left);
  const top = toFiniteNumber(bounds.top);
  const width = toFiniteNumber(bounds.width);
  const height = toFiniteNumber(bounds.height);
  const right = toFiniteNumber(bounds.right) ?? (left !== null && width !== null ? left + width : null);
  const bottom = toFiniteNumber(bounds.bottom) ?? (top !== null && height !== null ? top + height : null);
  if (left === null || top === null || right === null || bottom === null) return false;
  return point.x >= left - padding
    && point.x <= right + padding
    && point.y >= top - padding
    && point.y <= bottom + padding;
}

function activateTextTargetAncestorsForEditing(
  canvas: fabric.Canvas,
  target: fabric.FabricObject,
) {
  const ancestors = ((target as fabric.FabricObject & {
    getAncestors?: () => fabric.FabricObject[];
  }).getAncestors?.() || []).filter((ancestor) => ancestor.type === 'group');
  for (const ancestor of ancestors) {
    const group = ancestor as fabric.Group & {
      interactive?: boolean;
      subTargetCheck?: boolean;
      objectCaching?: boolean;
    };
    group.set({
      interactive: true,
      subTargetCheck: true,
      objectCaching: false,
    } as Partial<fabric.Group>);
    bindGroupInteractiveDeselect(canvas, group, target);
  }
  canvas.setActiveObject(target);
  canvas.requestRenderAll();
}

function enterFabricTextEditing(
  canvas: fabric.Canvas,
  object: fabric.FabricObject | null | undefined,
  event?: fabric.TPointerEvent,
) {
  if (!isEditableFabricTextObject(object)) return false;
  normalizeManualLineTextboxBeforeEditing(object);
  const editable = object as fabric.IText & {
    editable?: boolean;
    enterEditing?: (e?: fabric.TPointerEvent) => void;
    hiddenTextarea?: HTMLTextAreaElement | null;
    isEditing?: boolean;
    renderCursorOrSelection?: () => void;
    setCursorByClick?: (e: fabric.TPointerEvent) => void;
    _updateTextarea?: () => void;
  };
  if (editable.editable === false || editable.isEditing) return false;

  canvas.setActiveObject(object);
  editable.enterEditing?.(event);
  if (event) {
    editable.setCursorByClick?.(event);
    editable._updateTextarea?.();
    editable.renderCursorOrSelection?.();
  }
  editable.hiddenTextarea?.focus?.({ preventScroll: true });
  canvas.requestRenderAll();
  return true;
}

async function enterPdfSourceTextEditing(
  canvas: fabric.Canvas,
  activation: PdfSourceTextActivationObject,
): Promise<fabric.FabricObject> {
  const sourceBounds = getPdfSourceTextActivationBounds(activation);
  if ((activation._pdfSourceTextGlyphIds || []).length === 0) {
    await createPdfSourceTextBackgroundPatch(canvas, activation, sourceBounds);
  }
  const text = convertPdfSourceTextActivationToEditableText(canvas, activation);
  const editable = text as fabric.IText & {
    enterEditing?: () => void;
    selectAll?: () => void;
    hiddenTextarea?: HTMLTextAreaElement | null;
  };
  await waitForCanvasFont(
    String((text as fabric.IText).fontFamily || MISSING_PSD_TEXT_EDIT_FONT_FAMILY),
    Number((text as fabric.IText).fontSize) || 16,
    String((text as fabric.IText).fontWeight || '400'),
  );
  resetPsdEditableTextDimensions(text);
  fitPdfSourceSingleLineTextToOriginalWidth(text, activation);
  if (isPsdVerticalTextTarget(text)) {
    await fitPsdVerticalTextToVisualHeight(canvas, text, sourceBounds.height);
    await alignObjectToPsdPreviewBounds(canvas, text, sourceBounds);
  }
  text.setCoords();
  editable.enterEditing?.();
  editable.selectAll?.();
  editable.hiddenTextarea?.focus?.({ preventScroll: true });
  canvas.requestRenderAll();
  canvas.fire('object:modified', { target: text });
  return text;
}

async function createPdfSourceTextBackgroundPatch(
  canvas: fabric.Canvas,
  activation: PdfSourceTextActivationObject,
  bounds: Required<PsdLayerBounds>,
): Promise<fabric.FabricImage | null> {
  const existing = canvas.getObjects().find((object) => {
    const target = object as fabric.FabricObject & {
      _layerId?: unknown;
      _pdfSourceTextBackgroundPatch?: boolean;
      _pdfSourceTextBackgroundPatchVersion?: number;
    };
    return target._pdfSourceTextBackgroundPatch === true
      && String(target._layerId ?? '') === String(activation._layerId ?? '');
  });
  if (existing instanceof fabric.FabricImage) {
    const version = Number((existing as fabric.FabricImage & {
      _pdfSourceTextBackgroundPatchVersion?: number;
    })._pdfSourceTextBackgroundPatchVersion);
    if (version >= PDF_SOURCE_TEXT_BACKGROUND_PATCH_VERSION) return existing;
    canvas.remove(existing);
  }

  const underlay = canvas.getObjects().find((object): object is fabric.FabricImage =>
    object instanceof fabric.FabricImage
    && (object as fabric.FabricImage & { _pdfPageRasterUnderlay?: boolean })._pdfPageRasterUnderlay === true
  );
  if (!underlay) return null;

  try {
    const activationLocalBounds = activation._pdfPageLocalBounds;
    const localBounds: Required<PsdLayerBounds> = {
      left: toFiniteNumber(activationLocalBounds?.left) ?? bounds.left,
      top: toFiniteNumber(activationLocalBounds?.top) ?? bounds.top,
      width: positivePsdNumber(activationLocalBounds?.width, bounds.width),
      height: positivePsdNumber(activationLocalBounds?.height, bounds.height),
    };
    const cleanupBounds = getPdfSourceTextCleanupBounds(canvas, activation, localBounds, underlay);
    const source = underlay.getElement() as CanvasImageSource & {
      naturalWidth?: number;
      naturalHeight?: number;
      width?: number;
      height?: number;
    };
    const sourceWidth = Math.max(1, Number(source.naturalWidth || source.width || underlay.width || 1));
    const sourceHeight = Math.max(1, Number(source.naturalHeight || source.height || underlay.height || 1));
    const underlayLocalBounds = (underlay as PdfPageCompositeObject)._pdfPageLocalBounds || {
      left: 0,
      top: 0,
      width: underlay.width || sourceWidth,
      height: underlay.height || sourceHeight,
    };
    const displayWidth = positivePsdNumber(underlayLocalBounds.width, sourceWidth);
    const displayHeight = positivePsdNumber(underlayLocalBounds.height, sourceHeight);
    const underlayLeft = toFiniteNumber(underlayLocalBounds.left) ?? 0;
    const underlayTop = toFiniteNumber(underlayLocalBounds.top) ?? 0;
    const patchWidth = Math.max(1, Math.round(cleanupBounds.width));
    const patchHeight = Math.max(1, Math.round(cleanupBounds.height));
    const samplePad = Math.max(3, Math.min(18, Math.round(patchHeight * 0.35)));
    const expandedWidth = patchWidth + samplePad * 2;
    const expandedHeight = patchHeight + samplePad * 2;
    const sourceX = ((cleanupBounds.left - samplePad - underlayLeft) / displayWidth) * sourceWidth;
    const sourceY = ((cleanupBounds.top - samplePad - underlayTop) / displayHeight) * sourceHeight;
    const sourceCropWidth = (expandedWidth / displayWidth) * sourceWidth;
    const sourceCropHeight = (expandedHeight / displayHeight) * sourceHeight;

    const sampled = document.createElement('canvas');
    sampled.width = expandedWidth;
    sampled.height = expandedHeight;
    const sampledCtx = sampled.getContext('2d', { willReadFrequently: true });
    if (!sampledCtx) return null;
    sampledCtx.drawImage(
      source,
      sourceX,
      sourceY,
      sourceCropWidth,
      sourceCropHeight,
      0,
      0,
      expandedWidth,
      expandedHeight,
    );
    const sampledData = sampledCtx.getImageData(0, 0, expandedWidth, expandedHeight);
    const patchCanvas = document.createElement('canvas');
    patchCanvas.width = patchWidth;
    patchCanvas.height = patchHeight;
    const patchCtx = patchCanvas.getContext('2d');
    if (!patchCtx) return null;
    const patchData = patchCtx.createImageData(patchWidth, patchHeight);
    const edgeBand = Math.max(1, Math.min(4, Math.floor(samplePad / 2)));
    const textFill = parsePdfSourceTextFillColor(activation);
    const nearestBackground = textFill
      ? buildNearestPdfTextBackgroundMap(sampledData, textFill)
      : null;

    const samplePixel = (x: number, y: number, horizontal: boolean): [number, number, number] => {
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let offset = 0; offset < edgeBand; offset++) {
        const px = Math.max(0, Math.min(expandedWidth - 1, horizontal ? x : x + offset));
        const py = Math.max(0, Math.min(expandedHeight - 1, horizontal ? y + offset : y));
        const index = (py * expandedWidth + px) * 4;
        r += sampledData.data[index] || 0;
        g += sampledData.data[index + 1] || 0;
        b += sampledData.data[index + 2] || 0;
        count++;
      }
      return [r / count, g / count, b / count];
    };

    for (let y = 0; y < patchHeight; y++) {
      const verticalRatio = patchHeight <= 1 ? 0.5 : y / (patchHeight - 1);
      for (let x = 0; x < patchWidth; x++) {
        const horizontalRatio = patchWidth <= 1 ? 0.5 : x / (patchWidth - 1);
        const sampleX = samplePad + x;
        const sampleY = samplePad + y;
        const top = samplePixel(sampleX, 0, true);
        const bottom = samplePixel(sampleX, expandedHeight - edgeBand, true);
        const left = samplePixel(0, sampleY, false);
        const right = samplePixel(expandedWidth - edgeBand, sampleY, false);
        const outIndex = (y * patchWidth + x) * 4;
        const background = [0, 0, 0];
        for (let channel = 0; channel < 3; channel++) {
          const vertical = top[channel] * (1 - verticalRatio) + bottom[channel] * verticalRatio;
          const horizontal = left[channel] * (1 - horizontalRatio) + right[channel] * horizontalRatio;
          background[channel] = Math.round((vertical + horizontal) / 2);
          patchData.data[outIndex + channel] = background[channel];
        }
        const sourceIndex = (sampleY * expandedWidth + sampleX) * 4;
        const sourceAlpha = (sampledData.data[sourceIndex + 3] || 0) / 255;
        let foregroundAlpha: number;
        if (textFill && nearestBackground) {
          const backgroundIndex = (sampleY * expandedWidth + sampleX) * 3;
          background[0] = nearestBackground[backgroundIndex];
          background[1] = nearestBackground[backgroundIndex + 1];
          background[2] = nearestBackground[backgroundIndex + 2];
          patchData.data[outIndex] = background[0];
          patchData.data[outIndex + 1] = background[1];
          patchData.data[outIndex + 2] = background[2];
          foregroundAlpha = estimatePdfTextPixelCoverage(
            [
              sampledData.data[sourceIndex] || 0,
              sampledData.data[sourceIndex + 1] || 0,
              sampledData.data[sourceIndex + 2] || 0,
            ],
            textFill,
            background,
          );
        } else {
          const colorDelta = Math.max(
            Math.abs((sampledData.data[sourceIndex] || 0) - background[0]),
            Math.abs((sampledData.data[sourceIndex + 1] || 0) - background[1]),
            Math.abs((sampledData.data[sourceIndex + 2] || 0) - background[2]),
          );
          foregroundAlpha = Math.max(0, Math.min(1, (colorDelta - 10) / 26));
        }
        const replacementAlpha = getPdfTextBackgroundReplacementAlpha(foregroundAlpha);
        patchData.data[outIndex + 3] = Math.round(255 * sourceAlpha * replacementAlpha);
      }
    }
    patchCtx.putImageData(patchData, 0, 0);

    const patch = await fabric.FabricImage.fromURL(patchCanvas.toDataURL('image/png'));
    patch.set({
      originX: 'left',
      originY: 'top',
      left: cleanupBounds.left,
      top: cleanupBounds.top,
      scaleX: cleanupBounds.width / Math.max(1, patch.width || patchWidth),
      scaleY: cleanupBounds.height / Math.max(1, patch.height || patchHeight),
      selectable: false,
      evented: false,
      hasControls: false,
      objectCaching: false,
      hoverCursor: 'default',
      excludeFromExport: false,
    });
    const custom = patch as fabric.FabricImage & Record<string, unknown>;
    custom._layerId = activation._layerId;
    custom._layerName = `${activation._layerName || activation._psdTextContent || '文字'} 背景修复`;
    custom._layerType = 'image';
    custom._pdfSourceTextBackgroundPatch = true;
    custom._pdfSourceTextBackgroundPatchVersion = PDF_SOURCE_TEXT_BACKGROUND_PATCH_VERSION;
    custom._psdLocked = false;
    linkPdfPageCompositeMember(canvas, patch, 'background-patch', cleanupBounds);

    const activationIndex = canvas.getObjects().indexOf(activation);
    if (activationIndex >= 0) canvas.insertAt(activationIndex, patch);
    else canvas.add(patch);
    return patch;
  } catch (error) {
    console.warn('[Editor] PDF source text background patch failed:', error);
    return null;
  }
}

type PdfTextRgb = [number, number, number];

function parsePdfSourceTextFillColor(activation: PdfSourceTextActivationObject): PdfTextRgb | null {
  const fill = activation._psdTextOptions?.fill;
  if (typeof fill !== 'string' || !fill.trim()) return null;
  try {
    const source = new fabric.Color(fill).getSource();
    if (!source || source.length < 3 || (source[3] ?? 1) <= 0.05) return null;
    return [source[0], source[1], source[2]];
  } catch {
    return null;
  }
}

function buildNearestPdfTextBackgroundMap(
  imageData: ImageData,
  textFill: PdfTextRgb,
): Uint8ClampedArray | null {
  const { width, height, data } = imageData;
  const pixelCount = width * height;
  const nearest = new Uint8ClampedArray(pixelCount * 3);
  const distance = new Int32Array(pixelCount);
  distance.fill(-1);
  const queue = new Int32Array(pixelCount);
  let queueEnd = 0;
  const backgroundDistanceSq = 72 * 72;

  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const sourceIndex = pixel * 4;
    if ((data[sourceIndex + 3] || 0) < 24) continue;
    const colorDistanceSq = squaredPdfTextColorDistance(
      [data[sourceIndex] || 0, data[sourceIndex + 1] || 0, data[sourceIndex + 2] || 0],
      textFill,
    );
    if (colorDistanceSq < backgroundDistanceSq) continue;
    const backgroundIndex = pixel * 3;
    nearest[backgroundIndex] = data[sourceIndex] || 0;
    nearest[backgroundIndex + 1] = data[sourceIndex + 1] || 0;
    nearest[backgroundIndex + 2] = data[sourceIndex + 2] || 0;
    distance[pixel] = 0;
    queue[queueEnd++] = pixel;
  }
  if (queueEnd === 0) return null;

  let queueStart = 0;
  const visit = (fromPixel: number, toPixel: number) => {
    if (toPixel < 0 || toPixel >= pixelCount || distance[toPixel] >= 0) return;
    const fromIndex = fromPixel * 3;
    const toIndex = toPixel * 3;
    nearest[toIndex] = nearest[fromIndex];
    nearest[toIndex + 1] = nearest[fromIndex + 1];
    nearest[toIndex + 2] = nearest[fromIndex + 2];
    distance[toPixel] = distance[fromPixel] + 1;
    queue[queueEnd++] = toPixel;
  };
  while (queueStart < queueEnd) {
    const pixel = queue[queueStart++];
    const x = pixel % width;
    if (x > 0) visit(pixel, pixel - 1);
    if (x + 1 < width) visit(pixel, pixel + 1);
    if (pixel >= width) visit(pixel, pixel - width);
    if (pixel + width < pixelCount) visit(pixel, pixel + width);
  }
  return nearest;
}

function estimatePdfTextPixelCoverage(
  pixel: PdfTextRgb,
  textFill: PdfTextRgb,
  background: number[],
): number {
  const vector = [
    textFill[0] - background[0],
    textFill[1] - background[1],
    textFill[2] - background[2],
  ];
  const contrastSq = vector[0] ** 2 + vector[1] ** 2 + vector[2] ** 2;
  if (contrastSq < 36 * 36) return 0;
  const relative = [
    pixel[0] - background[0],
    pixel[1] - background[1],
    pixel[2] - background[2],
  ];
  const projected = Math.max(0, Math.min(1,
    (relative[0] * vector[0] + relative[1] * vector[1] + relative[2] * vector[2]) / contrastSq,
  ));
  if (projected <= 0.02) return 0;
  const reconstructed = [
    background[0] + vector[0] * projected,
    background[1] + vector[1] * projected,
    background[2] + vector[2] * projected,
  ];
  const reconstructionError = Math.sqrt(
    (pixel[0] - reconstructed[0]) ** 2
    + (pixel[1] - reconstructed[1]) ** 2
    + (pixel[2] - reconstructed[2]) ** 2,
  );
  const colorConfidence = Math.max(0, Math.min(1, 1 - reconstructionError / 42));
  return Math.max(0, Math.min(1, ((projected - 0.02) / 0.5) * colorConfidence));
}

function getPdfTextBackgroundReplacementAlpha(coverage: number): number {
  if (!Number.isFinite(coverage) || coverage <= 0.015) return 0;
  if (coverage >= 0.04) return 1;
  return (coverage - 0.015) / 0.025;
}

function squaredPdfTextColorDistance(first: PdfTextRgb, second: PdfTextRgb): number {
  return (first[0] - second[0]) ** 2
    + (first[1] - second[1]) ** 2
    + (first[2] - second[2]) ** 2;
}

function getPdfSourceTextCleanupBounds(
  canvas: fabric.Canvas,
  activation: PdfSourceTextActivationObject,
  bounds: Required<PsdLayerBounds>,
  underlay: fabric.FabricImage,
): Required<PsdLayerBounds> {
  const verticalPadding = Math.max(1, Math.min(2, Math.ceil(bounds.height * 0.06)));
  const horizontalPadding = 1;
  let topPadding = verticalPadding;
  let bottomPadding = verticalPadding;
  let leftPadding = horizontalPadding;
  let rightPadding = horizontalPadding;
  const currentLayerId = String(activation._layerId ?? '');

  canvas.getObjects().forEach((object) => {
    const target = object as fabric.FabricObject & {
      _layerId?: unknown;
      _pdfSourceTextActivated?: boolean;
      _psdLayerBounds?: PsdLayerBounds;
      _pdfPageLocalBounds?: PsdLayerBounds;
    };
    if (object === activation || String(target._layerId ?? '') === currentLayerId) return;
    if (!isPdfSourceTextActivationObject(object) && target._pdfSourceTextActivated !== true) return;

    const otherBounds = target._pdfPageLocalBounds || target._psdLayerBounds;
    const otherLeft = toFiniteNumber(otherBounds?.left);
    const otherTop = toFiniteNumber(otherBounds?.top);
    const otherWidth = toFiniteNumber(otherBounds?.width);
    const otherHeight = toFiniteNumber(otherBounds?.height);
    if (otherLeft === null || otherTop === null || otherWidth === null || otherHeight === null) return;

    const otherRight = otherLeft + otherWidth;
    const otherBottom = otherTop + otherHeight;
    const right = bounds.left + bounds.width;
    const bottom = bounds.top + bounds.height;
    const horizontalOverlap = Math.min(right, otherRight) - Math.max(bounds.left, otherLeft);
    const verticalOverlap = Math.min(bottom, otherBottom) - Math.max(bounds.top, otherTop);

    if (horizontalOverlap > 0) {
      if (otherBottom <= bounds.top) {
        topPadding = Math.min(topPadding, Math.max(0, Math.floor((bounds.top - otherBottom - 1) / 2)));
      } else if (otherTop >= bottom) {
        bottomPadding = Math.min(bottomPadding, Math.max(0, Math.floor((otherTop - bottom - 1) / 2)));
      }
    }
    if (verticalOverlap > 0) {
      if (otherRight <= bounds.left) {
        leftPadding = Math.min(leftPadding, Math.max(0, Math.floor((bounds.left - otherRight - 1) / 2)));
      } else if (otherLeft >= right) {
        rightPadding = Math.min(rightPadding, Math.max(0, Math.floor((otherLeft - right - 1) / 2)));
      }
    }
  });

  const underlayLocalBounds = (underlay as PdfPageCompositeObject)._pdfPageLocalBounds || {
    left: 0,
    top: 0,
    width: underlay.width || 1,
    height: underlay.height || 1,
  };
  const underlayLeft = toFiniteNumber(underlayLocalBounds.left) ?? 0;
  const underlayTop = toFiniteNumber(underlayLocalBounds.top) ?? 0;
  const underlayRight = underlayLeft + positivePsdNumber(underlayLocalBounds.width, 1);
  const underlayBottom = underlayTop + positivePsdNumber(underlayLocalBounds.height, 1);
  const left = Math.max(underlayLeft, bounds.left - leftPadding);
  const top = Math.max(underlayTop, bounds.top - topPadding);
  const right = Math.min(underlayRight, bounds.left + bounds.width + rightPadding);
  const bottom = Math.min(underlayBottom, bounds.top + bounds.height + bottomPadding);
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

function convertPdfSourceTextActivationToEditableText(
  canvas: fabric.Canvas,
  activation: PdfSourceTextActivationObject,
): fabric.FabricObject {
  const historyCanvas = canvas as HistoryAwareCanvas;
  const previousSuspendHistory = historyCanvas.__suspendHistory;
  historyCanvas.__suspendHistory = true;
  try {
    const rawContent = activation._psdTextContent || '';
    const options = activation._psdTextOptions || {};
    const bounds = getPdfSourceTextActivationBounds(activation);
    const localBounds = activation._pdfPageLocalBounds || bounds;
    const isVerticalText = isPsdVerticalTextOptions(options, activation._psdTextOrientation);
    const content = isVerticalText ? formatPsdVerticalTextContent(rawContent) : rawContent;
    const fontSize = positivePsdNumber(options.fontSize, positivePsdNumber(bounds.height, 16));
    const verticalLineHeight = isVerticalText
      ? getPsdVerticalLineHeight(
          rawContent || content,
          fontSize,
          bounds.height,
          positivePsdNumber(options.lineHeight, 1.16),
          toFiniteNumber(options.charSpacing) || 0,
        )
      : null;
    hidePdfSourceGlyphPaths(canvas, activation._pdfSourceTextGlyphIds || [], activation._layerId);
    hidePdfSourceLinkedVisualObjects(
      canvas,
      activation._pdfSourceTextGlyphIds || [],
      bounds,
      activation._layerId,
    );
    const hasManualLineBreak = /[\r\n]/.test(content);
    const baseOptions = {
      ...options,
      ...(verticalLineHeight !== null ? { lineHeight: verticalLineHeight } : {}),
      originX: 'left',
      originY: 'top',
      left: activation.left ?? bounds.left,
      top: activation.top ?? bounds.top,
      width: positivePsdNumber(localBounds.width, bounds.width),
      scaleX: activation.scaleX ?? 1,
      scaleY: activation.scaleY ?? 1,
      angle: activation.angle || 0,
      opacity: activation.opacity ?? toFiniteNumber(options.opacity) ?? 1,
      fontFamily: String(options.fontFamily || MISSING_PSD_TEXT_EDIT_FONT_FAMILY),
      fontSize,
      fontWeight: String(options.fontWeight || '400'),
      fill: typeof options.fill === 'string' ? options.fill : '#141413',
      editable: true,
      selectable: true,
      evented: true,
      objectCaching: false,
      splitByGrapheme: true,
      perPixelTargetFind: false,
      targetFindTolerance: 8,
      globalCompositeOperation: activation.globalCompositeOperation as GlobalCompositeOperation,
    } as Partial<fabric.IText> & Record<string, unknown>;
    const text = !isVerticalText && !hasManualLineBreak && bounds.height > positivePsdNumber(options.fontSize, 16) * 1.9
      ? new fabric.Textbox(content, baseOptions as Partial<fabric.Textbox>)
      : new fabric.IText(content, baseOptions as Partial<fabric.IText>);
    const custom = text as unknown as fabric.FabricObject & Record<string, unknown>;
    custom._layerId = activation._layerId;
    custom._layerName = activation._layerName;
    custom._layerType = 'text';
    custom._pdfSourceTextActivated = true;
    custom._pdfPageCompositeId = activation._pdfPageCompositeId;
    custom._pdfPageCompositeRole = activation._pdfPageCompositeId ? 'activated-text' : undefined;
    custom._pdfPageLocalBounds = { ...localBounds };
    custom._pdfSourceTextGlyphIds = activation._pdfSourceTextGlyphIds || [];
    custom._pdfSourceTextOptions = activation._pdfSourceTextOptions || {};
    custom._psdFontName = activation._psdFontName || '';
    custom._psdLayerBounds = bounds;
    custom._psdPreviewVisualBounds = bounds;
    custom._psdTextOrientation = isVerticalText ? 'vertical' : undefined;
    custom._psdTextOptions = {
      ...options,
      ...(verticalLineHeight !== null ? { lineHeight: verticalLineHeight } : {}),
      ...(isVerticalText ? { textOrientation: 'vertical' } : {}),
    };
    custom._psdTextContent = rawContent;

    const index = canvas.getObjects().indexOf(activation);
    canvas.remove(activation);
    if (index >= 0) canvas.insertAt(index, text);
    else canvas.add(text);
    canvas.setActiveObject(text);
    updatePdfPageCompositeMemberBounds(custom as PdfPageCompositeObject);
    return text;
  } finally {
    historyCanvas.__suspendHistory = previousSuspendHistory;
  }
}

function fitPdfSourceSingleLineTextToOriginalWidth(
  object: fabric.FabricObject,
  activation: PdfSourceTextActivationObject,
) {
  if (!isEditableFabricTextObject(object)) return;
  const text = object as fabric.IText;
  if (/\r|\n/.test(text.text || '') || isPsdVerticalTextTarget(text)) return;
  const localBounds = activation._pdfPageLocalBounds;
  const targetLocalWidth = positivePsdNumber(localBounds?.width, positivePsdNumber(activation.width, 1));
  const naturalWidth = positivePsdNumber(
    text.width,
    text.getScaledWidth() / Math.max(0.0001, Math.abs(text.scaleX || 1)),
  );
  const content = text.text || '';
  const graphemeCount = Math.max(1, Array.from(content).length);
  const gapCount = Math.max(0, graphemeCount - 1);
  const fontSize = positivePsdNumber(text.fontSize, 16);
  const widthDelta = targetLocalWidth - naturalWidth;

  if (gapCount > 0 && Math.abs(widthDelta) > 0.5) {
    const currentCharSpacing = toFiniteNumber(text.charSpacing) || 0;
    const charSpacingDelta = (widthDelta / gapCount / fontSize) * 1000;
    text.set({
      charSpacing: Math.max(-250, Math.min(1800, currentCharSpacing + charSpacingDelta)),
    });
    resetPsdEditableTextDimensions(text);
  }

  const spacedWidth = positivePsdNumber(
    text.width,
    text.getScaledWidth() / Math.max(0.0001, Math.abs(text.scaleX || 1)),
  );
  if (Math.abs(spacedWidth - targetLocalWidth) > 0.75) {
    const widthRatio = Math.max(0.5, Math.min(2, targetLocalWidth / spacedWidth));
    text.set({ scaleX: (text.scaleX || 1) * widthRatio });
  }
  text.setCoords();
  updatePdfPageCompositeMemberBounds(text as PdfPageCompositeObject);
}

function getPdfSourceTextActivationBounds(activation: PdfSourceTextActivationObject): Required<PsdLayerBounds> {
  const layerBounds = activation._psdLayerBounds || {};
  return {
    left: toFiniteNumber(layerBounds.left) ?? activation.left ?? 0,
    top: toFiniteNumber(layerBounds.top) ?? activation.top ?? 0,
    width: positivePsdNumber(layerBounds.width, activation.getScaledWidth()),
    height: positivePsdNumber(layerBounds.height, activation.getScaledHeight()),
  };
}

function hidePdfSourceGlyphPaths(canvas: fabric.Canvas, glyphIds: string[], layerId?: unknown) {
  if (glyphIds.length === 0) return;
  const idSet = new Set(glyphIds);
  const sourceLayerKey = String(layerId ?? '');
  canvas.getObjects().forEach((object) => {
    const target = object as SvgDecorationLinkedObject & {
      _pdfTextGlyphId?: string;
      _pdfTextPath?: boolean;
    };
    if (target._pdfTextPath !== true || !target._pdfTextGlyphId || !idSet.has(target._pdfTextGlyphId)) return;
    if (sourceLayerKey) {
      const hiddenBy = new Set((target._pdfSourceTextHiddenByLayerIds || []).map(String));
      hiddenBy.add(sourceLayerKey);
      target._pdfSourceTextHiddenByLayerIds = Array.from(hiddenBy);
    }
    target.set({
      visible: false,
      selectable: false,
      evented: false,
    });
    target.setCoords();
  });
}

function hidePdfSourceLinkedVisualObjects(
  canvas: fabric.Canvas,
  glyphIds: string[],
  sourceBounds: PsdLayerBounds,
  layerId: unknown,
) {
  const normalizedSourceBounds = normalizePsdLayerPixelBounds(sourceBounds);
  if (!normalizedSourceBounds) return;
  const glyphSet = new Set(glyphIds);
  const clusterIds = new Set<string>();
  if (glyphSet.size > 0) {
    canvas.getObjects().forEach((object) => {
      const target = object as SvgDecorationLinkedObject & {
        _pdfTextGlyphId?: string;
        _pdfTextPath?: boolean;
      };
      if (
        target._pdfTextPath === true
        && target._pdfTextGlyphId
        && glyphSet.has(target._pdfTextGlyphId)
        && target._svgDecorationClusterId
      ) {
        clusterIds.add(target._svgDecorationClusterId);
      }
    });
  }
  const sourceLayerKey = String(layerId ?? '');
  if (!sourceLayerKey) return;

  canvas.getObjects().forEach((object) => {
    const target = object as SvgDecorationLinkedObject;
    const role = normalizeSvgObjectRole(target._svgObjectRole);
    if (
      role !== 'decoration-vector'
      && role !== 'decoration-gradient-strip'
      && role !== 'decoration-texture-fill'
      && role !== 'decoration-effect-raster'
    ) return;
    const objectBounds = getFabricObjectPixelBounds(object);
    if (!objectBounds) return;
    const isSameCluster = Boolean(
      target._svgDecorationClusterId
      && clusterIds.has(target._svgDecorationClusterId),
    );
    const isBoundsMatchedTexture = (
      role === 'decoration-texture-fill'
      || role === 'decoration-effect-raster'
    ) && shouldHideStronglyBoundsMatchedPdfSourceVisual(objectBounds, normalizedSourceBounds);
    if (
      !(isSameCluster && shouldHideLinkedPdfSourceVisual(objectBounds, normalizedSourceBounds))
      && !isBoundsMatchedTexture
    ) return;

    const hiddenBy = new Set((target._pdfSourceTextHiddenByLayerIds || []).map(String));
    hiddenBy.add(sourceLayerKey);
    target._pdfSourceTextHiddenByLayerIds = Array.from(hiddenBy);
    target.set({ visible: false, selectable: false, evented: false, hasControls: false });
    target.setCoords();
  });
}

function showPdfSourceLinkedVisualObjects(canvas: fabric.Canvas, layerId: unknown) {
  const sourceLayerKey = String(layerId ?? '');
  if (!sourceLayerKey) return;
  canvas.getObjects().forEach((object) => {
    const target = object as SvgDecorationLinkedObject;
    if (!Array.isArray(target._pdfSourceTextHiddenByLayerIds)) return;
    const remaining = target._pdfSourceTextHiddenByLayerIds
      .map(String)
      .filter((item) => item !== sourceLayerKey);
    target._pdfSourceTextHiddenByLayerIds = remaining;
    if (remaining.length === 0) {
      target.set({ visible: true, selectable: false, evented: false, hasControls: false });
      target.setCoords();
    }
  });
}

function normalizePsdLayerPixelBounds(bounds: PsdLayerBounds): PixelBounds | null {
  const left = toFiniteNumber(bounds.left);
  const top = toFiniteNumber(bounds.top);
  const width = toFiniteNumber(bounds.width);
  const height = toFiniteNumber(bounds.height);
  if (left === null || top === null || width === null || height === null || width <= 0 || height <= 0) return null;
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function shouldHideLinkedPdfSourceVisual(objectBounds: PixelBounds, sourceBounds: PixelBounds): boolean {
  const left = Math.max(objectBounds.left, sourceBounds.left);
  const top = Math.max(objectBounds.top, sourceBounds.top);
  const right = Math.min(objectBounds.right, sourceBounds.right);
  const bottom = Math.min(objectBounds.bottom, sourceBounds.bottom);
  if (right <= left || bottom <= top) return false;
  const intersectionArea = (right - left) * (bottom - top);
  const objectArea = Math.max(1, getPixelBoundsArea(objectBounds));
  const sourceArea = Math.max(1, getPixelBoundsArea(sourceBounds));
  const objectCoverage = intersectionArea / objectArea;
  const sourceCoverage = intersectionArea / sourceArea;
  return objectCoverage >= 0.72 && (sourceCoverage >= 0.35 || objectArea <= sourceArea * 1.35);
}

function shouldHideStronglyBoundsMatchedPdfSourceVisual(
  objectBounds: PixelBounds,
  sourceBounds: PixelBounds,
): boolean {
  const left = Math.max(objectBounds.left, sourceBounds.left);
  const top = Math.max(objectBounds.top, sourceBounds.top);
  const right = Math.min(objectBounds.right, sourceBounds.right);
  const bottom = Math.min(objectBounds.bottom, sourceBounds.bottom);
  if (right <= left || bottom <= top) return false;
  const intersectionWidth = right - left;
  const intersectionHeight = bottom - top;
  const intersectionArea = intersectionWidth * intersectionHeight;
  const objectArea = Math.max(1, getPixelBoundsArea(objectBounds));
  const sourceArea = Math.max(1, getPixelBoundsArea(sourceBounds));
  const heightRatio = objectBounds.height / Math.max(1, sourceBounds.height);
  return intersectionArea / objectArea >= 0.82
    && intersectionWidth / Math.max(1, Math.min(objectBounds.width, sourceBounds.width)) >= 0.86
    && intersectionHeight / Math.max(1, Math.min(objectBounds.height, sourceBounds.height)) >= 0.86
    && heightRatio >= 0.5
    && heightRatio <= 1.8
    && objectArea <= sourceArea * 2;
}

function normalizePdfSourceTextHistoryState(
  canvas: fabric.Canvas,
  layerTree: ParsedLayer[],
  resolvedFonts: Record<string, string> = {},
) {
  const sourceLayers = collectSourceTextLayers(layerTree);
  if (sourceLayers.length === 0) return;

  const historyCanvas = canvas as HistoryAwareCanvas;
  const previousSuspendHistory = historyCanvas.__suspendHistory;
  historyCanvas.__suspendHistory = true;
  try {
    for (const layer of sourceLayers) {
      const glyphIds = getSourceTextLayerGlyphIds(layer);
      const bounds = sourceTextLayerBounds(layer);
      if (!bounds) continue;

      const activatedTexts = canvas.getObjects()
        .filter((object) => isActivatedPdfSourceTextObjectForLayer(object, layer, glyphIds));
      const activations = canvas.getObjects()
        .filter((object): object is PdfSourceTextActivationObject =>
          isPdfSourceTextActivationObject(object)
          && pdfSourceTextObjectMatchesLayer(object, layer, glyphIds),
        );
      const backgroundPatches = canvas.getObjects().filter((object) => {
        const target = object as fabric.FabricObject & {
          _layerId?: unknown;
          _pdfSourceTextBackgroundPatch?: boolean;
        };
        return target._pdfSourceTextBackgroundPatch === true
          && String(target._layerId ?? '') === String(layer.id);
      });

      if (activatedTexts.length > 0) {
        activatedTexts.forEach((object) => {
          repairActivatedPdfSourceTextObject(canvas, object, layer, glyphIds, bounds);
        });
        hidePdfSourceGlyphPaths(canvas, glyphIds, layer.id);
        hidePdfSourceLinkedVisualObjects(canvas, glyphIds, bounds, layer.id);
        activations.forEach((activation) => canvas.remove(activation));
        backgroundPatches.slice(1).forEach((patch) => canvas.remove(patch));
        continue;
      }

      showPdfSourceGlyphPaths(canvas, glyphIds, layer.id);
      showPdfSourceLinkedVisualObjects(canvas, layer.id);
      backgroundPatches.forEach((patch) => canvas.remove(patch));
      const [primaryActivation, ...duplicateActivations] = activations;
      if (primaryActivation) {
        repairPdfSourceTextActivationObject(primaryActivation, layer, glyphIds, bounds, resolvedFonts);
        linkPdfPageCompositeMember(canvas, primaryActivation, 'text-activation', bounds);
      } else {
        const activation = createPdfSourceTextActivationObject(layer, glyphIds, bounds, resolvedFonts);
        canvas.add(activation);
        linkPdfPageCompositeMember(canvas, activation, 'text-activation', bounds);
      }
      duplicateActivations.forEach((activation) => canvas.remove(activation));
    }
    restorePdfPageCompositeLinksForCanvas(canvas);
    canvas.requestRenderAll();
  } finally {
    historyCanvas.__suspendHistory = previousSuspendHistory;
  }
}

function collectSourceTextLayers(layers: ParsedLayer[]): ParsedLayer[] {
  const result: ParsedLayer[] = [];
  const visit = (layer: ParsedLayer) => {
    if (isSourceTextLayer(layer)) result.push(layer);
    layer.children?.forEach(visit);
  };
  layers.forEach(visit);
  return result;
}

function getSourceTextLayerGlyphIds(layer: ParsedLayer): string[] {
  const props = layer.properties as Record<string, unknown> | null | undefined;
  return Array.isArray(props?.textPathGlyphIds)
    ? props.textPathGlyphIds.map((item) => String(item)).filter(Boolean)
    : [];
}

function isActivatedPdfSourceTextObjectForLayer(
  object: fabric.FabricObject,
  layer: ParsedLayer,
  glyphIds: string[],
): boolean {
  const target = object as fabric.FabricObject & {
    _pdfSourceTextActivated?: boolean;
    editable?: boolean;
  };
  return target._pdfSourceTextActivated === true
    && isEditableFabricTextObject(object)
    && pdfSourceTextObjectMatchesLayer(object, layer, glyphIds);
}

function pdfSourceTextObjectMatchesLayer(
  object: fabric.FabricObject,
  layer: ParsedLayer,
  glyphIds: string[],
): boolean {
  const target = object as fabric.FabricObject & {
    _layerId?: unknown;
    _pdfSourceTextGlyphIds?: unknown;
    _pdfTextGlyphId?: unknown;
  };
  if (String(target._layerId ?? '') === String(layer.id)) return true;
  const glyphSet = new Set(glyphIds);
  if (Array.isArray(target._pdfSourceTextGlyphIds)) {
    return target._pdfSourceTextGlyphIds.some((item) => glyphSet.has(String(item)));
  }
  return typeof target._pdfTextGlyphId === 'string' && glyphSet.has(target._pdfTextGlyphId);
}

function repairActivatedPdfSourceTextObject(
  canvas: fabric.Canvas,
  object: fabric.FabricObject,
  layer: ParsedLayer,
  glyphIds: string[],
  bounds: PixelBounds,
) {
  const target = object as fabric.FabricObject & {
    editable?: boolean;
    _layerId?: unknown;
    _layerName?: unknown;
    _layerType?: unknown;
    _pdfSourceTextActivated?: boolean;
    _pdfSourceTextGlyphIds?: string[];
    _psdTextContent?: string;
    _psdTextOrientation?: string;
    _psdLayerBounds?: PsdLayerBounds;
    _psdPreviewVisualBounds?: PixelBounds;
    _psdLocked?: boolean;
    _pdfPageCompositeId?: string;
    _pdfPageCompositeRole?: PdfPageCompositeRole;
    _pdfPageLocalBounds?: PsdLayerBounds;
  };
  target._layerId = target._layerId ?? layer.id;
  target._layerName = target._layerName ?? layer.layerName;
  target._layerType = 'text';
  target._pdfSourceTextActivated = true;
  target._pdfSourceTextGlyphIds = glyphIds;
  target._psdTextContent = target._psdTextContent || layer.textContent || '';
  target._psdTextOrientation = isSourceTextLayerVertical(layer) ? 'vertical' : undefined;
  target._pdfPageCompositeRole = 'activated-text';
  target._pdfPageLocalBounds = target._pdfPageLocalBounds || {
    left: bounds.left,
    top: bounds.top,
    width: bounds.width,
    height: bounds.height,
  };
  target.set({
    editable: true,
    selectable: true,
    evented: true,
    objectCaching: false,
    lockMovementX: false,
    lockMovementY: false,
    lockScalingX: false,
    lockScalingY: false,
    lockRotation: false,
  } as Partial<fabric.FabricObject>);
  target._psdLocked = false;
  target.setCoords();
  if (!target._pdfPageCompositeId) {
    linkPdfPageCompositeMember(canvas, target, 'activated-text', target._pdfPageLocalBounds, {
      applyUnderlayTransform: false,
    });
  }
  updatePdfPageCompositeMemberBounds(target);
}

function repairPdfSourceTextActivationObject(
  activation: PdfSourceTextActivationObject,
  layer: ParsedLayer,
  glyphIds: string[],
  bounds: PixelBounds,
  resolvedFonts: Record<string, string>,
) {
  const repaired = createPdfSourceTextActivationObject(layer, glyphIds, bounds, resolvedFonts);
  activation.set({
    left: repaired.left,
    top: repaired.top,
    width: repaired.width,
    height: repaired.height,
    angle: repaired.angle || 0,
    opacity: repaired.opacity ?? 1,
    selectable: true,
    evented: true,
    hasControls: false,
    lockMovementX: false,
    lockMovementY: false,
    lockScalingX: false,
    lockScalingY: false,
    lockRotation: false,
    objectCaching: false,
    perPixelTargetFind: false,
    targetFindTolerance: 8,
    hoverCursor: 'text',
  } as Partial<fabric.Rect>);
  activation._layerId = repaired._layerId;
  activation._layerName = repaired._layerName;
  activation._pdfSourceTextActivation = true;
  activation._pdfSourceTextGlyphIds = repaired._pdfSourceTextGlyphIds;
  activation._pdfSourceTextOptions = repaired._pdfSourceTextOptions;
  activation._psdTextContent = repaired._psdTextContent;
  activation._psdTextOptions = repaired._psdTextOptions;
  activation._psdLayerBounds = repaired._psdLayerBounds;
  activation._psdPreviewVisualBounds = repaired._psdPreviewVisualBounds;
  activation._psdFontName = repaired._psdFontName;
  activation._psdTextOrientation = repaired._psdTextOrientation;
  activation._psdLocked = false;
  activation.setCoords();
}

function showPdfSourceGlyphPaths(canvas: fabric.Canvas, glyphIds: string[], layerId?: unknown) {
  if (glyphIds.length === 0) return;
  const idSet = new Set(glyphIds);
  const sourceLayerKey = String(layerId ?? '');
  canvas.getObjects().forEach((object) => {
    const target = object as SvgDecorationLinkedObject & {
      _pdfTextGlyphId?: string;
      _pdfTextPath?: boolean;
    };
    if (target._pdfTextPath !== true || !target._pdfTextGlyphId || !idSet.has(target._pdfTextGlyphId)) return;
    const remaining = (target._pdfSourceTextHiddenByLayerIds || [])
      .map(String)
      .filter((item) => !sourceLayerKey || item !== sourceLayerKey);
    target._pdfSourceTextHiddenByLayerIds = remaining;
    target.set({
      visible: remaining.length === 0,
      selectable: false,
      evented: false,
      hasControls: false,
      hoverCursor: 'default',
    });
    target.setCoords();
  });
}

function getGroupSubTarget(event: FabricPointerInfo) {
  const group = event.target as (fabric.Group & {
    interactive?: boolean;
    subTargetCheck?: boolean;
    objectCaching?: boolean;
  }) | null | undefined;
  if (!group || group.type !== 'group') return null;

  const subTargets = ((event as FabricPointerInfo & { subTargets?: fabric.FabricObject[] }).subTargets || [])
    .filter(Boolean);
  const groupIndex = subTargets.indexOf(group);
  const target = subTargets[groupIndex - 1] || subTargets[subTargets.length - 1];
  return target && target !== group ? target : null;
}

function activateGroupSubTarget(
  canvas: fabric.Canvas,
  event: FabricPointerInfo,
  explicitTarget?: fabric.FabricObject | null,
) {
  const group = event.target as (fabric.Group & {
    interactive?: boolean;
    subTargetCheck?: boolean;
    objectCaching?: boolean;
    _svgDecorationGroup?: boolean;
  }) | null | undefined;
  if (!group || group.type !== 'group' || group.interactive || group._svgDecorationGroup === true) return false;

  const target = explicitTarget || getGroupSubTarget(event);
  if (!target || target === group) return false;

  group.set({
    interactive: true,
    subTargetCheck: true,
    objectCaching: false,
  } as Partial<fabric.Group>);
  bindGroupInteractiveDeselect(canvas, group, group);
  canvas.setActiveObject(target);
  canvas.requestRenderAll();
  return true;
}

function bindGroupInteractiveDeselect(
  canvas: fabric.Canvas,
  group: fabric.Group & { interactive?: boolean; objectCaching?: boolean },
  target: fabric.FabricObject,
) {
  target.once('deselected', () => {
    const active = canvas.getActiveObject() as (fabric.FabricObject & {
      getAncestors?: () => fabric.FabricObject[];
      isDescendantOf?: (ancestor: fabric.FabricObject) => boolean;
    }) | undefined;
    const ancestors = active?.getAncestors?.() || [];
    const stillInsideGroup = Boolean(
      active?.isDescendantOf?.(group) || ancestors.includes(group),
    );
    if (!active || !stillInsideGroup) {
      group.set({
        interactive: false,
        objectCaching: true,
      } as Partial<fabric.Group>);
      return;
    }
    bindGroupInteractiveDeselect(canvas, group, active);
  });
}

async function enterPsdTextPreviewEditing(
  canvas: fabric.Canvas,
  preview: PsdTextPreviewImage,
): Promise<fabric.FabricObject> {
  const text = await convertPsdTextPreviewToEditableText(canvas, preview);
  const editable = text as fabric.IText & {
    enterEditing?: () => void;
    selectAll?: () => void;
    hiddenTextarea?: HTMLTextAreaElement | null;
  };
  editable.enterEditing?.();
  editable.selectAll?.();
  editable.hiddenTextarea?.focus?.({ preventScroll: true });
  canvas.requestRenderAll();
  return text;
}

async function convertPsdTextPreviewToEditableText(
  canvas: fabric.Canvas,
  preview: PsdTextPreviewImage,
): Promise<fabric.FabricObject> {
  const options = getPsdEditableSourceTextOptions(preview, preview._psdTextOptions || {});
  const layerBounds = getPsdTextPreviewLayerBounds(preview);
  const targetBounds = preview._psdPreviewVisualBounds
    || await measureObjectPixelBounds(canvas, preview)
    || psdLayerBoundsToPixelBounds(layerBounds);
  const isVerticalText = isPsdVerticalTextOptions(options, preview._psdTextOrientation);
  const content = isVerticalText
    ? formatPsdVerticalTextContent(preview._psdTextContent || '')
    : preview._psdTextContent || '';
  const hasManualLineBreak = /[\r\n]/.test(content);
  const fontFamily = String(options.fontFamily || MISSING_PSD_TEXT_EDIT_FONT_FAMILY);
  const previewMeta = preview as fabric.FabricObject & {
    _psdInvisibleHitArea?: boolean;
    _psdIgnorePreviewColor?: boolean;
  };
  const previewOpacity = previewMeta._psdInvisibleHitArea === true
    ? (toFiniteNumber(options.opacity) ?? 1)
    : (preview.opacity ?? toFiniteNumber(options.opacity) ?? 1);
  const editableFill =
    (previewMeta._psdIgnorePreviewColor === true ? null : sampleFabricImageDominantOpaqueColor(preview))
    || getDominantPsdRunFillColor(options.runs)
    || (typeof options.fill === 'string' ? options.fill : null)
    || '#141413';
  const verticalLineHeight = isVerticalText
    ? getPsdVerticalLineHeight(
        preview._psdTextContent || content,
        positivePsdNumber(options.fontSize, 16),
        targetBounds.height,
        positivePsdNumber(options.lineHeight, 1),
        toFiniteNumber(options.charSpacing) || 0,
      )
    : null;
  const textShadow = revivePsdTextShadow(options.shadow);
  const baseOptions = {
    ...options,
    ...(verticalLineHeight !== null ? { lineHeight: verticalLineHeight } : {}),
    ...(textShadow ? { shadow: textShadow } : { shadow: undefined }),
    left: layerBounds.left,
    top: layerBounds.top,
    angle: preview.angle || 0,
    opacity: previewOpacity,
    fontFamily,
    fontWeight: String(options.fontWeight || '400'),
    fill: editableFill,
    editable: true,
    objectCaching: false,
    splitByGrapheme: true,
    perPixelTargetFind: false,
    targetFindTolerance: 8,
    globalCompositeOperation: preview.globalCompositeOperation as GlobalCompositeOperation,
    ...(preview.clipPath ? { clipPath: preview.clipPath } : {}),
  } as unknown as Partial<fabric.IText> & Record<string, unknown>;
  const text = preview._psdTextIsAreaText && !isVerticalText && !hasManualLineBreak
    ? new fabric.Textbox(content, {
        ...baseOptions,
        width: positivePsdNumber(options.width, layerBounds.width || preview.getScaledWidth()),
      } as Partial<fabric.Textbox>)
    : new fabric.IText(content, baseOptions as Partial<fabric.IText>);

  const custom = text as unknown as fabric.FabricObject & Record<string, unknown>;
  custom._layerId = preview._layerId;
  custom._layerName = preview._layerName;
  custom._layerType = 'text';
  custom._psdTextPreview = false;
  custom._psdMissingFont = false;
  custom._psdTextIsAreaText = preview._psdTextIsAreaText && !hasManualLineBreak;
  custom._psdTextOrientation = isVerticalText ? 'vertical' : undefined;
  custom._psdTextOptions = {
    ...options,
    ...(verticalLineHeight !== null ? { lineHeight: verticalLineHeight } : {}),
  };
  custom._psdFontName = String(preview._psdFontName || fontFamily);
  custom._psdLayerBounds = layerBounds;
  custom._psdPreviewVisualBounds = targetBounds;
  custom._psdClipping = preview._psdClipping;
  custom._psdLocked = preview._psdLocked;
  copyPsdSourceMetadata(preview, custom);
  applyPsdPreviewEditableFontToStyles(text, fontFamily);

  const index = canvas.getObjects().indexOf(preview);
  canvas.remove(preview);
  if (index >= 0) {
    canvas.insertAt(index, text);
  } else {
    canvas.add(text);
  }
  canvas.setActiveObject(text);

  const storedRuns = Array.isArray(options.runs) ? options.runs as Array<Record<string, unknown>> : [];
  if (storedRuns.length > 0) {
    applyRunStylesToText(
      text,
      { textContent: preview._psdTextContent || '' } as ParsedLayer,
      storedRuns,
      String(options.psdBaseFontName || preview._psdFontName || ''),
      positivePsdNumber(options.psdTextScaleY, 1),
      String(options.psdFileType || 'psd'),
      typeof options.psdSolidFillColor === 'string' ? options.psdSolidFillColor : null,
      { verticalText: isVerticalText },
    );
  }

  await waitForCanvasFont(
    fontFamily,
    Number((text as fabric.IText).fontSize) || 16,
    String((text as fabric.IText).fontWeight || '400'),
  );
  resetPsdEditableTextDimensions(text);
  if (isVerticalText) {
    await fitPsdVerticalTextToVisualHeight(canvas, text, targetBounds.height);
  }
  await alignObjectToPsdPreviewBounds(canvas, text, targetBounds);
  text.setCoords();
  return text;
}

function getPsdTextPreviewLayerBounds(preview: PsdTextPreviewImage): Required<PsdLayerBounds> {
  const bounds = preview._psdLayerBounds || {};
  return {
    left: toFiniteNumber(bounds.left) ?? preview.left ?? 0,
    top: toFiniteNumber(bounds.top) ?? preview.top ?? 0,
    width: positivePsdNumber(bounds.width, preview.getScaledWidth()),
    height: positivePsdNumber(bounds.height, preview.getScaledHeight()),
  };
}

function positivePsdNumber(value: unknown, fallback: number): number {
  const next = toFiniteNumber(value);
  return next !== null && next > 0 ? next : Math.max(1, fallback || 1);
}

function psdLayerBoundsToPixelBounds(bounds: Required<PsdLayerBounds>): PixelBounds {
  const width = Math.max(1, bounds.width);
  const height = Math.max(1, bounds.height);
  return {
    left: bounds.left,
    top: bounds.top,
    width,
    height,
    right: bounds.left + width - 1,
    bottom: bounds.top + height - 1,
  };
}

async function alignObjectToPsdPreviewBounds(
  canvas: fabric.Canvas,
  object: fabric.FabricObject,
  bounds: Pick<PixelBounds, 'left' | 'top'>,
) {
  canvas.requestRenderAll();
  const visualBounds = await measureObjectPixelBounds(canvas, object);
  if (!visualBounds) {
    object.set({ left: bounds.left, top: bounds.top });
    return;
  }
  const dx = bounds.left - visualBounds.left;
  const dy = bounds.top - visualBounds.top;
  if (Math.abs(dx) > 0.2 || Math.abs(dy) > 0.2) {
    object.set({
      left: (Number(object.left) || 0) + dx,
      top: (Number(object.top) || 0) + dy,
    });
  }
  object.setCoords();
}

function applyPsdPreviewEditableFontToStyles(text: fabric.FabricObject, fontFamily: string) {
  const target = text as fabric.IText & {
    styles?: Record<string, Record<string, Record<string, unknown>>>;
  };
  target.set?.('fontFamily', fontFamily);
  if (!target.styles) return;
  Object.values(target.styles).forEach((lineStyles) => {
    Object.values(lineStyles || {}).forEach((charStyle) => {
      charStyle.fontFamily = fontFamily;
    });
  });
}

function resetPsdEditableTextDimensions(text: fabric.FabricObject) {
  const target = text as fabric.IText & { initDimensions?: () => void };
  try {
    target.initDimensions?.();
  } catch {
    // Keep editing available even if Fabric cannot recalculate immediately.
  }
  text.setCoords();
}

async function fitPsdVerticalTextToVisualHeight(
  canvas: fabric.Canvas,
  text: fabric.FabricObject,
  targetHeight: number,
): Promise<void> {
  const target = text as fabric.IText & { text?: string; lineHeight?: number; set?: (key: string, value: unknown) => void };
  const lineCount = String(target.text || '').split(/\n/).filter(Boolean).length;
  if (lineCount <= 1 || !Number.isFinite(targetHeight) || targetHeight <= 0) return;

  let bestLineHeight = toFiniteNumber(target.lineHeight) || 1;
  let bestDelta = Number.POSITIVE_INFINITY;
  let low = 0.25;
  let high = 1.8;

  for (let i = 0; i < 8; i++) {
    const mid = (low + high) / 2;
    target.set?.('lineHeight', mid);
    resetPsdEditableTextDimensions(text);
    const bounds = await measureObjectPixelBounds(canvas, text);
    if (!bounds) break;

    const delta = Math.abs(bounds.height - targetHeight);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestLineHeight = mid;
    }

    if (bounds.height > targetHeight) {
      high = mid;
    } else {
      low = mid;
    }
  }

  target.set?.('lineHeight', clampRatio(bestLineHeight, 0.25, 1.8));
  resetPsdEditableTextDimensions(text);
}

function restoreTransparentHitTesting(object: fabric.FabricObject) {
  const target = object as fabric.FabricObject & {
    type?: string;
    perPixelTargetFind?: boolean;
    targetFindTolerance?: number;
    _pdfRasterBackground?: boolean;
    _pdfSourceRasterImage?: boolean;
    _pdfSourceTextActivation?: boolean;
    _svgObjectRole?: SvgObjectRole;
    _psdLocked?: boolean;
    forEachObject?: (callback: (child: fabric.FabricObject) => void) => void;
  };

  if (isPdfRasterVisualFabricObject(target)) {
    enforcePdfRasterVisualOnlyObject(target);
  }

  if (target.type !== 'group' && target.type !== 'activeSelection') {
    const isText =
      object instanceof fabric.IText ||
      object instanceof fabric.Textbox ||
      target._pdfSourceTextActivation === true ||
      target.type === 'i-text' ||
      target.type === 'textbox' ||
      target.type === 'text';
    const svgRole = normalizeSvgObjectRole(target._svgObjectRole);
    const isEditableRaster = svgRole === 'editable-raster';
    target.perPixelTargetFind = !isText && !isEditableRaster;
    target.targetFindTolerance = isText || isEditableRaster ? 8 : 0;
  }

  target.forEachObject?.((child) => restoreTransparentHitTesting(child));
}

function isPdfRasterVisualFabricObject(object: fabric.FabricObject): boolean {
  const record = object as fabric.FabricObject & {
    _pdfPreviewOnlyBackground?: boolean;
    _pdfRasterBackground?: boolean;
    _pdfSourceRasterImage?: boolean;
    _pdfPageRasterUnderlay?: boolean;
    _pdfRasterFallbackEditable?: boolean;
    _pdfSourceTextBackgroundPatch?: boolean;
    _svgObjectRole?: SvgObjectRole;
  };
  const role = normalizeSvgObjectRole(record._svgObjectRole);
  return record._pdfPreviewOnlyBackground === true
    || record._pdfRasterBackground === true
    || record._pdfSourceRasterImage === true
    || (record._pdfPageRasterUnderlay === true && record._pdfRasterFallbackEditable !== true)
    || record._pdfSourceTextBackgroundPatch === true
    || role === 'visual-raster'
    || role === 'raster-image';
}

function enforcePdfRasterVisualOnlyObject(object: fabric.FabricObject) {
  const target = object as fabric.FabricObject & {
    _psdLocked?: boolean;
    _pdfPreviewOnlyBackground?: boolean;
  };
  const lockedBackground = target._pdfPreviewOnlyBackground === true;
  target.set({
    selectable: false,
    evented: false,
    hasControls: false,
    lockMovementX: lockedBackground,
    lockMovementY: lockedBackground,
    lockScalingX: lockedBackground,
    lockScalingY: lockedBackground,
    lockRotation: lockedBackground,
    hoverCursor: 'default',
  });
  target._psdLocked = lockedBackground;
  target.setCoords();
}

function markSvgImportedAtomObject(object: fabric.FabricObject) {
  const target = object as fabric.FabricObject & {
    _svgImportedAtom?: boolean;
    _psdLocked?: boolean;
  };
  target._svgImportedAtom = true;
  target._psdLocked = false;
}

function enforceSvgNonInteractiveVisualObject(object: fabric.FabricObject) {
  const target = object as fabric.FabricObject & {
    _psdLocked?: boolean;
  };
  target.set({
    selectable: false,
    evented: false,
    hasControls: false,
    excludeFromExport: false,
    objectCaching: false,
    lockMovementX: false,
    lockMovementY: false,
    lockScalingX: false,
    lockScalingY: false,
    lockRotation: false,
    hoverCursor: 'default',
  });
  target._psdLocked = false;
  if (target.clipPath) {
    target.clipPath.excludeFromExport = false;
    target.clipPath.objectCaching = false;
  }
  target.setCoords();
}

function isTextLayerUsingMissingFont(layer: ParsedLayer, missingFonts: string[]): boolean {
  if (!missingFonts.length) return false;
  const missing = missingFonts.map(normalizeFontNameForMissingMatch).filter(Boolean);
  if (!missing.length) return false;
  return collectPsdTextLayerFontNames(layer)
    .map(normalizeFontNameForMissingMatch)
    .filter(Boolean)
    .some((name) => missing.some((font) => name === font || name.includes(font) || font.includes(name)));
}

function collectPsdTextLayerFontNames(layer: ParsedLayer): string[] {
  const style = layer.textStyle as Record<string, unknown> | null;
  const names: string[] = [];
  const font = style?.font as Record<string, unknown> | undefined;
  if (typeof font?.name === 'string') names.push(font.name);
  const runs = style?.runs as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(runs)) {
    for (const run of runs) {
      if (typeof run.fontName === 'string') names.push(run.fontName);
    }
  }
  return names;
}

function normalizeFontNameForMissingMatch(value: unknown): string {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

function stampEditorObject(object: fabric.FabricObject, layerName: string, layerType: 'text' | 'shape' | 'image') {
  const id = `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  (object as any)._layerId = id;
  (object as any)._layerName = layerName;
  (object as any)._layerType = layerType;
}

function getCanvasPoint(canvas: fabric.Canvas, event: FabricPointerInfo): CanvasPoint | null {
  return getCanvasPointFromNativeEvent(canvas, event.e);
}

function getCanvasPointFromNativeEvent(
  canvas: fabric.Canvas,
  event: MouseEvent | PointerEvent | TouchEvent | fabric.TPointerEvent,
): CanvasPoint | null {
  const rectPoint = getCanvasPointFromElementRect(canvas, event as MouseEvent | PointerEvent | TouchEvent);
  if (rectPoint) return rectPoint;

  try {
    const pointer = canvas.getPointer(event as fabric.TPointerEvent);
    if (Number.isFinite(pointer.x) && Number.isFinite(pointer.y)) {
      return { x: pointer.x, y: pointer.y };
    }
  } catch {
    // Fall through to a null result when Fabric cannot resolve the event.
  }

  return null;
}

function getCanvasPointFromElementRect(
  canvas: fabric.Canvas,
  event: MouseEvent | PointerEvent | TouchEvent,
): CanvasPoint | null {
  const clientPoint = getClientPointFromEditorEvent(event);
  const element = getEditorUpperCanvasElement(canvas) || getEditorLowerCanvasElement(canvas);
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

function getClientPointFromEditorEvent(event: MouseEvent | PointerEvent | TouchEvent) {
  if ('changedTouches' in event) {
    const touch = event.changedTouches[0] || event.touches[0];
    if (!touch) return null;
    return { x: touch.clientX, y: touch.clientY };
  }
  if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return null;
  return { x: event.clientX, y: event.clientY };
}

function getEditorCanvasEventElements(canvas: fabric.Canvas): HTMLElement[] {
  return Array.from(new Set([
    getEditorUpperCanvasElement(canvas),
    getEditorLowerCanvasElement(canvas),
    (canvas as fabric.Canvas & { wrapperEl?: HTMLElement }).wrapperEl,
  ].filter(Boolean) as HTMLElement[]));
}

function getEditorUpperCanvasElement(canvas: fabric.Canvas): HTMLCanvasElement | null {
  const element = (canvas as fabric.Canvas & { upperCanvasEl?: HTMLCanvasElement }).upperCanvasEl;
  return element instanceof HTMLCanvasElement ? element : null;
}

function getEditorLowerCanvasElement(canvas: fabric.Canvas): HTMLCanvasElement | null {
  try {
    const element = canvas.getElement();
    return element instanceof HTMLCanvasElement ? element : null;
  } catch {
    return null;
  }
}

function isNativeEventInsideEditorCanvas(canvas: fabric.Canvas, event: MouseEvent | PointerEvent | TouchEvent) {
  const point = getClientPointFromEditorEvent(event);
  if (!point) return false;
  const elements = getEditorCanvasEventElements(canvas);
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  if (path.some((item) => elements.includes(item as HTMLElement))) return true;
  return elements.some((element) => {
    const rect = element.getBoundingClientRect();
    return point.x >= rect.left
      && point.x <= rect.right
      && point.y >= rect.top
      && point.y <= rect.bottom;
  });
}

function createTextToolObject(point: CanvasPoint, fontSize: number, fill: string) {
  const text = new fabric.IText('输入文字', {
    left: point.x,
    top: point.y,
    fontSize,
    fill,
    fontFamily: DEFAULT_CN_EDIT_FONT_FAMILY,
    editable: true,
    objectCaching: false,
    perPixelTargetFind: false,
    targetFindTolerance: 8,
  } as Partial<fabric.IText> & { perPixelTargetFind: boolean; targetFindTolerance: number });
  stampEditorObject(text, '文字', 'text');
  text.setCoords();
  return text;
}

function createShapeToolObject(
  shape: ShapeTool,
  start: CanvasPoint,
  style: { fill: string; stroke: string; strokeWidth: number; radius: number },
): fabric.FabricObject {
  let object: fabric.FabricObject;
  const hasStroke = style.strokeWidth > 0;
  const strokeProps = hasStroke
    ? { stroke: style.stroke, strokeWidth: style.strokeWidth }
    : { stroke: undefined, strokeWidth: 0 };

  if (shape === 'ellipse') {
    object = new fabric.Ellipse({
      left: start.x,
      top: start.y,
      rx: 1,
      ry: 1,
      fill: style.fill,
      ...strokeProps,
      objectCaching: false,
    });
  } else if (shape === 'triangle') {
    object = new fabric.Triangle({
      left: start.x,
      top: start.y,
      width: 1,
      height: 1,
      fill: style.fill,
      ...strokeProps,
      objectCaching: false,
    });
  } else if (shape === 'line') {
    object = new fabric.Line([start.x, start.y, start.x, start.y], {
      stroke: style.stroke,
      strokeWidth: Math.max(2, style.strokeWidth),
      strokeLineCap: 'round',
      objectCaching: false,
    });
  } else {
    object = new fabric.Rect({
      left: start.x,
      top: start.y,
      width: 1,
      height: 1,
      rx: style.radius,
      ry: style.radius,
      fill: style.fill,
      ...strokeProps,
      objectCaching: false,
    });
  }
  const layerNames: Record<ShapeTool, string> = {
    rect: '矩形',
    ellipse: '椭圆',
    triangle: '三角形',
    line: '线条',
  };
  stampEditorObject(object, layerNames[shape], 'shape');
  return object;
}

function updateShapeToolObject(object: fabric.FabricObject, shape: ShapeTool, start: CanvasPoint, end: CanvasPoint) {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);

  if (shape === 'line' && object instanceof fabric.Line) {
    object.set({ x1: start.x, y1: start.y, x2: end.x, y2: end.y });
    return;
  }

  if (shape === 'ellipse' && object instanceof fabric.Ellipse) {
    object.set({
      left,
      top,
      rx: Math.max(width / 2, 1),
      ry: Math.max(height / 2, 1),
    });
    return;
  }

  object.set({
    left,
    top,
    width: Math.max(width, 1),
    height: Math.max(height, 1),
  });
}

function finalizeShapeToolObject(object: fabric.FabricObject, shape: ShapeTool, start: CanvasPoint) {
  const width = object.getScaledWidth();
  const height = object.getScaledHeight();
  if (Math.max(width, height) >= 6) return;

  if (shape === 'line' && object instanceof fabric.Line) {
    object.set({ x1: start.x, y1: start.y, x2: start.x + 180, y2: start.y });
    return;
  }

  if (shape === 'ellipse' && object instanceof fabric.Ellipse) {
    object.set({ left: start.x, top: start.y, rx: 70, ry: 50 });
    return;
  }

  object.set({
    left: start.x,
    top: start.y,
    width: shape === 'triangle' ? 140 : 180,
    height: shape === 'triangle' ? 130 : 110,
  });
}

async function loadAiSvgObjects(
  canvas: fabric.Canvas,
  url: string,
  fileName: string,
  setCanvasSize: (w: number, h: number) => void,
  options: {
    lockRasterImages?: boolean;
    hideLockedRasterLayers?: boolean;
    skipPdfRasterImages?: boolean;
    skipImageObjects?: boolean;
    pageNumber?: number;
    hasSourceTextLayers?: boolean;
    requireEditableObjects?: boolean;
  } = {},
): Promise<{ count: number; visualCount: number; layers: ParsedLayer[] }> {
  const svgText = await loadSvgTextWithUploadCacheBuster(url);
  const rasterPageFallback = parseEditableRasterPageFallbackSvg(svgText);
  if (rasterPageFallback) {
    const img = await loadUploadFabricImageFromUrl(rasterPageFallback.href);
    const width = Math.round(rasterPageFallback.width || img.width || canvas.getWidth());
    const height = Math.round(rasterPageFallback.height || img.height || canvas.getHeight());
    if (width > 0 && height > 0 && (width !== canvas.getWidth() || height !== canvas.getHeight())) {
      setCanvasSize(width, height);
      canvas.setDimensions({ width, height });
    }
    const scaleX = width / Math.max(1, img.width || width);
    const scaleY = height / Math.max(1, img.height || height);
    const layerId = -1;
    const useAsTextUnderlay = options.hasSourceTextLayers === true;
    const layerName = useAsTextUnderlay ? '页面图片内容' : '保真页图（无可解析矢量）';
    const pageNumber = Number.isFinite(Number(options.pageNumber)) && Number(options.pageNumber) > 0
      ? Number(options.pageNumber)
      : 1;
    const pageCompositeId = useAsTextUnderlay ? `pdf-page-composite-${pageNumber}` : undefined;
    img.set({
      originX: 'left',
      originY: 'top',
      left: 0,
      top: 0,
      scaleX,
      scaleY,
      opacity: 1,
      selectable: true,
      evented: true,
      hasControls: true,
      objectCaching: false,
      lockMovementX: false,
      lockMovementY: false,
      lockScalingX: false,
      lockScalingY: false,
      lockRotation: false,
      excludeFromExport: false,
    });
    (img as any)._layerId = layerId;
    (img as any)._layerName = layerName;
    (img as any)._layerType = 'image';
    (img as any)._svgObjectRole = 'editable-raster';
    (img as any)._pdfRasterBackground = false;
    (img as any)._pdfSourceRasterImage = false;
    (img as any)._pdfPageRasterUnderlay = useAsTextUnderlay;
    (img as any)._pdfRasterFallbackEditable = true;
    (img as PdfPageCompositeObject)._pdfPageCompositeId = pageCompositeId;
    (img as PdfPageCompositeObject)._pdfPageCompositeRole = pageCompositeId ? 'underlay' : undefined;
    (img as PdfPageCompositeObject)._pdfPageLocalBounds = { left: 0, top: 0, width, height };
    (img as any)._psdLocked = false;
    canvas.add(img);
    resetPdfPageCompositeUnderlayState(img);
    (canvas as any).__benlaiImportedSvgRoleModelVersion = IMPORTED_SVG_ROLE_MODEL_VERSION;
    return {
      count: 1,
      visualCount: 1,
      layers: [{
        id: layerId,
        fileId: 0,
        layerName,
        layerType: 'image',
        parentLayerId: null,
        sortOrder: 1,
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        x: 0,
        y: 0,
        width,
        height,
        imagePath: rasterPageFallback.href,
        properties: {
          role: 'editable-raster',
          svgObjectType: 'image',
          svgObjectRole: 'editable-raster',
          rasterPageFallback: true,
          textUnderlaySource: useAsTextUnderlay,
          ...(Number.isFinite(Number(options.pageNumber)) && Number(options.pageNumber) > 0 ? { page: Number(options.pageNumber) } : {}),
        },
      }],
    };
  }
  const { objects, options: svgOptions } = await fabric.loadSVGFromString(
    svgText,
    (element, object) => {
      const label = element.getAttribute('id') || element.getAttribute('aria-label') || element.tagName.toLowerCase();
      const isPdfRasterBackground = element.getAttribute('data-pdf-raster') === 'true';
      const isPdfMaskArtifact = element.getAttribute('data-pdf-mask-artifact') === 'true';
      const isPdfTextPath = element.getAttribute('data-pdf-text-path') === 'true';
      const svgObjectRole =
        normalizeSvgObjectRole(element.getAttribute('data-object-role'))
        || (isPdfMaskArtifact ? 'mask-artifact' : null)
        || (isPdfTextPath ? 'text-outline' : null)
        || (isPdfRasterBackground ? 'raster-image' : null);
      const pdfTextGlyphId = element.getAttribute('data-pdf-text-glyph-id') || undefined;
      const pdfTextBounds = parseSvgTextBoundsAttr(element.getAttribute('data-pdf-text-bounds'));
      const pdfTextRunId = element.getAttribute('data-pdf-text-run-id') || undefined;
      const pdfTextGlyphIndex = toFiniteNumber(element.getAttribute('data-pdf-text-glyph-index'));
      const pdfTextWritingMode = element.getAttribute('data-pdf-writing-mode') || undefined;
      const pdfTextMatrix = parseSvgNumberList(element.getAttribute('data-pdf-text-matrix'));
      const pdfTextRotation = toFiniteNumber(element.getAttribute('data-pdf-text-rotation'));
      const svgDecorationClusterId = element.getAttribute('data-pdf-cluster-id') || undefined;
      (object as any)._svgLayerName = label;
      (object as any)._pdfRasterBackground = isPdfRasterBackground && svgObjectRole !== 'editable-raster';
      (object as any)._pdfMaskArtifact = isPdfMaskArtifact;
      (object as any)._pdfTextPath = isPdfTextPath;
      if (svgObjectRole) (object as any)._svgObjectRole = svgObjectRole;
      if (svgDecorationClusterId) (object as any)._svgDecorationClusterId = svgDecorationClusterId;
      if (pdfTextGlyphId) (object as any)._pdfTextGlyphId = pdfTextGlyphId;
      if (pdfTextBounds) (object as any)._pdfTextBounds = pdfTextBounds;
      if (pdfTextRunId) (object as any)._pdfTextRunId = pdfTextRunId;
      if (pdfTextGlyphIndex !== null) (object as any)._pdfTextGlyphIndex = pdfTextGlyphIndex;
      if (pdfTextWritingMode) (object as any)._pdfTextWritingMode = pdfTextWritingMode;
      if (pdfTextMatrix) (object as any)._pdfTextMatrix = pdfTextMatrix;
      if (pdfTextRotation !== null) (object as any)._pdfTextRotation = pdfTextRotation;
    },
    { crossOrigin: 'anonymous' }
  );
  try {
    ensureEditableSvgRasterObjectsComplete(svgText, objects);
  } catch (error) {
    objects.forEach((object) => object?.dispose());
    throw error;
  }

  const width = Math.round(resolveSvgDimension((svgOptions as any).width, (svgOptions as any).viewBox?.width, canvas.getWidth()));
  const height = Math.round(resolveSvgDimension((svgOptions as any).height, (svgOptions as any).viewBox?.height, canvas.getHeight()));
  console.log('[loadAiSvgObjects] svg dims', {
    rawOptionsWidth: (svgOptions as any).width,
    rawOptionsHeight: (svgOptions as any).height,
    rawViewBoxWidth: (svgOptions as any).viewBox?.width,
    rawViewBoxHeight: (svgOptions as any).viewBox?.height,
    rawViewBoxBoxWidth: (svgOptions as any).viewBoxWidth,
    rawViewBoxBoxHeight: (svgOptions as any).viewBoxHeight,
    resolvedWidth: width,
    resolvedHeight: height,
    canvasWidthBefore: canvas.getWidth(),
    canvasHeightBefore: canvas.getHeight(),
  });
  if (width > 0 && height > 0 && (width !== canvas.getWidth() || height !== canvas.getHeight())) {
    setCanvasSize(width, height);
    canvas.setDimensions({ width, height });
  }
  console.log('[loadAiSvgObjects] canvas dims after', {
    canvasWidth: canvas.getWidth(),
    canvasHeight: canvas.getHeight(),
  });

  const rawSvgObjects = objects.filter(Boolean) as fabric.FabricObject[];
  if (options.requireEditableObjects && rawSvgObjects.length === 0) {
    throw new Error('PDF SVG 未解析出对象，请手动重新解析。');
  }
  rawSvgObjects.forEach((object) => normalizePdfRasterRoleForSvgObject(object, width, height));
  const flattenedSvgObjects = flattenSvgObjects(rawSvgObjects);
  flattenedSvgObjects.forEach((object) => normalizePdfRasterRoleForSvgObject(object, width, height));
  const filteredSvgObjects = flattenedSvgObjects
    .filter((object) => {
      if (options.skipImageObjects && object.type === 'image') return false;
      const svgRole = normalizeSvgObjectRole((object as any)._svgObjectRole);
      if (isSkippedSvgObjectRole(svgRole)) return false;
      if ((object as any)._pdfMaskArtifact === true) return false;
      return !(
        options.skipPdfRasterImages
        && (
          (object as any)._pdfRasterBackground === true
          || (object as any)._pdfSourceRasterImage === true
        )
      );
    });
  const svgObjects = groupDecorationSvgObjects(filteredSvgObjects, fileName);
  if (options.requireEditableObjects && svgObjects.length === 0) {
    throw new Error('PDF SVG 未解析出有效元素，请手动重新解析。');
  }
  if (svgObjects.length === 0) return { count: 0, visualCount: 0, layers: [] };

  (canvas as any).__benlaiImportedSvgRoleModelVersion = IMPORTED_SVG_ROLE_MODEL_VERSION;
  const svgLayers: ParsedLayer[] = [];
  let editableObjectCount = 0;

  svgObjects.forEach((object, index) => {
    const layerId = -(index + 1);
    const decorationMeta = object as SvgDecorationLinkedObject;
    const isSvgDecorationProxy = decorationMeta._svgDecorationProxy === true;
    const isSvgDecorationMember = decorationMeta._svgDecorationMember === true;
    const isSvgDecorationVisualOnly = decorationMeta._svgDecorationVisualOnly === true;
    const isLockedRasterBackground = options.lockRasterImages && (object as any)._pdfRasterBackground === true;
    const isPdfTextPath = (object as any)._pdfTextPath === true;
    const svgRole =
      normalizeSvgObjectRole((object as any)._svgObjectRole)
      || (isPdfRasterVisualObject(object) ? 'raster-image' : null)
      || (isPdfTextPath ? 'text-outline' : null)
      || 'editable-vector';
    (object as any)._svgObjectRole = svgRole;
    const isPdfRasterObject = isPdfRasterVisualObject(object);
    const isNonInteractivePdfRasterObject = isPdfRasterObject && !isInteractiveSvgObjectRole(svgRole);
    const layerName = isLockedRasterBackground
      ? 'PDF 底图'
      : (object as any)._svgLayerName || `${fileName} ${index + 1}`;
    const layerType: ParsedLayer['layerType'] =
      object.type === 'text' || object.type === 'textbox' || object.type === 'i-text'
        ? 'text'
        : object.type === 'image'
          ? 'image'
          : object.type === 'group'
            ? 'group'
          : 'shape';
    const isSvgDecorationGroup = isSvgDecorationProxy || (svgRole === 'decoration-vector' && layerType === 'group');
    const isSvgAtom = !isPdfRasterObject
      && layerType !== 'text'
      && layerType !== 'image'
      && !isSvgDecorationGroup
      && !isSvgDecorationMember;
    const isNonInteractiveSvgAtom = svgRole === 'text-outline'
      || isSvgDecorationMember
      || isSvgDecorationVisualOnly
      || svgRole === 'decoration-gradient-strip';
    const isNonInteractiveVisualObject = isNonInteractivePdfRasterObject || isNonInteractiveSvgAtom;
    const isPointerPassthroughBackground = isPointerPassthroughSvgBackground(object, svgRole, layerType, width, height);

    if (isSvgAtom) {
      markSvgImportedAtomObject(object);
    }
    object.set({
      selectable: !isNonInteractiveVisualObject,
      evented: !isNonInteractiveVisualObject && !isPointerPassthroughBackground,
      objectCaching: false,
      lockMovementX: false,
      lockMovementY: false,
      lockScalingX: false,
      lockScalingY: false,
      lockRotation: false,
      hoverCursor: isNonInteractiveVisualObject || isPointerPassthroughBackground ? 'default' : undefined,
    });
    if (isPointerPassthroughBackground) {
      (object as any)._svgPointerPassthroughBackground = true;
    }
    if (isNonInteractivePdfRasterObject) {
      enforcePdfRasterVisualOnlyObject(object);
    }
    if (isNonInteractiveSvgAtom) {
      enforceSvgNonInteractiveVisualObject(object);
    }
    (object as any)._layerId = layerId;
    (object as any)._layerName = layerName;
    (object as any)._layerType = layerType;
    canvas.add(object);
    if (isSvgDecorationProxy) {
      resetSvgDecorationProxyState(object);
    }

    if (isNonInteractivePdfRasterObject) return;
    if (isNonInteractiveSvgAtom) return;
    if (!isNonInteractiveSvgAtom) editableObjectCount++;
    const layerPage = Number(options.pageNumber);
    const svgLayerProperties: Record<string, unknown> = {
      ...(Number.isFinite(layerPage) && layerPage > 0 ? { page: layerPage } : {}),
      role: isSvgAtom
        ? SVG_VECTOR_ATOM_ROLE
        : isSvgDecorationGroup
          ? SVG_DECORATION_GROUP_ROLE
          : svgRole,
      svgObjectType: object.type,
      svgObjectRole: svgRole,
    };

    svgLayers.push({
      id: layerId,
      fileId: 0,
      layerName,
      layerType,
      parentLayerId: null,
      sortOrder: index + 1,
      visible: object.visible !== false,
      opacity: object.opacity ?? 1,
      blendMode: 'normal',
      x: Math.round(Number(object.left) || 0),
      y: Math.round(Number(object.top) || 0),
      width: Math.round(object.getScaledWidth?.() || Number(object.width) || 0),
      height: Math.round(object.getScaledHeight?.() || Number(object.height) || 0),
      properties: svgLayerProperties,
    });
  });

  return { count: editableObjectCount, visualCount: svgObjects.length, layers: svgLayers };
}

function ensureEditableSvgRasterObjectsComplete(svgText: string, objects: Array<fabric.FabricObject | null>): void {
  const document = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  if (document.querySelector('parsererror')) throw new Error('PDF SVG 页面格式无效');
  const expected = Array.from(document.getElementsByTagNameNS('*', 'image')).filter((element) => {
    if (element.getAttribute('data-object-role') !== 'editable-raster') return false;
    let parent = element.parentElement;
    while (parent) {
      if (['defs', 'symbol', 'clippath', 'mask', 'pattern', 'marker'].includes(parent.localName.toLowerCase())) return false;
      parent = parent.parentElement;
    }
    return true;
  }).length;
  let loaded = 0;
  const visit = (object: fabric.FabricObject | null) => {
    if (!object) return;
    if (String(object.type).toLowerCase() === 'image' && (object as any)._svgObjectRole === 'editable-raster') loaded += 1;
    const children = (object as fabric.FabricObject & { getObjects?: () => fabric.FabricObject[] }).getObjects?.();
    children?.forEach(visit);
  };
  objects.forEach(visit);
  if (loaded < expected) throw new Error(`PDF 页面图片加载不完整（${loaded}/${expected}），请重新加载后再编辑。`);
}

function parseEditableRasterPageFallbackSvg(svgText: string): { href: string; width: number; height: number } | null {
  try {
    const svgTag = svgText.match(/<svg\b[^>]*>/i)?.[0];
    if (!svgTag) return null;
    const imageTags = svgText.match(/<image\b[^>]*>/gi) || [];
    if (imageTags.length !== 1) return null;
    const imageTag = imageTags[0];
    if (readSvgTagAttr(imageTag, 'data-pdf-page-rasterized') !== 'true') return null;
    if (normalizeSvgObjectRole(readSvgTagAttr(imageTag, 'data-object-role')) !== 'editable-raster') return null;
    const href = readSvgTagAttr(imageTag, 'href') || readSvgTagAttr(imageTag, 'xlink:href');
    if (!href || /^data:/i.test(href)) return null;
    const viewBox = readSvgTagAttr(svgTag, 'viewBox')
      ?.trim()
      .split(/[\s,]+/)
      .map((item) => Number(item));
    return {
      href: new URL(href.replace(/^uploads\//, '/uploads/'), window.location.origin).toString(),
      width: Math.round(resolveSvgDimension(readSvgTagAttr(svgTag, 'width'), viewBox?.[2], 0)),
      height: Math.round(resolveSvgDimension(readSvgTagAttr(svgTag, 'height'), viewBox?.[3], 0)),
    };
  } catch {
    return null;
  }
}

function readSvgTagAttr(tag: string, attrName: string): string | null {
  const escaped = attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\s${escaped}=([\"'])(.*?)\\1`, 'i');
  return tag.match(pattern)?.[2] || null;
}

async function loadUploadFabricImageFromUrl(src: string): Promise<fabric.FabricImage> {
  try {
    const url = new URL(src, window.location.origin);
    if (url.origin === window.location.origin && url.pathname.startsWith('/uploads/')) {
      const response = await fetch(url.toString(), { cache: 'no-store' });
      if (!response.ok) throw new Error(`upload_image_load_failed:${response.status}`);
      return loadFabricImageFromUrl(await blobToDataUrl(await response.blob()));
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('upload_image_load_failed:')) {
      throw error;
    }
  }
  return loadFabricImageFromUrl(src, { crossOrigin: 'anonymous' });
}

async function loadSvgTextWithUploadCacheBuster(url: string): Promise<string> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`SVG load failed: ${response.status} ${response.statusText}`);
  const buffer = await response.arrayBuffer();
  const svgText = new TextDecoder('utf-8').decode(buffer);
  const cacheBuster = extractSvgAssetCacheBuster(url);
  return normalizeUploadSvgHrefs(svgText, cacheBuster);
}

function extractSvgAssetCacheBuster(url: string): string | null {
  try {
    const parsed = new URL(url, window.location.origin);
    const version = parsed.searchParams.get('v') || parsed.searchParams.get('t');
    return version && version.trim() ? version.trim() : null;
  } catch {
    return null;
  }
}

function normalizeUploadSvgHrefs(svgText: string, cacheBuster: string | null): string {
  return svgText.replace(
    /\b((?:href|xlink:href))=(["'])([^"']+)\2/g,
    (match, attr: string, quote: string, rawHref: string) => {
      try {
        const url = new URL(rawHref.replace(/&amp;/g, '&').replace(/^uploads\//, '/uploads/'), window.location.origin);
        if (url.origin !== window.location.origin || !url.pathname.startsWith('/uploads/')) return match;
        const href = withUploadAssetRevision(url.toString(), cacheBuster, window.location.origin).replace(/&/g, '&amp;');
        return `${attr}=${quote}${href}${quote}`;
      } catch { return match; }
    },
  );
}

function groupDecorationSvgObjects(objects: fabric.FabricObject[], fileName: string): fabric.FabricObject[] {
  type DecorationItem = {
    object: fabric.FabricObject;
    index: number;
    bounds: PixelBounds;
    clusterId: string | undefined;
  };
  type DecorationCluster = {
    items: DecorationItem[];
    bounds: PixelBounds;
    clusterId?: string;
  };

  const items = objects
    .map((object, index) => ({
      object,
      index,
      bounds: getFabricObjectPixelBounds(object),
      clusterId: typeof (object as SvgDecorationLinkedObject)._svgDecorationClusterId === 'string'
        ? (object as SvgDecorationLinkedObject)._svgDecorationClusterId
        : undefined,
    }))
    .filter((item): item is DecorationItem =>
      item.bounds !== null
      && (
      item.object.type !== 'group'
        || normalizeSvgObjectRole((item.object as any)._svgObjectRole) === 'decoration-gradient-strip'
        || normalizeSvgObjectRole((item.object as any)._svgObjectRole) === 'decoration-texture-fill'
        || normalizeSvgObjectRole((item.object as any)._svgObjectRole) === 'decoration-effect-raster'
      ),
    );
  const decorationSeeds = items.filter((item) => {
    const role = normalizeSvgObjectRole((item.object as any)._svgObjectRole);
    return (
        role === 'decoration-vector'
        || role === 'decoration-gradient-strip'
        || role === 'decoration-texture-fill'
        || role === 'decoration-effect-raster'
      )
      && item.object.type !== 'text'
      && item.object.type !== 'textbox'
      && item.object.type !== 'i-text';
  });
  if (decorationSeeds.length === 0) return objects;
  if (
    decorationSeeds.length === 1
    && normalizeSvgObjectRole((decorationSeeds[0].object as any)._svgObjectRole) !== 'decoration-texture-fill'
    && normalizeSvgObjectRole((decorationSeeds[0].object as any)._svgObjectRole) !== 'decoration-effect-raster'
  ) {
    return objects;
  }

  const documentBounds = unionPixelBounds(items.map((item) => item.bounds));
  const clusters: DecorationCluster[] = [];
  const clusteredSeedIds = new Set<number>();
  const seedsByServerCluster = new Map<string, DecorationItem[]>();
  decorationSeeds.forEach((seed) => {
    if (!seed.clusterId) return;
    const bucket = seedsByServerCluster.get(seed.clusterId) || [];
    bucket.push(seed);
    seedsByServerCluster.set(seed.clusterId, bucket);
  });
  seedsByServerCluster.forEach((bucket) => {
    const bounds = unionPixelBounds(bucket.map((item) => item.bounds));
    if (!bounds) return;
    clusters.push({ items: [...bucket], bounds, clusterId: bucket[0].clusterId });
    bucket.forEach((item) => clusteredSeedIds.add(item.index));
  });

  for (const candidate of decorationSeeds) {
    if (clusteredSeedIds.has(candidate.index)) continue;
    const matches = clusters.filter((cluster) =>
      !cluster.clusterId
      && arePixelBoundsNear(cluster.bounds, candidate.bounds, 18),
    );
    if (matches.length === 0) {
      clusters.push({
        items: [candidate],
        bounds: { ...candidate.bounds },
        clusterId: candidate.clusterId,
      });
      continue;
    }

    const [primary, ...duplicates] = matches;
    primary.items.push(candidate);
    primary.bounds = unionPixelBounds([primary.bounds, candidate.bounds]) || primary.bounds;
    duplicates.forEach((cluster) => {
      primary.items.push(...cluster.items);
      primary.bounds = unionPixelBounds([primary.bounds, cluster.bounds]) || primary.bounds;
      const index = clusters.indexOf(cluster);
      if (index >= 0) clusters.splice(index, 1);
    });
  }

  const assigned = new Set(decorationSeeds.map((item) => item.index));
  for (const item of items) {
    if (assigned.has(item.index) || !item.clusterId) continue;
    if (normalizeSvgObjectRole((item.object as any)._svgObjectRole) !== 'text-outline') continue;
    const cluster = clusters.find((candidate) => candidate.clusterId === item.clusterId);
    if (!cluster) continue;
    cluster.items.push(item);
    cluster.bounds = unionPixelBounds([cluster.bounds, item.bounds]) || cluster.bounds;
    assigned.add(item.index);
  }

  for (const item of items) {
    if (assigned.has(item.index)) continue;
    if (normalizeSvgObjectRole((item.object as any)._svgObjectRole) !== 'editable-vector') continue;
    if (item.object.type === 'image' || item.object.type === 'text' || item.object.type === 'textbox' || item.object.type === 'i-text') continue;

    const cluster = item.clusterId
      ? clusters.find((candidate) => candidate.clusterId === item.clusterId)
      : clusters.find((candidate) =>
          !candidate.clusterId
          && isEditableVectorDecorationClusterMember(item.bounds, candidate.bounds),
        );
    if (!cluster) continue;
    cluster.items.push(item);
    cluster.bounds = unionPixelBounds([cluster.bounds, item.bounds]) || cluster.bounds;
    assigned.add(item.index);
  }

  const insertions = new Map<number, fabric.FabricObject[]>();
  let groupIndex = 0;
  clusters
    .filter((cluster) =>
      cluster.items.length > 1
      || cluster.items.some((item) => normalizeSvgObjectRole((item.object as any)._svgObjectRole) === 'decoration-texture-fill')
      || cluster.items.some((item) => normalizeSvgObjectRole((item.object as any)._svgObjectRole) === 'decoration-effect-raster')
    )
    .forEach((cluster) => {
      const ordered = [...cluster.items].sort((left, right) => left.index - right.index);
      const interactionGeometry = getSvgDecorationInteractionGeometry(ordered);
      if (!interactionGeometry) return;
      if (isOversizedDecorationProxyCluster(interactionGeometry.bounds, documentBounds)) {
        ordered.forEach((item) => markSvgDecorationDirectVectorFallbackObject(item.object));
        return;
      }
      groupIndex++;
      const serverClusterId = ordered.find((item) => item.clusterId)?.clusterId;
      const groupId = serverClusterId
        ? `svg-decoration-${serverClusterId}`
        : `svg-decoration-${groupIndex}-${ordered[0].index}`;
      const groupName = `${fileName} decoration ${groupIndex}`;
      ordered.forEach((item, memberIndex) => {
        markSvgDecorationMemberObject(item.object, groupId, memberIndex, groupName);
      });
      const insertIndex = ordered[ordered.length - 1].index;
      const proxy = createSvgDecorationProxyObject(
        interactionGeometry.bounds,
        groupId,
        groupName,
        interactionGeometry.memberBounds,
      );
      const bucket = insertions.get(insertIndex) || [];
      bucket.push(proxy);
      insertions.set(insertIndex, bucket);
    });

  if (insertions.size === 0) return objects;
  return objects.flatMap((object, index) => {
    const inserted = insertions.get(index);
    return inserted ? [object, ...inserted] : [object];
  });
}

function getSvgDecorationInteractionGeometry(
  items: Array<{ object: fabric.FabricObject; bounds: PixelBounds }>,
): { bounds: PixelBounds; memberBounds: PixelBounds[] } | null {
  const foregroundBounds = items
    .filter(({ object }) => {
      const role = normalizeSvgObjectRole((object as SvgDecorationLinkedObject)._svgObjectRole);
      return role === 'decoration-vector'
        || role === 'editable-vector'
        || role === 'text-outline';
    })
    .map(({ bounds }) => bounds);
  const structuralBounds = items
    .filter(({ object }) => {
      const role = normalizeSvgObjectRole((object as SvgDecorationLinkedObject)._svgObjectRole);
      return role !== 'decoration-texture-fill' && role !== 'decoration-effect-raster';
    })
    .map(({ bounds }) => bounds);
  const memberBounds = foregroundBounds.length > 0
    ? foregroundBounds
    : structuralBounds.length > 0
      ? structuralBounds
      : items.map(({ bounds }) => bounds);
  const rawBounds = unionPixelBounds(memberBounds);
  if (!rawBounds) return null;
  const bounds = getDenseSvgDecorationInteractionBounds(memberBounds, rawBounds);
  const clippedMemberBounds = memberBounds
    .map((memberBounds) => intersectPixelBounds(memberBounds, bounds))
    .filter((memberBounds): memberBounds is PixelBounds => memberBounds !== null);
  return {
    bounds,
    memberBounds: clippedMemberBounds.length > 0 ? clippedMemberBounds : [bounds],
  };
}

function getDenseSvgDecorationInteractionBounds(
  memberBounds: PixelBounds[],
  rawBounds: PixelBounds,
): PixelBounds {
  if (memberBounds.length < 48) return rawBounds;
  const left = getNumericQuantile(memberBounds.map((bounds) => bounds.left), 0.02);
  const top = getNumericQuantile(memberBounds.map((bounds) => bounds.top), 0.08);
  const right = getNumericQuantile(memberBounds.map((bounds) => bounds.right), 0.98);
  const bottom = getNumericQuantile(memberBounds.map((bounds) => bounds.bottom), 0.96);
  if (right <= left || bottom <= top) return rawBounds;

  const candidate: PixelBounds = {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
  const areaRatio = getPixelBoundsArea(candidate) / Math.max(1, getPixelBoundsArea(rawBounds));
  const retainedCount = memberBounds.filter((bounds) => getPixelBoundsOverlapRatio(bounds, candidate) >= 0.2).length;
  if (
    areaRatio < 0.28
    || candidate.width < 24
    || candidate.height < 24
    || retainedCount < Math.max(12, Math.floor(memberBounds.length * 0.55))
  ) return rawBounds;
  return candidate;
}

function getNumericQuantile(values: number[], quantile: number): number {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const position = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * quantile));
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const ratio = position - lowerIndex;
  return sorted[lowerIndex] * (1 - ratio) + sorted[upperIndex] * ratio;
}

function isOversizedDecorationProxyCluster(bounds: PixelBounds, documentBounds: PixelBounds | null): boolean {
  if (!documentBounds) return false;
  const documentArea = Math.max(1, getPixelBoundsArea(documentBounds));
  const areaRatio = getPixelBoundsArea(bounds) / documentArea;
  const widthRatio = bounds.width / Math.max(1, documentBounds.width);
  const heightRatio = bounds.height / Math.max(1, documentBounds.height);
  return areaRatio >= 0.3
    || (areaRatio >= 0.22 && heightRatio >= 0.85)
    || (areaRatio >= 0.22 && widthRatio >= 0.85)
    || (widthRatio >= 0.78 && heightRatio >= 0.78);
}

function markSvgDecorationVisualOnlyObject(object: fabric.FabricObject) {
  const target = object as SvgDecorationLinkedObject;
  delete target._svgDecorationGroupId;
  delete target._svgDecorationGroupName;
  delete target._svgDecorationMember;
  delete target._svgDecorationMemberIndex;
  delete target._svgDecorationBaseOpacity;
  target._svgDecorationVisualOnly = true;
  target._psdLocked = false;
  enforceSvgNonInteractiveVisualObject(target);
}

function markSvgDecorationDirectVectorFallbackObject(object: fabric.FabricObject) {
  const target = object as SvgDecorationLinkedObject;
  const role = normalizeSvgObjectRole(target._svgObjectRole);
  if (role === 'decoration-texture-fill' || role === 'decoration-effect-raster') {
    markSvgDecorationVisualOnlyObject(object);
    return;
  }
  delete target._svgDecorationGroupId;
  delete target._svgDecorationGroupName;
  delete target._svgDecorationMember;
  delete target._svgDecorationMemberIndex;
  delete target._svgDecorationBaseOpacity;
  delete target._svgDecorationVisualOnly;
  target._psdLocked = false;
  target.set({
    selectable: true,
    evented: true,
    hasControls: true,
    lockMovementX: false,
    lockMovementY: false,
    lockScalingX: false,
    lockScalingY: false,
    lockRotation: false,
    hoverCursor: 'move',
    objectCaching: false,
  });
  target.setCoords();
}

function markSvgDecorationMemberObject(
  object: fabric.FabricObject,
  groupId: string,
  memberIndex: number,
  groupName: string,
) {
  const target = object as SvgDecorationLinkedObject;
  target._svgDecorationGroupId = groupId;
  target._svgDecorationGroupName = groupName;
  target._svgDecorationMember = true;
  target._svgDecorationMemberIndex = memberIndex;
  if (!Number.isFinite(Number(target._svgDecorationBaseOpacity))) {
    target._svgDecorationBaseOpacity = target.opacity ?? 1;
  }
  target._psdLocked = false;
  target.set({
    selectable: false,
    evented: false,
    hasControls: false,
    lockMovementX: false,
    lockMovementY: false,
    lockScalingX: false,
    lockScalingY: false,
    lockRotation: false,
    hoverCursor: 'default',
    objectCaching: false,
  });
  target.setCoords();
}

function createSvgDecorationProxyObject(
  bounds: PixelBounds,
  groupId: string,
  layerName: string,
  memberBounds: PixelBounds[] = [bounds],
): fabric.Group {
  const hitRegions = buildSvgDecorationProxyHitRegions(bounds, memberBounds);
  const hitRects = hitRegions.map((region) => new fabric.Rect({
    originX: 'left',
    originY: 'top',
    left: region.left - bounds.left,
    top: region.top - bounds.top,
    width: Math.max(1, region.width),
    height: Math.max(1, region.height),
    fill: 'rgba(0,0,0,0.004)',
    stroke: 'rgba(0,0,0,0)',
    strokeWidth: 0,
    selectable: false,
    evented: false,
    hasControls: false,
    objectCaching: false,
  }));
  const group = new fabric.Group(hitRects, {
    left: bounds.left,
    top: bounds.top,
    originX: 'left',
    originY: 'top',
    objectCaching: false,
    subTargetCheck: false,
    interactive: false,
    perPixelTargetFind: true,
    targetFindTolerance: 8,
  } as Partial<fabric.Group>) as fabric.Group & SvgDecorationLinkedObject & { _svgDecorationGroup?: boolean };
  group.set({
    selectable: true,
    evented: true,
    lockMovementX: false,
    lockMovementY: false,
    lockScalingX: false,
    lockScalingY: false,
    lockRotation: false,
    hoverCursor: 'move',
  } as Partial<fabric.Group>);
  group._svgObjectRole = 'decoration-vector';
  group._svgLayerName = layerName;
  (group as any)._layerName = layerName;
  (group as any)._layerType = 'group';
  group._svgDecorationGroup = true;
  group._svgDecorationGroupId = groupId;
  group._svgDecorationGroupName = layerName;
  group._svgDecorationProxy = true;
  group._psdLocked = false;
  group.setCoords();
  resetSvgDecorationProxyState(group);
  return group;
}

function buildSvgDecorationProxyHitRegions(
  bounds: PixelBounds,
  memberBounds: PixelBounds[],
): PixelBounds[] {
  const padding = 3;
  const regions = memberBounds
    .filter((item) => item.width > 0 && item.height > 0)
    .map((item) => {
      const left = Math.max(bounds.left, item.left - padding);
      const top = Math.max(bounds.top, item.top - padding);
      const right = Math.min(bounds.right, item.right + padding);
      const bottom = Math.min(bounds.bottom, item.bottom + padding);
      return {
        left,
        top,
        right,
        bottom,
        width: Math.max(1, right - left),
        height: Math.max(1, bottom - top),
      };
    });
  if (regions.length === 0) return [bounds];

  const merged: PixelBounds[] = [];
  regions
    .sort((left, right) => getPixelBoundsArea(right) - getPixelBoundsArea(left))
    .forEach((region) => {
      let current = region;
      let index = 0;
      while (index < merged.length) {
        if (!arePixelBoundsNear(current, merged[index], 2)) {
          index++;
          continue;
        }
        current = unionPixelBounds([current, merged[index]]) || current;
        merged.splice(index, 1);
        index = 0;
      }
      merged.push(current);
    });
  return merged;
}

function isPdfPageCompositeUnderlayObject(
  object: fabric.FabricObject | null | undefined,
): object is PdfPageCompositeObject {
  const target = object as PdfPageCompositeObject | null | undefined;
  return Boolean(
    target
    && target._pdfPageCompositeRole === 'underlay'
    && target._pdfPageRasterUnderlay === true
    && target._pdfRasterFallbackEditable === true
    && target._pdfPageCompositeId,
  );
}

function restoreSavedEditablePdfLayerState(
  canvas: fabric.Canvas,
  layers: ParsedLayer[],
  fileId: number,
  pageNumber: number,
): ParsedLayer[] {
  // SVG layers are synthetic and are not returned by the parsed-layers API.
  // Rebuild their panel records from the saved scene, keeping edits and IDs.
  const restoredLayers = layers.filter((layer) => !(Number(layer.id) < 0));
  canvas.getObjects().forEach((object, index) => {
    const custom = object as fabric.FabricObject & Record<string, unknown>;
    const layerId = Number(custom._layerId);
    if (!Number.isFinite(layerId) || layerId >= 0 || isPdfPageCompositeUnderlayObject(object)) return;
    const svgRole = normalizeSvgObjectRole(custom._svgObjectRole);
    if (custom._pdfPreviewOnlyBackground === true
      || isSerializedPdfAuxiliaryPreviewObject(custom)
      || custom._pdfMaskArtifact === true
      || isSkippedSvgObjectRole(svgRole)
      || custom._svgDecorationMember === true
      || custom._svgDecorationVisualOnly === true
      || svgRole === 'text-outline'
      || svgRole === 'decoration-gradient-strip'
      || (isPdfRasterVisualObject(object) && !isInteractiveSvgObjectRole(svgRole || 'raster-image'))) return;
    const objectType = String(object.type).toLowerCase();
    const layerType: ParsedLayer['layerType'] =
      objectType === 'text' || objectType === 'textbox' || objectType === 'i-text'
        ? 'text'
        : objectType === 'image'
          ? 'image'
          : objectType === 'group'
            ? 'group'
            : 'shape';
    const isDecorationGroup = custom._svgDecorationProxy === true || (svgRole === 'decoration-vector' && layerType === 'group');
    const isSvgAtom = !isPdfRasterVisualObject(object) && layerType !== 'text' && layerType !== 'image' && !isDecorationGroup;
    restoredLayers.push({
      id: layerId,
      fileId,
      layerName: String(custom._layerName || custom._svgLayerName || `PDF ${index + 1}`),
      layerType,
      parentLayerId: null,
      sortOrder: index + 1,
      visible: object.visible !== false,
      opacity: object.opacity ?? 1,
      blendMode: 'normal',
      x: Math.round(Number(object.left) || 0),
      y: Math.round(Number(object.top) || 0),
      width: Math.round(object.getScaledWidth?.() || Number(object.width) || 0),
      height: Math.round(object.getScaledHeight?.() || Number(object.height) || 0),
      properties: {
        role: isSvgAtom ? SVG_VECTOR_ATOM_ROLE : isDecorationGroup ? SVG_DECORATION_GROUP_ROLE : svgRole || 'editable-vector',
        svgObjectType: object.type,
        svgObjectRole: svgRole,
        page: pageNumber,
      },
    });
  });
  return mergePdfPageCompositeUnderlayLayerState(canvas, restoredLayers, fileId);
}

function mergePdfPageCompositeUnderlayLayerState(
  canvas: fabric.Canvas,
  layers: ParsedLayer[],
  fileId: number,
): ParsedLayer[] {
  const underlay = canvas.getObjects().find(isPdfPageCompositeUnderlayObject);
  if (!underlay) return layers;

  const custom = underlay as PdfPageCompositeObject & {
    _layerId?: unknown;
    _layerName?: unknown;
    getSrc?: () => string;
  };
  const parsedLayerId = Number(custom._layerId);
  const layerId = Number.isFinite(parsedLayerId) ? parsedLayerId : -1;
  const alreadyIncluded = layers.some((layer) => (
    layer.id === layerId
    || layer.properties?.rasterPageFallback === true
  ));
  if (alreadyIncluded) return layers;

  const bounds = underlay.getBoundingRect();
  const page = Number(String(custom._pdfPageCompositeId).match(/(\d+)$/)?.[1] || 1);
  return [{
    id: layerId,
    fileId,
    layerName: String(custom._layerName || '页面图片内容'),
    layerType: 'image',
    parentLayerId: null,
    sortOrder: 0,
    visible: underlay.visible !== false,
    opacity: Number.isFinite(Number(underlay.opacity)) ? Number(underlay.opacity) : 1,
    blendMode: 'normal',
    x: bounds.left,
    y: bounds.top,
    width: bounds.width,
    height: bounds.height,
    imagePath: typeof custom.getSrc === 'function' ? custom.getSrc() : undefined,
    properties: {
      role: 'editable-raster',
      svgObjectType: 'image',
      svgObjectRole: 'editable-raster',
      rasterPageFallback: true,
      textUnderlaySource: true,
      page,
    },
  }, ...layers];
}

function findPdfPageCompositeUnderlay(canvas: fabric.Canvas): PdfPageCompositeObject | null {
  return (canvas.getObjects().find(isPdfPageCompositeUnderlayObject) as PdfPageCompositeObject | undefined) || null;
}

function resetPdfPageCompositeUnderlayState(object: fabric.FabricObject) {
  if (!isPdfPageCompositeUnderlayObject(object)) return;
  const currentMatrix = [...object.calcTransformMatrix()];
  if (!Array.isArray(object._pdfPageCompositeBaseMatrix) || object._pdfPageCompositeBaseMatrix.length !== 6) {
    object._pdfPageCompositeBaseMatrix = [...currentMatrix];
  }
  object._pdfPageCompositeLastMatrix = currentMatrix;
}

function restorePdfPageCompositeLinksForCanvas(canvas: fabric.Canvas) {
  const underlay = findPdfPageCompositeUnderlay(canvas);
  if (!underlay) return;
  resetPdfPageCompositeUnderlayState(underlay);
  const members = canvas.getObjects().filter((object) => {
    const member = object as PdfPageCompositeObject;
    return member !== underlay && member._pdfPageCompositeId === underlay._pdfPageCompositeId;
  });
  members.forEach((object) => {
    const member = object as PdfPageCompositeObject;
    member.set({
      lockMovementX: false,
      lockMovementY: false,
      lockScalingX: false,
      lockScalingY: false,
      lockRotation: false,
    });
    member._psdLocked = false;
    member.setCoords();
  });

  canvas.moveObjectTo(underlay, 0);
  let nextIndex = 1;
  const roleOrder: PdfPageCompositeRole[] = ['background-patch', 'activated-text', 'text-activation'];
  roleOrder.forEach((role) => {
    members
      .filter((member) => (member as PdfPageCompositeObject)._pdfPageCompositeRole === role)
      .forEach((member) => {
        canvas.moveObjectTo(member, nextIndex);
        nextIndex += 1;
      });
  });
}

function linkPdfPageCompositeMember(
  canvas: fabric.Canvas,
  object: fabric.FabricObject,
  role: Exclude<PdfPageCompositeRole, 'underlay'>,
  localBounds: PsdLayerBounds,
  options: { applyUnderlayTransform?: boolean } = {},
) {
  const underlay = findPdfPageCompositeUnderlay(canvas);
  if (!underlay?._pdfPageCompositeId) return;
  const member = object as PdfPageCompositeObject;
  member._pdfPageCompositeId = underlay._pdfPageCompositeId;
  member._pdfPageCompositeRole = role;
  member._pdfPageLocalBounds = { ...localBounds };
  member._psdLocked = false;

  if (options.applyUnderlayTransform !== false) {
    applyPdfPageCompositeTransformFromBase(underlay, member);
  }
  updatePdfPageCompositeMemberBounds(member);
}

function applyPdfPageCompositeTransformFromBase(
  underlay: PdfPageCompositeObject,
  member: PdfPageCompositeObject,
) {
  const baseMatrix = underlay._pdfPageCompositeBaseMatrix;
  if (!Array.isArray(baseMatrix) || baseMatrix.length !== 6) return;
  const currentMatrix = [...underlay.calcTransformMatrix()];
  const utils = fabric.util as unknown as {
    applyTransformToObject?: (object: fabric.FabricObject, transform: number[]) => void;
    invertTransform?: (transform: number[]) => number[];
    multiplyTransformMatrices?: (left: number[], right: number[]) => number[];
  };
  if (!utils.applyTransformToObject || !utils.invertTransform || !utils.multiplyTransformMatrices) return;
  const delta = utils.multiplyTransformMatrices(currentMatrix, utils.invertTransform(baseMatrix));
  if (areFabricMatricesClose(delta, [1, 0, 0, 1, 0, 0])) return;
  applySvgTransformDeltaToObjectAndClipPath(member, delta, {
    applyTransformToObject: utils.applyTransformToObject,
    multiplyTransformMatrices: utils.multiplyTransformMatrices,
  });
}

function syncPdfPageCompositeMembers(
  canvas: fabric.Canvas,
  target: fabric.FabricObject | null | undefined,
  options: { requestRender?: boolean } = {},
) {
  if (!isPdfPageCompositeUnderlayObject(target) || !target._pdfPageCompositeId) return;
  const previousMatrix = target._pdfPageCompositeLastMatrix;
  const currentMatrix = [...target.calcTransformMatrix()];
  if (!Array.isArray(previousMatrix) || previousMatrix.length !== 6) {
    target._pdfPageCompositeLastMatrix = currentMatrix;
    return;
  }
  if (areFabricMatricesClose(previousMatrix, currentMatrix)) return;

  const utils = fabric.util as unknown as {
    applyTransformToObject?: (object: fabric.FabricObject, transform: number[]) => void;
    invertTransform?: (transform: number[]) => number[];
    multiplyTransformMatrices?: (left: number[], right: number[]) => number[];
  };
  if (!utils.applyTransformToObject || !utils.invertTransform || !utils.multiplyTransformMatrices) return;
  const delta = utils.multiplyTransformMatrices(currentMatrix, utils.invertTransform(previousMatrix));
  const syncCanvas = canvas as fabric.Canvas & { __syncingPdfPageComposite?: boolean };
  const previousSyncing = syncCanvas.__syncingPdfPageComposite;
  syncCanvas.__syncingPdfPageComposite = true;
  try {
    canvas.getObjects().forEach((object) => {
      const member = object as PdfPageCompositeObject;
      if (member === target || member._pdfPageCompositeId !== target._pdfPageCompositeId) return;
      applySvgTransformDeltaToObjectAndClipPath(member, delta, {
        applyTransformToObject: utils.applyTransformToObject!,
        multiplyTransformMatrices: utils.multiplyTransformMatrices!,
      });
      updatePdfPageCompositeMemberBounds(member);
    });
  } finally {
    syncCanvas.__syncingPdfPageComposite = previousSyncing;
  }
  target._pdfPageCompositeLastMatrix = currentMatrix;
  if (options.requestRender !== false) canvas.requestRenderAll();
}

function updatePdfPageCompositeMemberBounds(member: PdfPageCompositeObject) {
  const bounds = getFabricObjectPixelBounds(member);
  if (!bounds) return;
  member._psdLayerBounds = {
    left: bounds.left,
    top: bounds.top,
    width: bounds.width,
    height: bounds.height,
  };
  member._psdPreviewVisualBounds = bounds;
}

function isSvgDecorationProxyObject(object: fabric.FabricObject | null | undefined): object is SvgDecorationLinkedObject {
  return Boolean(object && (object as SvgDecorationLinkedObject)._svgDecorationProxy === true);
}

function isSvgDecorationMemberObject(object: fabric.FabricObject | null | undefined): object is SvgDecorationLinkedObject {
  return Boolean(object && (object as SvgDecorationLinkedObject)._svgDecorationMember === true);
}

function resetSvgDecorationProxyState(object: fabric.FabricObject) {
  if (!isSvgDecorationProxyObject(object)) return;
  object._svgDecorationLastMatrix = [...object.calcTransformMatrix()];
}

function restoreSvgDecorationLinksForCanvas(canvas: fabric.Canvas) {
  rebuildMissingSvgDecorationProxies(canvas);
  const objects = canvas.getObjects();
  objects.forEach((object) => {
    if (isSvgDecorationMemberObject(object)) {
      const proxy = findSvgDecorationProxy(canvas, object._svgDecorationGroupId);
      if (!Number.isFinite(Number(object._svgDecorationBaseOpacity))) {
        const proxyOpacity = Math.max(0.0001, Number(proxy?.opacity ?? 1) || 1);
        object._svgDecorationBaseOpacity = (object.opacity ?? 1) / proxyOpacity;
      }
      object.set({
        selectable: false,
        evented: false,
        hasControls: false,
        lockMovementX: false,
        lockMovementY: false,
        lockScalingX: false,
        lockScalingY: false,
        lockRotation: false,
        hoverCursor: 'default',
        objectCaching: false,
      });
      object._psdLocked = false;
      object.setCoords();
    }
    if (isSvgDecorationProxyObject(object)) {
      object.set({
        selectable: object.visible !== false,
        evented: object.visible !== false,
        lockMovementX: false,
        lockMovementY: false,
        lockScalingX: false,
        lockScalingY: false,
        lockRotation: false,
        objectCaching: false,
      });
      object._psdLocked = false;
      resetSvgDecorationProxyState(object);
      syncSvgDecorationProxyMembers(canvas, object, { applyTransform: false, requestRender: false });
    }
  });
}

function rebuildMissingSvgDecorationProxies(canvas: fabric.Canvas) {
  const membersByGroup = new Map<string, SvgDecorationLinkedObject[]>();
  canvas.getObjects().forEach((object) => {
    if (!isSvgDecorationMemberObject(object) || !object._svgDecorationGroupId) return;
    const members = membersByGroup.get(object._svgDecorationGroupId) || [];
    members.push(object);
    membersByGroup.set(object._svgDecorationGroupId, members);
  });

  membersByGroup.forEach((members, groupId) => {
    if (findSvgDecorationProxy(canvas, groupId)) return;
    const memberItems = members
      .map((member) => ({ object: member, bounds: getFabricObjectPixelBounds(member) }))
      .filter((item): item is { object: SvgDecorationLinkedObject; bounds: PixelBounds } => Boolean(item.bounds));
    const interactionGeometry = getSvgDecorationInteractionGeometry(memberItems);
    if (!interactionGeometry) return;
    const groupName = members.find((member) => member._svgDecorationGroupName)?._svgDecorationGroupName
      || members.find((member) => member._svgLayerName)?._svgLayerName
      || '装饰组合';
    const proxy = createSvgDecorationProxyObject(
      interactionGeometry.bounds,
      groupId,
      groupName,
      interactionGeometry.memberBounds,
    );
    const currentObjects = canvas.getObjects();
    const lastMemberIndex = members.reduce(
      (lastIndex, member) => Math.max(lastIndex, currentObjects.indexOf(member)),
      -1,
    );
    canvas.insertAt(Math.min(currentObjects.length, Math.max(0, lastMemberIndex + 1)), proxy);
  });
}

function syncSvgDecorationProxyMembers(
  canvas: fabric.Canvas,
  proxy: fabric.FabricObject | null | undefined,
  options: { applyTransform?: boolean; requestRender?: boolean } = {},
) {
  if (!isSvgDecorationProxyObject(proxy) || !proxy._svgDecorationGroupId) return;
  const members = getSvgDecorationMembers(canvas, proxy._svgDecorationGroupId);
  if (members.length === 0) {
    resetSvgDecorationProxyState(proxy);
    return;
  }

  const applyTransform = options.applyTransform !== false;
  const previousMatrix = proxy._svgDecorationLastMatrix;
  const currentMatrix = [...proxy.calcTransformMatrix()];
  const hasPreviousMatrix = Array.isArray(previousMatrix) && previousMatrix.length === 6;
  const hasTransformDelta = applyTransform && hasPreviousMatrix && !areFabricMatricesClose(previousMatrix, currentMatrix);
  const utils = fabric.util as unknown as {
    applyTransformToObject?: (object: fabric.FabricObject, transform: number[]) => void;
    invertTransform?: (transform: number[]) => number[];
    multiplyTransformMatrices?: (left: number[], right: number[]) => number[];
  };
  const delta = hasTransformDelta && utils.invertTransform && utils.multiplyTransformMatrices
    ? utils.multiplyTransformMatrices(currentMatrix, utils.invertTransform(previousMatrix))
    : null;
  const transformUtils = utils.applyTransformToObject && utils.multiplyTransformMatrices
    ? {
        applyTransformToObject: utils.applyTransformToObject,
        multiplyTransformMatrices: utils.multiplyTransformMatrices,
      }
    : null;
  const proxyOpacity = proxy.opacity ?? 1;
  const proxyVisible = proxy.visible !== false;
  const syncCanvas = canvas as fabric.Canvas & { __syncingSvgDecoration?: boolean };
  const previousSyncing = syncCanvas.__syncingSvgDecoration;
  syncCanvas.__syncingSvgDecoration = true;
  try {
    members.forEach((member) => {
      if (delta && transformUtils) {
        applySvgTransformDeltaToObjectAndClipPath(member, delta, transformUtils);
      }
      const baseOpacity = Number.isFinite(Number(member._svgDecorationBaseOpacity))
        ? Number(member._svgDecorationBaseOpacity)
        : (member.opacity ?? 1);
      member._svgDecorationBaseOpacity = baseOpacity;
      const hiddenBySourceText = Array.isArray(member._pdfSourceTextHiddenByLayerIds)
        && member._pdfSourceTextHiddenByLayerIds.length > 0;
      member.set({
        visible: proxyVisible && !hiddenBySourceText,
        opacity: baseOpacity * proxyOpacity,
        selectable: false,
        evented: false,
        hasControls: false,
        lockMovementX: false,
        lockMovementY: false,
        lockScalingX: false,
        lockScalingY: false,
        lockRotation: false,
        hoverCursor: 'default',
      });
      member._psdLocked = false;
      member.setCoords();
    });
  } finally {
    syncCanvas.__syncingSvgDecoration = previousSyncing;
  }
  proxy._svgDecorationLastMatrix = currentMatrix;
  if (options.requestRender !== false) canvas.requestRenderAll();
}

function removeSvgDecorationMembersForProxy(canvas: fabric.Canvas, proxy: fabric.FabricObject | null | undefined) {
  if (!isSvgDecorationProxyObject(proxy) || !proxy._svgDecorationGroupId) return;
  const syncCanvas = canvas as fabric.Canvas & { __bulkLoading?: boolean; __syncingSvgDecoration?: boolean };
  if (syncCanvas.__bulkLoading === true || syncCanvas.__syncingSvgDecoration === true) return;
  const members = getSvgDecorationMembers(canvas, proxy._svgDecorationGroupId);
  if (members.length === 0) return;
  const previousSyncing = syncCanvas.__syncingSvgDecoration;
  syncCanvas.__syncingSvgDecoration = true;
  try {
    members.forEach((member) => canvas.remove(member));
  } finally {
    syncCanvas.__syncingSvgDecoration = previousSyncing;
  }
}

function findSvgDecorationProxy(canvas: fabric.Canvas, groupId: string | undefined): SvgDecorationLinkedObject | null {
  if (!groupId) return null;
  return (canvas.getObjects().find((object) =>
    isSvgDecorationProxyObject(object) && object._svgDecorationGroupId === groupId,
  ) as SvgDecorationLinkedObject | undefined) || null;
}

function getSvgDecorationMembers(canvas: fabric.Canvas, groupId: string): SvgDecorationLinkedObject[] {
  return canvas.getObjects()
    .filter((object): object is SvgDecorationLinkedObject =>
      isSvgDecorationMemberObject(object) && object._svgDecorationGroupId === groupId,
    )
    .sort((left, right) => Number(left._svgDecorationMemberIndex || 0) - Number(right._svgDecorationMemberIndex || 0));
}

function areFabricMatricesClose(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => Math.abs(value - right[index]) <= 0.0001);
}

function getFabricObjectPixelBounds(object: fabric.FabricObject): PixelBounds | null {
  object.setCoords();
  const rect = typeof object.getBoundingRect === 'function'
    ? object.getBoundingRect()
    : { left: object.left || 0, top: object.top || 0, width: object.width || 0, height: object.height || 0 };
  const left = Number(rect.left || 0);
  const top = Number(rect.top || 0);
  const width = Number(rect.width || 0);
  const height = Number(rect.height || 0);
  if (!Number.isFinite(left) || !Number.isFinite(top) || width <= 0 || height <= 0) return null;
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

function arePixelBoundsNear(left: PixelBounds, right: PixelBounds, tolerance: number): boolean {
  return left.left <= right.right + tolerance
    && left.right >= right.left - tolerance
    && left.top <= right.bottom + tolerance
    && left.bottom >= right.top - tolerance;
}

function isEditableVectorDecorationClusterMember(bounds: PixelBounds, cluster: PixelBounds): boolean {
  if (!arePixelBoundsNear(bounds, cluster, 6)) return false;
  const clusterArea = getPixelBoundsArea(cluster);
  const boundsArea = getPixelBoundsArea(bounds);
  if (boundsArea / Math.max(1, clusterArea) > 0.9) return false;
  return getPixelBoundsOverlapRatio(bounds, cluster) >= 0.85;
}

function isPixelBoundsInside(bounds: PixelBounds, container: PixelBounds, tolerance = 0): boolean {
  return bounds.left >= container.left - tolerance
    && bounds.top >= container.top - tolerance
    && bounds.right <= container.right + tolerance
    && bounds.bottom <= container.bottom + tolerance;
}

function getPixelBoundsOverlapRatio(bounds: PixelBounds, container: PixelBounds): number {
  const left = Math.max(bounds.left, container.left);
  const top = Math.max(bounds.top, container.top);
  const right = Math.min(bounds.right, container.right);
  const bottom = Math.min(bounds.bottom, container.bottom);
  if (right <= left || bottom <= top) return 0;
  return ((right - left) * (bottom - top)) / Math.max(1, getPixelBoundsArea(bounds));
}

function getPixelBoundsArea(bounds: PixelBounds): number {
  return Math.max(0, bounds.width) * Math.max(0, bounds.height);
}

function unionPixelBounds(bounds: PixelBounds[]): PixelBounds | null {
  if (bounds.length === 0) return null;
  const left = Math.min(...bounds.map((item) => item.left));
  const top = Math.min(...bounds.map((item) => item.top));
  const right = Math.max(...bounds.map((item) => item.right));
  const bottom = Math.max(...bounds.map((item) => item.bottom));
  if (!Number.isFinite(left) || !Number.isFinite(top) || right <= left || bottom <= top) return null;
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

function intersectPixelBounds(bounds: PixelBounds, clip: PixelBounds): PixelBounds | null {
  const left = Math.max(bounds.left, clip.left);
  const top = Math.max(bounds.top, clip.top);
  const right = Math.min(bounds.right, clip.right);
  const bottom = Math.min(bounds.bottom, clip.bottom);
  if (right <= left || bottom <= top) return null;
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

function isPdfRasterVisualObject(object: fabric.FabricObject): boolean {
  const custom = object as fabric.FabricObject & {
    _pdfRasterBackground?: boolean;
    _pdfSourceRasterImage?: boolean;
    _svgObjectRole?: SvgObjectRole;
  };
  const role = normalizeSvgObjectRole(custom._svgObjectRole);
  return custom._pdfRasterBackground === true
    || custom._pdfSourceRasterImage === true
    || role === 'visual-raster'
    || role === 'raster-image';
}

function isPointerPassthroughSvgBackground(
  object: fabric.FabricObject,
  svgRole: SvgObjectRole,
  layerType: ParsedLayer['layerType'],
  pageWidth: number,
  pageHeight: number,
): boolean {
  if (svgRole !== 'editable-vector' || layerType !== 'shape') return false;
  const bounds = getFabricObjectPixelBounds(object);
  if (!bounds) return false;
  const pageArea = Math.max(1, pageWidth * pageHeight);
  const areaRatio = Math.max(0, bounds.width) * Math.max(0, bounds.height) / pageArea;
  if (areaRatio >= 0.45) return true;

  const coversMostWidth = bounds.left <= pageWidth * 0.08 && bounds.right >= pageWidth * 0.92;
  const coversMostHeight = bounds.top <= pageHeight * 0.08 && bounds.bottom >= pageHeight * 0.92;
  return (coversMostWidth && bounds.height >= pageHeight * 0.28)
    || (coversMostHeight && bounds.width >= pageWidth * 0.28);
}

function normalizePdfRasterRoleForSvgObject(object: fabric.FabricObject, pageWidth: number, pageHeight: number) {
  const custom = object as fabric.FabricObject & {
    _pdfRasterBackground?: boolean;
    _pdfSourceRasterImage?: boolean;
    _svgObjectRole?: SvgObjectRole;
  };
  const role = normalizeSvgObjectRole(custom._svgObjectRole);
  if (role === 'editable-raster' || role === 'decoration-texture-fill') {
    custom._pdfRasterBackground = false;
    custom._pdfSourceRasterImage = false;
    return;
  }
  if (custom._pdfRasterBackground !== true) return;
  const isFullPage = isFullPageSvgRasterObject(object, pageWidth, pageHeight);
  custom._pdfRasterBackground = isFullPage;
  custom._pdfSourceRasterImage = !isFullPage;
}

function isFullPageSvgRasterObject(object: fabric.FabricObject, pageWidth: number, pageHeight: number): boolean {
  const rect = typeof object.getBoundingRect === 'function'
    ? object.getBoundingRect()
    : { left: object.left || 0, top: object.top || 0, width: object.width || 0, height: object.height || 0 };
  const width = Math.max(1, Number(pageWidth || 1));
  const height = Math.max(1, Number(pageHeight || 1));
  const areaRatio = (Math.max(0, Number(rect.width || 0)) * Math.max(0, Number(rect.height || 0))) / (width * height);
  if (areaRatio >= 0.75) return true;
  const left = Number(rect.left || 0);
  const top = Number(rect.top || 0);
  const right = left + Number(rect.width || 0);
  const bottom = top + Number(rect.height || 0);
  const coversWidth = left <= width * 0.05 && right >= width * 0.95;
  const coversHeight = top <= height * 0.05 && bottom >= height * 0.95;
  return coversWidth && coversHeight;
}

function flattenSvgObjects(objects: fabric.FabricObject[]): fabric.FabricObject[] {
  const flattened: fabric.FabricObject[] = [];

  const visit = (object: fabric.FabricObject, inheritedName?: string) => {
    const custom = object as fabric.FabricObject & {
      _svgLayerName?: string;
      _pdfRasterBackground?: boolean;
      _pdfSourceRasterImage?: boolean;
      _pdfMaskArtifact?: boolean;
      _pdfTextPath?: boolean;
      _pdfTextGlyphId?: string;
      _pdfTextBounds?: PixelBounds;
      _pdfTextRunId?: string;
      _pdfTextGlyphIndex?: number;
      _pdfTextWritingMode?: string;
      _pdfTextMatrix?: number[];
      _pdfTextRotation?: number;
      _svgObjectRole?: SvgObjectRole;
      _svgDecorationClusterId?: string;
      removeAll?: () => fabric.FabricObject[];
      getObjects?: () => fabric.FabricObject[];
    };
    const children = typeof custom.getObjects === 'function' ? custom.getObjects() : [];
    const canFlattenGroup =
      object.type === 'group'
      && children.length > 0
      && !object.clipPath
      && custom._pdfRasterBackground !== true;

    if (!canFlattenGroup) {
      if (!custom._svgLayerName && inheritedName) custom._svgLayerName = inheritedName;
      flattened.push(object);
      return;
    }

    const groupMatrix = object.calcTransformMatrix();
    const groupName = custom._svgLayerName || inheritedName;
    children.forEach((child, index) => {
      const childCustom = child as fabric.FabricObject & {
        _svgLayerName?: string;
        _pdfRasterBackground?: boolean;
        _pdfSourceRasterImage?: boolean;
        _pdfMaskArtifact?: boolean;
        _pdfTextPath?: boolean;
        _pdfTextGlyphId?: string;
        _pdfTextBounds?: PixelBounds;
        _pdfTextRunId?: string;
        _pdfTextGlyphIndex?: number;
        _pdfTextWritingMode?: string;
        _pdfTextMatrix?: number[];
        _pdfTextRotation?: number;
        _svgObjectRole?: SvgObjectRole;
        _svgDecorationClusterId?: string;
      };
      if (!childCustom._svgLayerName && groupName) {
        childCustom._svgLayerName = `${groupName} / ${index + 1}`;
      }
      if (custom._pdfRasterBackground === true) {
        childCustom._pdfRasterBackground = true;
      }
      if (custom._pdfSourceRasterImage === true) {
        childCustom._pdfSourceRasterImage = true;
      }
      if (custom._pdfMaskArtifact === true) {
        childCustom._pdfMaskArtifact = true;
      }
      if (custom._pdfTextPath === true) {
        childCustom._pdfTextPath = true;
      }
      if (custom._pdfTextGlyphId && !childCustom._pdfTextGlyphId) {
        childCustom._pdfTextGlyphId = custom._pdfTextGlyphId;
      }
      if (custom._pdfTextBounds && !childCustom._pdfTextBounds) {
        childCustom._pdfTextBounds = custom._pdfTextBounds;
      }
      if (custom._pdfTextRunId && !childCustom._pdfTextRunId) {
        childCustom._pdfTextRunId = custom._pdfTextRunId;
      }
      if (custom._pdfTextGlyphIndex !== undefined && childCustom._pdfTextGlyphIndex === undefined) {
        childCustom._pdfTextGlyphIndex = custom._pdfTextGlyphIndex;
      }
      if (custom._pdfTextWritingMode && !childCustom._pdfTextWritingMode) {
        childCustom._pdfTextWritingMode = custom._pdfTextWritingMode;
      }
      if (custom._pdfTextMatrix && !childCustom._pdfTextMatrix) {
        childCustom._pdfTextMatrix = custom._pdfTextMatrix;
      }
      if (custom._pdfTextRotation !== undefined && childCustom._pdfTextRotation === undefined) {
        childCustom._pdfTextRotation = custom._pdfTextRotation;
      }
      if (custom._svgObjectRole && !childCustom._svgObjectRole) {
        childCustom._svgObjectRole = custom._svgObjectRole;
      }
      if (custom._svgDecorationClusterId && !childCustom._svgDecorationClusterId) {
        childCustom._svgDecorationClusterId = custom._svgDecorationClusterId;
      }
      sendSvgObjectToCanvasPlane(child, groupMatrix);
      rebaseSvgClipPathToCanvasPlane(child, groupMatrix);
      visit(child, childCustom._svgLayerName);
    });
    custom.removeAll?.();
  };

  objects.forEach((object) => visit(object));
  return flattened;
}

function sendSvgObjectToCanvasPlane(object: fabric.FabricObject, fromMatrix: number[]) {
  const sendObjectToPlane = (fabric.util as {
    sendObjectToPlane?: (target: fabric.FabricObject, from?: number[], to?: number[]) => unknown;
  }).sendObjectToPlane;
  if (typeof sendObjectToPlane === 'function') {
    sendObjectToPlane(object, fromMatrix);
    object.setCoords();
  }
}

function rebaseSvgClipPathToCanvasPlane(object: fabric.FabricObject, fromMatrix: number[]) {
  const target = object as fabric.FabricObject & {
    clipPath?: (fabric.FabricObject & { absolutePositioned?: boolean }) | undefined;
  };
  const clipPath = target.clipPath;
  if (!clipPath) return;
  sendSvgObjectToCanvasPlane(clipPath, fromMatrix);
  clipPath.absolutePositioned = true;
  clipPath.excludeFromExport = false;
  clipPath.objectCaching = false;
  clipPath.setCoords();
}

function applySvgTransformDeltaToObjectAndClipPath(
  object: fabric.FabricObject,
  delta: number[],
  utils: {
    applyTransformToObject: (target: fabric.FabricObject, transform: number[]) => void;
    multiplyTransformMatrices: (left: number[], right: number[]) => number[];
  },
) {
  const target = object as fabric.FabricObject & {
    clipPath?: (fabric.FabricObject & { absolutePositioned?: boolean }) | undefined;
  };
  const nextTransform = utils.multiplyTransformMatrices(delta, target.calcTransformMatrix());
  utils.applyTransformToObject(target, nextTransform);
  target.setCoords();

  const clipPath = target.clipPath;
  if (clipPath?.absolutePositioned === true) {
    const nextClipTransform = utils.multiplyTransformMatrices(delta, clipPath.calcTransformMatrix());
    utils.applyTransformToObject(clipPath, nextClipTransform);
    clipPath.dirty = true;
    clipPath.setCoords();
  }
  target.dirty = true;
}

function resolveSvgDimension(value: unknown, viewBoxValue: unknown, fallback: number): number {
  const parsed = parseSvgDimension(value);
  if (parsed > 0) return parsed;
  const viewBoxParsed = Number(viewBoxValue);
  if (Number.isFinite(viewBoxParsed) && viewBoxParsed > 0) return viewBoxParsed;
  return fallback;
}

function parseSvgDimension(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  const match = /^\s*([\d.]+)\s*(px|pt|mm|cm|in)?\s*$/i.exec(value);
  if (!match) return 0;
  const raw = Number(match[1]);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const unit = (match[2] || 'px').toLowerCase();
  if (unit === 'pt') return raw * (96 / 72);
  if (unit === 'mm') return raw * (96 / 25.4);
  if (unit === 'cm') return raw * (96 / 2.54);
  if (unit === 'in') return raw * 96;
  return raw;
}

function hasAiEditableMetadata(parseResult: Record<string, unknown> | undefined): boolean {
  if (!parseResult) return false;
  return Number(parseResult.aiParserVersion) >= CURRENT_AI_PARSER_VERSION;
}

function isPsdFileType(fileType?: string): boolean {
  return fileType === 'psd' || fileType === 'psb';
}

function usesRawPsdScene(file: DesignFile): boolean {
  return isPsdFileType(file.fileType)
    && Number(file.parseResult?.psdParserVersion) >= parserVersions.psd
    && file.parseResult?.rasterContentMode === 'raw';
}

function readPsdVisibilityOverrides(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'));
}

async function loadRawPsdLayerObjects(
  canvas: fabric.Canvas,
  layers: ParsedLayer[],
  resolveAssetUrl: (path: string) => string,
  missingFonts: string[],
  report: (items: PsdImportDiagnostic[]) => void,
  isCurrent = () => true,
): Promise<number> {
  let count = 0;
  for (const layer of collectPsdLeafLayers(layers).sort((left, right) => left.sortOrder - right.sortOrder)) {
    if (!isCurrent()) return count;
    const sourceKey = psdLayerSourceKey(layer);
    const shape = layer.layerType === 'shape' ? createPsdSimpleShape(layer) : null;
    if (!shape && !layer.imagePath) {
      if (layer.layerType !== 'adjustment') report([{
        code: 'layer-raster-missing', severity: 'warning', layerKey: sourceKey,
        layerName: layer.layerName, message: '此图层缺少图像内容，暂不能完整还原。',
      }]);
      continue;
    }
    try {
      const image = shape || await loadFabricImageFromUrl(resolveAssetUrl(layer.imagePath!), { crossOrigin: 'anonymous' });
      if (!isCurrent()) return count;
      const locked = layer.properties?.locked === true;
      image.set({
        ...(shape ? {} : { originX: 'left', originY: 'top', left: layer.x || 0, top: layer.y || 0,
          ...getLayerImageScale(layer, image as fabric.FabricImage) }), opacity: layer.opacity ?? 1,
        visible: layer.visible !== false, selectable: !locked, evented: !locked,
        objectCaching: false, globalCompositeOperation: 'source-over',
      });
      const source = image as fabric.FabricObject & Record<string, unknown>;
      source._layerId = layer.id;
      source._layerName = layer.layerName;
      source._layerType = layer.layerType;
      source._psdSourceKey = sourceKey;
      source._psdClipBaseKey = layer.properties?.psdClipBaseKey;
      source._psdOwnVisible = layer.visible !== false;
      source._psdSceneObject = true;
      source._psdMask = layer.properties?.psdMask;
      source._psdImagePath = layer.imagePath;
      source._psdLocked = locked;
      if (layer.layerType === 'text' && layer.textContent) {
        const style = layer.textStyle || {};
        const runs = Array.isArray(style.runs) ? style.runs as Array<Record<string, unknown>> : [];
        const dominant = runs.reduce<Record<string, unknown> | null>((best, run) =>
          Number(run.length || 0) > Number(best?.length || 0) ? run : best, null);
        const font = style.font as { name?: string } | undefined;
        const fontName = String(dominant?.fontName || font?.name || '');
        const missing = isTextLayerUsingMissingFont(layer, missingFonts);
        const scaleY = toFiniteNumber(style.textScaleY) || toFiniteNumber(style.textScale) || 1;
        const fontSize = (toFiniteNumber(style.fontSize) || toFiniteNumber(dominant?.fontSize) || 24) * scaleY;
        const fontFamily = missing ? MISSING_PSD_TEXT_EDIT_FONT_FAMILY : mapPsdFont(fontName);
        const vertical = isPsdVerticalTextLayer(layer, style, fontSize, layer.width || image.width, layer.height || image.height);
        const lineHeight = getPsdLineHeight(style, fontSize / scaleY, dominant);
        const bounds = { left: layer.x || 0, top: layer.y || 0, width: layer.width || image.width, height: layer.height || image.height };
        source._psdTextPreview = true;
        source._psdTextContent = layer.textContent;
        source._psdTextIsAreaText = !vertical && !/[\r\n]/.test(layer.textContent) && bounds.height > fontSize * lineHeight * 1.9;
        source._psdTextOrientation = vertical ? 'vertical' : undefined;
        source._psdFontName = fontName;
        source._psdMissingFont = missing;
        source._psdIgnorePreviewColor = true;
        source._psdLayerBounds = bounds;
        source._psdTextOptions = {
          fontFamily, fontSize, fontWeight: missing ? '400' : getPsdFontWeight(fontName, style),
          fontStyle: style.fauxItalic === true ? 'italic' : 'normal',
          fill: getDominantPsdRunFillColor(runs) || extractColor(style) || '#141413',
          opacity: layer.opacity ?? 1, lineHeight,
          textAlign: getPsdTextAlign(style), charSpacing: toFiniteNumber(style.tracking) || 0,
          psdBaseFontName: fontName, psdTextScaleY: scaleY, psdFileType: 'psd', runs,
          psdNativeTextStroke: buildPsdTextStrokeOptions({ ...style, effects: undefined }, scaleY),
        };
      }
      canvas.add(image);
      count++;
    } catch (error) {
      report([{
        code: 'layer-load-failed', severity: 'error', layerKey: sourceKey,
        layerName: layer.layerName, message: '图层图像加载失败，未能还原此图层。',
      }]);
      console.warn('[Editor] PSD layer load failed:', layer.layerName, error);
    }
  }
  return count;
}

async function loadPsdCompositeFallback(
  canvas: fabric.Canvas,
  file: DesignFile,
  resolveAssetUrl: (path: string) => string,
  report: (items: PsdImportDiagnostic[]) => void,
  isCurrent = () => true,
) {
  const path = file.parseResult?.compositePath;
  if (typeof path !== 'string' || !path) throw new Error('PSD 缺少可用图层和完整合成图，请重新解析。');
  const image = await loadFabricImageFromUrl(resolveAssetUrl(path), { crossOrigin: 'anonymous' });
  if (!isCurrent()) return;
  image.set({
    left: 0, top: 0, scaleX: (file.width || canvas.getWidth()) / (image.width || 1),
    scaleY: (file.height || canvas.getHeight()) / (image.height || 1), selectable: false, evented: false,
  });
  const source = image as fabric.FabricImage & Record<string, unknown>;
  source._layerName = '原文件完整外观';
  source._layerType = 'image';
  canvas.add(image);
  report([{ code: 'composite-fallback', severity: 'warning', message: '已保留原文件完整外观，原有图层暂不能单独修改。' }]);
}

function shouldSubmitClientParseAssist(file: DesignFile): boolean {
  if (file.sourceParseStatus === 'failed' || file.autoParseBlocked === true) return false;
  if (!canGenerateClientParseAssist(file.originalFilename || file.name, file.fileType)) return false;
  if (file.parseStatus === 'pending' || file.parseStatus === 'parsing') return true;
  if (file.fileType === 'ai') return file.parseStatus === 'completed' && !hasAiEditableMetadata(file.parseResult);
  if (file.fileType === 'pdf') return file.parseStatus === 'completed' && !hasPdfEditableMetadata(file.parseResult);
  return false;
}

function submitClientParseAssistOnce(fileId: number, file: DesignFile, submittedKeys: Set<string>) {
  if (!shouldSubmitClientParseAssist(file)) return;
  const key = `${fileId}:${file.updatedAt || file.parseStatus}`;
  if (submittedKeys.has(key)) return;
  submittedKeys.add(key);
  void (async () => {
    try {
      const blob = await downloadFileBlob(fileId);
      const localFile = new File([blob], file.originalFilename || file.name || `file-${fileId}.${file.fileType}`, {
        type: blob.type || (file.fileType === 'pdf' ? 'application/pdf' : 'application/octet-stream'),
      });
      const assist = await generateClientParseAssist(localFile);
      if (assist) await submitClientParseAssist(fileId, assist);
    } catch (error) {
      console.warn('[Editor] client parse assist skipped:', error);
    }
  })();
}

function hasPsdLayerEffectMetadata(parseResult: Record<string, unknown> | undefined): boolean {
  if (!parseResult) return false;
  return Number(parseResult.psdParserVersion) >= parserVersions.psd;
}

function hasPdfEditableMetadata(parseResult: Record<string, unknown> | undefined): boolean {
  if (!parseResult) return false;
  return Number(parseResult.pdfParserVersion) >= CURRENT_PDF_PARSER_VERSION || hasReliableLegacyEditablePdfMetadata(parseResult);
}

function hasReliableLegacyEditablePdfMetadata(parseResult: Record<string, unknown> | undefined): boolean {
  if (!parseResult || Number(parseResult.pdfParserVersion) !== 77 || parseResult.editableSvg !== true
    || parseResult.previewOnly === true || parseResult.svgVisualReliable === false || parseResult.svgOmitsRasterImages === true) return false;
  const pages = Array.isArray(parseResult.pages) ? parseResult.pages : [];
  return pages.length > 0 ? pages.every((page) => page && typeof page === 'object'
    && (page as Record<string, unknown>).previewOnly !== true && (page as Record<string, unknown>).svgVisualReliable !== false
    && typeof (page as Record<string, unknown>).svgPath === 'string' && Boolean((page as Record<string, unknown>).svgPath))
    : typeof parseResult.svgPath === 'string' && Boolean(parseResult.svgPath);
}

function isPreviewLayer(layer: ParsedLayer): boolean {
  const props = layer.properties as Record<string, unknown> | null;
  return isPdfAuxiliaryImageRole(props?.role)
    || isTextMetadataLayer(layer)
    || (layer.layerType === 'image' && !!layer.imagePath?.startsWith('thumbnails/'));
}

function isTextMetadataLayer(layer: ParsedLayer): boolean {
  const props = layer.properties as Record<string, unknown> | null | undefined;
  return layer.layerType === 'text'
    && (props?.role === 'text-metadata' || props?.editableAs === 'metadata');
}

function isSourceTextLayer(layer: ParsedLayer): boolean {
  const props = layer.properties as Record<string, unknown> | null | undefined;
  return layer.layerType === 'text'
    && props?.role === 'source-text'
    && props?.editableAs === 'text-on-demand';
}

function removePreviewLayers(layerTree: ParsedLayer[]): ParsedLayer[] {
  return layerTree
    .filter((layer) => !isPreviewLayer(layer))
    .map((layer) => ({
      ...layer,
      children: layer.children ? removePreviewLayers(layer.children) : undefined,
    }));
}

function foldSvgVectorAtomPanelLayers(layerTree: ParsedLayer[]): ParsedLayer[] {
  const atomLayers = layerTree.filter(isSvgVectorAtomLayer);
  if (atomLayers.length <= SVG_VECTOR_ATOM_FOLD_THRESHOLD) {
    return layerTree.map((layer) => ({
      ...layer,
      children: layer.children ? foldSvgVectorAtomPanelLayers(layer.children) : undefined,
    }));
  }

  const nonAtomLayers = layerTree
    .filter((layer) => !isSvgVectorAtomLayer(layer))
    .map((layer) => ({
      ...layer,
      children: layer.children ? foldSvgVectorAtomPanelLayers(layer.children) : undefined,
    }));
  const firstAtom = atomLayers[0];
  const sortOrders = atomLayers
    .map((layer) => Number(layer.sortOrder))
    .filter((value) => Number.isFinite(value));

  return [
    {
      id: SVG_VECTOR_SUMMARY_LAYER_ID,
      fileId: firstAtom?.fileId || 0,
      layerName: `视觉内容（${atomLayers.length} 个对象）`,
      layerType: 'group',
      parentLayerId: null,
      sortOrder: sortOrders.length ? Math.min(...sortOrders) : 0,
      visible: atomLayers.some((layer) => layer.visible !== false),
      opacity: 1,
      blendMode: 'normal',
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      properties: {
        role: SVG_VECTOR_SUMMARY_ROLE,
        panelOnly: true,
        atomCount: atomLayers.length,
      },
    },
    ...nonAtomLayers,
  ];
}

function isSvgVectorAtomLayer(layer: ParsedLayer): boolean {
  const props = layer.properties as Record<string, unknown> | null | undefined;
  return props?.role === SVG_VECTOR_ATOM_ROLE;
}

function parseSvgTextBoundsAttr(value: string | null): PixelBounds | null {
  if (!value) return null;
  const parts = value.split(',').map((item) => Number(item.trim()));
  if (parts.length < 4 || parts.some((item) => !Number.isFinite(item))) return null;
  const [left, top, width, height] = parts;
  if (width <= 0 || height <= 0) return null;
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

function parseSvgNumberList(value: string | null): number[] | null {
  if (!value) return null;
  const parts = value.split(',').map((item) => Number(item.trim()));
  if (parts.length === 0 || parts.some((item) => !Number.isFinite(item))) return null;
  return parts;
}

function filterImportedSvgOverlayLayers(
  layerTree: ParsedLayer[],
  options: { includeText: boolean; includeImages: boolean },
): ParsedLayer[] {
  const filtered: ParsedLayer[] = [];
  for (const layer of layerTree) {
    const children = layer.children
      ? filterImportedSvgOverlayLayers(layer.children, options)
      : undefined;
    const keepSelf = layer.layerType === 'text'
      ? options.includeText
      : layer.layerType === 'image'
        ? options.includeImages
        : true;
    if (!keepSelf && (!children || children.length === 0)) continue;
    filtered.push({
      ...layer,
      children,
    });
  }
  return filtered;
}

function createSourceTextActivationLayers(
  canvas: fabric.Canvas,
  textLayers: ParsedLayer[],
  resolvedFonts: Record<string, string> = {},
): ParsedLayer[] {
  const activationLayers: ParsedLayer[] = [];
  const historyCanvas = canvas as HistoryAwareCanvas;
  const previousSuspendHistory = historyCanvas.__suspendHistory;
  historyCanvas.__suspendHistory = true;
  try {
    textLayers.forEach((layer) => {
      if (!isSourceTextLayer(layer) || !layer.textContent) return;
      const props = layer.properties as Record<string, unknown> | null | undefined;
      const glyphIds = Array.isArray(props?.textPathGlyphIds)
        ? props.textPathGlyphIds.map((item) => String(item)).filter(Boolean)
        : [];
      const bounds = sourceTextLayerBounds(layer);
      if (!bounds) return;
      const rect = createPdfSourceTextActivationObject(layer, glyphIds, bounds, resolvedFonts);
      canvas.add(rect);
      linkPdfPageCompositeMember(canvas, rect, 'text-activation', bounds);
      activationLayers.push({
        ...layer,
        visible: layer.visible !== false,
      });
    });
  } finally {
    historyCanvas.__suspendHistory = previousSuspendHistory;
  }
  canvas.discardActiveObject();
  canvas.requestRenderAll();
  return activationLayers;
}

function createPdfSourceTextActivationObject(
  layer: ParsedLayer,
  glyphIds: string[],
  bounds: PixelBounds,
  resolvedFonts: Record<string, string> = {},
): PdfSourceTextActivationObject {
  const props = layer.properties as Record<string, unknown> | null | undefined;
  const rect = new fabric.Rect({
    originX: 'left',
    originY: 'top',
    left: bounds.left,
    top: bounds.top,
    width: Math.max(1, bounds.width),
    height: Math.max(1, bounds.height),
    fill: 'rgba(0,0,0,0)',
    stroke: 'rgba(0,0,0,0)',
    strokeWidth: 0,
    opacity: 1,
    selectable: true,
    evented: true,
    hasControls: false,
    lockMovementX: false,
    lockMovementY: false,
    lockScalingX: false,
    lockScalingY: false,
    lockRotation: false,
    objectCaching: false,
    perPixelTargetFind: false,
    targetFindTolerance: 8,
    hoverCursor: 'text',
    excludeFromExport: true,
  }) as PdfSourceTextActivationObject;
  rect._layerId = layer.id;
  rect._layerName = layer.layerName || layer.textContent?.slice(0, 60);
  rect._pdfSourceTextActivation = true;
  rect._pdfSourceTextGlyphIds = glyphIds;
  rect._pdfSourceTextOptions = {
    source: props?.textSource || props?.source,
    fontName: props?.fontName || (layer.textStyle as Record<string, unknown> | undefined)?.fontName,
    writingMode: props?.writingMode,
    textMatrix: props?.textMatrix,
    rotation: props?.rotation,
  };
  rect._psdTextContent = layer.textContent || '';
  rect._psdTextOrientation = isSourceTextLayerVertical(layer) ? 'vertical' : undefined;
  rect._psdTextOptions = buildSourceTextFabricOptions(layer, resolvedFonts);
  rect._psdLayerBounds = { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
  rect._psdPreviewVisualBounds = bounds;
  rect._psdFontName = String(props?.fontName || '');
  rect._psdLocked = false;
  return rect;
}

function sourceTextLayerBounds(layer: ParsedLayer): PixelBounds | null {
  const props = layer.properties as Record<string, unknown> | null | undefined;
  const pathBounds = props?.textPathBounds && typeof props.textPathBounds === 'object'
    ? props.textPathBounds as Record<string, unknown>
    : null;
  const left = toFiniteNumber(pathBounds?.left) ?? toFiniteNumber(layer.x) ?? 0;
  const top = toFiniteNumber(pathBounds?.top) ?? toFiniteNumber(layer.y) ?? 0;
  const width = positivePsdNumber(pathBounds?.width, positivePsdNumber(layer.width, 1));
  const height = positivePsdNumber(pathBounds?.height, positivePsdNumber(layer.height, 1));
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

function isSourceTextLayerVertical(layer: ParsedLayer): boolean {
  const props = layer.properties as Record<string, unknown> | null | undefined;
  const writingMode = String(props?.writingMode || '').toLowerCase();
  if (writingMode.includes('vertical') || writingMode === 'ttb') return true;

  const style = (layer.textStyle || {}) as Record<string, unknown>;
  const fontSize = positivePsdNumber(style.fontSize, positivePsdNumber(layer.height, 16));
  return isPsdVerticalTextLayer(
    layer,
    { textOrientation: writingMode },
    fontSize,
    positivePsdNumber(layer.width, 1),
    positivePsdNumber(layer.height, 1),
  );
}

function resolveSourceTextEditableFontFamily(
  sourceFontName: string,
  resolvedFonts: Record<string, string>,
): string {
  const rawName = String(sourceFontName || '').trim();
  if (!rawName) return DEFAULT_CN_EDIT_FONT_FAMILY;
  const uploadedFamily = resolvedFonts[rawName];
  if (uploadedFamily) {
    return quoteFontFamilyList([
      uploadedFamily,
      DEFAULT_CN_EDIT_FONT_NAME,
      'Microsoft YaHei',
      'Source Han Sans CN',
      'Noto Sans SC',
      'sans-serif',
    ]);
  }
  if (isKnownAvailableSystemFont(rawName)) return mapImportedTextFont(rawName);
  if (isProbablyUnavailablePdfSourceFont(rawName)) return DEFAULT_CN_EDIT_FONT_FAMILY;
  return DEFAULT_CN_EDIT_FONT_FAMILY;
}

function isKnownAvailableSystemFont(fontName: string): boolean {
  const normalized = normalizeFontName(fontName);
  return [
    'alibabapuhuiti3055regular',
    'alibabapuhuiti355regular',
    'alibabapuhuiti',
    'microsoftyahei',
    'msyh',
    'simsun',
    'simhei',
    'arial',
  ].some((name) => normalized.includes(name));
}

function isProbablyUnavailablePdfSourceFont(fontName: string): boolean {
  const raw = String(fontName || '').trim();
  const normalized = normalizeFontName(raw);
  return !raw
    || /^[A-Z]{6}\+/.test(raw)
    || /^g_d\d+_f\d+$/i.test(raw)
    || /^f\d+$/i.test(raw)
    || /^font\d+$/i.test(raw)
    || normalized.includes('subset');
}

function normalizeFontName(fontName: string): string {
  return String(fontName || '').toLowerCase().replace(/[\s"'_-]/g, '');
}

function buildSourceTextFabricOptions(layer: ParsedLayer, resolvedFonts: Record<string, string> = {}): Record<string, unknown> {
  const style = (layer.textStyle || {}) as Record<string, unknown>;
  const props = (layer.properties || {}) as Record<string, unknown>;
  const font = (style.font || {}) as Record<string, unknown>;
  const fontSize = positivePsdNumber(style.fontSize, positivePsdNumber(layer.height, 16));
  const fill = typeof style.fillColor === 'string' ? style.fillColor : '#141413';
  const sourceFontName = String(props.fontName || font.name || '');
  const editableFontFamily = resolveSourceTextEditableFontFamily(sourceFontName, resolvedFonts);
  const isVerticalText = isSourceTextLayerVertical(layer);
  const lineHeight = isVerticalText
    ? getPsdVerticalLineHeight(layer.textContent || '', fontSize, positivePsdNumber(layer.height, fontSize), 1.16, 0)
    : 1.16;
  return {
    fontSize,
    fill,
    fontFamily: editableFontFamily,
    fontWeight: '400',
    lineHeight,
    charSpacing: 0,
    textAlign: 'left',
    ...(isVerticalText ? { textOrientation: 'vertical' } : {}),
    width: positivePsdNumber(layer.width, Math.max(1, String(layer.textContent || '').length * fontSize * 0.5)),
    opacity: layer.opacity ?? 1,
    psdBaseFontName: sourceFontName,
    psdFileType: 'pdf-ai-source-text',
  };
}

// 从 PSD 文字样式中提取颜色
function psdClipBaseKey(layer: ParsedLayer): string {
  return String(layer.parentLayerId ?? 'root');
}

function isPsdClippingLayer(layer: ParsedLayer): boolean {
  const props = layer.properties as Record<string, unknown> | null | undefined;
  const clipping = props?.clipping;
  return clipping === true || clipping === 1 || clipping === 'true';
}

async function applyPsdLayerClipPath(
  object: fabric.FabricObject,
  layer: ParsedLayer,
  clipBases: PsdClipBaseMap,
): Promise<boolean> {
  if (!isPsdClippingLayer(layer)) return true;
  const base = clipBases.get(psdClipBaseKey(layer));
  if (!base) {
    console.warn('[Editor] PSD clipping layer skipped without base:', layer.layerName);
    return false;
  }

  try {
    const clipPath = await base.clone() as fabric.FabricObject & { absolutePositioned?: boolean };
    clipPath.set({
      left: base.left,
      top: base.top,
      scaleX: base.scaleX,
      scaleY: base.scaleY,
      angle: base.angle,
      opacity: 1,
      selectable: false,
      evented: false,
      objectCaching: false,
      globalCompositeOperation: 'source-over' as GlobalCompositeOperation,
    } as Partial<fabric.FabricObject>);
    clipPath.absolutePositioned = true;
    object.set({
      clipPath,
    } as Partial<fabric.FabricObject>);
    (object as fabric.FabricObject & { _psdClipping?: boolean })._psdClipping = true;
    return true;
  } catch (error) {
    console.warn('[Editor] PSD clipping layer failed:', layer.layerName, error);
    return false;
  }
}

function registerPsdClipBase(layer: ParsedLayer, object: fabric.FabricObject, clipBases: PsdClipBaseMap): void {
  if (isPsdClippingLayer(layer)) return;
  clipBases.set(psdClipBaseKey(layer), object);
}

function extractColor(style: Record<string, unknown> | null): string | null {
  if (!style) return null;
  if (typeof style.fillColor === 'string') return style.fillColor;
  if (style.fillColor && typeof style.fillColor === 'object') {
    const fc = style.fillColor as Record<string, number>;
    if (fc.r !== undefined) {
      // ag-psd 的 fillColor RGB 值范围是 0-255
      return `rgb(${Math.round(fc.r)},${Math.round(fc.g)},${Math.round(fc.b)})`;
    }
  }
  return null;
}

function extractCssColor(value: unknown, opacity?: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return null;
  const color = value as Record<string, unknown>;
  const readChannel = (primary: unknown, floatValue: unknown) => {
    const direct = toFiniteNumber(primary);
    if (direct !== null) return direct;
    const normalized = toFiniteNumber(floatValue);
    return normalized !== null ? normalized * 255 : null;
  };
  const r = readChannel(color.r, color.fr);
  const g = readChannel(color.g, color.fg);
  const b = readChannel(color.b, color.fb);
  if (r === null || g === null || b === null) return null;
  const explicitAlpha = toFiniteNumber(color.a) ?? toFiniteNumber(color.alpha);
  const rawOpacity = toFiniteNumber(opacity);
  const alpha = rawOpacity !== null
    ? (rawOpacity > 1 ? rawOpacity / 100 : rawOpacity)
    : explicitAlpha;
  const safeR = Math.max(0, Math.min(255, Math.round(r)));
  const safeG = Math.max(0, Math.min(255, Math.round(g)));
  const safeB = Math.max(0, Math.min(255, Math.round(b)));
  if (alpha !== null && alpha >= 0 && alpha < 1) {
    return `rgba(${safeR},${safeG},${safeB},${Math.max(0, Math.min(1, alpha))})`;
  }
  return `rgb(${safeR},${safeG},${safeB})`;
}

function getPsdTextSolidFillColor(style: Record<string, unknown> | null): string | null {
  const fx = style?.effects as Record<string, unknown> | undefined;
  const solidFill = fx?.solidFill as Record<string, unknown> | undefined;
  if (!solidFill) return null;
  const blendMode = String(solidFill.blendMode || 'normal').toLowerCase();
  if (blendMode !== 'normal' && blendMode !== 'source-over') return null;
  return extractCssColor(solidFill.color, solidFill.opacity);
}

function getPsdTextOrientation(style: Record<string, unknown> | null | undefined, fallback?: unknown): string {
  const raw = style?.textOrientation ?? style?.orientation ?? style?.Ornt ?? fallback ?? '';
  return String(raw || '').toLowerCase();
}

function isPsdVerticalTextStyle(style: Record<string, unknown> | null | undefined, fallback?: unknown): boolean {
  const orientation = getPsdTextOrientation(style, fallback);
  return orientation.includes('vertical') || orientation.includes('vrtc');
}

function isPsdVerticalTextOptions(options: Record<string, unknown>, fallback?: unknown): boolean {
  return isPsdVerticalTextStyle(options, fallback);
}

function formatPsdVerticalTextContent(content: string): string {
  const compact = String(content || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n+/g, '')
    .trim();
  return Array.from(compact).join('\n');
}

function getPsdVerticalLineHeight(
  content: string,
  fontSize: number,
  targetHeight: number,
  fallback: number,
  tracking = 0,
): number {
  const count = Array.from(String(content || '').replace(/\s+/g, '')).length;
  const trackingLineHeight = getPsdVerticalTrackingLineHeight(tracking);
  if (count <= 1 || fontSize <= 0 || targetHeight <= fontSize) {
    return trackingLineHeight ?? fallback;
  }
  const fabricLineBoxMultiplier = 1.13;
  const fitted = ((targetHeight / (fontSize * fabricLineBoxMultiplier)) - 1) / (count - 1);
  if (!Number.isFinite(fitted) || fitted <= 0) return trackingLineHeight ?? fallback;
  return clampRatio(fitted, 0.45, 1.6);
}

function getPsdVerticalTrackingLineHeight(tracking: number): number | null {
  const trackingRatio = Number.isFinite(tracking) ? tracking / 1000 : 0;
  const photoshopAdvanceRatio = 1 + trackingRatio;
  const fabricLineBoxMultiplier = 1.13;
  const lineHeight = photoshopAdvanceRatio / fabricLineBoxMultiplier;
  return Number.isFinite(lineHeight) && lineHeight > 0
    ? clampRatio(lineHeight, 0.45, 1.6)
    : null;
}

function isPsdVerticalTextLayer(
  layer: ParsedLayer,
  style: Record<string, unknown> | null,
  renderedFontSize: number,
  textBoxWidth: number,
  textBoxHeight: number,
): boolean {
  if (isPsdVerticalTextStyle(style)) return true;
  const content = String(layer.textContent || '');
  if (!content || /[\r\n]/.test(content)) return false;
  const compact = content.replace(/\s+/g, '');
  if (compact.length < 2 || !/[\u3400-\u9fff\uf900-\ufaff]/.test(compact)) return false;
  if (textBoxWidth <= 0 || textBoxHeight <= 0) return false;
  return textBoxHeight > textBoxWidth * 2.2
    && textBoxHeight > renderedFontSize * 2.4
    && textBoxWidth < renderedFontSize * 5;
}

function isPsdVerticalTextTarget(target: unknown): boolean {
  const textTarget = target as { _psdTextOrientation?: unknown; textOrientation?: unknown };
  return isPsdVerticalTextStyle(
    { textOrientation: textTarget.textOrientation },
    textTarget._psdTextOrientation,
  );
}

function shouldUsePsdRasterTextPreview(style: Record<string, unknown> | null, isAreaText: boolean, layer?: ParsedLayer): boolean {
  if (layer?.properties?.psdMask || layer?.properties?.maskBakedIntoRaster === true || Number(layer?.properties?.inheritedGroupMaskCount) > 0) return true;
  if (isAreaText) return true;
  const effects = style?.effects as Record<string, unknown> | undefined;
  if (!effects) return false;
  return Boolean(
    getPsdEffect(effects, 'stroke')
    || getPsdEffect(effects, 'dropShadow')
    || getPsdEffect(effects, 'innerShadow')
    || getPsdEffect(effects, 'outerGlow')
    || getPsdEffect(effects, 'innerGlow')
    || getPsdEffect(effects, 'bevel')
    || getPsdEffect(effects, 'satin')
    || getPsdEffect(effects, 'solidFill'),
  );
}

function buildPsdTextStrokeOptions(
  style: Record<string, unknown> | null,
  textScale: number,
): Record<string, unknown> {
  if (!style) return {};
  let strokeOptions: Record<string, unknown> = {};

  if (style.strokeFlag === true) {
    const strokeColor = extractCssColor(style.strokeColor);
    const outlineWidth = toFiniteNumber(style.outlineWidth);
    if (strokeColor && outlineWidth !== null && outlineWidth > 0) {
      strokeOptions = {
        stroke: strokeColor,
        strokeWidth: Math.max(0.5, outlineWidth * textScale),
        paintFirst: 'stroke',
      };
    }
  }

  const fx = style.effects as Record<string, unknown> | undefined;
  const fxStroke = fx?.stroke as Record<string, unknown> | undefined;
  if (fxStroke) {
    const strokeColor = extractCssColor(fxStroke.color, fxStroke.opacity);
    const strokeWidth = toFiniteNumber(fxStroke.size);
    if (strokeColor && strokeWidth !== null && strokeWidth > 0) {
      strokeOptions = {
        stroke: strokeColor,
        strokeWidth: Math.max(0.5, strokeWidth),
        paintFirst: 'stroke',
      };
    }
  }

  return strokeOptions;
}

type PsdAlphaShadow = {
  color: string;
  blur: number;
  offsetX: number;
  offsetY: number;
};

function getPsdEffect(effects: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | null {
  const value = effects?.[key];
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function getPsdEffectShadow(effects: Record<string, unknown> | null | undefined, key: string): PsdAlphaShadow | null {
  const effect = getPsdEffect(effects, key);
  if (!effect) return null;
  const color = extractCssColor(effect.color, effect.opacity);
  if (!color) return null;
  const angle = ((toFiniteNumber(effect.angle) ?? 90) * Math.PI) / 180;
  const distance = toFiniteNumber(effect.distance) ?? 0;
  const size = Math.max(0, toFiniteNumber(effect.size) ?? 0);
  return {
    color,
    blur: size,
    offsetX: Math.cos(angle) * distance,
    offsetY: Math.sin(angle) * distance,
  };
}

function getPsdEffectGlow(effects: Record<string, unknown> | null | undefined, key: string): PsdAlphaShadow | null {
  const effect = getPsdEffect(effects, key);
  if (!effect) return null;
  const color = extractCssColor(effect.color, effect.opacity);
  if (!color) return null;
  return {
    color,
    blur: Math.max(0, toFiniteNumber(effect.size) ?? 0),
    offsetX: 0,
    offsetY: 0,
  };
}

function getPsdEffectBevelShadows(effects: Record<string, unknown> | null | undefined): PsdAlphaShadow[] {
  const effect = getPsdEffect(effects, 'bevel');
  if (!effect) return [];
  const size = Math.max(0, toFiniteNumber(effect.size) ?? 0);
  const distance = Math.max(1, size || 1);
  const blur = Math.max(0, size / 2);
  const angle = ((toFiniteNumber(effect.angle) ?? 90) * Math.PI) / 180;
  const offsetX = Math.cos(angle) * distance;
  const offsetY = Math.sin(angle) * distance;
  const highlight = extractCssColor(effect.highlightColor, effect.highlightOpacity);
  const shadow = extractCssColor(effect.shadowColor, effect.shadowOpacity);
  return [
    highlight ? { color: highlight, blur, offsetX: -offsetX, offsetY: -offsetY } : null,
    shadow ? { color: shadow, blur, offsetX, offsetY } : null,
  ].filter(Boolean) as PsdAlphaShadow[];
}

function buildPsdAlphaShadows(effects: Record<string, unknown> | null | undefined): PsdAlphaShadow[] {
  return [
    getPsdEffectGlow(effects, 'outerGlow'),
    getPsdEffectShadow(effects, 'dropShadow'),
    getPsdEffectShadow(effects, 'innerShadow'),
    getPsdEffectShadow(effects, 'satin'),
    ...getPsdEffectBevelShadows(effects),
  ].filter(Boolean) as PsdAlphaShadow[];
}

function buildPsdFabricShadow(effects: Record<string, unknown> | null | undefined): fabric.Shadow | undefined {
  const shadow = getPsdEffectShadow(effects, 'dropShadow') || getPsdEffectGlow(effects, 'outerGlow');
  if (!shadow) return undefined;
  return new fabric.Shadow({
    color: shadow.color,
    blur: shadow.blur,
    offsetX: Math.round(shadow.offsetX),
    offsetY: Math.round(shadow.offsetY),
  });
}

function serializePsdTextShadow(shadow: fabric.Shadow) {
  const source = shadow as fabric.Shadow & {
    affectStroke?: boolean;
    nonScaling?: boolean;
  };
  return {
    color: source.color,
    blur: source.blur,
    offsetX: source.offsetX,
    offsetY: source.offsetY,
    affectStroke: source.affectStroke,
    nonScaling: source.nonScaling,
  };
}

function revivePsdTextShadow(value: unknown): fabric.Shadow | undefined {
  if (!value) return undefined;
  if (value instanceof fabric.Shadow) return value;
  const source = value as Record<string, unknown>;
  const color = typeof source.color === 'string' ? source.color : '';
  if (!color) return undefined;
  return new fabric.Shadow({
    color,
    blur: Math.max(0, toFiniteNumber(source.blur) ?? 0),
    offsetX: Math.round(toFiniteNumber(source.offsetX) ?? 0),
    offsetY: Math.round(toFiniteNumber(source.offsetY) ?? 0),
    affectStroke: source.affectStroke === true,
    nonScaling: source.nonScaling === true,
  });
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clampRatio(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getDominantPsdTextRun(style: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  const runs = style?.runs;
  if (!Array.isArray(runs) || runs.length === 0) return null;
  return runs.reduce<Record<string, unknown> | null>((best, current) => {
    const currentRun = current as Record<string, unknown>;
    if (!best) return currentRun;
    return (toFiniteNumber(currentRun.length) || 0) > (toFiniteNumber(best.length) || 0)
      ? currentRun
      : best;
  }, null);
}

function getPsdLineHeight(
  style: Record<string, unknown> | null,
  rawFontSize: number,
  dominantRun?: Record<string, unknown> | null,
): number {
  // PSD 的「真正 leading」存放优先级（实测来自 ag-psd 给的 PSD 文字数据）：
  //
  //   1) paragraphStyle.autoLeading（PSD 默认 1.2，绝大多数文字层用这个 ↑ 真实生效的）
  //   2) style.leading（旧版本字段、或历史残留；很多 PSD 里这个值跟实际渲染的行距完全不沾边
  //      —— 比如此项目里「鲜果上新啦」style.leading=19.48 而 fontSize=52.80，比例 0.37 是
  //      不可能渲染成视觉合理行距的；源编辑器忽略这个字段并采用 autoLeading 1.2）
  //   3) PSD / Photoshop 默认 auto leading 1.2
  //
  // 之前我直接用 style.leading / fontSize 并 clamp 到 0.85，把整段文字行距压扁了。
  const leading = toFiniteNumber(dominantRun?.leading) ?? toFiniteNumber(style?.leading);
  if (leading !== null && leading > 0 && rawFontSize > 0) {
    const ratio = leading / rawFontSize;
    // 只有在合理范围内才认显式 leading，过小的值通常是 PSD 历史残留，应忽略
    if (ratio > 0.65 && ratio < 4) return ratio;
  }
  const paragraphStyle = style?.paragraphStyle as Record<string, unknown> | undefined;
  const autoLeading = toFiniteNumber(paragraphStyle?.autoLeading);
  if (autoLeading !== null && autoLeading > 0.5 && autoLeading < 3) {
    return autoLeading;
  }
  return 1.2;
}

function getPsdManualLineHeight(
  content: string,
  renderedFontSize: number,
  targetHeight: number,
  rawLineHeight: number,
): number {
  const lineCount = String(content || '').split(/\r\n|\r|\n/).length;
  if (lineCount <= 1 || renderedFontSize <= 0 || targetHeight <= 0) return rawLineHeight;

  const fabricLineBoxMultiplier = 1.13;
  const fitted = ((targetHeight / (renderedFontSize * fabricLineBoxMultiplier)) - 1) / (lineCount - 1);
  if (!Number.isFinite(fitted) || fitted <= 0) return rawLineHeight;

  // Exact height-fitting makes Fabric text look tighter than the PSD preview.
  // Add a small cushion, but cap oversized Photoshop leading that would visibly
  // stretch manual newline text after converting it to editable text.
  const visualLineHeight = clampRatio(fitted + 0.12, 1.1, 2);
  return Math.min(rawLineHeight, visualLineHeight);
}

function getPsdTextAlign(style: Record<string, unknown> | null): fabric.Textbox['textAlign'] {
  const paragraph = style?.paragraphStyle as Record<string, unknown> | undefined;
  const justification = String(paragraph?.justification || '').toLowerCase();
  if (justification.includes('center')) return 'center';
  if (justification.includes('right')) return 'right';
  if (justification.includes('justify')) return 'justify';
  return 'left';
}

/**
 * 把 PSD 的「字体名」翻译成 CSS font-weight。
 *
 * 重要：中文字体里的「黑体」字面量（中黑 / 准黑 / 细黑 / 粗黑 / 特黑）描述的是字体本身
 * 的笔画粗细级别，不是 CSS 的 font-weight 应该叫的值。把「方正兰亭中黑」直接映射到
 * font-weight: 700 是错的——
 *   1) 如果对应字体已上传到 /api/v1/fonts，它的 @font-face 里通常声明 font-weight: normal，
 *      请求 700 找不到匹配，浏览器会触发合成 faux-bold（结果比真实字体更粗一档）。
 *   2) 如果对应字体没上传，浏览器回退到系统 sans-serif 700，比真字体更粗。
 *
 * 所以这里只在三种情况下才返回 700：
 *   a) 文字图层显式 fauxBold（PS 里点了「假粗体」按钮）；
 *   b) 字体名直白带 bold / heavy / black / extra；
 *   c) 字体名是真正的「粗黑 / 特黑」级别（CuHei / TeHei / FZLTCH / FZLTTH 等）。
 *
 * 「中黑 / 准黑」走 400（regular），交给真实字体文件本身表达粗细；「细黑」走 300（light）。
 */
function getPsdFontWeight(fontName: string, style: Record<string, unknown> | null): string {
  const lower = (fontName || '').toLowerCase();
  if (style?.fauxBold === true) return '700';
  if (lower.includes('bold') || lower.includes('heavy') || lower.includes('black') || lower.includes('extrabold')) {
    return '700';
  }
  // 真正的粗黑 / 特黑（CSS bold/heavy 量级）
  if (lower.includes('fzltch') || lower.includes('fzltth') || lower.includes('cuhei') || lower.includes('tehei')) {
    return '700';
  }
  // 中黑 / ZhongHei 是字体家族自己的字面，不是 CSS font-weight。
  if (lower.includes('fzltzhk') || lower.includes('zhonghei')) return '400';
  // 准黑 / Regular
  if (lower.includes('fzltzh') || lower.includes('zhunhei')) return '400';
  // 细黑 / Light
  if (lower.includes('fzltxih') || lower.includes('xihei')) return '300';
  return '400';
}

type PixelBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

async function fitTextToPsdBounds(
  canvas: fabric.Canvas,
  text: fabric.FabricObject,
  layer: ParsedLayer,
  isAreaText: boolean,
  options: { preservePosition?: boolean } = {},
) {
  const targetWidth = toFiniteNumber(layer.width);
  const targetHeight = toFiniteNumber(layer.height);
  const targetLeft = toFiniteNumber(layer.x) ?? 0;
  const targetTop = toFiniteNumber(layer.y) ?? 0;
  if (!targetWidth || !targetHeight || targetWidth <= 0 || targetHeight <= 0) return;

  let visualBounds = await measureObjectPixelBounds(canvas, text);
  if (!visualBounds) return;

  if (!isAreaText && !isPsdVerticalTextTarget(text)) {
    // 宽度比例用 fabric 内部 text.width（即 [Editor::TEXT] 日志里的 width），
    // 而不是 offscreen 像素扫的 visualBounds.width —— 后者会把抗锯齿/描边/阴影
    // 都算进去，在 DIN-Bold 这种带 charSpacing 负值的样本上偏大几个百分点，
    // 反而把 ratio 算小、scaleX 卡到 minScale 让 99 显窄。
    const fabricUnscaledWidth = toFiniteNumber((text as fabric.IText).width) ?? 0;
    const currentScaleX = toFiniteNumber(text.scaleX) || 1;
    const currentRenderedWidth = fabricUnscaledWidth * currentScaleX;

    if (
      currentRenderedWidth > 0
      && !isDinNumericTextTarget(text)
      && !isMissingFontTextTarget(text)
    ) {
      const ratio = targetWidth / currentRenderedWidth;
      if (ratio < 0.985 || ratio > 1.015) {
        const minScale = 0.86;
        const maxScale = 1.24;
        const safeRatio = clampRatio(ratio, minScale, maxScale);
        const nextScaleX = currentScaleX * safeRatio;
        // 任何文本图层做 fit 时都打一行——把 99 字体改成黑体后 isDin=false，
        // 走的是非 DIN 带 [0.86, 1.24]，没有这个日志就完全看不到。
        console.log('[text-fit]', {
          textContent: (text as fabric.IText).text,
          fontFamily: (text as fabric.IText).fontFamily,
          fabricUnscaledWidth,
          currentScaleX,
          currentRenderedWidth,
          targetWidth,
          band: [minScale, maxScale],
          ratio,
          safeRatio,
          nextScaleX,
          clamped: Math.abs(ratio - safeRatio) > 0.001,
        });
        if (Math.abs(nextScaleX - currentScaleX) > 0.001) {
          text.set({ scaleX: nextScaleX });
          (text as fabric.FabricObject & { _psdAutoScaleX?: number })._psdAutoScaleX = nextScaleX;
          text.setCoords();
          visualBounds = await measureObjectPixelBounds(canvas, text);
          if (!visualBounds) return;
        }
      }
    }
  }

  if (options.preservePosition) return;

  const dx = targetLeft - visualBounds.left;
  const dy = targetTop - visualBounds.top;
  if (Math.abs(dx) > 0.2 || Math.abs(dy) > 0.2) {
    text.set({
      left: (toFiniteNumber(text.left) || 0) + dx,
      top: (toFiniteNumber(text.top) || 0) + dy,
    });
    text.setCoords();
  }
}

function isDinNumericTextTarget(target: unknown): boolean {
  const textTarget = target as {
    _psdFontName?: unknown;
    fontFamily?: unknown;
    text?: unknown;
  };
  const fontName = String(textTarget._psdFontName || textTarget.fontFamily || '');
  const text = String(textTarget.text || '').trim();
  return /din/i.test(fontName) && /^\d+$/.test(text);
}

function isDinNumericTextLayer(fontName: string, textContent?: string): boolean {
  return /din/i.test(fontName) && /^\d+$/.test(String(textContent || '').trim());
}

function isMissingFontTextTarget(target: unknown): boolean {
  return (target as { _psdMissingFont?: unknown })._psdMissingFont === true;
}

/**
 * 已保存画布加载之后，对所有 DIN 数字图层重测宽度并下补偿 scaleX。
 *
 * 背景：自定义字体（DINPro-Bold 等）在浏览器实际可用之前，fabric 用
 * fallback 字体测得的宽度可能与最终渲染差很多；保存到 JSON 里 width 字段
 * 就被冻住了。重新加载时即便字体已经下载好，scaleX 仍然按当时错误的
 * 宽度算。这里在字体真正可测后重做一遍 fit，把 99 这类数字拉回 PSD bbox。
 */
async function refitDinTextsFromSavedState(
  canvas: fabric.Canvas,
  layers: ParsedLayer[],
): Promise<void> {
  if ((canvas as PsdImportCanvas).__psdScene) return;
  const layerById = new Map<string | number, ParsedLayer>();
  for (const layer of layers) {
    layerById.set(layer.id, layer);
    layerById.set(String(layer.id), layer);
  }
  const dinObjects = canvas.getObjects().filter(isDinNumericTextTarget);
  if (dinObjects.length === 0) return;

  for (const obj of dinObjects) {
    const layerId = (obj as fabric.FabricObject & { _layerId?: string | number })._layerId;
    if (layerId === undefined || layerId === null) continue;
    const layer = layerById.get(layerId);
    if (!layer) continue;

    // 等真实字体可被测量
    const target = obj as fabric.IText & {
      _psdAutoScaleX?: number;
      initDimensions?: () => void;
    };
    const fontFamily = String(target.fontFamily || '');
    const fontSize = Number(target.fontSize) || 12;
    const fontWeight = String(target.fontWeight || '400');
    await waitForCanvasFont(fontFamily, fontSize, fontWeight);

    // 重置 scaleX 让 fitTextToPsdBounds 拿到自然宽度，再统一下补偿
    target.set?.({ scaleX: 1 });
    target._psdAutoScaleX = undefined;
    try { target.initDimensions?.(); } catch { /* ignore */ }
    target.setCoords();

    await fitTextToPsdBounds(canvas, target as fabric.FabricObject, layer, false);
  }
}

async function measureObjectPixelBounds(
  canvas: fabric.Canvas,
  object: fabric.FabricObject,
): Promise<PixelBounds | null> {
  if (typeof document === 'undefined') return null;
  const width = Math.max(1, Math.ceil(canvas.getWidth()));
  const height = Math.max(1, Math.ceil(canvas.getHeight()));
  const offscreen = document.createElement('canvas');
  offscreen.width = width;
  offscreen.height = height;

  const clone = await object.clone() as fabric.FabricObject;
  clone.set({
    selectable: false,
    evented: false,
    objectCaching: false,
    opacity: 1,
    globalCompositeOperation: 'source-over' as GlobalCompositeOperation,
  });

  const staticCanvas = new fabric.StaticCanvas(offscreen, {
    width,
    height,
    renderOnAddRemove: false,
    enableRetinaScaling: false,
  });
  try {
    staticCanvas.add(clone);
    staticCanvas.renderAll();
    const ctx = offscreen.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    const data = ctx.getImageData(0, 0, width, height).data;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y++) {
      const row = y * width * 4;
      for (let x = 0; x < width; x++) {
        if (data[row + x * 4 + 3] <= 8) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < minX || maxY < minY) return null;
    return {
      left: minX,
      top: minY,
      right: maxX + 1,
      bottom: maxY + 1,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    };
  } finally {
    staticCanvas.dispose();
  }
}

/**
 * 把 PSD 解析出来的 styleRuns 按字符区间逐段下到 fabric 文本对象上。
 * 调用时机要求：必须在 canvas.add(text) 之后（fabric v6 未挂载状态下做这件事会抛错）。
 *
 * 本函数会被调用两次：
 *   1) preventSpuriousWrap 之前 —— 让 fabric 测得正确的逐行自然宽度
 *   2) preventSpuriousWrap 之后 —— 因为调整 textbox.width 会触发 wrap 重映射，
 *      第一次设的样式（典型如「105」上的 linethrough）会被错位，必须重打。
 */
function applyRunStylesToText(
  text: fabric.FabricObject,
  layer: ParsedLayer,
  psdRuns: Array<Record<string, unknown>>,
  baseFontName: string,
  textScaleY: number,
  fileType?: string,
  forcedFill?: string | null,
  options: { verticalText?: boolean } = {},
): void {
  if (!psdRuns || psdRuns.length === 0) return;
  const total = (layer.textContent || '').length;
  if (total === 0) return;
  const importedVectorText = isImportedVectorType(fileType);
  try {
    for (const run of psdRuns) {
      const from = Math.max(0, toFiniteNumber(run.from) || 0);
      const length = Math.max(0, toFiniteNumber(run.length) || 0);
      const to = Math.min(total, from + length);
      if (to <= from) continue;
      const charStyle: Record<string, unknown> = {};
      const runFontSize = toFiniteNumber(run.fontSize);
      if (runFontSize !== null && runFontSize > 0) {
        charStyle.fontSize = runFontSize * textScaleY;
      }
      const fc = run.fillColor as { r?: number; g?: number; b?: number } | undefined;
      if (fc && typeof fc.r === 'number') {
        charStyle.fill = `rgb(${Math.round(fc.r)},${Math.round(fc.g!)},${Math.round(fc.b!)})`;
      }
      if (forcedFill) charStyle.fill = forcedFill;
      if (run.strokeFlag === true) {
        const strokeColor = extractCssColor(run.strokeColor);
        const outlineWidth = toFiniteNumber(run.outlineWidth);
        if (strokeColor && outlineWidth !== null && outlineWidth > 0) {
          charStyle.stroke = strokeColor;
          charStyle.strokeWidth = Math.max(0.5, outlineWidth * textScaleY);
          charStyle.paintFirst = 'stroke';
        }
      }
      if (run.underline === true) charStyle.underline = true;
      if (run.strikethrough === true) charStyle.linethrough = true;
      if (!importedVectorText && run.fauxBold === true) charStyle.fontWeight = '700';
      if (run.fauxItalic === true) charStyle.fontStyle = 'italic';
      const runTracking = toFiniteNumber(run.tracking);
      if (runTracking !== null) charStyle.charSpacing = Math.round(runTracking);
      const runFontName = typeof run.fontName === 'string' ? run.fontName : '';
      if (runFontName && runFontName !== baseFontName) {
        if (importedVectorText) {
          charStyle.fontFamily = MISSING_PSD_TEXT_EDIT_FONT_FAMILY;
          charStyle.fontWeight = '400';
        } else {
          charStyle.fontFamily = mapPsdFont(runFontName);
          charStyle.fontWeight = getPsdFontWeight(runFontName, {
            fauxBold: run.fauxBold === true,
          });
        }
      }
      if (Object.keys(charStyle).length > 0) {
        try {
          if (options.verticalText) {
            for (let charIndex = from; charIndex < to; charIndex++) {
              const displayIndex = charIndex * 2;
              (text as fabric.IText).setSelectionStyles(charStyle, displayIndex, displayIndex + 1);
            }
          } else {
            (text as fabric.IText).setSelectionStyles(charStyle, from, to);
          }
        } catch (selErr) {
          console.warn('[Editor] setSelectionStyles 失败（忽略）:', selErr);
        }
      }
    }
    if (text instanceof fabric.Textbox) {
      try {
        text.initDimensions();
      } catch (dimErr) {
        console.warn('[Editor] Textbox initDimensions 失败（忽略）:', dimErr);
      }
    }
    try {
      text.setCoords();
    } catch {
      // ignore
    }
  } catch (runErr) {
    console.warn('[Editor] 多 run 字符级样式应用失败（忽略，保留基础渲染）:', runErr);
  }
}

/**
 * 修正 fabric.Textbox 因字体回退导致的「比 PSD 多折一行」问题。
 *
 * 流程：
 *   1) 先按当前宽度 layout，读出 fabric 实际折行数 wrapped。
 *   2) 用 \r\n / \n / \r 切 textContent 计算 PSD 真正想要的逻辑行数 intended。
 *   3) 若 wrapped > intended，把 textbox.width 设成超大值再 layout 一次，
 *      取出每条逻辑行的「自然宽度」，回填一个 max(自然宽度 + 2, 原始宽度)
 *      作为最终 textbox 宽度，再 layout 一次。
 *
 * 这样既不扭曲字形（避免使用 scaleX），又能让「(单果225g以上)105」这种含数字
 * 与 CJK 混排的字符串保持原本的整体行型，不会因为差几个像素被强制拆行。
 */
function preventSpuriousWrap(
  text: fabric.FabricObject,
  layer: ParsedLayer,
  originalWidth: number,
): void {
  if (!(text instanceof fabric.Textbox)) return;
  preventTextboxManualLineWrap(text, layer.textContent || '', originalWidth);
}

function preventTextboxManualLineWrap(
  text: fabric.Textbox,
  content: string,
  originalWidth: number,
): void {
  if (!Number.isFinite(originalWidth) || originalWidth <= 0) return;
  const internal = text as unknown as {
    _textLines?: unknown[];
    getLineWidth?: (i: number) => number;
    initDimensions?: () => void;
  };
  try {
    internal.initDimensions?.();
    const intended = String(content || '').split(/\r\n|\r|\n/).length;
    const wrapped = internal._textLines?.length ?? 1;
    if (wrapped <= intended) {
      text.setCoords();
      return;
    }
    // 用足够大的宽度重新 layout，得到「自然行宽」
    const huge = Math.max(originalWidth * 6, 100000);
    text.set({ width: huge });
    internal.initDimensions?.();
    let maxLineWidth = 0;
    const lines = internal._textLines ?? [];
    for (let i = 0; i < lines.length; i++) {
      const w = internal.getLineWidth?.(i) ?? 0;
      if (w > maxLineWidth) maxLineWidth = w;
    }
    const expanded = Math.ceil(Math.max(maxLineWidth + 2, originalWidth));
    text.set({ width: expanded });
    internal.initDimensions?.();
    text.setCoords();
  } catch (e) {
    console.warn('[Editor] preventSpuriousWrap 失败（忽略）:', e);
    try {
      text.set({ width: originalWidth });
      internal.initDimensions?.();
      text.setCoords();
    } catch {
      // ignore
    }
  }
}

const canvasFontLoadCache = new Map<string, Promise<boolean>>();
// fontFamily 串 -> 真正在浏览器里被识别到的家族名（document.fonts.check 命中的那个）。
// 用于事后判断「文字渲染时实际拿到的是哪个字体」，方便 UI 上提示哪些 PSD 字体没装。
const resolvedFontCache = new Map<string, string | null>();

/**
 * 等待 fontFamily 中第一个能加载到的字体真正可用（document.fonts.check 通过），
 * 而不是简单 race 一个 900ms 超时然后默认 fallback。
 *
 * 返回值：是否拿到了非系统 fallback 的字体（true = 自定义字体加载成功）。
 * 副作用：把第一个命中的具体 family 名缓存到 resolvedFontCache 里。
 */
async function waitForCanvasFont(
  fontFamily: string,
  fontSize: number,
  fontWeight: string,
): Promise<boolean> {
  if (typeof document === 'undefined' || !document.fonts) return false;
  // 渲染前一定先等自定义字体 CSS 加载完，否则一上来 check 就全 false
  await ensureCustomFontsLoaded();

  const key = `${fontWeight}|${Math.round(fontSize)}|${fontFamily}`;
  if (!canvasFontLoadCache.has(key)) {
    const fontShorthand = `${fontWeight} ${Math.max(1, Math.round(fontSize))}px ${fontFamily}`;
    const loadPromise = (async () => {
      try {
        // 让浏览器去真正下载字体（如果有匹配 @font-face）
        await Promise.race([
          (document.fonts as FontFaceSet).load(fontShorthand),
          new Promise((resolve) => window.setTimeout(resolve, 1500)),
        ]);
      } catch {
        // ignore
      }
      // 把 fontFamily 拆成单个 family，逐个用 check 判断哪个真的可用
      const families = parseFontFamilies(fontFamily);
      for (const family of families) {
        if (family === 'sans-serif' || family === 'serif' || family === 'monospace') {
          resolvedFontCache.set(fontFamily, family);
          return false; // 退到了通用 fallback
        }
        const checkSpec = `${fontWeight} ${Math.max(1, Math.round(fontSize))}px "${family.replace(/"/g, '')}"`;
        try {
          if ((document.fonts as FontFaceSet).check(checkSpec)) {
            resolvedFontCache.set(fontFamily, family);
            return true;
          }
        } catch {
          // ignore — 某些 family 名包含 CSS 不允许的字符会抛
        }
      }
      resolvedFontCache.set(fontFamily, null);
      return false;
    })();
    canvasFontLoadCache.set(key, loadPromise);
  }
  return (await canvasFontLoadCache.get(key)) ?? false;
}

function parseFontFamilies(fontFamily: string): string[] {
  // 简单拆解 "FamilyA", "FamilyB", sans-serif —— 不处理嵌套引号等极端情况
  return fontFamily.split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
}

// 实测当前 fontFamily / fontSize / fontWeight 在浏览器里加载到的字体的 ascent（像素值）。
// 用 canvas TextMetrics 取 fontBoundingBoxAscent；旧浏览器没有这个字段时回退到 actualBoundingBoxAscent；
// 实在拿不到就近似 fontSize × 0.82。
// 缓存结果，每个 (family|size|weight) 三元组只测一次。
const fontAscentCache = new Map<string, number>();
function measureFontAscentPx(fontFamily: string, fontSize: number, fontWeight: string): number {
  if (!fontSize || !Number.isFinite(fontSize) || fontSize <= 0) return 0;
  const key = `${fontWeight}|${Math.round(fontSize)}|${fontFamily}`;
  const cached = fontAscentCache.get(key);
  if (cached !== undefined) return cached;
  let result = fontSize * 0.82;
  try {
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.font = `${fontWeight} ${Math.max(1, Math.round(fontSize))}px ${fontFamily}`;
        ctx.textBaseline = 'alphabetic';
        // 用一个高 ascent 的 CJK 字符 + Latin 大写字母混合采样，覆盖多脚本字体
        const m = ctx.measureText('鲜M99');
        const fbAscent = (m as TextMetrics).fontBoundingBoxAscent;
        const aAscent = (m as TextMetrics).actualBoundingBoxAscent;
        if (typeof fbAscent === 'number' && fbAscent > 0) {
          result = fbAscent;
        } else if (typeof aAscent === 'number' && aAscent > 0) {
          result = aAscent;
        }
      }
    }
  } catch {
    // ignore — 用 fallback 0.82 ratio
  }
  fontAscentCache.set(key, result);
  return result;
}

function quoteFontFamilyList(families: string[]): string {
  return families
    .filter(Boolean)
    .map((family) => {
      if (family === 'sans-serif' || family === 'serif' || family === 'monospace') return family;
      return `"${family.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    })
    .join(', ');
}

function isImportedVectorType(fileType?: string): boolean {
  return fileType === 'ai' || fileType === 'pdf';
}

function mapImportedTextFont(fontName: string): string {
  const rawName = String(fontName || '').trim();
  const lower = rawName.toLowerCase();
  const looksLikeBoldFace = /bold|black|heavy|extrabold|semibold|demibold|medium|zhonghei|fzltzhk|db-|db_|cuhei|tehei|fzltch|fzltth/.test(lower);
  const shouldKeepRawName =
    rawName &&
    !looksLikeBoldFace &&
    !/^g_d\d+_f\d+$/i.test(rawName) &&
    !/^f\d+$/i.test(rawName) &&
    !rawName.includes(',');

  return quoteFontFamilyList([
    ...(shouldKeepRawName ? [rawName] : []),
    DEFAULT_CN_EDIT_FONT_NAME,
    'Microsoft YaHei',
    'Source Han Sans CN',
    'Noto Sans SC',
    'PingFang SC',
    'Heiti SC',
    '黑体',
    'FZLTXIHJW',
    'FZLTXHK',
    'FZLanTingHei-L-GBK',
    'FZLanTingHeiS-L-GB',
    'FZLTHK--GBK1-0',
    'FZLanTingHei-R-GBK',
    'FZLanTingHeiS-R-GB',
    'sans-serif',
  ]);
}

// PSD 字体名 → CSS font-family 映射
//
// 设计原则：在用户没有上传精确匹配字体时，回退**字重相符**的中文字体，而不是
// 字族名沾边的字体。比如 PSD 是 FZLTZHK（中黑，medium 字重），如果用户字体库里
// 只有「思源黑体 Bold」和「方正兰亭细黑」，应该优先用细黑（Light）而不是 Bold ——
// 细黑虽然偏轻，但比 Bold 更接近原始视觉；至少不会把一段普通正文渲染成超粗黑。
function mapPsdFont(psdName: string): string {
  if (!psdName) return 'sans-serif';
  const lower = psdName.toLowerCase();
  // 系统级中文字体（在 mac / Windows 大概率装着，是最稳的「正常字重」回退）
  const systemCnRegular = ['PingFang SC', 'Microsoft YaHei', 'Heiti SC', '黑体'];
  // 通用 Google / Adobe 中文字体（如果系统装了或服务端上传过 Regular 变体）
  const universalCnRegular = ['Source Han Sans CN', 'Noto Sans SC'];
  // 已上传字体库里的中文 / 通用 fallback。普通回退不放 Bold，避免 AI/PDF 字体名不准时全变粗。
  const uploadedCnFallback = [
    'FZLTXIHJW',                  // 方正兰亭细黑（已上传）— 同族但偏 Light
  ];

  // 方正兰亭中黑（中等字重）
  if (lower.includes('fzltzhk') || lower.includes('zhonghei')) return quoteFontFamilyList([
    psdName,
    'FZLTZHK--GBK1-0',
    'FZLanTingHei-DB-GBK',
    'FZLanTingHeiS-DB-GB',
    '方正兰亭中黑_GBK',
    '方正兰亭中黑',
    ...universalCnRegular,
    ...systemCnRegular,
    ...uploadedCnFallback,
    'sans-serif',
  ]);
  // 方正兰亭黑（普通粗细的「黑」字面）
  if (lower.includes('fzlthk') || lower === 'fzheijw') return quoteFontFamilyList([
    psdName,
    'FZLTHK--GBK1-0',
    'FZLanTingHei-R-GBK',
    'FZLanTingHeiS-R-GB',
    '方正兰亭黑_GBK',
    '方正兰亭黑',
    ...universalCnRegular,
    ...systemCnRegular,
    ...uploadedCnFallback,
    'sans-serif',
  ]);
  // 方正兰亭粗黑 / 特黑（真的粗）
  if (lower.includes('fzltch') || lower.includes('fzltth') || lower.includes('cuhei') || lower.includes('tehei')) {
    return quoteFontFamilyList([
      psdName,
      'SOURCEHANSANSCN-BOLD (1)',
      'Source Han Sans CN Bold',
      ...universalCnRegular,
      ...systemCnRegular,
      'sans-serif',
    ]);
  }
  // 方正兰亭细黑 / 准黑（轻字重）
  if (lower.includes('fzltxih') || lower.includes('fzltzh') || lower.includes('xihei') || lower.includes('zhunhei')) {
    return quoteFontFamilyList([
      psdName,
      'FZLTXIHJW',
      ...universalCnRegular,
      ...systemCnRegular,
      ...uploadedCnFallback,
      'sans-serif',
    ]);
  }
  // 方正字体通用
  if (lower.startsWith('fz')) return quoteFontFamilyList([
    psdName,
    ...universalCnRegular,
    ...systemCnRegular,
    ...uploadedCnFallback,
    'sans-serif',
  ]);
  // DIN Pro
  if (lower.includes('dinpro') || lower.includes('din')) return quoteFontFamilyList([
    psdName,
    'DINPro-Bold',
    'DIN-Bold',
    'Bahnschrift',
    'DIN Pro',
    'DIN',
    'DIN Alternate',
    'Arial Black',
    'sans-serif',
  ]);
  // 思源黑体
  if (lower.includes('sourcehansans') || lower.includes('notosans')) return quoteFontFamilyList([
    psdName,
    ...universalCnRegular,
    ...systemCnRegular,
    ...uploadedCnFallback,
    'sans-serif',
  ]);
  // 其他
  return quoteFontFamilyList([
    psdName,
    ...universalCnRegular,
    ...systemCnRegular,
    ...uploadedCnFallback,
    'sans-serif',
  ]);
}

// 展平图层树，继承父组的 visible 状态
function flattenLayers(
  layers: ParsedLayer[],
  parentVisible = true,
  inheritedEffects: Record<string, unknown> | null = null,
  inheritedOpacity = 1,
): ParsedLayer[] {
  const result: ParsedLayer[] = [];
  for (const layer of layers) {
    const effectiveVisible = parentVisible && isLayerVisibleValue(layer.visible);
    const effectiveEffects = mergePsdLayerEffects(getParsedLayerEffects(layer), inheritedEffects);
    const layerWithInheritedEffects = applyInheritedPsdLayerEffects(
      { ...layer, visible: effectiveVisible },
      effectiveEffects,
      inheritedEffects,
      inheritedOpacity,
    );
    // 将有效可见性写入图层（覆盖原始值）
    const renderGroupEffectsAfterChildren =
      layer.layerType === 'group' && isPsdGroupEffectOverlayLayer(layerWithInheritedEffects);
    if (!renderGroupEffectsAfterChildren) {
      result.push(layerWithInheritedEffects);
    }
    if (layer.children?.length) {
      const groupOpacity = layer.layerType === 'group'
        ? Math.max(0, Math.min(1, toFiniteNumber(layer.opacity) ?? 1))
        : 1;
      result.push(...flattenLayers(layer.children, effectiveVisible, effectiveEffects, inheritedOpacity * groupOpacity));
    }
    if (renderGroupEffectsAfterChildren) {
      result.push(layerWithInheritedEffects);
    }
  }
  return result;
}

function getCanvasRenderableLayers(layers: ParsedLayer[], includeHidden = false): ParsedLayer[] {
  return flattenLayers(layers)
    .filter((layer) =>
      (includeHidden || layer.visible)
      && !isTextMetadataLayer(layer)
      && !isSourceTextLayer(layer)
      && (layer.layerType !== 'group' || isPsdGroupEffectOverlayLayer(layer)));
}

function isPsdGroupEffectOverlayLayer(layer: ParsedLayer): boolean {
  if (layer.layerType !== 'group' || !layer.children?.length) return false;
  const effects = getParsedLayerEffects(layer);
  if (!effects) return false;
  return Boolean(
    getPsdEffect(effects, 'stroke')
    || getPsdEffect(effects, 'dropShadow')
    || getPsdEffect(effects, 'outerGlow'),
  );
}

function collectPsdGroupImageLayers(layers: ParsedLayer[], parentVisible = true): ParsedLayer[] {
  const result: ParsedLayer[] = [];
  for (const layer of layers) {
    const effectiveVisible = parentVisible && isLayerVisibleValue(layer.visible);
    if (!effectiveVisible) continue;
    if (layer.children?.length) {
      result.push(...collectPsdGroupImageLayers(layer.children, effectiveVisible));
      continue;
    }
    if (layer.imagePath) result.push(layer);
  }
  return result;
}

function unionParsedLayerBounds(layers: ParsedLayer[]): PixelBounds | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const layer of layers) {
    const x = toFiniteNumber(layer.x) ?? 0;
    const y = toFiniteNumber(layer.y) ?? 0;
    const width = toFiniteNumber(layer.width) ?? 0;
    const height = toFiniteNumber(layer.height) ?? 0;
    if (width <= 0 || height <= 0) continue;
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + width);
    bottom = Math.max(bottom, y + height);
  }
  if (!Number.isFinite(left) || !Number.isFinite(top) || right <= left || bottom <= top) return null;
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

function getParsedLayerEffects(layer: ParsedLayer): Record<string, unknown> | null {
  const props = layer.properties as Record<string, unknown> | null | undefined;
  const propEffects = props?.effects && typeof props.effects === 'object'
    ? props.effects as Record<string, unknown>
    : null;
  const style = layer.textStyle as Record<string, unknown> | null | undefined;
  const textEffects = style?.effects && typeof style.effects === 'object'
    ? style.effects as Record<string, unknown>
    : null;
  return mergePsdLayerEffects(textEffects, propEffects);
}

function mergePsdLayerEffects(
  ownEffects: Record<string, unknown> | null,
  inheritedEffects: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const merged: Record<string, unknown> = {
    ...(ownEffects || {}),
  };
  const inheritedSolidFill = inheritedEffects?.solidFill;
  if (inheritedSolidFill) {
    merged.solidFill = inheritedSolidFill;
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

function applyInheritedPsdLayerEffects(
  layer: ParsedLayer,
  effects: Record<string, unknown> | null,
  inheritedEffects: Record<string, unknown> | null,
  inheritedOpacity: number,
): ParsedLayer {
  const style = layer.textStyle as Record<string, unknown> | null | undefined;
  const props = layer.properties as Record<string, unknown> | null | undefined;
  const inherited = {
    ...(inheritedEffects ? { inheritedEffects } : {}),
    ...(inheritedOpacity !== 1 ? { inheritedOpacity } : {}),
  };
  if (!effects || layer.layerType !== 'text') {
    return {
      ...layer,
      properties: {
        ...(props || {}),
        ...inherited,
      },
    };
  }
  return {
    ...layer,
    properties: {
      ...(props || {}),
      ...inherited,
    },
    textStyle: {
      ...(style || {}),
      effects,
    },
  };
}

function getPsdLayerFillOpacity(layer: ParsedLayer): number {
  const props = layer.properties as Record<string, unknown> | null | undefined;
  const value = toFiniteNumber(props?.fillOpacity);
  if (value === null) return 1;
  const normalized = value > 1 ? value / 100 : value;
  return Math.max(0, Math.min(1, normalized));
}

function getPsdLayerContentOpacity(layer: ParsedLayer): number {
  const opacity = toFiniteNumber(layer.opacity) ?? 1;
  const props = layer.properties as Record<string, unknown> | null | undefined;
  const inheritedOpacity = toFiniteNumber(props?.inheritedOpacity) ?? 1;
  return Math.max(0, Math.min(1, opacity * inheritedOpacity * getPsdLayerFillOpacity(layer)));
}

function getPsdInheritedSolidFillColor(layer: ParsedLayer): string | null {
  const inherited = getPsdLayerInheritedEffects(layer);
  const solidFill = inherited?.solidFill as Record<string, unknown> | undefined;
  if (!solidFill) return null;
  const blendMode = String(solidFill.blendMode || 'normal').toLowerCase();
  if (blendMode !== 'normal' && blendMode !== 'source-over') return null;
  return extractCssColor(solidFill.color, solidFill.opacity);
}

function getPsdLayerInheritedEffects(layer: ParsedLayer): Record<string, unknown> | null {
  const props = layer.properties as Record<string, unknown> | null | undefined;
  return props?.inheritedEffects && typeof props.inheritedEffects === 'object'
    ? props.inheritedEffects as Record<string, unknown>
    : null;
}

function isLikelyCanvasBackgroundLayer(layer: ParsedLayer, canvas: fabric.Canvas, layerCount: number): boolean {
  if (layerCount <= 1 || layer.layerType !== 'image') return false;
  const canvasWidth = canvas.getWidth();
  const canvasHeight = canvas.getHeight();
  if (canvasWidth <= 0 || canvasHeight <= 0) return false;

  const left = toFiniteNumber(layer.x) || 0;
  const top = toFiniteNumber(layer.y) || 0;
  const width = toFiniteNumber(layer.width) || 0;
  const height = toFiniteNumber(layer.height) || 0;
  if (width <= 0 || height <= 0) return false;

  const right = left + width;
  const bottom = top + height;
  const coversCanvas =
    left <= canvasWidth * 0.05 &&
    top <= canvasHeight * 0.05 &&
    right >= canvasWidth * 0.95 &&
    bottom >= canvasHeight * 0.95;
  const areaRatio = (width * height) / Math.max(1, canvasWidth * canvasHeight);
  return coversCanvas && areaRatio >= 0.72;
}

function isLayerVisibleValue(value: unknown): boolean {
  return value !== false && value !== 0;
}

function collectHiddenParsedLayerIds(
  layers: ParsedLayer[],
  parentVisible = true,
  result = new Set<number>(),
): Set<number> {
  for (const layer of layers) {
    const effectiveVisible = parentVisible && isLayerVisibleValue(layer.visible);
    if (!effectiveVisible && typeof layer.id === 'number') {
      result.add(layer.id);
    }
    if (layer.children?.length) {
      collectHiddenParsedLayerIds(layer.children, effectiveVisible, result);
    }
  }
  return result;
}

function removeHiddenParsedLayerObjects(canvas: fabric.Canvas, layers: ParsedLayer[]) {
  const hiddenLayerIds = collectHiddenParsedLayerIds(layers);
  if (hiddenLayerIds.size === 0) return;

  for (const object of canvas.getObjects()) {
    const layerId = (object as fabric.FabricObject & { _layerId?: unknown })._layerId;
    const numericLayerId = typeof layerId === 'number' ? layerId : Number(layerId);
    if (Number.isFinite(numericLayerId) && hiddenLayerIds.has(numericLayerId)) {
      canvas.remove(object);
    }
  }
}
