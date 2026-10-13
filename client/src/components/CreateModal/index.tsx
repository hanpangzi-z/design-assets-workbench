import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Columns,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  Layout,
  Link,
  Monitor,
  Plus,
  Search,
  Smartphone,
  Square,
  X,
} from 'lucide-react';
import { Empty, message, Spin } from 'antd';
import { getFiles, uploadFile, useTemplate, type FileListParams } from '@/api/files';
import Thumb from '@/components/FileCard/Thumb';
import useEditorWorkspaceStore, { MAX_OPEN_BOARDS } from '@/store/editorWorkspaceStore';
import { appendClientUploadPreview } from '@/utils/clientUploadPreview';
import type { DesignFile } from 'shared/types';

const CREATE_PRESETS = [
  { id: 'p1',  name: '手机海报',    ratio: '9:16', w: 1242, h: 2208, Icon: Smartphone },
  { id: 'p2',  name: '横版海报',    ratio: '',     w: 1600, h: 1000, Icon: Monitor },
  { id: 'p3',  name: '小红书配图',  ratio: '3:4',  w: 1242, h: 1656, Icon: ImageIcon },
  { id: 'p4',  name: '公众号首图',  ratio: '',     w: 900,  h: 383,  Icon: Layout },
  { id: 'p5',  name: '公众号次图',  ratio: '1:1',  w: 1080, h: 1080, Icon: Square },
  { id: 'p6',  name: '文章长图',    ratio: '',     w: 1080, h: 1920, Icon: Columns },
  { id: 'p7',  name: '商城 Banner', ratio: '',     w: 1920, h: 560,  Icon: Layout },
  { id: 'p8',  name: '商品主图',    ratio: '1:1',  w: 800,  h: 800,  Icon: Square },
];

const CREATE_ENTRIES = [
  { id: 'blank' as const,  t: '新建画布', Icon: Square },
  { id: 'import' as const, t: '导入图片', Icon: ImageIcon },
  { id: 'local' as const,  t: '打开本地', Icon: FolderOpen, tag: 'PSD' },
];

const IMAGE_FILE_TYPES = new Set(['png', 'jpg', 'jpeg', 'svg', 'gif', 'webp']);
const RESOURCE_IMAGE_TYPES = new Set(['png', 'jpg', 'gif', 'webp', 'svg']);
const LOCAL_FILE_TYPES = new Set(['psd', 'psb', 'ai', 'pdf']);
const MAX_RESOURCE_IMAGES = 16;
const MAX_RESOURCE_BOARDS = MAX_OPEN_BOARDS;
const PRINT_POINTS_PER_CM = 72 / 2.54;

type EntryId = typeof CREATE_ENTRIES[number]['id'];
type CanvasUnit = 'px' | 'cm';
type ResourceMode = 'image' | 'local';
type ResourceSource = 'my' | 'enterprise';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface ImportImagePayload {
  src: string;
  name: string;
  width: number;
  height: number;
}

