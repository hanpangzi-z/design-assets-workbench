import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Home, Undo2, Redo2, ZoomIn, ZoomOut, Download, FolderOpen, Image, ChevronDown, X, CopyPlus } from 'lucide-react';
import useEditorStore from '@/store/editorStore';
import {
  downloadFile,
  triggerFileDownload,
  uploadFile,
} from '@/api/files';
import api from '@/api/index';
import { appendClientUploadPreview } from '@/utils/clientUploadPreview';
import { message } from 'antd';
import type { Font as OpenTypeFont, PathCommand as OpenTypePathCommand } from 'opentype.js';
import { restoreHistorySnapshot } from './history';
import { DEFAULT_CN_EDIT_FONT_NAME } from './fontDefaults';

interface Props {
  fileName?: string;
  sourceFileType?: string;
  canCreateCleanCopy?: boolean;
  onCreateCleanCopy?: () => void;
}

type DownloadKind = 'pdf' | 'pdf-image' | 'png' | 'jpg' | 'source';
type ColorMode = 'rgb' | 'cmyk';
type Matrix2D = [number, number, number, number, number, number];

export default function EditorToolbar({
  fileName = '设计稿',
  sourceFileType,
  canCreateCleanCopy = false,
  onCreateCleanCopy,
}: Props) {
  const navigate = useNavigate();
  const { fileId, engine, canvas, zoom, setZoom, undo, redo, isDirty, canvasWidth, canvasHeight } = useEditorStore();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [downloadKind, setDownloadKind] = useState<DownloadKind>('pdf');
  const [colorMode, setColorMode] = useState<ColorMode>('rgb');
  const [outlineText, setOutlineText] = useState(false);
  const safeFileName = sanitizeFileName(fileName || '设计稿');

  const handleUndo = () => {
    const state = undo();
    if (state && canvas) {
      void restoreHistorySnapshot(canvas, state);
    }
  };

  const handleRedo = () => {
    const state = redo();
    if (state && canvas) {
      void restoreHistorySnapshot(canvas, state);
    }
  };

  const handleDownloadImage = (format: 'png' | 'jpg') => {
    if (!canvas && engine && format === 'png') {
      void engine.exportPng()
        .then((blob) => {
          triggerBlobDownload(blob, `${safeFileName}.png`);
          message.success('PNG 下载已开始');
        })
        .catch(() => message.error('PNG 导出失败'));
      return;
    }
    if (!canvas) return message.warning(format === 'jpg' ? '当前引擎暂不支持 JPG 导出' : '画布还没有准备好');
    try {
      const dataUrl = canvas.toDataURL({
        format: format === 'jpg' ? 'jpeg' : 'png',
        quality: 0.95,
        multiplier: 1,
      });
      triggerBlobDownload(dataUrlToBlob(dataUrl), `${safeFileName}.${format}`);
      message.success(`${format.toUpperCase()} 下载已开始`);
    } catch {
      message.error(`${format.toUpperCase()} 导出失败`);
    }
  };

  const handleDownloadPdf = async (mode: ColorMode) => {
    if (!canvas) return message.warning('画布还没有准备好');
    try {
      if (!outlineText) {
        const usedSourcePdf = await tryDownloadOriginalPdf(mode);
        if (usedSourcePdf) return;
      }

      logCanvasObjectsForExport(canvas);

      const pdfBlob = await createEditablePrintPdfFromFabricCanvas(canvas, safeFileName, {
        colorMode: mode,
        outlineText,
        pageWidth: canvasWidth,
        pageHeight: canvasHeight,
        sourceFileType,
      });
      triggerBlobDownload(pdfBlob, `${safeFileName}-print-${mode.toUpperCase()}.pdf`);
      message.success(outlineText
        ? `PDF 转曲格式（${mode.toUpperCase()}）下载已开始`
        : `PDF 打印格式（${mode.toUpperCase()}）下载已开始`);
    } catch (error) {
      console.error('[PDF export] failed:', error);
      message.error(getApiErrorMessage(error, 'PDF 导出失败'));
    }
  };

  const handleDownloadFlattenedPdf = async (mode: ColorMode) => {
    if (!canvas) return message.warning('画布还没有准备好');
    try {
      const pdfBlob = await createFlattenedPrintPdfFromFabricCanvas(canvas, safeFileName, {
        colorMode: mode,
        outlineText: false,
        pageWidth: canvasWidth,
        pageHeight: canvasHeight,
        sourceFileType,
      });
      triggerBlobDownload(pdfBlob, `${safeFileName}-proof-image-${mode.toUpperCase()}.pdf`);
      message.success('PDF 保真图片版下载已开始');
    } catch (error) {
      console.error('[PDF image export] failed:', error);
      message.error(error instanceof Error ? error.message : 'PDF 保真图片版导出失败');
    }
  };

  const tryDownloadOriginalPdf = async (mode: ColorMode) => {
    // A source PDF is not a CMYK export merely because the filename says CMYK.
    if (mode === 'cmyk') return false;
    if (canvas?.getObjects().some((object) => (object as unknown as Record<string, unknown>)._pdfPreviewOnlyBackground === true)) return false;
    if (!fileId || isDirty || !isPdfPreservingSource(sourceFileType)) return false;
    const sourceBlob = await downloadFile(fileId);
    const header = await sourceBlob.slice(0, 8).text().catch(() => '');
    if (sourceFileType === 'ai' && !header.startsWith('%PDF')) return false;

    triggerBlobDownload(sourceBlob, `${safeFileName}-print-${mode.toUpperCase()}.pdf`);
    message.success('已下载源文件 PDF');
    return true;
  };

  const handleDownloadSource = () => {
    if (!fileId) return message.warning('当前画布没有源文件');
    const ext = sourceFileType ? `.${sourceFileType}` : '';
    triggerFileDownload(fileId, `${safeFileName}${ext}`);
    message.success('源文件下载已开始');
  };

  const handleConfirmDownload = () => {
    if (downloadKind === 'png') handleDownloadImage('png');
    if (downloadKind === 'jpg') handleDownloadImage('jpg');
    if (downloadKind === 'source') handleDownloadSource();
    if (downloadKind === 'pdf') void handleDownloadPdf(colorMode);
    if (downloadKind === 'pdf-image') void handleDownloadFlattenedPdf(colorMode);
    setDownloadOpen(false);
  };

  // 打开本地文件到画布
  const handleOpenFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || (!canvas && !engine)) return;
    e.target.value = '';

    const ext = file.name.split('.').pop()?.toLowerCase();

    // 图片文件直接加载到画布
    if (['png', 'jpg', 'jpeg', 'svg', 'gif', 'webp'].includes(ext || '')) {
      const url = URL.createObjectURL(file);
      try {
        if (!canvas && engine) {
          await engine.addImage(url);
          message.success(`已添加图片 ${file.name}`);
          return;
        }
        if (!canvas) return;
        const { FabricImage } = await import('fabric');
        const img = await FabricImage.fromURL(url);
        if (img.width && img.height) {
          const cw = canvas.getWidth();
          const ch = canvas.getHeight();
          const scale = Math.min(cw / img.width, ch / img.height, 1);
          img.set({
            scaleX: scale, scaleY: scale,
            left: (cw - img.width * scale) / 2,
            top: (ch - img.height * scale) / 2,
          });
        }
        canvas.add(img);
        canvas.setActiveObject(img);
        canvas.renderAll();
        message.success(`已添加图片 ${file.name}`);
      } catch {
        message.error('图片加载失败');
      } finally {
        URL.revokeObjectURL(url);
      }
      return;
    }

    // PSD/AI/PDF 文件上传到服务端解析，然后跳转到编辑器
    if (['psd', 'psb', 'ai', 'pdf'].includes(ext || '')) {
      const hide = message.loading(`正在上传 ${file.name}...`, 0);
      try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('storageScope', 'my');
        await appendClientUploadPreview(formData, file);
        const result = await uploadFile(formData);
        hide();
        message.success('上传成功，正在打开...');
        // 跳转到该文件的编辑器
        navigate(`/editor/${result.id}`);
      } catch {
        hide();
        message.error('上传失败');
      }
      return;
    }

    message.warning(`不支持的文件格式: .${ext}`);
  };

  // 添加图片到画布（从本地文件）
  const handleAddImage = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/svg+xml,image/gif,image/webp';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file || (!canvas && !engine)) return;
      const url = URL.createObjectURL(file);
      try {
        if (!canvas && engine) {
          await engine.addImage(url);
          return;
        }
        if (!canvas) return;
        const { FabricImage } = await import('fabric');
        const img = await FabricImage.fromURL(url);
        const cw = canvas.getWidth();
        const ch = canvas.getHeight();
        if (img.width && img.height) {
          const scale = Math.min(cw / img.width, ch / img.height, 0.8);
          img.set({
            scaleX: scale, scaleY: scale,
            left: (cw - img.width * scale) / 2,
            top: (ch - img.height * scale) / 2,
          });
        }
        canvas.add(img);
        canvas.setActiveObject(img);
        canvas.renderAll();
      } catch {
        message.error('加载失败');
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    input.click();
  };

  return (
    <div style={{
      height: 48, padding: '0 16px',
      background: '#fff', borderBottom: '1px solid var(--border-1)',
      display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0,
    }}>
      {/* 返回 */}
      <button onClick={() => navigate('/')} style={toolBtnStyle} title="返回首页">
        <Home size={18} />
      </button>

      <div style={separatorStyle} />

      {/* 文件操作 */}
      <button onClick={() => fileInputRef.current?.click()} style={toolBtnStyle} title="打开文件 (PSD/AI/图片)">
        <FolderOpen size={16} />
      </button>
      <button onClick={handleAddImage} style={toolBtnStyle} title="插入图片">
        <Image size={16} />
      </button>
      {canCreateCleanCopy && onCreateCleanCopy && (
        <button onClick={onCreateCleanCopy} style={toolBtnStyle} title="从源模板新建副本">
          <CopyPlus size={16} />
        </button>
      )}
      <input
        ref={fileInputRef}
        type="file"
        hidden
        accept=".psd,.psb,.ai,.pdf,.png,.jpg,.jpeg,.svg,.gif,.webp"
        onChange={handleOpenFile}
      />

      <div style={separatorStyle} />

      {/* 文件名 */}
      <span
        title={fileName}
        style={{
          font: '500 14px var(--font-sans)',
          color: 'var(--fg-1)',
          maxWidth: 260,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {fileName || '编辑器'}
      </span>
      {isDirty && (
        <span style={{ font: 'var(--type-caption)', color: 'var(--color-warning-fg)' }}>已修改</span>
      )}

      <div style={{ flex: 1 }} />

      {/* 撤销/重做 */}
      <button onClick={handleUndo} title="撤销 (Ctrl+Z)" style={toolBtnStyle}>
        <Undo2 size={16} />
      </button>
      <button onClick={handleRedo} title="重做 (Ctrl+Y)" style={toolBtnStyle}>
        <Redo2 size={16} />
      </button>

      <div style={separatorStyle} />

      {/* 缩放 */}
      <button onClick={() => setZoom(zoom - 10)} style={toolBtnStyle}>
        <ZoomOut size={16} />
      </button>
      <span style={{ font: 'var(--type-label)', color: 'var(--fg-2)', minWidth: 40, textAlign: 'center' }}>
        {zoom}%
      </span>
      <button onClick={() => setZoom(zoom + 10)} style={toolBtnStyle}>
        <ZoomIn size={16} />
      </button>

      <div style={separatorStyle} />

      {/* 下载 */}
      <div style={{ position: 'relative' }}>
        <button
          onClick={() => setDownloadOpen((open) => !open)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '0 14px', height: 32, borderRadius: 6,
            background: '#2D5AF0', color: '#fff',
            border: 'none', cursor: 'pointer', font: '700 13px var(--font-sans)',
          }}
        >
          <Download size={14} /> 下载
        </button>

        {downloadOpen && (
          <>
            <div onClick={() => setDownloadOpen(false)} style={downloadBackdropStyle} />
            <div style={downloadPanelStyle}>
              <div style={downloadPanelHeaderStyle}>
                <h3 style={{ margin: 0, font: '800 16px var(--font-sans)', color: 'var(--fg-1)' }}>下载作品</h3>
                <button onClick={() => setDownloadOpen(false)} style={panelIconButtonStyle} title="关闭">
                  <X size={17} />
                </button>
              </div>

              <div style={downloadLabelRowStyle}>
                <span>作品类型</span>
                {(downloadKind === 'pdf' || downloadKind === 'pdf-image') && <span style={{ color: 'var(--fg-3)', fontWeight: 500 }}>预览色差</span>}
              </div>
              <SelectLike
                value={downloadKind}
                onChange={(value) => setDownloadKind(value as DownloadKind)}
                options={[
                  { value: 'pdf', label: 'PDF印刷' },
                  { value: 'pdf-image', label: 'PDF保真图片版' },
                  { value: 'png', label: 'PNG 图片' },
                  { value: 'jpg', label: 'JPG 图片' },
                  { value: 'source', label: `源文件${sourceFileType ? `（${sourceFileType.toUpperCase()}）` : ''}`, disabled: !fileId },
                ]}
              />

              {(downloadKind === 'pdf' || downloadKind === 'pdf-image') && (
                <>
                  <SelectLike
                    value={colorMode}
                    onChange={(value) => setColorMode(value as ColorMode)}
                    options={[
                      { value: 'rgb', label: '普通（RGB）' },
                      { value: 'cmyk', label: '印刷（CMYK）' },
                    ]}
                  />

                  {downloadKind === 'pdf' && (
                    <label style={checkboxRowStyle}>
                      <input
                        type="checkbox"
                        checked={outlineText}
                        onChange={(e) => setOutlineText(e.target.checked)}
                        style={{ width: 14, height: 14, accentColor: '#2D5AF0' }}
                      />
                      <span>PDF 内的文字转曲</span>
                    </label>
                  )}

                  <div style={pdfNoticeStyle}>
                    <strong>「PDF文件」</strong> 用于印刷时，印刷效果可能存在一些偏差。请注意测试印刷效果，确认无误后再进行批量印刷。
                    {outlineText && <div style={{ marginTop: 6 }}>当前画布导出会将文字作为图形写入 PDF。</div>}
                    {downloadKind === 'pdf-image' && <div style={{ marginTop: 6 }}>当前会将画布作为整页图片写入 PDF。</div>}
                  </div>
                </>
              )}

              {downloadKind === 'source' && !fileId && (
                <div style={pdfNoticeStyle}>当前画布没有绑定上传源文件，请选择 PNG、JPG 或 PDF 下载。</div>
              )}

              <button
                onClick={handleConfirmDownload}
                disabled={downloadKind === 'source' && !fileId}
                style={{
                  ...downloadPrimaryButtonStyle,
                  opacity: downloadKind === 'source' && !fileId ? 0.45 : 1,
                  cursor: downloadKind === 'source' && !fileId ? 'not-allowed' : 'pointer',
                }}
              >
                下载
              </button>
              <div style={{ font: 'var(--type-caption)', color: 'var(--fg-4)', lineHeight: 1.7 }}>
                下载即视为您已阅读并同意 <span style={{ color: '#2D5AF0' }}>授权许可协议</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned || '设计稿';
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [meta, payload] = dataUrl.split(',');
  const mime = /data:(.*?);base64/.exec(meta)?.[1] || 'application/octet-stream';
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 300);
}

function getApiErrorMessage(error: unknown, fallback: string): string {
  const responseMessage = (error as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  if (typeof responseMessage === 'string' && responseMessage.trim()) return responseMessage;
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

function isPdfPreservingSource(sourceFileType?: string): boolean {
  const type = String(sourceFileType || '').toLowerCase();
  return type === 'pdf' || type === 'ai';
}

function isPsdSource(sourceFileType?: string): boolean {
  return String(sourceFileType || '').toLowerCase() === 'psd';
}

function SelectLike({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
}) {
  return (
    <div style={selectWrapStyle}>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        style={selectStyle}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown size={16} style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--fg-3)', pointerEvents: 'none' }} />
    </div>
  );
}

type FabricExportCanvas = {
  getWidth: () => number;
  getHeight: () => number;
  getObjects?: () => unknown[];
  toDataURL?: (options?: Record<string, unknown>) => string;
};

function logCanvasObjectsForExport(canvas: unknown) {
  const c = canvas as FabricExportCanvas;
  const objects = c.getObjects?.() || [];
  const summary = objects.map((object, index) => {
    const obj = object as Record<string, unknown>;
    const text = typeof obj.text === 'string' ? (obj.text as string).slice(0, 24) : undefined;
    return {
      index,
      type: obj.type,
      layerType: (obj as { _layerType?: string })._layerType,
      layerName: (obj as { _layerName?: string })._layerName,
      visible: obj.visible !== false,
      opacity: obj.opacity,
      hasText: typeof obj.text === 'string' && (obj.text as string).length > 0,
      textPreview: text,
      width: typeof obj.width === 'number' ? obj.width : undefined,
      height: typeof obj.height === 'number' ? obj.height : undefined,
    };
  });
  console.log('[PDF export] canvas objects:', summary);
}

function filterObjectsForPdfExport(objects: unknown[], options: PdfExportOptions): unknown[] {
  const hasVisualBacking = objects.some(isImportedVisualBackingObject);
  const filtered = objects.filter((object) => {
    if (isPdfExportAuxiliaryObject(object, options)) return false;
    return true;
  });
  if (hasVisualBacking || filtered.length !== objects.length) {
    console.log('[PDF export] editable-object mode:', {
      before: objects.length,
      after: filtered.length,
      skipped: objects.length - filtered.length,
      skippedVisualBacking: hasVisualBacking,
    });
  }
  return filtered;
}

function isImportedVisualBackingObject(object: unknown): boolean {
  const obj = object as Record<string, unknown> | null;
  if (!obj) return false;
  const layerId = Number(obj._layerId);
  const layerName = typeof obj._layerName === 'string' ? obj._layerName : '';
  const role = readPdfExportObjectRole(obj);
  return (
    layerId <= -1000000000
    || role === 'visual-backing'
    || role === 'page-preview'
    || role === 'preview-fallback'
    || layerName.includes('瑙嗚搴曞浘')
  );
}

function isPdfExportAuxiliaryObject(object: unknown, options: PdfExportOptions): boolean {
  const obj = object as Record<string, unknown> | null;
  if (!obj) return false;
  if (obj._pdfPreviewOnlyBackground === true) return false;
  if (isImportedVisualBackingObject(object)) return true;
  if (obj._pdfMaskArtifact === true) return true;
  if (obj._pdfPreviewFallback === true) return true;
  if (obj._pdfVisualBacking === true) return true;
  if (obj._pdfImportPlaceholder === true) return true;
  if (obj._svgDecorationProxy === true) return true;
  if (obj._pdfRasterBackground === true) return isFullPagePdfRasterObject(object, options);
  if (obj._psdInvisibleHitArea === true) return true;
  if (obj._pdfSourceTextActivation === true) return true;
  if (isPdfExportAuxiliaryRole(readPdfExportObjectRole(obj))) return true;
  return false;
}

function readPdfExportObjectRole(obj: Record<string, unknown>): string | undefined {
  if (typeof obj._svgObjectRole === 'string') return obj._svgObjectRole;
  if (typeof obj._pdfAuxiliaryImageRole === 'string') return obj._pdfAuxiliaryImageRole;
  if (!isRecord(obj.properties)) return undefined;
  const role = obj.properties.role ?? obj.properties.svgObjectRole;
  return typeof role === 'string' ? role : undefined;
}

function isPdfExportAuxiliaryRole(role: string | undefined): boolean {
  return role === 'page-raster'
    || role === 'visual-backing'
    || role === 'page-preview'
    || role === 'preview-fallback'
    || role === 'visual-raster'
    || role === 'mask-artifact'
    || role === 'raster-reconstruction-strip';
}

function isFullPagePdfRasterObject(object: unknown, options: PdfExportOptions): boolean {
  const obj = object as Record<string, unknown> | null;
  if (!obj) return false;
  const role = readPdfExportObjectRole(obj);
  if (isPdfExportAuxiliaryRole(role)) return true;
  const rect = getObjectRect(obj);
  const pageWidth = Math.max(1, Number(options.pageWidth || 1));
  const pageHeight = Math.max(1, Number(options.pageHeight || 1));
  const pageArea = pageWidth * pageHeight;
  const objectArea = Math.max(0, rect.width) * Math.max(0, rect.height);
  if (objectArea / pageArea >= 0.75) return true;
  const coversWidth = rect.left <= pageWidth * 0.05 && rect.left + rect.width >= pageWidth * 0.95;
  const coversHeight = rect.top <= pageHeight * 0.05 && rect.top + rect.height >= pageHeight * 0.95;
  return coversWidth && coversHeight;
}

type FontMeta = {
  id: string;
  name: string;
  family: string;
  filename: string;
  originalName?: string;
  format?: string;
  aliases?: string[];
};

type OutlineFontSource = {
  key: string;
  family: string;
  label: string;
  url: string;
  fallback?: boolean;
  ttcIndex?: number;
  aliases?: string[];
};

type LoadedFontSource = {
  source: OutlineFontSource;
  font: OpenTypeFont;
  bytes: Uint8Array;
};

type PdfEmbeddedGlyph = {
  cid: number;
  unicode: string;
  width: number;
};

type PdfEmbeddedFontResource = {
  name: string;
  key: string;
  source: OutlineFontSource;
  font: OpenTypeFont;
  bytes: Uint8Array;
  unitsPerEm: number;
  postScriptName: string;
  glyphs: Map<number, PdfEmbeddedGlyph>;
};

type PdfExportContext = PdfExportOptions & {
  embeddedTextFonts: PdfEmbeddedFontResource[];
  embeddedTextFontByKey: Map<string, PdfEmbeddedFontResource>;
};

const loadedFontCache = new Map<string, Promise<LoadedFontSource>>();
const DEFAULT_CN_EDIT_FONT_ALIASES = [
  DEFAULT_CN_EDIT_FONT_NAME,
  'AlibabaPuHuiTi-3-55-Regular',
  'Alibaba PuHuiTi 3 55 Regular',
  'Alibaba PuHuiTi 3.0 55 Regular',
  'Alibaba PuHuiTi',
  'AlibabaPuHuiTi',
  'Alibaba PuHuiTi',
];
const GENERIC_FONT_ALIAS_NAMES = new Set([
  'regular',
  'normal',
  'book',
  'roman',
  'medium',
  'light',
  'thin',
  'bold',
  'heavy',
  'black',
  'italic',
  'oblique',
]);
const SYSTEM_OUTLINE_FONTS: OutlineFontSource[] = [
  { key: 'system-alibaba-puhuiti-regular', family: DEFAULT_CN_EDIT_FONT_NAME, label: DEFAULT_CN_EDIT_FONT_NAME, url: '/api/v1/fonts/default-cn-edit', fallback: true, aliases: DEFAULT_CN_EDIT_FONT_ALIASES },
  { key: 'system-microsoft-yahei', family: 'Microsoft YaHei', label: 'Microsoft YaHei', url: '/api/v1/fonts/system/msyh.ttc', fallback: true, ttcIndex: 0 },
  { key: 'system-microsoft-yahei-bold', family: 'Microsoft YaHei', label: 'Microsoft YaHei Bold', url: '/api/v1/fonts/system/msyhbd.ttc', fallback: true, ttcIndex: 0 },
  { key: 'system-noto-sans-sc', family: 'Noto Sans SC', label: 'Noto Sans SC', url: '/api/v1/fonts/system/NotoSansSC-VF.ttf', fallback: true },
  { key: 'system-simhei', family: 'SimHei', label: 'SimHei', url: '/api/v1/fonts/system/simhei.ttf', fallback: true },
  { key: 'system-simsun', family: 'SimSun', label: 'SimSun', url: '/api/v1/fonts/system/simsun.ttc', fallback: true, ttcIndex: 0 },
  { key: 'system-arial', family: 'Arial', label: 'Arial', url: '/api/v1/fonts/system/arial.ttf', fallback: true },
];

type PdfExportOptions = {
  colorMode: ColorMode;
  outlineText: boolean;
  pageWidth: number;
  pageHeight: number;
  sourceFileType?: string;
};

type PdfImageResource = {
  name: string;
  width: number;
  height: number;
  encoding: 'jpeg' | 'rgb';
  bytes: Uint8Array;
  alphaBytes?: Uint8Array;
};

type PdfRgbRaster = {
  width: number;
  height: number;
  bytes: Uint8Array;
  alphaBytes?: Uint8Array;
};

async function createEditablePrintPdfFromFabricCanvas(
  canvas: unknown,
  title: string,
  options: PdfExportOptions
): Promise<Blob> {
  if (options.colorMode === 'cmyk') {
    return createManagedCmykPdfFromFabricCanvas(canvas, title, options);
  }

  // PSD layers can depend on Photoshop clipping, masks, blend modes and text
  // previews that cannot be reconstructed reliably as independent PDF objects.
  if (isPsdSource(options.sourceFileType)) {
    return createFlattenedPrintPdfFromFabricCanvas(canvas, title, options);
  }

  const c = canvas as FabricExportCanvas;
  const pageWidth = Math.max(1, Math.round(options.pageWidth));
  const pageHeight = Math.max(1, Math.round(options.pageHeight));
  const objects = filterObjectsForPdfExport(c.getObjects?.() || [], options);
  const imageResources: PdfImageResource[] = [];
  const contentParts: string[] = [];
  const context: PdfExportContext = {
    ...options,
    embeddedTextFonts: [],
    embeddedTextFontByKey: new Map<string, PdfEmbeddedFontResource>(),
  };

  for (const object of objects) {
    await appendFabricObjectToPdf(object, contentParts, imageResources, pageHeight, context);
  }

  const content = contentParts.join('\n');
  if (options.outlineText) assertOutlinedPdfContentHasNoTextOperators(content);

  return buildPdfDocument({
    title,
    pageWidth,
    pageHeight,
    content,
    images: imageResources,
    fonts: context.embeddedTextFonts,
  });
}

async function createFlattenedPrintPdfFromFabricCanvas(
  canvas: unknown,
  title: string,
  options: PdfExportOptions
): Promise<Blob> {
  if (options.colorMode === 'cmyk') {
    return createManagedCmykPdfFromFabricCanvas(canvas, title, options);
  }

  const c = canvas as FabricExportCanvas;
  const pageWidth = Math.max(1, Math.round(options.pageWidth));
  const pageHeight = Math.max(1, Math.round(options.pageHeight));
  const dataUrl = c.toDataURL?.({ format: 'png', multiplier: 1 });
  if (!dataUrl) throw new Error('PDF 保真图片版导出失败：无法读取画布图像');
  const rasterCanvas = await dataUrlToCanvas(dataUrl);
  const raster = canvasToRgbRaster(rasterCanvas);
  if (!raster) throw new Error('PDF 保真图片版导出失败：无法生成画布图像');

  return buildPdfDocument({
    title,
    pageWidth,
    pageHeight,
    content: `q\n${fmt(pageWidth)} 0 0 ${fmt(pageHeight)} 0 0 cm\n/Im1 Do\nQ`,
    images: [{ name: 'Im1', encoding: 'rgb', ...raster }],
    fonts: [],
  });
}

async function createManagedCmykPdfFromFabricCanvas(
  canvas: unknown,
  title: string,
  options: PdfExportOptions
): Promise<Blob> {
  const c = canvas as FabricExportCanvas;
  const pageWidth = Math.max(1, Math.round(options.pageWidth));
  const pageHeight = Math.max(1, Math.round(options.pageHeight));
  const longestEdge = Math.max(pageWidth, pageHeight);
  const multiplier = Math.max(1, Math.min(3, 4096 / longestEdge));
  const dataUrl = c.toDataURL?.({ format: 'png', multiplier });
  if (!dataUrl) throw new Error('CMYK 导出失败：无法读取画布图像');

  const response = await api.post('/files/export/cmyk', dataUrlToBlob(dataUrl), {
    params: { pageWidth, pageHeight, title },
    headers: { 'Content-Type': 'image/png' },
    responseType: 'blob',
    timeout: 120_000,
  });
  return response.data instanceof Blob
    ? response.data
    : new Blob([response.data], { type: 'application/pdf' });
}

async function appendFabricObjectToPdf(
  object: unknown,
  contentParts: string[],
  imageResources: PdfImageResource[],
  pageHeight: number,
  options: PdfExportContext
) {
  const obj = object as any;
  if (!obj || obj.visible === false || obj.opacity === 0) return;
  if (isPdfExportAuxiliaryObject(obj, options)) return;

  const type = String(obj.type || '').toLowerCase();
  if (type === 'group' || type === 'activeSelection'.toLowerCase()) {
    const children = getGroupChildren(obj);
    const reason = getNonVectorGroupReason(obj);
    if (reason) {
      await appendObjectAsImage(obj, contentParts, imageResources, pageHeight, { transparent: true, multiplier: 4 });
      return;
    }
    if (!children.length) {
      throw new Error('PDF 导出已停止：发现空组合对象，无法生成矢量内容。');
    }
    for (const child of children) {
      await appendFabricObjectToPdf(child, contentParts, imageResources, pageHeight, options);
    }
    return;
  }

  if (type === 'image') {
    if (options.outlineText) {
      const outlined = await appendImportedTextPreviewAsOutlinedText(obj, contentParts, pageHeight, options);
      if (outlined) return;
    }
    await appendObjectAsImage(obj, contentParts, imageResources, pageHeight);
    return;
  }

  if (type === 'text' || type === 'textbox' || type === 'i-text') {
    if (isImportedSourceTextObject(obj, options)) {
      throw new Error('PDF 导出已停止：当前 PDF/AI 仍包含旧源文字层，请重新打开文件触发新版解析后再导出。');
    }
    if (options.outlineText) {
      const outlined = await appendOutlinedTextObject(obj, contentParts, pageHeight, options.colorMode);
      if (!outlined && String(obj.text || '').trim()) {
        throw new Error(`PDF 导出已停止：文字“${String(obj.text || '').slice(0, 12)}”无法转成矢量轮廓。`);
      }
    } else {
      await appendEditableTextObject(obj, contentParts, pageHeight, options);
    }
    return;
  }

  if (type === 'path' && Array.isArray(obj.path)) {
    if (shouldRasterizeObjectForPdfExport(obj)) {
      await appendObjectAsImage(obj, contentParts, imageResources, pageHeight, { transparent: true, multiplier: 4 });
      return;
    }
    const path = convertFabricPathToPdfPath(obj, pageHeight);
    appendPaintedPath(path, obj, contentParts, options.colorMode);
    return;
  }

  if (type === 'rect') {
    if (shouldRasterizeObjectForPdfExport(obj)) {
      await appendObjectAsImage(obj, contentParts, imageResources, pageHeight, { transparent: true, multiplier: 4 });
      return;
    }
    appendPaintedPath(convertRectToPdfPath(obj, pageHeight), obj, contentParts, options.colorMode);
    return;
  }

  if (type === 'circle' || type === 'ellipse') {
    if (shouldRasterizeObjectForPdfExport(obj)) {
      await appendObjectAsImage(obj, contentParts, imageResources, pageHeight, { transparent: true, multiplier: 4 });
      return;
    }
    appendPaintedPath(convertEllipseToPdfPath(obj, pageHeight), obj, contentParts, options.colorMode);
    return;
  }

  if ((type === 'polygon' || type === 'polyline') && Array.isArray(obj.points)) {
    if (shouldRasterizeObjectForPdfExport(obj)) {
      await appendObjectAsImage(obj, contentParts, imageResources, pageHeight, { transparent: true, multiplier: 4 });
      return;
    }
    const path = convertPointsToPdfPath(obj, pageHeight, type === 'polygon');
    appendPaintedPath(path, obj, contentParts, options.colorMode);
    return;
  }

  if (type === 'line') {
    if (shouldRasterizeObjectForPdfExport(obj)) {
      await appendObjectAsImage(obj, contentParts, imageResources, pageHeight, { transparent: true, multiplier: 4 });
      return;
    }
    appendLineObject(obj, contentParts, pageHeight, options.colorMode);
    return;
  }

  throw new Error(`PDF 导出已停止：对象类型“${type || 'unknown'}”暂不支持矢量导出。`);
}

function isImportedSourceTextObject(obj: Record<string, unknown>, options: PdfExportOptions): boolean {
  const sourceType = String(options.sourceFileType || '').toLowerCase();
  if (sourceType !== 'pdf' && sourceType !== 'ai') return false;
  if (obj._layerType !== 'text' || obj._layerId === undefined) return false;
  const props = isRecord(obj.properties) ? obj.properties : null;
  if (props?.role === 'text-metadata' || props?.editableAs === 'metadata') return true;
  if (obj._pdfSourceTextActivated === true) return false;
  if (props?.source === 'pdf' || props?.source === 'ai') return true;
  return obj._psdTextPreview !== true;
}

function getGroupChildren(obj: any): unknown[] {
  if (typeof obj.getObjects === 'function') return obj.getObjects() || [];
  if (Array.isArray(obj._objects)) return obj._objects;
  return [];
}

function shouldRasterizeObjectForPdfExport(obj: any): boolean {
  if (!obj) return false;
  if (obj.clipPath) return true;
  if (obj.shadow) return true;
  if (obj.filters && Array.isArray(obj.filters) && obj.filters.length > 0) return true;
  if (obj.globalCompositeOperation && obj.globalCompositeOperation !== 'source-over') return true;
  return hasUnsupportedPdfVectorPaint(obj.fill) || hasUnsupportedPdfVectorPaint(obj.stroke);
}

function hasUnsupportedPdfVectorPaint(paint: unknown): boolean {
  if (paint === null || paint === undefined || paint === false) return false;
  if (typeof paint !== 'string') return true;
  const value = paint.trim().toLowerCase();
  if (!value || value === 'none' || value === 'transparent') return false;
  if (/^url\(/i.test(value)) return true;
  const parsed = parseCssColorWithAlpha(value);
  if (!parsed) return true;
  if (parsed.a <= 0) return false;
  return parsed.a < 1;
}

function getNonVectorGroupReason(obj: any): string {
  if (obj.clipPath) return '瑁佸壀钂欑増';
  if (obj.shadow) return '鎶曞奖';
  if (obj.filters && Array.isArray(obj.filters) && obj.filters.length > 0) return '婊ら暅';
  if (obj.globalCompositeOperation && obj.globalCompositeOperation !== 'source-over') return '娣峰悎妯″紡';
  return '';
}

function appendTextObject(obj: any, contentParts: string[], pageHeight: number, colorMode: ColorMode) {
  const rect = getObjectRect(obj);
  const fontSize = Math.max(1, Number(obj.fontSize || 16) * Math.abs(Number(obj.scaleY || 1)));
  const lineHeight = fontSize * Number(obj.lineHeight || 1.16);
  const fill = colorToPdfCommand(obj.fill || '#000000', colorMode, 'fill');
  const lines = String(obj.text || '').split(/\r?\n/);
  const escapedLines = lines.map((line) => escapePdfText(line));
  const x = rect.left;
  const firstBaseline = pageHeight - rect.top - fontSize;
  const textCommands = escapedLines.map((line, index) => {
    const y = firstBaseline - (index * lineHeight);
    return `BT\n/F1 ${fmt(fontSize)} Tf\n${fill}1 0 0 1 ${fmt(x)} ${fmt(y)} Tm\n(${line}) Tj\nET`;
  });
  contentParts.push(`q\n${textCommands.join('\n')}\nQ`);
}

async function appendEditableTextObject(
  obj: any,
  contentParts: string[],
  pageHeight: number,
  options: PdfExportContext
): Promise<boolean> {
  const text = String(obj.text || '');
  if (!text) return true;

  const fontResource = await resolveEmbeddedTextFontForObject(obj, text, options);
  const localSize = getObjectLocalSize(obj);
  const fontSize = Math.max(1, Number(obj.fontSize || 16));
  const lineHeight = fontSize * Number(obj.lineHeight || 1.16);
  const textAlign = String(obj.textAlign || 'left').toLowerCase();
  const charSpacing = Number(obj.charSpacing || 0);
  const pdfCharSpacing = Number.isFinite(charSpacing) && charSpacing !== 0
    ? (charSpacing / 1000) * fontSize
    : 0;
  const fill = colorToPdfCommand(obj.fill || '#000000', options.colorMode, 'fill');
  const lines = getTextLines(obj, text);
  const textCommands: string[] = [];

  lines.forEach((line, index) => {
    if (!line) return;
    const encoded = encodeTextForEmbeddedFont(line, fontResource);
    if (!encoded.hex) return;
    const lineWidth = measureEmbeddedTextWidth(line, fontResource.font, fontSize, charSpacing);
    const lineLeft = textAlign === 'center'
      ? (-localSize.width / 2) + Math.max(0, (localSize.width - lineWidth) / 2)
      : textAlign === 'right' || textAlign === 'end'
        ? (-localSize.width / 2) + Math.max(0, localSize.width - lineWidth)
        : (-localSize.width / 2);
    const baselineY = (-localSize.height / 2) + fontSize + (index * lineHeight);
    const matrix = getPdfTextMatrixForFabricObject(obj, pageHeight, lineLeft, baselineY);
    const spacing = pdfCharSpacing ? `${fmt(pdfCharSpacing)} Tc\n` : '';
    textCommands.push(`BT\n/${fontResource.name} ${fmt(fontSize)} Tf\n${fill}${spacing}${matrix.map(fmt).join(' ')} Tm\n<${encoded.hex}> Tj\nET`);
  });

  if (!textCommands.length && text.trim()) {
    throw new Error(`PDF 导出已停止：文字“${text.slice(0, 12)}”没有可嵌入的字形，请勾选“PDF 内的文字转曲”。`);
  }

  contentParts.push(`q\n${textCommands.join('\n')}\nQ`);
  return true;
}

function assertOutlinedPdfContentHasNoTextOperators(content: string) {
  if (/(^|\s)(BT|ET|Tj|TJ|Tf|Tm|Tc)(?=\s|$)/.test(content)) {
    throw new Error('PDF 转曲失败：导出内容仍包含可编辑文字指令，已停止生成文件。');
  }
}

async function resolveEmbeddedTextFontForObject(
  obj: any,
  text: string,
  context: PdfExportContext
): Promise<PdfEmbeddedFontResource> {
  const candidates = await resolveFontSourceCandidatesForObject(obj, text);
  const errors: unknown[] = [];

  for (const source of candidates) {
    const cached = context.embeddedTextFontByKey.get(source.key);
    if (cached && fontCanEncodeText(cached.font, text)) return cached;

    try {
      const loaded = await loadFontSource(source);
      if (!fontCanEncodeText(loaded.font, text)) {
        errors.push(new Error(`Font ${source.label} misses glyphs`));
        continue;
      }
      const resource = createEmbeddedFontResource(source, loaded, context);
      context.embeddedTextFonts.push(resource);
      context.embeddedTextFontByKey.set(source.key, resource);
      return resource;
    } catch (error) {
      errors.push(error);
      console.warn('[PDF export] embedded font candidate failed:', source.label, error);
    }
  }

  if (errors.length) console.warn('[PDF export] no embeddable font candidate matched:', errors);
  throw new Error('PDF 导出已停止：当前文字没有可嵌入字体，请勾选“PDF 内的文字转曲”。');
}

function createEmbeddedFontResource(
  source: OutlineFontSource,
  loaded: LoadedFontSource,
  context: PdfExportContext
): PdfEmbeddedFontResource {
  const fontAny = loaded.font as any;
  return {
    name: `F${context.embeddedTextFonts.length + 2}`,
    key: source.key,
    source,
    font: loaded.font,
    bytes: loaded.bytes,
    unitsPerEm: Math.max(1, Number(fontAny.unitsPerEm || fontAny.tables?.head?.unitsPerEm || 1000)),
    postScriptName: getOpenTypeName(fontAny, 'postScriptName') || sanitizePdfName(source.family || source.label || 'EmbeddedFont'),
    glyphs: new Map<number, PdfEmbeddedGlyph>(),
  };
}

async function resolveFontSourceCandidatesForObject(obj: any, text: string): Promise<OutlineFontSource[]> {
  const sources = await listOutlineFontSources();
  const requested = parseFontFamilyList(String(obj.fontFamily || ''));
  const matched = sources.filter((source) =>
    requested.some((family) => fontSourceMatchesRequestedFamily(source, family))
  );
  const fallback = hasCjkText(text)
    ? getCjkFallbackFontSources(sources)
    : sources.filter((source) => source.key === 'system-arial' || source.key === 'system-noto-sans-sc');
  const candidates = uniqueFontSources([...matched, ...fallback, ...sources]);
  if (!candidates.length) {
    throw new Error('PDF 导出已停止：没有可嵌入字体，请勾选“PDF 内的文字转曲”。');
  }
  return candidates;
}

function fontCanEncodeText(font: OpenTypeFont, text: string): boolean {
  const typedFont = font as any;
  for (const char of Array.from(text)) {
    if (!char.trim()) continue;
    const glyph = typedFont.charToGlyph?.(char);
    if (!glyph || Number(glyph.index || 0) === 0) return false;
  }
  return true;
}

function encodeTextForEmbeddedFont(text: string, resource: PdfEmbeddedFontResource): { hex: string } {
  let hex = '';
  for (const char of Array.from(text)) {
    const glyph = (resource.font as any).charToGlyph(char) as any;
    const cid = Math.max(0, Number(glyph?.index || 0));
    if (cid === 0 && char.trim()) {
      throw new Error(`PDF 导出已停止：字体“${resource.source.label}”缺少文字“${char}”的字形，请勾选“PDF 内的文字转曲”。`);
    }
    const width = scaleFontMetric(Number(glyph?.advanceWidth ?? resource.unitsPerEm * 0.5), resource.unitsPerEm);
    if (!resource.glyphs.has(cid)) {
      resource.glyphs.set(cid, { cid, unicode: char, width });
    }
    hex += cid.toString(16).padStart(4, '0').slice(-4);
  }
  return { hex };
}

function measureEmbeddedTextWidth(
  text: string,
  font: OpenTypeFont,
  fontSize: number,
  charSpacing: number
): number {
  const spacing = Number.isFinite(charSpacing) ? (charSpacing / 1000) * fontSize : 0;
  const chars = Array.from(text);
  const baseWidth = font.getAdvanceWidth?.(text, fontSize, { kerning: true, tracking: charSpacing }) ?? (fontSize * chars.length * 0.55);
  return baseWidth + Math.max(0, chars.length - 1) * spacing;
}

function getPdfTextMatrixForFabricObject(obj: any, pageHeight: number, localX: number, localY: number): Matrix2D {
  const matrix = getObjectMatrix(obj);
  const point = transformLocalPointToCanvas(matrix, localX, localY);
  return [
    matrix[0],
    -matrix[1],
    -matrix[2],
    matrix[3],
    point.x,
    pageHeight - point.y,
  ];
}

async function appendImportedTextPreviewAsOutlinedText(
  obj: any,
  contentParts: string[],
  pageHeight: number,
  options: PdfExportOptions
): Promise<boolean> {
  if (obj._psdImportedTextPreview !== true || obj._psdTextPreview !== true) return false;
  const text = String(obj._psdTextContent || '');
  if (!text.trim()) return false;

  const textOptions = isRecord(obj._psdTextOptions) ? obj._psdTextOptions : {};
  const layerBounds = getImportedTextPreviewLayerBoundsForExport(obj, textOptions);
  if (!layerBounds) return false;

  const fontSize = positivePdfNumber(textOptions.fontSize, 16);
  const cropBounds = getImportedTextPreviewCropBoundsForExport(
    layerBounds,
    options.pageWidth,
    options.pageHeight,
    fontSize
  );
  const matrix = getImportedTextPreviewTextMatrix(obj, layerBounds, cropBounds);
  const pseudoText = {
    ...textOptions,
    _layerId: obj._layerId,
    _layerName: obj._layerName,
    _layerType: 'text',
    _psdFontName: obj._psdFontName,
    _psdTextContent: text,
    type: 'text',
    text,
    width: layerBounds.width,
    height: layerBounds.height,
    fontSize,
    fill: typeof textOptions.fill === 'string' ? textOptions.fill : '#141413',
    fontFamily: typeof textOptions.fontFamily === 'string' ? textOptions.fontFamily : undefined,
    fontWeight: textOptions.fontWeight || '400',
    lineHeight: positivePdfNumber(textOptions.lineHeight, 1.16),
    charSpacing: finitePdfNumber(textOptions.charSpacing, 0),
    textAlign: typeof textOptions.textAlign === 'string' ? textOptions.textAlign : 'left',
    calcTransformMatrix: () => matrix,
  };

  return appendOutlinedTextObject(pseudoText, contentParts, pageHeight, options.colorMode);
}

function getImportedTextPreviewLayerBoundsForExport(
  obj: any,
  textOptions: Record<string, unknown>
): { left: number; top: number; width: number; height: number } | null {
  const stored = isRecord(obj._psdLayerBounds) ? obj._psdLayerBounds : {};
  const rect = getObjectRect(obj);
  const fontSize = positivePdfNumber(textOptions.fontSize, 16);
  const lineHeight = positivePdfNumber(textOptions.lineHeight, 1.16);
  const width = positivePdfNumber(stored.width, positivePdfNumber(textOptions.width, rect.width));
  const height = positivePdfNumber(
    stored.height,
    positivePdfNumber(textOptions.minHeight, Math.max(rect.height, fontSize * lineHeight))
  );
  if (width <= 0 || height <= 0) return null;

  return {
    left: finitePdfNumber(stored.left, rect.left),
    top: finitePdfNumber(stored.top, rect.top),
    width,
    height,
  };
}

function getImportedTextPreviewCropBoundsForExport(
  bounds: { left: number; top: number; width: number; height: number },
  canvasWidth: number,
  canvasHeight: number,
  fontSize: number
): { left: number; top: number; width: number; height: number } {
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

function getImportedTextPreviewTextMatrix(
  obj: any,
  layerBounds: { left: number; top: number; width: number; height: number },
  cropBounds: { left: number; top: number; width: number; height: number }
): Matrix2D {
  const imageMatrix = getObjectMatrix(obj);
  const imageSize = getObjectLocalSize(obj);
  const imageWidth = Math.max(1, imageSize.width);
  const imageHeight = Math.max(1, imageSize.height);
  const cropWidth = Math.max(1, cropBounds.width);
  const cropHeight = Math.max(1, cropBounds.height);
  const localTextToImage: Matrix2D = [
    imageWidth / cropWidth,
    0,
    0,
    imageHeight / cropHeight,
    (((layerBounds.left + layerBounds.width / 2 - cropBounds.left) / cropWidth) - 0.5) * imageWidth,
    (((layerBounds.top + layerBounds.height / 2 - cropBounds.top) / cropHeight) - 0.5) * imageHeight,
  ];
  return multiplyMatrix2d(imageMatrix, localTextToImage);
}

async function appendOutlinedTextObject(obj: any, contentParts: string[], pageHeight: number, colorMode: ColorMode): Promise<boolean> {
  const text = String(obj.text || '');
  if (!text) return true;

  const font = await resolveOutlineFontForObject(obj, text);
  const matrix = getObjectMatrix(obj);
  const localSize = getObjectLocalSize(obj);
  const fontSize = Math.max(1, Number(obj.fontSize || 16));
  const lineHeight = fontSize * Number(obj.lineHeight || 1.16);
  const textAlign = String(obj.textAlign || 'left').toLowerCase();
  const tracking = Number(obj.charSpacing || 0);
  const pathOptions = { kerning: true, tracking };
  const lines = getTextLines(obj, text);
  const paths: string[] = [];

  lines.forEach((line, index) => {
    if (!line) return;
    const outline = font.getPath(line, 0, 0, fontSize, pathOptions);
    const bounds = getOpenTypePathBounds(outline.commands);
    if (!bounds) return;
    const rawWidth = Math.max(
      0,
      font.getAdvanceWidth?.(line, fontSize, pathOptions) ?? (bounds.x2 - bounds.x1)
    );
    const lineWidth = rawWidth;
    const lineLeft = textAlign === 'center'
      ? (-localSize.width / 2) + Math.max(0, (localSize.width - lineWidth) / 2)
      : textAlign === 'right' || textAlign === 'end'
        ? (-localSize.width / 2) + Math.max(0, localSize.width - lineWidth)
        : (-localSize.width / 2);
    const lineTop = (-localSize.height / 2) + (index * lineHeight);
    const path = convertOpenTypeCommandsToPdfPath(outline.commands, pageHeight, {
      bounds,
      left: lineLeft,
      top: lineTop,
      matrix,
    });
    if (path) paths.push(path);
  });

  if (!paths.length) return false;
  const fill = typeof obj.fill === 'string' && obj.fill !== 'transparent' && obj.fill !== 'none'
    ? colorToPdfCommand(obj.fill, colorMode, 'fill')
    : colorToPdfCommand('#000000', colorMode, 'fill');
  const stroke = typeof obj.stroke === 'string' && obj.stroke !== 'transparent' && obj.stroke !== 'none'
    ? colorToPdfCommand(obj.stroke, colorMode, 'stroke')
    : '';
  const strokeWidth = stroke
    ? `${fmt(Math.max(0.1, Number(obj.strokeWidth || 1) * getMatrixAverageScale(matrix)))} w\n`
    : '';
  const op = stroke ? 'B*' : 'f*';
  contentParts.push(`q\n${fill}${stroke}${strokeWidth}${paths.join('\n')}\n${op}\nQ`);
  return true;
}

function getTextLines(obj: any, text: string): string[] {
  if (Array.isArray(obj.textLines) && obj.textLines.length) {
    return obj.textLines.map((line: unknown) => Array.isArray(line) ? line.join('') : String(line));
  }
  return text.split(/\r?\n/);
}

async function resolveOutlineFontForObject(obj: any, text: string): Promise<OpenTypeFont> {
  const sources = await listOutlineFontSources();
  const requested = parseFontFamilyList(String(obj.fontFamily || ''));
  const matched = sources.filter((source) =>
    requested.some((family) => fontSourceMatchesRequestedFamily(source, family))
  );
  const fallback = hasCjkText(text)
    ? getCjkFallbackFontSources(sources)
    : sources.filter((source) => source.key === 'system-arial' || source.key === 'system-noto-sans-sc');
  const candidates = uniqueFontSources([...matched, ...fallback, ...sources]);

  for (const source of candidates) {
    try {
      return await loadOutlineFont(source);
    } catch (error) {
      console.warn('[PDF export] outline font load failed:', source.label, error);
    }
  }

  throw new Error('PDF 转曲失败：没有可用的字体轮廓文件');
}

async function listOutlineFontSources(): Promise<OutlineFontSource[]> {
  let uploadedFonts: OutlineFontSource[] = [];
  try {
    const response = await api.get('/fonts');
    const fonts = (response.data?.data || []) as FontMeta[];
    uploadedFonts = fonts.map((font) => ({
      key: `upload-${font.id}`,
      family: font.family,
      label: font.name || font.family,
      url: `/uploads/fonts/${font.filename}`,
      aliases: [
        font.originalName,
        font.filename,
        ...(font.aliases || []),
      ].filter((value): value is string => Boolean(value)),
    }));
  } catch (error) {
    console.warn('[PDF export] font metadata unavailable:', error);
  }
  const uploadedDefaultFonts = uploadedFonts.filter(isDefaultCnEditFontSource);
  const otherUploadedFonts = uploadedFonts.filter((source) => !isDefaultCnEditFontSource(source));
  return uniqueFontSources([...uploadedDefaultFonts, ...SYSTEM_OUTLINE_FONTS, ...otherUploadedFonts]);
}

async function loadOutlineFont(source: OutlineFontSource): Promise<OpenTypeFont> {
  return (await loadFontSource(source)).font;
}

async function loadFontSource(source: OutlineFontSource): Promise<LoadedFontSource> {
  const cacheKey = `${source.key}:${source.ttcIndex ?? 0}`;
  const cached = loadedFontCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    const response = await fetch(source.url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Font request failed: ${source.url}`);
    const buffer = await response.arrayBuffer();
    const fontBuffer = extractOpenTypeFontBuffer(buffer, source);
    const opentype = await import('opentype.js');
    return {
      source,
      font: opentype.parse(fontBuffer),
      bytes: new Uint8Array(fontBuffer),
    };
  })();

  loadedFontCache.set(cacheKey, promise);
  return promise;
}

function extractOpenTypeFontBuffer(buffer: ArrayBuffer, source: OutlineFontSource): ArrayBuffer {
  const bytes = new Uint8Array(buffer);
  if (readAscii(bytes, 0, 4) !== 'ttcf') return buffer.slice(0);
  const sfnt = extractSfntFromTtc(bytes, Math.max(0, Number(source.ttcIndex ?? 0)));
  return sfnt.buffer.slice(sfnt.byteOffset, sfnt.byteOffset + sfnt.byteLength) as ArrayBuffer;
}

function extractSfntFromTtc(ttcBytes: Uint8Array, requestedIndex: number): Uint8Array {
  const view = new DataView(ttcBytes.buffer, ttcBytes.byteOffset, ttcBytes.byteLength);
  if (readAscii(ttcBytes, 0, 4) !== 'ttcf' || ttcBytes.length < 12) {
    throw new Error('Invalid TTC font');
  }
  const fontCount = view.getUint32(8, false);
  if (fontCount <= 0) throw new Error('TTC font has no faces');
  const index = Math.min(requestedIndex, fontCount - 1);
  const fontOffset = view.getUint32(12 + index * 4, false);
  if (fontOffset + 12 > ttcBytes.length) throw new Error('Invalid TTC face offset');

  const numTables = view.getUint16(fontOffset + 4, false);
  const headerLength = 12 + numTables * 16;
  if (fontOffset + headerLength > ttcBytes.length) throw new Error('Invalid TTC table directory');

  const tableRecords = Array.from({ length: numTables }, (_, tableIndex) => {
    const recordOffset = fontOffset + 12 + tableIndex * 16;
    const tag = readAscii(ttcBytes, recordOffset, 4);
    const checksum = view.getUint32(recordOffset + 4, false);
    const sourceOffset = view.getUint32(recordOffset + 8, false);
    const length = view.getUint32(recordOffset + 12, false);
    if (sourceOffset + length > ttcBytes.length) throw new Error(`Invalid TTC table ${tag}`);
    return { tag, checksum, sourceOffset, length };
  });

  let outputLength = headerLength;
  tableRecords.forEach((record) => {
    outputLength += align4(record.length);
  });
  const output = new Uint8Array(outputLength);
  output.set(ttcBytes.subarray(fontOffset, fontOffset + 12), 0);

  let writeOffset = headerLength;
  tableRecords.forEach((record, tableIndex) => {
    const recordOffset = 12 + tableIndex * 16;
    writeAscii(output, recordOffset, record.tag);
    writeUInt32BE(output, recordOffset + 4, record.checksum);
    writeUInt32BE(output, recordOffset + 8, writeOffset);
    writeUInt32BE(output, recordOffset + 12, record.length);
    output.set(ttcBytes.subarray(record.sourceOffset, record.sourceOffset + record.length), writeOffset);
    writeOffset += align4(record.length);
  });

  return output;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  return Array.from(bytes.subarray(offset, offset + length))
    .map((value) => String.fromCharCode(value))
    .join('');
}

function writeAscii(bytes: Uint8Array, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index) & 0xff;
  }
}

function writeUInt32BE(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function align4(value: number): number {
  return (value + 3) & ~3;
}

function parseFontFamilyList(fontFamily: string): string[] {
  return fontFamily
    .split(',')
    .map((family) => family.trim().replace(/^['"]|['"]$/g, ''))
    .filter((family) => family && !/^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/i.test(family));
}

function fontNameMatches(left: string, right: string): boolean {
  const a = normalizeFontName(left);
  const b = normalizeFontName(right);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function isGenericFontAlias(value: string): boolean {
  const normalized = normalizeFontName(value);
  return !normalized || GENERIC_FONT_ALIAS_NAMES.has(normalized);
}

function expandFontAlias(value: string): string[] {
  const alias = value.trim();
  if (!alias) return [];
  const withoutExt = alias.replace(/\.(ttf|otf|ttc|woff2?)$/i, '');
  return [alias, withoutExt, withoutExt.replace(/[_-]+/g, ' ')];
}

function isSpecificDefaultCnEditFontName(value: string): boolean {
  const candidates = expandFontAlias(value).filter((name) => !isGenericFontAlias(name));
  const expected = new Set(
    DEFAULT_CN_EDIT_FONT_ALIASES
      .flatMap(expandFontAlias)
      .filter((name) => !isGenericFontAlias(name))
      .map(normalizeFontName),
  );
  return candidates.some((candidate) => {
    const normalized = normalizeFontName(candidate);
    return Boolean(normalized && (expected.has(normalized) || normalized.includes('alibabapuhuiti')));
  });
}

function getFontSourceNames(source: OutlineFontSource): string[] {
  return [source.family, source.label, ...(source.aliases || [])].filter(Boolean);
}

function fontSourceMatchesRequestedFamily(source: OutlineFontSource, family: string): boolean {
  return getFontSourceNames(source).some((name) => fontNameMatches(family, name));
}

function isDefaultCnEditFontSource(source: OutlineFontSource): boolean {
  return getFontSourceNames(source).some(isSpecificDefaultCnEditFontName);
}

function getCjkFallbackFontSources(sources: OutlineFontSource[]): OutlineFontSource[] {
  return uniqueFontSources([
    ...sources.filter(isDefaultCnEditFontSource),
    ...sources.filter((source) =>
      source.key === 'system-alibaba-puhuiti-regular'
      || source.key === 'system-microsoft-yahei'
      || source.key === 'system-microsoft-yahei-bold'
      || source.key === 'system-noto-sans-sc'
      || source.key === 'system-simhei'
      || source.key === 'system-simsun'
    ),
    ...sources.filter(isSourceHanSansCnBoldSource),
  ]);
}

function isSourceHanSansCnBoldSource(source: OutlineFontSource): boolean {
  const normalized = normalizeFontName(`${source.key} ${getFontSourceNames(source).join(' ')}`);
  return normalized.includes('sourcehansanscnbold')
    || (normalized.includes('sourcehansanscn') && normalized.includes('bold'));
}

function normalizeFontName(value: string): string {
  return value.toLowerCase().replace(/[\s"'_-]/g, '');
}

function uniqueFontSources(sources: OutlineFontSource[]): OutlineFontSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (seen.has(source.key)) return false;
    seen.add(source.key);
    return true;
  });
}

function hasCjkText(text: string): boolean {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(text);
}

function getOpenTypePathBounds(commands: OpenTypePathCommand[]) {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  const addPoint = (x?: number, y?: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    x1 = Math.min(x1, x as number);
    y1 = Math.min(y1, y as number);
    x2 = Math.max(x2, x as number);
    y2 = Math.max(y2, y as number);
  };

  commands.forEach((command) => {
    if (command.type === 'M' || command.type === 'L') addPoint(command.x, command.y);
    if (command.type === 'C') {
      addPoint(command.x1, command.y1);
      addPoint(command.x2, command.y2);
      addPoint(command.x, command.y);
    }
    if (command.type === 'Q') {
      addPoint(command.x1, command.y1);
      addPoint(command.x, command.y);
    }
  });

  if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) return null;
  return { x1, y1, x2, y2 };
}

function convertOpenTypeCommandsToPdfPath(
  commands: OpenTypePathCommand[],
  pageHeight: number,
  layout: {
    bounds: { x1: number; y1: number; x2: number; y2: number };
    left: number;
    top: number;
    matrix: Matrix2D;
  }
): string {
  const output: string[] = [];
  let current = { x: 0, y: 0 };
  let start = { x: 0, y: 0 };
  const point = (x: number, y: number) => transformLocalPointToPdf(
    layout.matrix,
    pageHeight,
    layout.left + (x - layout.bounds.x1),
    layout.top + (y - layout.bounds.y1),
  );

  commands.forEach((command) => {
    if (command.type === 'M') {
      const p = point(command.x, command.y);
      output.push(`${fmt(p.x)} ${fmt(p.y)} m`);
      current = p;
      start = p;
    } else if (command.type === 'L') {
      const p = point(command.x, command.y);
      output.push(`${fmt(p.x)} ${fmt(p.y)} l`);
      current = p;
    } else if (command.type === 'C') {
      const p1 = point(command.x1, command.y1);
      const p2 = point(command.x2, command.y2);
      const p = point(command.x, command.y);
      output.push(`${fmt(p1.x)} ${fmt(p1.y)} ${fmt(p2.x)} ${fmt(p2.y)} ${fmt(p.x)} ${fmt(p.y)} c`);
      current = p;
    } else if (command.type === 'Q') {
      const q = point(command.x1, command.y1);
      const end = point(command.x, command.y);
      const c1 = {
        x: current.x + ((2 / 3) * (q.x - current.x)),
        y: current.y + ((2 / 3) * (q.y - current.y)),
      };
      const c2 = {
        x: end.x + ((2 / 3) * (q.x - end.x)),
        y: end.y + ((2 / 3) * (q.y - end.y)),
      };
      output.push(`${fmt(c1.x)} ${fmt(c1.y)} ${fmt(c2.x)} ${fmt(c2.y)} ${fmt(end.x)} ${fmt(end.y)} c`);
      current = end;
    } else if (command.type === 'Z') {
      output.push('h');
      current = start;
    }
  });

  return output.join('\n');
}

function appendLineObject(obj: any, contentParts: string[], pageHeight: number, colorMode: ColorMode) {
  const matrix = getObjectMatrix(obj);
  const centerX = (Number(obj.x1 || 0) + Number(obj.x2 || 0)) / 2;
  const centerY = (Number(obj.y1 || 0) + Number(obj.y2 || 0)) / 2;
  const p1 = transformLocalPointToCanvas(matrix, Number(obj.x1 || 0) - centerX, Number(obj.y1 || 0) - centerY);
  const p2 = transformLocalPointToCanvas(matrix, Number(obj.x2 || 0) - centerX, Number(obj.y2 || 0) - centerY);
  const stroke = colorToPdfCommand(obj.stroke || '#000000', colorMode, 'stroke');
  if (!stroke) return;
  const width = getWorldStrokeWidth(obj);
  contentParts.push(`q\n${stroke}${fmt(width)} w\n${fmt(p1.x)} ${fmt(pageHeight - p1.y)} m\n${fmt(p2.x)} ${fmt(pageHeight - p2.y)} l\nS\nQ`);
}

function appendPaintedPath(path: string, obj: any, contentParts: string[], colorMode: ColorMode) {
  if (!path.trim()) return;
  const fill = typeof obj.fill === 'string' && obj.fill !== 'transparent' && obj.fill !== 'none'
    ? colorToPdfCommand(obj.fill, colorMode, 'fill')
    : '';
  const stroke = typeof obj.stroke === 'string' && obj.stroke !== 'transparent' && obj.stroke !== 'none'
    ? colorToPdfCommand(obj.stroke, colorMode, 'stroke')
    : '';
  const strokeWidth = stroke ? `${fmt(getWorldStrokeWidth(obj))} w\n` : '';
  const op = fill && stroke ? 'B' : fill ? 'f' : stroke ? 'S' : 'n';
  contentParts.push(`q\n${fill}${stroke}${strokeWidth}${path}\n${op}\nQ`);
}

async function appendObjectAsImage(
  obj: any,
  contentParts: string[],
  imageResources: PdfImageResource[],
  pageHeight: number,
  options: { transparent?: boolean; multiplier?: number } = {}
) {
  const rect = getObjectRect(obj);
  if (rect.width <= 0 || rect.height <= 0) return;

  const name = `Im${imageResources.length + 1}`;
  if (options.transparent) {
    const raster = await fabricObjectToTransparentRgb(obj, options.multiplier || 4);
    if (!raster) return;
    imageResources.push({ name, encoding: 'rgb', ...raster });
  } else {
    const sourceRaster = await fabricImageToOriginalRgb(obj);
    if (sourceRaster) {
      imageResources.push({ name, encoding: 'rgb', ...sourceRaster });
    } else {
      const raster = await fabricObjectToTransparentRgb(obj, options.multiplier || 4);
      if (!raster) return;
      imageResources.push({ name, encoding: 'rgb', ...raster });
    }
  }
  const imageMatrix = getPdfImageMatrixForFabricObject(obj, pageHeight);
  contentParts.push(`q\n${imageMatrix.map(fmt).join(' ')} cm\n/${name} Do\nQ`);
}

async function fabricImageToOriginalRgb(obj: any): Promise<PdfRgbRaster | null> {
  if (String(obj.type || '').toLowerCase() !== 'image') return null;
  const element = typeof obj.getElement === 'function' ? obj.getElement() : null;
  if (!element) return null;

  const naturalWidth = Math.max(
    1,
    Math.round(Number(element.naturalWidth || element.videoWidth || element.width || obj.width || 1))
  );
  const naturalHeight = Math.max(
    1,
    Math.round(Number(element.naturalHeight || element.videoHeight || element.height || obj.height || 1))
  );
  const cropX = Math.max(0, Math.round(Number(obj.cropX || 0)));
  const cropY = Math.max(0, Math.round(Number(obj.cropY || 0)));
  const cropWidth = Math.max(
    1,
    Math.min(naturalWidth - cropX, Math.round(Number(obj.width || naturalWidth - cropX || 1)))
  );
  const cropHeight = Math.max(
    1,
    Math.min(naturalHeight - cropY, Math.round(Number(obj.height || naturalHeight - cropY || 1)))
  );
  if (cropWidth <= 0 || cropHeight <= 0) return null;

  const offscreen = document.createElement('canvas');
  offscreen.width = cropWidth;
  offscreen.height = cropHeight;
  const context = offscreen.getContext('2d', { willReadFrequently: true });
  if (!context) return null;

  try {
    context.drawImage(element, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
    return canvasToRgbRaster(offscreen);
  } catch {
    return null;
  }
}

async function fabricObjectToTransparentRgb(
  obj: any,
  multiplier: number
): Promise<PdfRgbRaster | null> {
  let objectCanvas: HTMLCanvasElement | null = null;

  if (typeof obj.toCanvasElement === 'function') {
    try {
      objectCanvas = obj.toCanvasElement({
        multiplier,
        enableRetinaScaling: true,
        withoutTransform: false,
        withoutShadow: false,
      });
    } catch {
      try {
        objectCanvas = obj.toCanvasElement(multiplier);
      } catch {
        objectCanvas = null;
      }
    }
  }

  if (!objectCanvas && typeof obj.toDataURL === 'function') {
    try {
      const dataUrl = obj.toDataURL({ format: 'png', multiplier });
      objectCanvas = await dataUrlToCanvas(dataUrl);
    } catch {
      objectCanvas = null;
    }
  }

  if (!objectCanvas) return null;
  return canvasToRgbRaster(objectCanvas);
}

function canvasToRgbRaster(sourceCanvas: HTMLCanvasElement): PdfRgbRaster | null {
  const width = Math.max(1, sourceCanvas.width);
  const height = Math.max(1, sourceCanvas.height);
  const context = sourceCanvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;

  const rgba = context.getImageData(0, 0, width, height).data;
  const rgb = new Uint8Array(width * height * 3);
  const alpha = new Uint8Array(width * height);
  let hasPartialAlpha = false;

  for (let source = 0, pixel = 0, target = 0; source < rgba.length; source += 4, pixel += 1, target += 3) {
    rgb[target] = rgba[source];
    rgb[target + 1] = rgba[source + 1];
    rgb[target + 2] = rgba[source + 2];
    alpha[pixel] = rgba[source + 3];
    if (rgba[source + 3] < 255) hasPartialAlpha = true;
  }

  return {
    width,
    height,
    bytes: rgb,
    alphaBytes: hasPartialAlpha ? alpha : undefined,
  };
}

function dataUrlToCanvas(dataUrl: string): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, image.naturalWidth || image.width || 1);
      canvas.height = Math.max(1, image.naturalHeight || image.height || 1);
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error('Canvas context is unavailable'));
        return;
      }
      context.drawImage(image, 0, 0);
      resolve(canvas);
    };
    image.onerror = () => reject(new Error('Image decode failed'));
    image.src = dataUrl;
  });
}

async function fabricObjectToJpegDataUrl(obj: any): Promise<string | null> {
  if (typeof obj.toDataURL === 'function') {
    try {
      return obj.toDataURL({ format: 'jpeg', quality: 0.95, multiplier: 1 });
    } catch {
      // Continue with element fallback.
    }
  }

  const element = typeof obj.getElement === 'function' ? obj.getElement() : null;
  if (!element) return null;
  const width = Math.max(1, Math.round(Number(obj.width || element.naturalWidth || element.width || 1)));
  const height = Math.max(1, Math.round(Number(obj.height || element.naturalHeight || element.height || 1)));
  const offscreen = document.createElement('canvas');
  offscreen.width = width;
  offscreen.height = height;
  const context = offscreen.getContext('2d');
  if (!context) return null;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(element, 0, 0, width, height);
  return offscreen.toDataURL('image/jpeg', 0.95);
}

function convertFabricPathToPdfPath(obj: any, pageHeight: number): string {
  const matrix = getObjectMatrix(obj);
  const offset = obj.pathOffset || { x: 0, y: 0 };
  const commands: string[] = [];
  let current = { x: 0, y: 0 };
  let start = { x: 0, y: 0 };

  const point = (x: number, y: number) => {
    const p = applyMatrix(matrix, x - Number(offset.x || 0), y - Number(offset.y || 0));
    return { x: p.x, y: pageHeight - p.y };
  };

  for (const raw of obj.path as unknown[][]) {
    const cmd = String(raw[0]).toUpperCase();
    if (cmd === 'M') {
      const p = point(Number(raw[1]), Number(raw[2]));
      commands.push(`${fmt(p.x)} ${fmt(p.y)} m`);
      current = { x: Number(raw[1]), y: Number(raw[2]) };
      start = current;
    } else if (cmd === 'L') {
      const p = point(Number(raw[1]), Number(raw[2]));
      commands.push(`${fmt(p.x)} ${fmt(p.y)} l`);
      current = { x: Number(raw[1]), y: Number(raw[2]) };
    } else if (cmd === 'H') {
      const p = point(Number(raw[1]), current.y);
      commands.push(`${fmt(p.x)} ${fmt(p.y)} l`);
      current = { x: Number(raw[1]), y: current.y };
    } else if (cmd === 'V') {
      const p = point(current.x, Number(raw[1]));
      commands.push(`${fmt(p.x)} ${fmt(p.y)} l`);
      current = { x: current.x, y: Number(raw[1]) };
    } else if (cmd === 'C') {
      const p1 = point(Number(raw[1]), Number(raw[2]));
      const p2 = point(Number(raw[3]), Number(raw[4]));
      const p = point(Number(raw[5]), Number(raw[6]));
      commands.push(`${fmt(p1.x)} ${fmt(p1.y)} ${fmt(p2.x)} ${fmt(p2.y)} ${fmt(p.x)} ${fmt(p.y)} c`);
      current = { x: Number(raw[5]), y: Number(raw[6]) };
    } else if (cmd === 'Q') {
      const q = { x: Number(raw[1]), y: Number(raw[2]) };
      const end = { x: Number(raw[3]), y: Number(raw[4]) };
      const c1 = { x: current.x + (2 / 3) * (q.x - current.x), y: current.y + (2 / 3) * (q.y - current.y) };
      const c2 = { x: end.x + (2 / 3) * (q.x - end.x), y: end.y + (2 / 3) * (q.y - end.y) };
      const p1 = point(c1.x, c1.y);
      const p2 = point(c2.x, c2.y);
      const p = point(end.x, end.y);
      commands.push(`${fmt(p1.x)} ${fmt(p1.y)} ${fmt(p2.x)} ${fmt(p2.y)} ${fmt(p.x)} ${fmt(p.y)} c`);
      current = end;
    } else if (cmd === 'Z') {
      commands.push('h');
      current = start;
    }
  }

  return commands.join('\n');
}

function convertPointsToPdfPath(obj: any, pageHeight: number, close: boolean): string {
  const matrix = getObjectMatrix(obj);
  const offset = obj.pathOffset || { x: 0, y: 0 };
  const points = obj.points as Array<{ x: number; y: number }>;
  if (!points.length) return '';

  const toPoint = (pt: { x: number; y: number }) => {
    const p = applyMatrix(matrix, Number(pt.x) - Number(offset.x || 0), Number(pt.y) - Number(offset.y || 0));
    return { x: p.x, y: pageHeight - p.y };
  };

  const first = toPoint(points[0]);
  const commands = [`${fmt(first.x)} ${fmt(first.y)} m`];
  points.slice(1).forEach((pt) => {
    const p = toPoint(pt);
    commands.push(`${fmt(p.x)} ${fmt(p.y)} l`);
  });
  if (close) commands.push('h');
  return commands.join('\n');
}

function convertRectToPdfPath(obj: any, pageHeight: number): string {
  const matrix = getObjectMatrix(obj);
  const { width, height } = getObjectLocalSize(obj);
  if (width <= 0 || height <= 0) return '';
  const points = [
    transformLocalPointToPdf(matrix, pageHeight, -width / 2, -height / 2),
    transformLocalPointToPdf(matrix, pageHeight, width / 2, -height / 2),
    transformLocalPointToPdf(matrix, pageHeight, width / 2, height / 2),
    transformLocalPointToPdf(matrix, pageHeight, -width / 2, height / 2),
  ];
  return [
    `${fmt(points[0].x)} ${fmt(points[0].y)} m`,
    `${fmt(points[1].x)} ${fmt(points[1].y)} l`,
    `${fmt(points[2].x)} ${fmt(points[2].y)} l`,
    `${fmt(points[3].x)} ${fmt(points[3].y)} l`,
    'h',
  ].join('\n');
}

function convertEllipseToPdfPath(obj: any, pageHeight: number): string {
  const k = 0.5522847498;
  const matrix = getObjectMatrix(obj);
  const { width, height } = getObjectLocalSize(obj);
  const rx = Math.max(0, Number(obj.rx || width / 2));
  const ry = Math.max(0, Number(obj.ry || height / 2));
  if (rx <= 0 || ry <= 0) return '';
  const p = (px: number, py: number) => {
    const point = transformLocalPointToPdf(matrix, pageHeight, px, py);
    return `${fmt(point.x)} ${fmt(point.y)}`;
  };
  return [
    `${p(rx, 0)} m`,
    `${p(rx, ry * k)} ${p(rx * k, ry)} ${p(0, ry)} c`,
    `${p(-rx * k, ry)} ${p(-rx, ry * k)} ${p(-rx, 0)} c`,
    `${p(-rx, -ry * k)} ${p(-rx * k, -ry)} ${p(0, -ry)} c`,
    `${p(rx * k, -ry)} ${p(rx, -ry * k)} ${p(rx, 0)} c`,
    'h',
  ].join('\n');
}

function getObjectRect(obj: any) {
  const rect = typeof obj.getBoundingRect === 'function' ? obj.getBoundingRect() : null;
  return {
    left: Number(rect?.left ?? obj.left ?? 0),
    top: Number(rect?.top ?? obj.top ?? 0),
    width: Math.max(0, Number(rect?.width ?? ((obj.width || 0) * Math.abs(obj.scaleX || 1)))),
    height: Math.max(0, Number(rect?.height ?? ((obj.height || 0) * Math.abs(obj.scaleY || 1)))),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function finitePdfNumber(value: unknown, fallback: number): number {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function positivePdfNumber(value: unknown, fallback: number): number {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? next : fallback;
}

function getObjectMatrix(obj: any): Matrix2D {
  if (typeof obj.calcTransformMatrix === 'function') {
    const matrix = obj.calcTransformMatrix();
    if (Array.isArray(matrix) && matrix.length >= 6) return matrix as Matrix2D;
  }
  const angle = (Number(obj.angle || 0) * Math.PI) / 180;
  const scaleX = Number(obj.scaleX || 1);
  const scaleY = Number(obj.scaleY || 1);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [
    cos * scaleX,
    sin * scaleX,
    -sin * scaleY,
    cos * scaleY,
    Number(obj.left || 0),
    Number(obj.top || 0),
  ];
}

function getObjectLocalSize(obj: any): { width: number; height: number } {
  return {
    width: Math.max(0, Number(obj.width || 0)),
    height: Math.max(0, Number(obj.height || 0)),
  };
}

function transformLocalPointToCanvas(matrix: Matrix2D, x: number, y: number) {
  return applyMatrix(matrix, x, y);
}

function transformLocalPointToPdf(matrix: Matrix2D, pageHeight: number, x: number, y: number) {
  const point = transformLocalPointToCanvas(matrix, x, y);
  return { x: point.x, y: pageHeight - point.y };
}

function getPdfImageMatrixForFabricObject(obj: any, pageHeight: number): Matrix2D {
  const matrix = getObjectMatrix(obj);
  const { width, height } = getObjectLocalSize(obj);
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const bottomLeft = transformLocalPointToCanvas(matrix, -safeWidth / 2, safeHeight / 2);
  return [
    matrix[0] * safeWidth,
    -matrix[1] * safeWidth,
    -matrix[2] * safeHeight,
    matrix[3] * safeHeight,
    bottomLeft.x,
    pageHeight - bottomLeft.y,
  ];
}

function getWorldStrokeWidth(obj: any): number {
  const strokeWidth = Math.max(0.1, Number(obj.strokeWidth || 1));
  const matrix = getObjectMatrix(obj);
  return Math.max(0.1, strokeWidth * getMatrixAverageScale(matrix));
}

function getMatrixAverageScale(matrix: Matrix2D): number {
  const scaleX = Math.hypot(matrix[0], matrix[1]) || 1;
  const scaleY = Math.hypot(matrix[2], matrix[3]) || scaleX;
  return (scaleX + scaleY) / 2;
}

function applyMatrix(matrix: Matrix2D, x: number, y: number) {
  return {
    x: (matrix[0] * x) + (matrix[2] * y) + matrix[4],
    y: (matrix[1] * x) + (matrix[3] * y) + matrix[5],
  };
}

function multiplyMatrix2d(a: Matrix2D, b: Matrix2D): Matrix2D {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function colorToPdfCommand(color: string, mode: ColorMode, target: 'fill' | 'stroke') {
  const rgb = parseCssColor(color);
  if (!rgb) return '';
  if (mode === 'cmyk') {
    const { c, m, y, k } = rgbToCmyk(rgb.r, rgb.g, rgb.b);
    const operator = target === 'fill' ? 'k' : 'K';
    return `${fmt(c / 255)} ${fmt(m / 255)} ${fmt(y / 255)} ${fmt(k / 255)} ${operator}\n`;
  }
  const operator = target === 'fill' ? 'rg' : 'RG';
  return `${fmt(rgb.r / 255)} ${fmt(rgb.g / 255)} ${fmt(rgb.b / 255)} ${operator}\n`;
}

function parseCssColor(color: string): { r: number; g: number; b: number } | null {
  const parsed = parseCssColorWithAlpha(color);
  if (!parsed || parsed.a <= 0) return null;
  return { r: parsed.r, g: parsed.g, b: parsed.b };
}

function parseCssColorWithAlpha(color: string): { r: number; g: number; b: number; a: number } | null {
  const value = color.trim().toLowerCase();
  if (!value || value === 'none' || value === 'transparent') return null;
  if (value === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  if (value === 'white') return { r: 255, g: 255, b: 255, a: 1 };
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    return {
      r: parseInt(value[1] + value[1], 16),
      g: parseInt(value[2] + value[2], 16),
      b: parseInt(value[3] + value[3], 16),
      a: 1,
    };
  }
  if (/^#[0-9a-f]{6}$/i.test(value)) {
    return {
      r: parseInt(value.slice(1, 3), 16),
      g: parseInt(value.slice(3, 5), 16),
      b: parseInt(value.slice(5, 7), 16),
      a: 1,
    };
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(value);
  if (rgb) {
    const parts = rgb[1].includes(',')
      ? rgb[1].split(',').map((part) => Number(part.trim()))
      : rgb[1].split(/\s+\/\s+|\s+/).map((part) => Number(part.trim()));
    if (parts.length >= 3 && parts.every((part) => Number.isFinite(part))) {
      return {
        r: Math.max(0, Math.min(255, parts[0])),
        g: Math.max(0, Math.min(255, parts[1])),
        b: Math.max(0, Math.min(255, parts[2])),
        a: parts.length >= 4 ? Math.max(0, Math.min(1, parts[3])) : 1,
      };
    }
  }
  return null;
}

function canUseBuiltinPdfFont(text: string): boolean {
  return /^[\u0009\u000a\u000d\u0020-\u00ff]*$/.test(text);
}

function getOpenTypeName(font: any, key: string): string {
  const value = font?.names?.[key];
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.en || value.zh || Object.values(value).find((item) => typeof item === 'string') || '';
}

function sanitizePdfName(value: string): string {
  const cleaned = String(value || 'EmbeddedFont')
    .replace(/[^A-Za-z0-9_.-]+/g, '')
    .slice(0, 80);
  return cleaned || 'EmbeddedFont';
}

function scaleFontMetric(value: number, unitsPerEm: number): number {
  return Math.round((Number(value) / Math.max(1, unitsPerEm)) * 1000);
}

function getPdfFontDescriptor(fontResource: PdfEmbeddedFontResource): {
  bbox: [number, number, number, number];
  ascent: number;
  descent: number;
  capHeight: number;
  italicAngle: number;
} {
  const font = fontResource.font as any;
  const units = fontResource.unitsPerEm;
  const head = font.tables?.head || {};
  const hhea = font.tables?.hhea || {};
  const os2 = font.tables?.os2 || {};
  return {
    bbox: [
      scaleFontMetric(Number(head.xMin ?? -1000), units),
      scaleFontMetric(Number(head.yMin ?? -1000), units),
      scaleFontMetric(Number(head.xMax ?? 1000), units),
      scaleFontMetric(Number(head.yMax ?? 1000), units),
    ],
    ascent: scaleFontMetric(Number(hhea.ascender ?? os2.sTypoAscender ?? 880), units),
    descent: scaleFontMetric(Number(hhea.descender ?? os2.sTypoDescender ?? -120), units),
    capHeight: scaleFontMetric(Number(os2.sCapHeight ?? hhea.ascender ?? 700), units),
    italicAngle: Number(font.tables?.post?.italicAngle || 0),
  };
}

function formatPdfCidWidths(fontResource: PdfEmbeddedFontResource): string {
  return Array.from(fontResource.glyphs.values())
    .filter((glyph) => glyph.cid > 0 && Number.isFinite(glyph.width))
    .sort((left, right) => left.cid - right.cid)
    .map((glyph) => `${glyph.cid} [${Math.max(1, Math.round(glyph.width))}]`)
    .join(' ');
}

function buildToUnicodeCMap(fontResource: PdfEmbeddedFontResource): string {
  const entries = Array.from(fontResource.glyphs.values())
    .filter((glyph) => glyph.cid > 0 && glyph.unicode)
    .sort((left, right) => left.cid - right.cid);
  const blocks: string[] = [];
  for (let index = 0; index < entries.length; index += 100) {
    const chunk = entries.slice(index, index + 100);
    blocks.push(`${chunk.length} beginbfchar\n${chunk.map((glyph) =>
      `<${glyph.cid.toString(16).padStart(4, '0').slice(-4)}> <${utf16BeHex(glyph.unicode)}>`
    ).join('\n')}\nendbfchar`);
  }
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    ...blocks,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
    '',
  ].join('\n');
}

function utf16BeHex(value: string): string {
  let hex = '';
  for (let index = 0; index < value.length; index += 1) {
    hex += value.charCodeAt(index).toString(16).padStart(4, '0');
  }
  return hex;
}

async function buildPdfDocument({
  title,
  pageWidth,
  pageHeight,
  content,
  images,
  fonts,
}: {
  title: string;
  pageWidth: number;
  pageHeight: number;
  content: string;
  images: PdfImageResource[];
  fonts: PdfEmbeddedFontResource[];
}): Promise<Blob> {
  const encoder = new TextEncoder();
  const chunks: BlobPart[] = [];
  const offsets: number[] = [];
  let offset = 0;

  const addString = (value: string) => {
    chunks.push(value);
    offset += encoder.encode(value).byteLength;
  };
  const addBytes = (bytes: Uint8Array) => {
    chunks.push(copyToArrayBuffer(bytes));
    offset += bytes.byteLength;
  };
  const beginObject = (id: number) => {
    offsets[id] = offset;
    addString(`${id} 0 obj\n`);
  };

  const fontObjectId = 4;
  let nextObjectId = 5;
  const embeddedFontObjects = fonts.map((font) => {
    const type0ObjectId = nextObjectId++;
    const cidFontObjectId = nextObjectId++;
    const descriptorObjectId = nextObjectId++;
    const fontFileObjectId = nextObjectId++;
    const toUnicodeObjectId = nextObjectId++;
    return { font, type0ObjectId, cidFontObjectId, descriptorObjectId, fontFileObjectId, toUnicodeObjectId };
  });
  const imageObjects = images.map((image) => {
    const imageObjectId = nextObjectId++;
    const alphaObjectId = image.alphaBytes ? nextObjectId++ : null;
    return { image, imageObjectId, alphaObjectId };
  });
  const contentObjectId = nextObjectId++;
  const infoObjectId = nextObjectId++;
  const objectCount = infoObjectId;
  const xObjectResources = images.length > 0
    ? `/XObject << ${imageObjects.map(({ image, imageObjectId }) => `/${image.name} ${imageObjectId} 0 R`).join(' ')} >>`
    : '';
  const fontResources = [
    `/F1 ${fontObjectId} 0 R`,
    ...embeddedFontObjects.map(({ font, type0ObjectId }) => `/${font.name} ${type0ObjectId} 0 R`),
  ].join(' ');

  addString('%PDF-1.4\n');
  addBytes(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

  beginObject(1);
  addString('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  beginObject(2);
  addString('<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');

  beginObject(3);
  addString(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(pageWidth)} ${fmt(pageHeight)}] /Resources << /Font << ${fontResources} >> ${xObjectResources} >> /Group << /Type /Group /S /Transparency /I true /CS /DeviceRGB >> /Contents ${contentObjectId} 0 R >>\nendobj\n`);

  beginObject(fontObjectId);
  addString('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n');

  for (const { font, type0ObjectId, cidFontObjectId, descriptorObjectId, fontFileObjectId, toUnicodeObjectId } of embeddedFontObjects) {
    const baseName = sanitizePdfName(font.postScriptName || font.source.family || font.source.label);
    const descriptor = getPdfFontDescriptor(font);
    const widths = formatPdfCidWidths(font);
    const toUnicode = buildToUnicodeCMap(font);

    beginObject(type0ObjectId);
    addString(`<< /Type /Font /Subtype /Type0 /BaseFont /${baseName} /Encoding /Identity-H /DescendantFonts [${cidFontObjectId} 0 R] /ToUnicode ${toUnicodeObjectId} 0 R >>\nendobj\n`);

    beginObject(cidFontObjectId);
    addString(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${baseName} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptorObjectId} 0 R /CIDToGIDMap /Identity /DW 1000${widths ? ` /W [${widths}]` : ''} >>\nendobj\n`);

    beginObject(descriptorObjectId);
    addString(`<< /Type /FontDescriptor /FontName /${baseName} /Flags 4 /FontBBox [${descriptor.bbox.map(fmt).join(' ')}] /ItalicAngle ${fmt(descriptor.italicAngle)} /Ascent ${fmt(descriptor.ascent)} /Descent ${fmt(descriptor.descent)} /CapHeight ${fmt(descriptor.capHeight)} /StemV 80 /FontFile2 ${fontFileObjectId} 0 R >>\nendobj\n`);

    beginObject(fontFileObjectId);
    addString(`<< /Length ${font.bytes.byteLength} /Length1 ${font.bytes.byteLength} >>\nstream\n`);
    addBytes(font.bytes);
    addString('\nendstream\nendobj\n');

    beginObject(toUnicodeObjectId);
    const toUnicodeBytes = encoder.encode(toUnicode);
    addString(`<< /Length ${toUnicodeBytes.byteLength} >>\nstream\n`);
    addBytes(toUnicodeBytes);
    addString('\nendstream\nendobj\n');
  }

  imageObjects.forEach(({ image, imageObjectId, alphaObjectId }) => {
    beginObject(imageObjectId);
    const filter = image.encoding === 'jpeg' ? '/Filter /DCTDecode ' : '';
    const smask = alphaObjectId ? `/SMask ${alphaObjectId} 0 R ` : '';
    addString(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 ${filter}${smask}/Length ${image.bytes.byteLength} >>\nstream\n`);
    addBytes(image.bytes);
    addString('\nendstream\nendobj\n');

    if (alphaObjectId && image.alphaBytes) {
      beginObject(alphaObjectId);
      addString(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${image.alphaBytes.byteLength} >>\nstream\n`);
      addBytes(image.alphaBytes);
      addString('\nendstream\nendobj\n');
    }
  });

  beginObject(contentObjectId);
  const compressedContent = await deflateBytes(encoder.encode(content));
  addString(`<< /Length ${compressedContent.byteLength} /Filter /FlateDecode >>\nstream\n`);
  addBytes(compressedContent);
  addString('\nendstream\nendobj\n');

  beginObject(infoObjectId);
  addString(`<< /Title (${escapePdfText(title)}) /Producer (Benlai Asset Editor) /Creator (Benlai Asset Editor) >>\nendobj\n`);

  offsets[0] = 0;
  const xrefStart = offset;
  addString(`xref\n0 ${objectCount + 1}\n`);
  addString('0000000000 65535 f \n');
  for (let id = 1; id <= objectCount; id++) {
    addString(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  }
  addString(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R /Info ${infoObjectId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

  return new Blob(chunks, { type: 'application/pdf' });
}

async function deflateBytes(input: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') return input;
  const stream = new Blob([copyToArrayBuffer(input)])
    .stream()
    .pipeThrough(new CompressionStream('deflate'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

function rgbToCmyk(red: number, green: number, blue: number) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const kFloat = 1 - Math.max(r, g, b);

  if (kFloat >= 1) return { c: 0, m: 0, y: 0, k: 255 };

  return {
    c: Math.round(((1 - r - kFloat) / (1 - kFloat)) * 255),
    m: Math.round(((1 - g - kFloat) / (1 - kFloat)) * 255),
    y: Math.round(((1 - b - kFloat) / (1 - kFloat)) * 255),
    k: Math.round(kFloat * 255),
  };
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function awaitlessAtob(base64: string): number[] {
  const binary = atob(base64);
  const bytes = new Array<number>(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function fmt(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function escapePdfText(value: string): string {
  return value.replace(/[()\\]/g, (match) => `\\${match}`);
}

const toolBtnStyle: React.CSSProperties = {
  width: 32, height: 32, display: 'grid', placeItems: 'center',
  background: 'transparent', border: 'none', borderRadius: 6,
  cursor: 'pointer', color: 'var(--fg-2)',
};

const separatorStyle: React.CSSProperties = {
  width: 1, height: 24, background: 'var(--border-1)', margin: '0 4px',
};

const downloadBackdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 60,
  background: 'transparent',
};

const downloadPanelStyle: React.CSSProperties = {
  position: 'fixed',
  top: 56,
  right: 16,
  width: 360,
  zIndex: 61,
  padding: 18,
  borderRadius: 12,
  background: '#fff',
  boxShadow: '0 18px 46px rgba(20,20,19,.16)',
  border: '1px solid var(--border-2)',
};

const downloadPanelHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 18,
};

const panelIconButtonStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  display: 'grid',
  placeItems: 'center',
  border: 0,
  borderRadius: 6,
  background: 'transparent',
  color: 'var(--fg-3)',
  cursor: 'pointer',
};

const downloadLabelRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 8,
  font: '700 13px var(--font-sans)',
  color: 'var(--fg-1)',
};

const selectWrapStyle: React.CSSProperties = {
  position: 'relative',
  marginBottom: 12,
};

const selectStyle: React.CSSProperties = {
  width: '100%',
  height: 40,
  padding: '0 38px 0 13px',
  borderRadius: 9,
  border: '1px solid var(--border-1)',
  background: '#fff',
  color: 'var(--fg-1)',
  font: '500 13px var(--font-sans)',
  outline: 'none',
  appearance: 'none',
  cursor: 'pointer',
};

const checkboxRowStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  margin: '0 0 12px',
  color: 'var(--fg-2)',
  font: '500 13px var(--font-sans)',
};

const pdfNoticeStyle: React.CSSProperties = {
  padding: '12px 13px',
  marginBottom: 16,
  borderRadius: 9,
  border: '1px solid #F2D4B5',
  background: '#FFF4EA',
  color: '#7A4C1D',
  font: 'var(--type-caption)',
  lineHeight: 1.65,
};

const downloadPrimaryButtonStyle: React.CSSProperties = {
  width: '100%',
  height: 42,
  border: 0,
  borderRadius: 9,
  background: '#2D5AF0',
  color: '#fff',
  font: '800 14px var(--font-sans)',
  marginBottom: 10,
};
