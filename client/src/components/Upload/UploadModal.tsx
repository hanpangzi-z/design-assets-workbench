import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Upload, FileText, X, CheckCircle2, Folder, ListTree } from 'lucide-react';
import { message, Select } from 'antd';
import { FALLBACK_TRANSFER_CHUNK_SIZE, getTransferConfig, uploadFileByTransfer } from '@/api/transfer';
import { getCategoryTree } from '@/api/categories';
import type { Category } from 'shared/types';

interface Props {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  libraryId?: number;
  initialCategoryIds?: number[];
  mode?: 'file' | 'folder';
}

type Phase = 'idle' | 'uploading' | 'done';

const DIM_LABELS: Record<string, string> = {
  festival: '节日',
  design_type: '设计类型',
  product_type: '品类',
  version: '版本',
};

const SUPPORTED_EXTENSIONS = new Set([
  'psd', 'psb', 'ai', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'pptx', 'ppt',
  'ttf', 'otf', 'ttc', 'woff', 'woff2',
]);

const DEFAULT_MAX_BATCH_FILES = 50;
const DEFAULT_MAX_FILE_SIZE = 30 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_SIZE = 100 * 1024 * 1024;

export default function UploadModal({ open, onClose, onSuccess, libraryId, initialCategoryIds = [], mode = 'file' }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState('');
  const [fileSize, setFileSize] = useState('');
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedDimensions, setSelectedDimensions] = useState<string[]>([]);
  const [categoryByDimension, setCategoryByDimension] = useState<Record<string, number | undefined>>({});
  const [openSubCategory, setOpenSubCategory] = useState<string | undefined>();
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [uploadLimits, setUploadLimits] = useState({
    maxBatchFiles: DEFAULT_MAX_BATCH_FILES,
    maxFileSize: DEFAULT_MAX_FILE_SIZE,
    maxTotalSize: DEFAULT_MAX_TOTAL_SIZE,
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadingRef = useRef(false);
  const isFolderMode = mode === 'folder';

  useEffect(() => {
    if (!open) return;
    if (!libraryId) {
      setCategories([]);
      return;
    }
    getCategoryTree({ libraryId }).then(setCategories).catch(() => setCategories([]));
  }, [open, libraryId]);

  useEffect(() => {
    if (!open) return;
    getTransferConfig()
      .then((config) => setUploadLimits({
        maxBatchFiles: config.maxBatchFiles,
        maxFileSize: config.maxFileSize,
        maxTotalSize: config.maxTotalSize,
      }))
      .catch(() => setUploadLimits({
        maxBatchFiles: DEFAULT_MAX_BATCH_FILES,
        maxFileSize: DEFAULT_MAX_FILE_SIZE,
        maxTotalSize: DEFAULT_MAX_TOTAL_SIZE,
      }));
  }, [open]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    if (isFolderMode) {
      input.setAttribute('webkitdirectory', '');
      input.setAttribute('directory', '');
    } else {
      input.removeAttribute('webkitdirectory');
      input.removeAttribute('directory');
    }
  }, [isFolderMode, open]);

  const categoryGroups = useMemo(() => {
    const groups = new Map<string, Array<Category & { prefix: string }>>();
    flattenCategories(categories)
      .filter((cat) => Boolean(cat.dimension))
      .forEach((cat) => {
        const dim = String(cat.dimension);
        groups.set(dim, [...(groups.get(dim) || []), cat]);
      });
    return Array.from(groups.entries()).map(([dimension, items]) => ({
      dimension,
      label: DIM_LABELS[dimension] || dimension,
      items,
    }));
  }, [categories]);

  const categoryOptions = useMemo(() => categoryGroups.map((group) => ({
    value: group.dimension,
    label: group.label,
  })), [categoryGroups]);

  const categoryIds = useMemo(() => selectedDimensions
    .map((dimension) => categoryByDimension[dimension])
    .filter((value): value is number => typeof value === 'number'), [categoryByDimension, selectedDimensions]);
  const initialCategoryKey = initialCategoryIds.join(',');

  useEffect(() => {
    if (!open || initialCategoryIds.length === 0 || categoryGroups.length === 0) return;

    const nextDimensions: string[] = [];
    const nextByDimension: Record<string, number | undefined> = {};
    const categoryMeta = new Map<number, { dimension: string }>();

    categoryGroups.forEach((group) => {
      group.items.forEach((category) => {
        categoryMeta.set(category.id, { dimension: group.dimension });
      });
    });

    normalizeCategoryIdsByGroup(initialCategoryIds, categoryGroups).forEach((categoryId) => {
      const meta = categoryMeta.get(categoryId);
      if (!meta || nextByDimension[meta.dimension]) return;
      nextDimensions.push(meta.dimension);
      nextByDimension[meta.dimension] = categoryId;
    });

    setSelectedDimensions(nextDimensions);
    setCategoryByDimension(nextByDimension);
  }, [open, initialCategoryKey, categoryGroups]);

  const reset = (keepMeta = false) => {
    setPhase('idle');
    setProgress(0);
    setDragging(false);
    setOpenSubCategory(undefined);
    setCategoryOpen(false);
    setFileName('');
    setFileSize('');
    if (!keepMeta) {
      setSelectedDimensions([]);
      setCategoryByDimension({});
    }
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const doUploadFiles = useCallback(async (sourceFiles: File[]) => {
    if (uploadingRef.current) return;
    const validFiles = sourceFiles.filter(isSupportedUploadFile);
    if (validFiles.length === 0) {
      message.warning(isFolderMode ? '文件夹中没有可上传的支持格式文件' : '请选择支持的文件格式');
      return;
    }

    const config = await getTransferConfig().catch(() => ({
      chunkSize: FALLBACK_TRANSFER_CHUNK_SIZE,
      uploadConcurrency: 3,
      maxBatchFiles: uploadLimits.maxBatchFiles,
      maxFileSize: uploadLimits.maxFileSize,
      maxTotalSize: uploadLimits.maxTotalSize,
    }));
    const maxBatchFiles = config.maxBatchFiles || DEFAULT_MAX_BATCH_FILES;
    const maxFileSize = config.maxFileSize || DEFAULT_MAX_FILE_SIZE;
    const maxTotalSize = config.maxTotalSize || DEFAULT_MAX_TOTAL_SIZE;
    const oversize = validFiles.find((file) => file.size > maxFileSize);
    if (oversize) {
      message.error(`${oversize.name} 超过 ${formatTotalSize(maxFileSize)}`);
      return;
    }

    const uploadFiles = isFolderMode ? validFiles : validFiles.slice(0, maxBatchFiles);
    if (!isFolderMode && validFiles.length > maxBatchFiles) {
      message.warning(`单次最多上传 ${maxBatchFiles} 个文件，已取前 ${maxBatchFiles} 个`);
    }
    const totalSize = uploadFiles.reduce((sum, file) => sum + file.size, 0);
    if (totalSize > maxTotalSize) {
      message.error(`本次上传总大小不能超过 ${formatTotalSize(maxTotalSize)}`);
      return;
    }
    if (sourceFiles.length !== validFiles.length) {
      message.warning(`已忽略 ${sourceFiles.length - validFiles.length} 个不支持的文件`);
    }

    setFileName(uploadFiles.length === 1 ? uploadFiles[0].name : `${uploadFiles.length} 个文件`);
    setFileSize(formatTotalSize(totalSize));
    setPhase('uploading');
    setProgress(0);
    uploadingRef.current = true;

    try {
      for (let index = 0; index < uploadFiles.length; index += 1) {
        const file = uploadFiles[index];
        await uploadFileByTransfer(file, {
          libraryId,
          categoryId: categoryIds[0],
          categoryTagIds: categoryIds,
          relativePath: isFolderMode ? getFileRelativePath(file) : undefined,
        }, ({ percent }) => {
          const pct = percent;
          setProgress(Math.round(((index + pct / 100) / uploadFiles.length) * 100));
        });
      }
      refreshFontCss();
      setPhase('done');
      onSuccess?.();
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '上传失败');
      setPhase('idle');
    } finally {
      uploadingRef.current = false;
    }
  }, [categoryIds, isFolderMode, libraryId, onSuccess, uploadLimits.maxBatchFiles, uploadLimits.maxFileSize, uploadLimits.maxTotalSize]);

  const handleDimensionChange = (values: string[]) => {
    setSelectedDimensions(values);
    setCategoryByDimension((current) => {
      const next: Record<string, number | undefined> = {};
      values.forEach((dimension) => {
        next[dimension] = current[dimension];
      });
      return next;
    });
    setOpenSubCategory(undefined);
    setCategoryOpen(false);
  };

  const handleSubCategoryChange = (dimension: string, value?: number) => {
    setCategoryByDimension((current) => ({
      ...current,
      [dimension]: value,
    }));
    setOpenSubCategory(undefined);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) void doUploadFiles(files);
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length > 0) void doUploadFiles(files);
  };

  const swallowDragEvent = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  if (!open) return null;

  return (
    <>
      <div
        style={backdropStyle}
        onDragEnter={swallowDragEvent}
        onDragOver={swallowDragEvent}
        onDragLeave={swallowDragEvent}
        onDrop={swallowDragEvent}
      />

      <div
        style={modalStyle}
        onDragEnter={swallowDragEvent}
        onDragOver={swallowDragEvent}
        onDragLeave={swallowDragEvent}
        onDrop={swallowDragEvent}
      >
        <div style={headerStyle}>
          <div>
            <h3 style={{ font: '700 18px var(--font-sans)', color: 'var(--fg-1)', margin: 0 }}>
              <span>{phase === 'done' ? '上传完成' : isFolderMode ? '上传文件夹' : '上传文件'}</span>
            </h3>
            <div style={{ font: 'var(--type-caption)', color: 'var(--fg-3)', marginTop: 4 }}>
              可选择多个大分类，每个大分类下只能选择一个子分类。
            </div>
          </div>
          <span onClick={phase === 'uploading' ? undefined : handleClose} style={{
            ...closeButtonStyle,
            cursor: phase === 'uploading' ? 'not-allowed' : 'pointer',
            opacity: phase === 'uploading' ? 0.45 : 1,
          }}>
            <X size={18} />
          </span>
        </div>

        {phase === 'idle' && (
          <div style={{ padding: 24 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12, marginBottom: 16 }}>
              <label style={fieldStyle}>
                <span style={fieldLabelStyle}><Folder size={13} /> 分类</span>
                <Select
                  mode="multiple"
                  allowClear
                  showSearch
                  placeholder="选择大分类"
                  value={selectedDimensions}
                  options={categoryOptions}
                  onChange={handleDimensionChange}
                  open={categoryOpen}
                  onDropdownVisibleChange={setCategoryOpen}
                  onSelect={() => window.setTimeout(() => setCategoryOpen(false), 0)}
                  onDeselect={() => window.setTimeout(() => setCategoryOpen(false), 0)}
                  onClear={() => setCategoryOpen(false)}
                  optionFilterProp="label"
                  size="large"
                  maxTagCount="responsive"
                  style={{ width: '100%' }}
                />
              </label>

              <div style={fieldStyle}>
                <span style={fieldLabelStyle}><ListTree size={13} /> 子分类</span>
                {selectedDimensions.length === 0 ? (
                  <div style={emptySubCategoryStyle}>先选择需要的分类</div>
                ) : (
                  <div style={subCategoryListStyle}>
                    {selectedDimensions.map((dimension) => {
                      const group = categoryGroups.find((item) => item.dimension === dimension);
                      const options = (group?.items || []).map((cat) => ({
                        value: cat.id,
                        label: `${cat.prefix}${cat.name}`,
                      }));
                      return (
                        <div key={dimension} style={subCategoryRowStyle}>
                          <span style={subCategoryNameStyle}>{group?.label || dimension}</span>
                          <Select
                            allowClear
                            showSearch
                            placeholder={`选择${group?.label || dimension}下的子分类`}
                            open={openSubCategory === dimension}
                            onDropdownVisibleChange={(visible) => setOpenSubCategory(visible ? dimension : undefined)}
                            value={categoryByDimension[dimension]}
                            options={options}
                            onChange={(value) => handleSubCategoryChange(
                              dimension,
                              typeof value === 'number' ? value : undefined,
                            )}
                            optionFilterProp="label"
                            size="large"
                            style={{ width: '100%' }}
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div
              onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(true); }}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(true); }}
              onDragLeave={(e) => { e.stopPropagation(); setDragging(false); }}
              onDrop={handleDrop}
              style={{
                border: `2px dashed ${dragging ? 'var(--brand-teal-500)' : 'var(--border-1)'}`,
                borderRadius: 8,
                padding: '46px 24px',
                textAlign: 'center',
                background: dragging ? 'var(--brand-teal-50)' : 'var(--n-50)',
                transition: 'all .12s',
                cursor: 'pointer',
              }}
              onClick={() => inputRef.current?.click()}
            >
              <Upload size={36} style={{ color: 'var(--fg-3)', margin: '0 auto 12px' }} />
              <div style={{ font: 'var(--type-body-lg)', color: 'var(--fg-2)', marginBottom: 8 }}>
                {isFolderMode ? '点击选择文件夹，自动上传其中支持的文件' : '拖放文件至此处，或点击选择'}
              </div>
              <div style={{ font: 'var(--type-caption)', color: 'var(--fg-4)' }}>
                支持 PSD / AI / SVG / PNG / JPG / GIF / WEBP / PDF / PPTX / TTF / OTF / WOFF，单文件最大 {formatTotalSize(uploadLimits.maxFileSize)}，单次总大小最大 {formatTotalSize(uploadLimits.maxTotalSize)}
              </div>
            </div>
            <input
              ref={inputRef}
              type="file"
              hidden
              multiple
              onChange={handleFileSelect}
              accept=".psd,.psb,.ai,.svg,.png,.jpg,.jpeg,.gif,.webp,.pdf,.pptx,.ppt,.ttf,.otf,.ttc,.woff,.woff2"
            />

            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'center' }}>
              {['PSD', 'AI', 'SVG', 'PNG', 'PDF', 'TTF', 'OTF', 'WOFF'].map((fmt) => (
                <span key={fmt} style={{
                  padding: '3px 10px',
                  borderRadius: 4,
                  background: 'var(--n-100)',
                  color: 'var(--fg-3)',
                  font: '500 11px var(--font-sans)',
                }}>{fmt}</span>
              ))}
            </div>
          </div>
        )}

        {phase === 'uploading' && (
          <div style={{ textAlign: 'center', padding: '54px 32px 48px' }}>
            <FileText size={40} style={{ color: 'var(--brand-teal-500)', margin: '0 auto 16px' }} />
            <div style={{ font: 'var(--type-label)', color: 'var(--fg-1)', marginBottom: 4 }}>{fileName}</div>
            <div style={{ font: 'var(--type-caption)', color: 'var(--fg-3)', marginBottom: 16 }}>{fileSize}</div>
            <div style={{ height: 6, background: 'var(--n-100)', borderRadius: 3, overflow: 'hidden', maxWidth: 400, margin: '0 auto' }}>
              <div style={{
                width: `${progress}%`,
                height: '100%',
                background: 'var(--brand-teal-500)',
                transition: 'width .3s ease',
              }} />
            </div>
            <div style={{ font: 'var(--type-caption)', color: 'var(--fg-3)', marginTop: 8 }}>
              上传中 {progress}%
            </div>
          </div>
        )}

        {phase === 'done' && (
          <div style={{ textAlign: 'center', padding: '54px 32px 42px' }}>
            <CheckCircle2 size={48} style={{ color: 'var(--color-success-fg)', margin: '0 auto 16px' }} />
            <div style={{ font: 'var(--type-body-lg)', color: 'var(--fg-1)', marginBottom: 4 }}>{fileName}</div>
            <div style={{ font: 'var(--type-caption)', color: 'var(--fg-3)', marginBottom: 24 }}>{fileSize} · 上传成功</div>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
              <button
                onClick={() => reset(true)}
                style={{
                  padding: '0 20px',
                  height: 36,
                  borderRadius: 6,
                  border: '1px solid var(--border-1)',
                  background: '#fff',
                  color: 'var(--fg-1)',
                  font: '500 14px var(--font-sans)',
                  cursor: 'pointer',
                }}
              >再上传一个</button>
              <button
                onClick={handleClose}
                style={{
                  padding: '0 20px',
                  height: 36,
                  borderRadius: 6,
                  border: 'none',
                  background: 'var(--brand-teal-500)',
                  color: '#fff',
                  font: '500 14px var(--font-sans)',
                  cursor: 'pointer',
                }}
              >完成</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function flattenCategories(categories: Category[], prefix = ''): Array<Category & { prefix: string }> {
  return categories.flatMap((cat) => [
    { ...cat, prefix },
    ...flattenCategories(cat.children || [], `${prefix}${cat.name} / `),
  ]);
}

function normalizeCategoryIdsByGroup(ids: number[], groups: Array<{ items: Category[] }>) {
  const selectedIds = new Set(ids);
  return groups.flatMap((group) => {
    const selectedInGroup = group.items.filter((category) => selectedIds.has(category.id));
    return selectedInGroup
      .filter((category) => !hasSelectedDescendant(category, selectedIds))
      .slice(-1)
      .map((category) => category.id);
  });
}

function hasSelectedDescendant(category: Category, selectedIds: Set<number>): boolean {
  return (category.children || []).some((child) => (
    selectedIds.has(child.id) || hasSelectedDescendant(child, selectedIds)
  ));
}

function isSupportedUploadFile(file: File) {
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  return SUPPORTED_EXTENSIONS.has(ext);
}

function getFileRelativePath(file: File) {
  const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return relativePath || file.name;
}

function formatTotalSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function refreshFontCss() {
  const href = `/api/v1/fonts/css?t=${Date.now()}`;
  const existing = document.getElementById('custom-fonts-css') as HTMLLinkElement | null;
  if (existing) {
    existing.href = href;
    return;
  }
  const link = document.createElement('link');
  link.id = 'custom-fonts-css';
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

const fieldStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const fieldLabelStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  font: '500 12px var(--font-sans)',
  color: 'var(--fg-2)',
};

const emptySubCategoryStyle: React.CSSProperties = {
  minHeight: 40,
  borderRadius: 8,
  border: '1px solid var(--border-1)',
  background: 'var(--n-50)',
  color: 'var(--fg-4)',
  display: 'flex',
  alignItems: 'center',
  padding: '0 12px',
  font: '500 13px var(--font-sans)',
};

const subCategoryListStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const subCategoryRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '76px minmax(0, 1fr)',
  alignItems: 'center',
  gap: 10,
};

const subCategoryNameStyle: React.CSSProperties = {
  color: 'var(--fg-3)',
  font: '600 13px var(--font-sans)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const backdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(20, 20, 19, 0.42)',
  zIndex: 1000,
  backdropFilter: 'blur(2px)',
};

const modalStyle: React.CSSProperties = {
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  width: 640,
  maxWidth: 'calc(100vw - 40px)',
  background: '#fff',
  borderRadius: 10,
  padding: 0,
  boxShadow: 'var(--shadow-xl)',
  zIndex: 1001,
  overflow: 'hidden',
  border: '1px solid var(--border-2)',
};

const headerStyle: React.CSSProperties = {
  minHeight: 68,
  padding: '16px 22px',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  borderBottom: '1px solid var(--border-2)',
  background: '#fff',
};

const closeButtonStyle: React.CSSProperties = {
  color: 'var(--fg-3)',
  width: 30,
  height: 30,
  borderRadius: 6,
  display: 'grid',
  placeItems: 'center',
  background: 'var(--n-50)',
};