export default function CreateModal({ open, onClose }: Props) {
  const navigate = useNavigate();
  const [entry, setEntry] = useState<EntryId>('blank');
  const [w, setW] = useState(1920);
  const [h, setH] = useState(1080);
  const [unit, setUnit] = useState<CanvasUnit>('px');
  const [openingFile, setOpeningFile] = useState(false);
  const [resourceOpen, setResourceOpen] = useState(false);
  const [resourceMode, setResourceMode] = useState<ResourceMode>('image');
  const [resourceSource, setResourceSource] = useState<ResourceSource>('my');
  const [resourceQuery, setResourceQuery] = useState('');
  const [resourceFiles, setResourceFiles] = useState<DesignFile[]>([]);
  const [resourceLoading, setResourceLoading] = useState(false);
  const [selectedResourceIds, setSelectedResourceIds] = useState<number[]>([]);

  const selectedResourceFiles = useMemo(
    () => selectedResourceIds
      .map((id) => resourceFiles.find((file) => file.id === id))
      .filter(Boolean) as DesignFile[],
    [resourceFiles, selectedResourceIds],
  );

  const resourceMax = resourceMode === 'image' ? MAX_RESOURCE_IMAGES : MAX_RESOURCE_BOARDS;
  const resourceAllowedTypes = resourceMode === 'image' ? RESOURCE_IMAGE_TYPES : LOCAL_FILE_TYPES;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (resourceOpen) setResourceOpen(false);
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, resourceOpen]);

  useEffect(() => {
    if (!resourceOpen) return;
    let cancelled = false;
    setResourceLoading(true);

    const timer = window.setTimeout(async () => {
      try {
        const params: FileListParams = {
          page: 1,
          pageSize: 80,
          keyword: resourceQuery.trim() || undefined,
          sortBy: 'created_at',
          sortOrder: 'desc',
        };
        if (resourceSource === 'my') {
          params.scope = 'my';
          params.myView = 'space';
        }

        const data = await getFiles(params);
        const filtered = data.list.filter((file) => resourceAllowedTypes.has(file.fileType.toLowerCase()));
        if (!cancelled) setResourceFiles(filtered);
      } catch {
        if (!cancelled) setResourceFiles([]);
      } finally {
        if (!cancelled) setResourceLoading(false);
      }
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [resourceAllowedTypes, resourceOpen, resourceQuery, resourceSource]);

  const closeAll = useCallback(() => {
    setResourceOpen(false);
    onClose();
  }, [onClose]);

  if (!open) return null;

  const handleCreate = (cw: number, ch: number, name: string) => {
    closeAll();
    navigate(`/editor/new?w=${cw}&h=${ch}&name=${encodeURIComponent(name)}`);
  };

  const openImagesInEditor = (images: ImportImagePayload[]) => {
    if (images.length === 0) return;
    const first = images[0];
    (window as Window & { __createImportImages?: { images: ImportImagePayload[] } }).__createImportImages = { images };
    window.sessionStorage.setItem('create-import-images', JSON.stringify({ images }));
    closeAll();
    navigate(`/editor/new?w=${first.width}&h=${first.height}&name=${encodeURIComponent(first.name)}&importImages=1`);
  };

  const openLocalImages = async (files: FileList | File[]) => {
    const picked = Array.from(files).slice(0, MAX_RESOURCE_IMAGES);
    const valid = picked.filter((file) => IMAGE_FILE_TYPES.has(getFileExt(file.name)));
    if (valid.length === 0) {
      message.warning('请选择图片文件');
      return;
    }

    setOpeningFile(true);
    try {
      const images = await Promise.all(valid.map(fileToImportImage));
      openImagesInEditor(images);
    } catch {
      message.error('图片打开失败');
    } finally {
      setOpeningFile(false);
    }
  };

  const openSourceFile = async (file: File) => {
    const ext = getFileExt(file.name);
    if (!LOCAL_FILE_TYPES.has(ext)) {
      message.warning('请选择 PSD / AI / PDF 文件');
      return;
    }
    if (file.size > 30 * 1024 * 1024) {
      message.error('文件大小不能超过 30MB');
      return;
    }

    setOpeningFile(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      appendPersonalStorageScope(formData);
      await appendClientUploadPreview(formData, file);
      const uploaded = await uploadFile(formData);
      closeAll();
      navigate(`/editor/${uploaded.id}`);
    } catch (err: any) {
      message.error(err?.response?.data?.message || '文件打开失败');
    } finally {
      setOpeningFile(false);
    }
  };

  const openResourcePicker = (mode: ResourceMode) => {
    setResourceMode(mode);
    setResourceSource('my');
    setResourceQuery('');
    setSelectedResourceIds([]);
    setResourceOpen(true);
  };

  const toggleResource = (file: DesignFile) => {
    setSelectedResourceIds((current) => {
      if (current.includes(file.id)) return current.filter((id) => id !== file.id);
      if (current.length >= resourceMax) {
        message.warning(`最多能选 ${resourceMax} 个文件`);
        return current;
      }
      return [...current, file.id];
    });
  };

  const confirmResourceSelection = async () => {
    if (selectedResourceFiles.length === 0) return;
    if (resourceMode === 'local') {
      setOpeningFile(true);
      try {
        const editableFiles = await Promise.all(selectedResourceFiles.map((file) => (
          file.isPersonalCopy ? Promise.resolve(file) : useTemplate(file.id)
        )));
        const openedBoards = useEditorWorkspaceStore.getState().addFileBoards(editableFiles);
        closeAll();
        navigate(openedBoards[0]?.route || `/editor/${editableFiles[0].id}`);
      } catch (error: any) {
        console.error('[CreateModal] open multiple boards failed:', error);
        message.error(error?.response?.data?.message || '打开画板失败');
      } finally {
        setOpeningFile(false);
      }
      return;
    }

    openImagesInEditor(selectedResourceFiles.map((file) => ({
      src: `/api/v1/files/${file.id}/preview`,
      name: file.name,
      width: file.width || 1080,
      height: file.height || 1080,
    })));
  };

  return (
    <>
      <div style={overlayStyle} onClick={closeAll}>
        <div onClick={(event) => event.stopPropagation()} style={modalStyle}>
          <aside style={leftPanelStyle}>
            <div style={createTitleStyle}>创建设计</div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {CREATE_ENTRIES.map((item) => {
                const active = entry === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => !openingFile && setEntry(item.id)}
                    disabled={openingFile}
                    style={entryButtonStyle(active, openingFile)}
                  >
                    <item.Icon size={18} />
                    <span style={{ flex: 1, textAlign: 'left' }}>{item.t}</span>
                    {item.tag && <span style={entryTagStyle}>{item.tag}</span>}
                  </button>
                );
              })}
            </div>

            <div style={leftPlusStyle}>
              <Plus size={24} />
            </div>
          </aside>

          <main style={rightPanelStyle}>
            {entry === 'blank' && (
              <CanvasChoicePanel
                w={w}
                h={h}
                unit={unit}
                setW={setW}
                setH={setH}
                setUnit={setUnit}
                onClose={closeAll}
                onCreate={handleCreate}
              />
            )}
            {entry === 'import' && (
              <UploadChoicePanel
                mode="image"
                title="拖放图片至此处"
                subtitle="jpg / png / gif / svg / webp"
                actionText="上传图片"
                disabled={openingFile}
                onClose={closeAll}
                onDrop={(event) => {
                  event.preventDefault();
                  if (event.dataTransfer.files.length) void openLocalImages(event.dataTransfer.files);
                }}
                onSelectFiles={(files) => void openLocalImages(files)}
                onResource={() => openResourcePicker('image')}
              />
            )}
            {entry === 'local' && (
              <UploadChoicePanel
                mode="local"
                title="拖放文件至此处"
                subtitle="psd / ai / pdf"
                actionText="上传文件"
                disabled={openingFile}
                onClose={closeAll}
                onDrop={(event) => {
                  event.preventDefault();
                  const file = event.dataTransfer.files?.[0];
                  if (file) void openSourceFile(file);
                }}
                onSelectFiles={(files) => {
                  const file = files[0];
                  if (file) void openSourceFile(file);
                }}
                onResource={() => openResourcePicker('local')}
              />
            )}
          </main>
        </div>
      </div>

      {resourceOpen && (
        <ResourcePicker
          files={resourceFiles}
          loading={resourceLoading}
          mode={resourceMode}
          max={resourceMax}
          source={resourceSource}
          query={resourceQuery}
          selectedIds={selectedResourceIds}
                onSourceChange={(next) => {
                  setResourceSource(next);
                  setSelectedResourceIds([]);
                }}
          onQueryChange={setResourceQuery}
          onToggle={toggleResource}
          onClose={() => setResourceOpen(false)}
          onConfirm={confirmResourceSelection}
        />
      )}
    </>
  );
}

function CanvasChoicePanel({
  w,
  h,
  unit,
  setW,
  setH,
  setUnit,
  onClose,
  onCreate,
}: {
  w: number;
  h: number;
  unit: CanvasUnit;
  setW: (value: number) => void;
  setH: (value: number) => void;
  setUnit: (value: CanvasUnit) => void;
  onClose: () => void;
  onCreate: (w: number, h: number, name: string) => void;
}) {
  return (
    <PanelFrame onClose={onClose}>
      <div style={panelCenterStyle}>
        <span style={batchBadgeStyle}>常用尺寸</span>
        <div style={formatIconRowStyle}>
          <FormatIcon label="9:16" color="#2563eb" />
          <FormatIcon label="1:1" color="#16a34a" />
          <FormatIcon label="Bnr" color="#f97316" />
        </div>
        <div style={uploadTitleStyle}>新建自定义画布</div>
        <div style={uploadSubtitleStyle}>输入尺寸或从下方推荐尺寸快速开始</div>

        <div style={canvasSizeCardStyle}>
          <input type="number" value={w} onChange={(event) => setW(Number(event.target.value) || 0)} placeholder="宽" style={numFieldStyle} />
          <Link size={14} style={{ color: '#98a2b3', flexShrink: 0 }} />
          <input type="number" value={h} onChange={(event) => setH(Number(event.target.value) || 0)} placeholder="高" style={numFieldStyle} />
          <select value={unit} onChange={(event) => setUnit(event.target.value as CanvasUnit)} style={unitSelectStyle}>
            <option value="px">px</option>
            <option value="cm">cm</option>
          </select>
        </div>

        <button type="button" onClick={() => onCreate(toCanvasPixels(w, unit), toCanvasPixels(h, unit), '未命名')} style={primaryActionStyle(false)}>
          <Square size={16} />
          创建画布
        </button>
      </div>

      <div style={presetFooterStyle}>
        {CREATE_PRESETS.slice(0, 4).map((preset) => (
          <button key={preset.id} type="button" onClick={() => onCreate(preset.w, preset.h, preset.name)} style={presetButtonStyle}>
            <preset.Icon size={14} />
            <span>{preset.name}</span>
            <small>{preset.w} × {preset.h}</small>
          </button>
        ))}
      </div>
    </PanelFrame>
  );
}

function UploadChoicePanel({
  mode,
  title,
  subtitle,
  actionText,
  disabled,
  onClose,
  onDrop,
  onSelectFiles,
  onResource,
}: {
  mode: ResourceMode;
  title: string;
  subtitle: string;
  actionText: string;
  disabled: boolean;
  onClose: () => void;
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
  onSelectFiles: (files: File[]) => void;
  onResource: () => void;
}) {
  return (
    <PanelFrame onClose={onClose} onDrop={onDrop}>
      <div style={panelCenterStyle}>
        <span style={batchBadgeStyle}>支持批量</span>
        <div style={formatIconRowStyle}>
          {mode === 'image' ? (
            <>
              <FormatIcon label="jpg" color="#f97316" />
              <FormatIcon label="png" color="#2563eb" />
              <FormatIcon label="gif" color="#7c3aed" />
            </>
          ) : (
            <>
              <FormatIcon label="Ps" color="#2563eb" />
              <FormatIcon label="Ai" color="#f59e0b" />
              <FormatIcon label="PDF" color="#dc2626" />
            </>
          )}
        </div>
        <div style={uploadTitleStyle}>{title}</div>
        <div style={uploadSubtitleStyle}>{subtitle}</div>

        <label style={primaryActionStyle(disabled)}>
          {mode === 'image' ? <ImageIcon size={16} /> : <FileText size={16} />}
          {disabled ? '打开中...' : actionText}
          <input
            type="file"
            multiple={mode === 'image'}
            accept={mode === 'image'
              ? 'image/png,image/jpeg,image/svg+xml,image/gif,image/webp,.png,.jpg,.jpeg,.svg,.gif,.webp'
              : '.psd,.psb,.ai,.pdf,image/vnd.adobe.photoshop,application/postscript,application/pdf'}
            disabled={disabled}
            style={fileInputOverlayStyle(disabled)}
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files || []);
              event.currentTarget.value = '';
              if (files.length > 0) onSelectFiles(files);
            }}
          />
        </label>
        <button type="button" onClick={onResource} disabled={disabled} style={secondaryActionStyle(disabled)}>
          <FolderOpen size={16} />
          从资源库选择
        </button>
      </div>

      <div style={sampleFooterStyle}>
        <button type="button" style={sampleLinkStyle}>
          查看文件规范
          <span>›</span>
        </button>
        <div style={sampleThumbsStyle}>
          <span>试试样片：</span>
          <span style={sampleThumbStyle('#e5e7eb')} />
          <span style={sampleThumbStyle('#f3ead7')} />
          <span style={sampleThumbStyle('#dbeafe')} />
        </div>
      </div>
    </PanelFrame>
  );
}

function PanelFrame({
  children,
  onClose,
  onDrop,
}: {
  children: React.ReactNode;
  onClose: () => void;
  onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
}) {
  return (
    <div style={uploadPanelStyle} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
      <div style={{ position: 'absolute', right: 14, top: 14 }}>
        <CloseButton onClick={onClose} />
      </div>
      {children}
    </div>
  );
}

function ResourcePicker({
  files,
  loading,
  mode,
  max,
  source,
  query,
  selectedIds,
  onSourceChange,
  onQueryChange,
  onToggle,
  onClose,
  onConfirm,
}: {
  files: DesignFile[];
  loading: boolean;
  mode: ResourceMode;
  max: number;
  source: ResourceSource;
  query: string;
  selectedIds: number[];
  onSourceChange: (source: ResourceSource) => void;
  onQueryChange: (query: string) => void;
  onToggle: (file: DesignFile) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div style={resourceBackdropStyle} onClick={onClose}>
      <section style={resourceOverlayStyle} onClick={(event) => event.stopPropagation()}>
        <header style={resourceHeaderStyle}>
          <strong>选择资源</strong>
          <button type="button" onClick={onClose} style={resourceCloseStyle} title="关闭"><X size={20} /></button>
        </header>
        <div style={resourceBodyStyle}>
          <aside style={resourceSiderStyle}>
            {([
              ['my', '我的空间'],
              ['enterprise', '企业资源库'],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => onSourceChange(key)}
                style={resourceNavStyle(source === key)}
              >
                <span style={{ color: '#a0a7b2' }}>›</span>
                {label}
              </button>
            ))}
          </aside>
          <main style={resourceMainStyle}>
            <div style={resourceToolbarStyle}>
              <div style={{ font: '800 15px var(--font-sans)', color: '#1f2937' }}>
                {source === 'my' ? '我的空间' : '企业资源库'}
              </div>
              <div style={resourceSearchStyle}>
                <input
                  value={query}
                  onChange={(event) => onQueryChange(event.target.value)}
                  placeholder={`在「${source === 'my' ? '我的空间' : '企业资源库'}」内搜索`}
                  style={resourceSearchInputStyle}
                />
                <Search size={18} style={{ color: '#98a2b3' }} />
              </div>
            </div>
            <div style={resourceSubToolbarStyle}>
              <label style={resourceCheckboxLabelStyle}>
                <span style={resourceSmallCheckboxStyle(false)} />
                当前内容 {files.length}
              </label>
              <span style={{ flex: 1 }} />
              <span style={resourceToggleStyle}><span /></span>
              <span style={{ color: '#4b5563', font: '600 13px var(--font-sans)' }}>显示子文件内容</span>
            </div>

            {loading ? (
              <div style={{ display: 'grid', placeItems: 'center', height: 260 }}><Spin /></div>
            ) : files.length === 0 ? (
              <div style={{ paddingTop: 96 }}><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可选资源" /></div>
            ) : (
              <div style={resourceGridStyle}>
                {files.map((file) => {
                  const selected = selectedIds.includes(file.id);
                  return (
                    <button key={file.id} type="button" onClick={() => onToggle(file)} style={resourceCardStyle}>
                      <span style={resourceSmallCheckboxStyle(selected)} />
                      <div style={resourceThumbShellStyle}>
                        <Thumb thumbnailUrl={file.thumbnailPath} fileType={file.fileType} label={file.name?.charAt(0)} file={file} name={file.name} height={122} showBadge={false} />
                      </div>
                      <span style={resourceFileNameStyle} title={file.name}>{file.name}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </main>
        </div>
        <footer style={resourceFooterStyle}>
          <span>已选 <b style={{ color: '#2563eb' }}>{selectedIds.length}</b> 个文件，最多能选 {max} 个文件</span>
          <button type="button" onClick={onConfirm} disabled={selectedIds.length === 0} style={resourceConfirmStyle(selectedIds.length === 0)}>
            确定
          </button>
        </footer>
      </section>
    </div>
  );
}

function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={closeButtonStyle} title="关闭">
      <X size={16} />
    </button>
  );
}

function FormatIcon({ label, color }: { label: string; color: string }) {
  return (
    <div style={formatIconStyle}>
      <FileText size={36} strokeWidth={1.4} style={{ color: '#d8dee8' }} />
      <span style={{ position: 'absolute', left: 0, right: 0, top: 19, textAlign: 'center', color, font: '800 12px var(--font-sans)' }}>{label}</span>
    </div>
  );
}

function getFileExt(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return ext === 'jpeg' ? 'jpg' : ext;
}

function fileToImportImage(file: File): Promise<ImportImagePayload> {
  return new Promise((resolve, reject) => {
    const src = URL.createObjectURL(file);
    const image = new window.Image();
    image.onload = () => resolve({
      src,
      name: file.name.replace(/\.[^.]+$/, '') || '未命名',
      width: image.naturalWidth || 1080,
      height: image.naturalHeight || 1080,
    });
    image.onerror = () => {
      URL.revokeObjectURL(src);
      reject(new Error('decode_failed'));
    };
    image.src = src;
  });
}

function appendPersonalStorageScope(formData: FormData) {
  formData.append('storageScope', 'my');
}

function toCanvasPixels(value: number, unit: CanvasUnit) {
  return Math.round(unit === 'cm' ? value * PRINT_POINTS_PER_CM : value);
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 500,
  background: 'rgba(17, 24, 39, 0.45)',
  display: 'grid',
  placeItems: 'center',
  backdropFilter: 'blur(2px)',
};

const modalStyle: React.CSSProperties = {
  width: 720,
  height: 520,
  background: '#fff',
  borderRadius: 12,
  boxShadow: '0 24px 64px rgba(0,0,0,.24)',
  display: 'flex',
  overflow: 'hidden',
  border: '1px solid var(--border-1)',
};

const leftPanelStyle: React.CSSProperties = {
  width: 220,
  padding: '22px 12px',
  background: 'linear-gradient(180deg, #3f5cff 0%, #7792ff 100%)',
  display: 'flex',
  flexDirection: 'column',
  gap: 24,
  position: 'relative',
  overflow: 'hidden',
};

const createTitleStyle: React.CSSProperties = {
  padding: '0 10px',
  font: '800 24px var(--font-sans)',
  color: '#fff',
};

function entryButtonStyle(active: boolean, disabled: boolean): React.CSSProperties {
  return {
    border: 0,
    width: '100%',
    minHeight: 50,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '0 14px',
    borderRadius: 16,
    cursor: disabled ? 'not-allowed' : 'pointer',
    background: active ? 'rgba(255,255,255,.92)' : 'transparent',
    color: active ? '#111827' : '#fff',
    boxShadow: active ? '0 10px 24px rgba(15,23,42,.12)' : 'none',
    opacity: disabled ? 0.65 : 1,
    font: '800 16px var(--font-sans)',
  };
}

const entryTagStyle: React.CSSProperties = {
  font: '800 11px var(--font-sans)',
  color: '#fff',
  padding: '1px 6px',
  borderRadius: 4,
  background: '#1d4ed8',
};

const leftPlusStyle: React.CSSProperties = {
  position: 'absolute',
  left: -24,
  bottom: -34,
  width: 164,
  height: 124,
  borderRadius: 8,
  background: 'rgba(255,255,255,.08)',
  display: 'grid',
  placeItems: 'center',
  color: 'rgba(255,255,255,.35)',
};

const rightPanelStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
};

const uploadPanelStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  backgroundColor: '#fff',
  backgroundImage: 'radial-gradient(#d7dce5 1px, transparent 1px)',
  backgroundSize: '16px 16px',
};

const panelCenterStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '54px 24px 34px',
};

const batchBadgeStyle: React.CSSProperties = {
  height: 24,
  display: 'inline-flex',
  alignItems: 'center',
  padding: '0 12px',
  borderRadius: 999,
  border: '1px solid #c7ddff',
  background: '#eef6ff',
  color: '#2563eb',
  font: '700 12px var(--font-sans)',
  marginBottom: 16,
};

const formatIconRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  marginBottom: 12,
};

const formatIconStyle: React.CSSProperties = {
  width: 44,
  height: 52,
  position: 'relative',
  display: 'grid',
  placeItems: 'center',
  background: '#fff',
};

const uploadTitleStyle: React.CSSProperties = {
  color: '#111827',
  font: '800 16px var(--font-sans)',
  marginTop: 2,
};

const uploadSubtitleStyle: React.CSSProperties = {
  color: '#667085',
  font: '500 13px var(--font-sans)',
  marginTop: 7,
  minHeight: 18,
};

const canvasSizeCardStyle: React.CSSProperties = {
  width: 320,
  minHeight: 42,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  marginTop: 24,
  marginBottom: 12,
};

const numFieldStyle: React.CSSProperties = {
  width: 86,
  height: 34,
  padding: '0 10px',
  borderRadius: 7,
  border: '1px solid #d8dde5',
  font: '700 13px var(--font-sans)',
  color: '#111827',
  outline: 'none',
  background: '#fff',
};

const unitSelectStyle: React.CSSProperties = {
  height: 34,
  padding: '0 8px',
  borderRadius: 7,
  border: '1px solid #d8dde5',
  background: '#fff',
  font: '700 13px var(--font-sans)',
  color: '#111827',
  outline: 'none',
  cursor: 'pointer',
};

function primaryActionStyle(disabled: boolean): React.CSSProperties {
  return {
    width: 300,
    height: 42,
    border: 0,
    borderRadius: 9,
    background: '#2557f6',
    color: '#fff',
    font: '800 15px var(--font-sans)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.72 : 1,
    marginTop: 8,
    position: 'relative',
    overflow: 'hidden',
  };
}

function fileInputOverlayStyle(disabled: boolean): React.CSSProperties {
  return {
    position: 'absolute',
    inset: 0,
    opacity: 0,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 0,
  };
}

function secondaryActionStyle(disabled: boolean): React.CSSProperties {
  return {
    width: 300,
    height: 42,
    border: 0,
    borderRadius: 9,
    background: '#e5e7eb',
    color: '#111827',
    font: '800 15px var(--font-sans)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.72 : 1,
    marginTop: 10,
  };
}

const presetFooterStyle: React.CSSProperties = {
  minHeight: 74,
  padding: '10px 14px',
  background: '#f3f4f6',
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 8,
};

const presetButtonStyle: React.CSSProperties = {
  height: 26,
  border: 0,
  borderRadius: 6,
  background: '#fff',
  color: '#111827',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '0 8px',
  font: '700 12px var(--font-sans)',
  cursor: 'pointer',
};

const sampleFooterStyle: React.CSSProperties = {
  height: 56,
  padding: '0 18px',
  background: '#f3f4f6',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

const sampleLinkStyle: React.CSSProperties = {
  border: 0,
  background: 'transparent',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  color: '#111827',
  font: '700 13px var(--font-sans)',
  cursor: 'pointer',
};

const sampleThumbsStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  color: '#667085',
  font: '500 13px var(--font-sans)',
};

function sampleThumbStyle(background: string): React.CSSProperties {
  return {
    width: 34,
    height: 34,
    borderRadius: 6,
    background,
    border: '1px solid rgba(15,23,42,.08)',
    boxShadow: '0 1px 2px rgba(15,23,42,.08)',
  };
}

const closeButtonStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  border: 0,
  borderRadius: 6,
  cursor: 'pointer',
  display: 'grid',
  placeItems: 'center',
  color: '#98a2b3',
  background: 'transparent',
};

const resourceBackdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 700,
  background: 'rgba(17, 24, 39, 0.38)',
  display: 'grid',
  placeItems: 'center',
  padding: 32,
};

const resourceOverlayStyle: React.CSSProperties = {
  width: 'min(1180px, calc(100vw - 64px))',
  height: 'min(720px, calc(100vh - 64px))',
  background: '#fff',
  display: 'flex',
  flexDirection: 'column',
  borderRadius: 8,
  overflow: 'hidden',
  boxShadow: '0 24px 64px rgba(15,23,42,.28)',
};

const resourceHeaderStyle: React.CSSProperties = {
  height: 42,
  flexShrink: 0,
  borderBottom: '1px solid #e5e7eb',
  display: 'flex',
  alignItems: 'center',
  padding: '0 18px',
  font: '800 15px var(--font-sans)',
  color: '#111827',
};

const resourceCloseStyle: React.CSSProperties = {
  marginLeft: 'auto',
  width: 34,
  height: 34,
  border: 0,
  background: 'transparent',
  display: 'grid',
  placeItems: 'center',
  color: '#98a2b3',
  cursor: 'pointer',
};

const resourceBodyStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'grid',
  gridTemplateColumns: '172px minmax(0, 1fr)',
};

const resourceSiderStyle: React.CSSProperties = {
  borderRight: '1px solid #eef0f2',
  padding: '22px 10px',
};

function resourceNavStyle(active: boolean): React.CSSProperties {
  return {
    width: '100%',
    height: 40,
    border: 0,
    borderRadius: 6,
    background: active ? '#f0f1ee' : 'transparent',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '0 12px',
    color: active ? '#111827' : '#4b5563',
    font: active ? '800 14px var(--font-sans)' : '700 14px var(--font-sans)',
    cursor: 'pointer',
  };
}

const resourceMainStyle: React.CSSProperties = {
  minWidth: 0,
  padding: '22px 24px',
  overflowY: 'auto',
};

const resourceToolbarStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 20,
  marginBottom: 20,
};

const resourceSearchStyle: React.CSSProperties = {
  marginLeft: 'auto',
  width: 330,
  height: 36,
  border: '1px solid #e1e5eb',
  borderRadius: 8,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '0 10px',
};

const resourceSearchInputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: 0,
  outline: 'none',
  background: 'transparent',
  color: '#111827',
  font: '600 13px var(--font-sans)',
};

const resourceSubToolbarStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 18,
};

const resourceCheckboxLabelStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  color: '#4b5563',
  font: '800 14px var(--font-sans)',
};

function resourceSmallCheckboxStyle(checked: boolean): React.CSSProperties {
  return {
    width: 16,
    height: 16,
    borderRadius: 4,
    border: checked ? '1px solid #2563eb' : '1px solid #d8dde5',
    background: checked ? '#2563eb' : '#fff',
    boxShadow: checked ? 'inset 0 0 0 3px #fff' : 'none',
    flexShrink: 0,
  };
}

const resourceToggleStyle: React.CSSProperties = {
  width: 28,
  height: 16,
  borderRadius: 999,
  background: '#e5e7eb',
};

const resourceGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))',
  gap: '24px 18px',
};

const resourceCardStyle: React.CSSProperties = {
  border: 0,
  background: 'transparent',
  padding: 0,
  position: 'relative',
  textAlign: 'center',
  cursor: 'pointer',
  minWidth: 0,
};

const resourceThumbShellStyle: React.CSSProperties = {
  height: 132,
  borderRadius: 10,
  overflow: 'hidden',
  background: '#f4f5f7',
  padding: 5,
  marginBottom: 10,
};

const resourceFileNameStyle: React.CSSProperties = {
  display: 'block',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: '#374151',
  font: '700 13px var(--font-sans)',
};

const resourceFooterStyle: React.CSSProperties = {
  height: 54,
  flexShrink: 0,
  padding: '0 18px',
  background: '#fff',
  borderTop: '1px solid #eef0f2',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 14,
  color: '#374151',
  font: '700 14px var(--font-sans)',
};

function resourceConfirmStyle(disabled: boolean): React.CSSProperties {
  return {
    height: 38,
    minWidth: 70,
    border: 0,
    borderRadius: 10,
    background: disabled ? '#eef0f3' : '#2557f6',
    color: disabled ? '#b7bec8' : '#fff',
    font: '800 14px var(--font-sans)',
    cursor: disabled ? 'not-allowed' : 'pointer',
  };
}
