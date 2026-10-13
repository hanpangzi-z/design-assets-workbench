import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Edit3, Sparkles, Plus, X, ZoomIn, ZoomOut, Maximize, MoreHorizontal } from 'lucide-react';
import { Spin, message } from 'antd';
import { getCategoryTree } from '@/api/categories';
import { getFileById, updateFile, useTemplate } from '@/api/files';
import { getTags, createTag } from '@/api/tags';
import Thumb from '@/components/FileCard/Thumb';
import { appendAssetVersion, getAssetPreviewPath } from '@/utils/assetPreview';
import type { Category, DesignFile, Tag } from 'shared/types';

const DIM_LABELS: Record<string, string> = { festival: '节日', design_type: '设计类型', product_type: '品类', version: '版本' };

type FlatCategory = Category & { prefix: string; groupLabel: string; groupKey: string };
type CategoryGroup = { key: string; label: string; items: FlatCategory[] };

export default function ResourceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [file, setFile] = useState<DesignFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState(100);
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<number[]>([]);
  const [savingCategories, setSavingCategories] = useState(false);
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [savingTags, setSavingTags] = useState(false);
  const tagInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    getFileById(Number(id))
      .then(setFile)
      .catch(() => message.error('资源加载失败'))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (!file?.libraryId) {
      setCategories([]);
      return;
    }
    getCategoryTree({ libraryId: file.libraryId }).then(setCategories).catch(() => setCategories([]));
  }, [file?.libraryId]);

  const previewSrc = useMemo(() => {
    if (!file) return '';
    const assetPath = getAssetPreviewPath(file, { preferOriginalForPortrait: true });
    if (assetPath) return appendAssetVersion(assetPath, file.updatedAt || file.id);
    if (['png', 'jpg', 'svg'].includes(file.fileType)) return `/api/v1/files/${file.id}/preview`;
    return '';
  }, [file]);

  const flatCategories = useMemo(() => flattenCategories(categories).filter((cat) => Boolean(cat.groupKey)), [categories]);
  const categoryById = useMemo(() => new Map(flatCategories.map((cat) => [cat.id, cat])), [flatCategories]);
  const categoryNameSet = useMemo(() => new Set(flatCategories.map((cat) => cat.name)), [flatCategories]);
  const selectedCategorySet = useMemo(() => new Set(selectedCategoryIds), [selectedCategoryIds]);
  const selectedCategories = useMemo(() => {
    return selectedCategoryIds.map((categoryId) => categoryById.get(categoryId)).filter(Boolean) as FlatCategory[];
  }, [categoryById, selectedCategoryIds]);
  const categoryGroups = useMemo(() => {
    const groups = new Map<string, CategoryGroup>();
    flatCategories.forEach((cat) => {
      const group = groups.get(cat.groupKey);
      if (group) {
        group.items.push(cat);
      } else {
        groups.set(cat.groupKey, { key: cat.groupKey, label: cat.groupLabel || cat.groupKey, items: [cat] });
      }
    });
    return Array.from(groups.values());
  }, [flatCategories]);
  const displayTags = useMemo(() => {
    return (file?.tags || []).filter((tag) => !categoryNameSet.has(tag.name));
  }, [file?.tags, categoryNameSet]);
  const categoryTagIds = useMemo(() => {
    return (file?.tags || []).filter((tag) => categoryNameSet.has(tag.name)).map((tag) => tag.id);
  }, [file?.tags, categoryNameSet]);
  const selectableTags = useMemo(() => {
    return allTags.filter((tag) => !categoryNameSet.has(tag.name));
  }, [allTags, categoryNameSet]);

  useEffect(() => {
    if (!file) return;
    setSelectedCategoryIds(normalizeCategoryIdsByGroup(resolveSelectedCategoryIds(file, flatCategories), categoryGroups));
  }, [file, flatCategories, categoryGroups]);

  const handleCategoryChange = async (nextIds: number[]) => {
    if (!file) return;
    const normalizedIds = normalizeCategoryIdsByGroup(nextIds, categoryGroups);
    setSelectedCategoryIds(normalizedIds);
    setSavingCategories(true);
    try {
      const updated = await updateFile(file.id, {
        categoryId: normalizedIds[0] || null,
        categoryTagIds: normalizedIds,
      });
      setFile(updated);
      message.success('分类已更新');
    } catch (err: any) {
      message.error(err?.response?.data?.message || '分类更新失败');
      setSelectedCategoryIds(normalizeCategoryIdsByGroup(resolveSelectedCategoryIds(file, flatCategories), categoryGroups));
    } finally {
      setSavingCategories(false);
    }
  };

  const toggleCategory = (categoryId: number) => {
    const group = categoryGroups.find((item) => item.items.some((category) => category.id === categoryId));
    if (!group) return;
    const groupIds = new Set(group.items.map((category) => category.id));
    const outsideGroupIds = selectedCategoryIds.filter((id) => !groupIds.has(id));
    const nextIds = selectedCategorySet.has(categoryId)
      ? outsideGroupIds
      : [...outsideGroupIds, categoryId];
    handleCategoryChange(nextIds);
  };

  useEffect(() => {
    getTags().then(setAllTags).catch(() => setAllTags([]));
  }, []);

  useEffect(() => {
    if (tagPickerOpen) window.setTimeout(() => tagInputRef.current?.focus(), 0);
  }, [tagPickerOpen]);

  const persistFileTags = async (nextTagIds: number[]) => {
    if (!file) return;
    setSavingTags(true);
    try {
      const updated = await updateFile(file.id, { tagIds: Array.from(new Set([...categoryTagIds, ...nextTagIds])) });
      setFile(updated);
    } catch (err: any) {
      message.error(err?.response?.data?.message || '标签更新失败');
    } finally {
      setSavingTags(false);
    }
  };

  const toggleFileTag = async (tag: Tag) => {
    if (!file) return;
    const currentIds = displayTags.map((t) => t.id);
    const has = currentIds.includes(tag.id);
    const nextIds = has ? currentIds.filter((id) => id !== tag.id) : [...currentIds, tag.id];
    await persistFileTags(nextIds);
  };

  const removeFileTag = async (tagId: number) => {
    if (!file) return;
    const nextIds = displayTags.map((t) => t.id).filter((id) => id !== tagId);
    await persistFileTags(nextIds);
  };

  const commitNewTag = async () => {
    const name = newTagName.trim();
    if (!name) return;
    if (!file) return;
    if (categoryNameSet.has(name)) {
      message.warning('该名称已经是分类，请换一个标签名');
      return;
    }
    const existing = selectableTags.find((t) => t.name === name);
    setSavingTags(true);
    try {
      let target = existing;
      if (!target) {
        target = await createTag({ name });
        setAllTags((prev) => [...prev, target!]);
      }
      const currentIds = displayTags.map((t) => t.id);
      if (!currentIds.includes(target.id)) {
        const updated = await updateFile(file.id, { tagIds: Array.from(new Set([...categoryTagIds, ...currentIds, target.id])) });
        setFile(updated);
      }
      setNewTagName('');
      message.success('已添加');
    } catch (err: any) {
      message.error(err?.response?.data?.message || '添加失败');
    } finally {
      setSavingTags(false);
    }
  };

  const openEditableCopy = async () => {
    if (!file) return;
    try {
      const personalCopy = await useTemplate(file.id);
      navigate(`/editor/${personalCopy.id}`);
    } catch (err: any) {
      message.error(err?.response?.data?.message || '创建编辑副本失败');
    }
  };

  if (loading) {
    return <div style={{ flex: 1, display: 'grid', placeItems: 'center' }}><Spin size="large" /></div>;
  }

  if (!file) {
    return <div style={{ padding: 48, color: 'var(--fg-3)' }}>资源不存在</div>;
  }

  return (
    <div style={{ flex: 1, padding: '24px 32px', overflow: 'hidden', background: '#fff', minHeight: 0 }}>
      <div style={shellStyle}>
        <button onClick={() => navigate('/admin/resources')} style={backButtonStyle} title="返回">
          <ArrowLeft size={22} />
        </button>

        <div style={previewStageStyle}>
          <div style={{ transform: `scale(${zoom / 100})`, transformOrigin: 'center', transition: 'transform .12s', display: 'inline-block' }}>
            {previewSrc ? (
              <img
                src={previewSrc}
                alt={file.name}
                style={{
                  maxWidth: 'min(1100px, calc(100vw - 480px))',
                  maxHeight: 'calc(100vh - 180px)',
                  objectFit: 'contain',
                  display: 'block',
                  boxShadow: file.thumbnailPath ? '0 1px 2px rgba(20,20,19,.06)' : 'none',
                }}
              />
            ) : (
              <div style={{ width: 'min(900px, calc(100vw - 480px))' }}>
                <Thumb thumbnailUrl={file.thumbnailPath} fileType={file.fileType} label={file.name?.charAt(0)} height={520} file={file} name={file.name} />
              </div>
            )}
          </div>
        </div>

        <div style={zoomBarStyle}>
          <button style={zoomButtonStyle} onClick={() => setZoom((v) => Math.max(40, v - 10))}><ZoomOut size={15} /></button>
          <span style={{ minWidth: 44, textAlign: 'center', font: 'var(--type-caption)', color: 'var(--fg-1)' }}>{zoom}%</span>
          <button style={zoomButtonStyle} onClick={() => setZoom((v) => Math.min(200, v + 10))}><ZoomIn size={15} /></button>
          <button style={zoomButtonStyle} onClick={() => setZoom(100)}><Maximize size={15} /></button>
        </div>

        <aside style={panelStyle}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 24 }}>
            <MoreHorizontal size={22} style={{ color: 'var(--fg-2)' }} />
          </div>
          <h2 style={{ font: '800 18px var(--font-sans)', color: 'var(--fg-1)', marginBottom: 18, wordBreak: 'break-word' }}>
            {file.name}
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 30 }}>
            <button onClick={openEditableCopy} style={primaryEditButtonStyle}>
              <Edit3 size={15} /> 编辑
            </button>
            <button onClick={openEditableCopy} style={secondaryEditButtonStyle}>
              <Sparkles size={15} /> AI 编辑
            </button>
          </div>

          <SectionTitle>基本信息</SectionTitle>
          <InfoRow label="颜色"><ColorStrip /></InfoRow>
          <InfoRow label="大小">{formatFileSize(file.fileSize)}</InfoRow>
          <InfoRow label="添加时间">{formatDate(file.createdAt)}</InfoRow>
          <InfoRow label="修改时间">{formatDate(file.updatedAt)}</InfoRow>
          <InfoRow label="所有者">{file.uploader?.displayName || '-'}</InfoRow>
          <InfoRow label="合规检测">
            <span style={passChipStyle}>未涉政</span>
            <span style={passChipStyle}>未涉黄</span>
            <span style={passChipStyle}>未涉暴</span>
          </InfoRow>

          <div style={{ height: 24 }} />
          <SectionTitle>分类</SectionTitle>
          <div style={categoryBlockStyle}>
            {categoryPickerOpen && <div onClick={() => setCategoryPickerOpen(false)} style={pickerBackdropStyle} />}
            <button
              type="button"
              onClick={() => setCategoryPickerOpen((open) => !open)}
              disabled={savingCategories}
              style={categoryAddChipStyle}
              title="添加分类"
            >
              <Plus size={14} />
            </button>
            {selectedCategories.map((category) => (
              <button
                key={category.id}
                type="button"
                onClick={() => toggleCategory(category.id)}
                disabled={savingCategories}
                style={categoryChipStyle}
                title="点击取消该分类"
              >
                {category.name}
              </button>
            ))}
            {selectedCategories.length === 0 && (
              <span style={{ ...categoryChipStyle, color: 'var(--fg-4)' }}>未分类</span>
            )}
            {categoryPickerOpen && (
              <div style={categoryPickerStyle}>
                {categoryGroups.length === 0 ? (
                  <div style={{ padding: 12, color: 'var(--fg-4)', font: 'var(--type-caption)' }}>暂无可选分类</div>
                ) : categoryGroups.map((group) => (
                  <div key={group.key} style={{ padding: '8px 10px' }}>
                    <div style={{ font: '700 12px var(--font-sans)', color: 'var(--fg-3)', marginBottom: 8 }}>{group.label}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                      {group.items.map((category) => {
                        const active = selectedCategorySet.has(category.id);
                        return (
                          <button
                            key={category.id}
                            type="button"
                            onClick={() => toggleCategory(category.id)}
                            disabled={savingCategories}
                            style={pickerChipStyle(active)}
                            title={category.prefix ? `${category.prefix}${category.name}` : category.name}
                          >
                            {category.prefix ? `${category.prefix}${category.name}` : category.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <SectionTitle>标签</SectionTitle>
          <div style={tagBlockStyle}>
            {tagPickerOpen && <div onClick={() => setTagPickerOpen(false)} style={pickerBackdropStyle} />}
            {displayTags.map((tag) => (
              <span key={tag.id} style={tagChipStyle}>
                {tag.name}
                <X
                  size={11}
                  style={{ cursor: savingTags ? 'not-allowed' : 'pointer', color: 'var(--fg-4)' }}
                  onClick={() => !savingTags && removeFileTag(tag.id)}
                />
              </span>
            ))}
            <button
              type="button"
              onClick={() => setTagPickerOpen((open) => !open)}
              disabled={savingTags}
              style={ghostAddButtonStyle}
            >
              <Plus size={13} /> 添加标签
            </button>
            {tagPickerOpen && (
              <div style={tagPickerStyle} onClick={(e) => e.stopPropagation()}>
                <div style={{ display: 'flex', gap: 6, padding: 10, borderBottom: '1px solid var(--border-2)' }}>
                  <input
                    ref={tagInputRef}
                    value={newTagName}
                    onChange={(e) => setNewTagName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); commitNewTag(); }
                      if (e.key === 'Escape') setTagPickerOpen(false);
                    }}
                    placeholder="搜索或新建标签"
                    maxLength={32}
                    style={tagPickerInputStyle}
                  />
                  <button
                    type="button"
                    onClick={commitNewTag}
                    disabled={!newTagName.trim() || savingTags}
                    style={tagPickerAddButtonStyle(Boolean(newTagName.trim()) && !savingTags)}
                  >
                    添加
                  </button>
                </div>
                <div style={{ maxHeight: 200, overflowY: 'auto', padding: 8 }}>
                  {(() => {
                    const fileTagIds = new Set(displayTags.map((t) => t.id));
                    const filtered = selectableTags.filter((t) => !newTagName.trim() || t.name.toLowerCase().includes(newTagName.trim().toLowerCase()));
                    if (filtered.length === 0) {
                      return <div style={{ padding: 8, color: 'var(--fg-4)', font: 'var(--type-caption)' }}>没有匹配标签，按 Enter 新建</div>;
                    }
                    return (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {filtered.map((tag) => {
                          const active = fileTagIds.has(tag.id);
                          return (
                            <button
                              key={tag.id}
                              type="button"
                              onClick={() => toggleFileTag(tag)}
                              disabled={savingTags}
                              style={pickerChipStyle(active)}
                            >
                              {active && <span style={{ marginRight: 4 }}>✓</span>}
                              {tag.name}
                            </button>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ font: '800 13px var(--font-sans)', color: 'var(--fg-1)', marginBottom: 12 }}>{children}</div>;
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '78px 1fr', gap: 10, minHeight: 30, alignItems: 'center', font: 'var(--type-body)' }}>
      <span style={{ color: 'var(--fg-3)' }}>{label}</span>
      <div style={{ color: 'var(--fg-2)', display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>{children}</div>
    </div>
  );
}

function flattenCategories(categories: Category[], prefix = '', groupLabel = '', groupKey = ''): FlatCategory[] {
  return categories.flatMap((cat) => {
    const dimension = cat.dimension ? String(cat.dimension) : '';
    const nextGroupKey = groupKey || dimension;
    const nextGroupLabel = groupLabel || (dimension ? (DIM_LABELS[dimension] || dimension) : '');
    return [
      { ...cat, prefix, groupLabel: nextGroupLabel, groupKey: nextGroupKey },
      ...flattenCategories(cat.children || [], `${prefix}${cat.name} / `, nextGroupLabel, nextGroupKey),
    ];
  });
}

function resolveSelectedCategoryIds(file: DesignFile, categories: FlatCategory[]) {
  const ids = new Set<number>();
  if (file.categoryId) ids.add(file.categoryId);
  (file.categoryAssignments || []).forEach((category) => ids.add(category.id));

  const categoriesByName = new Map<string, FlatCategory[]>();
  categories.forEach((cat) => {
    categoriesByName.set(cat.name, [...(categoriesByName.get(cat.name) || []), cat]);
  });
  (file.tags || []).forEach((tag) => {
    const matches = categoriesByName.get(tag.name) || [];
    if (matches.length === 1) ids.add(matches[0].id);
  });

  return Array.from(ids);
}

function normalizeCategoryIdsByGroup(ids: number[], groups: CategoryGroup[]) {
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

function ColorStrip() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 28px)', height: 8, overflow: 'hidden' }}>
      {['#7FA263', '#E2C757', '#76C4DD', '#E9773A', '#84CFD2'].map((color) => <span key={color} style={{ background: color }} />)}
    </div>
  );
}

function formatDate(value?: string) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(/\//g, '/');
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

const shellStyle: React.CSSProperties = {
  height: 'calc(100vh - 48px)',
  minHeight: 620,
  border: '1px solid var(--border-2)',
  borderRadius: 14,
  position: 'relative',
  overflow: 'hidden',
  background: '#fff',
};

const backButtonStyle: React.CSSProperties = {
  position: 'absolute',
  top: 24,
  left: 24,
  zIndex: 2,
  border: 0,
  background: 'transparent',
  color: 'var(--fg-2)',
  cursor: 'pointer',
};

const previewStageStyle: React.CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 360,
  top: 0,
  bottom: 0,
  display: 'grid',
  placeItems: 'center',
  background: '#fff',
  overflow: 'auto',
};

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  right: 0,
  bottom: 0,
  width: 360,
  borderLeft: '1px solid var(--border-2)',
  background: '#fff',
  padding: '26px 30px',
  overflow: 'auto',
};

const zoomBarStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 24,
  left: 'calc((100% - 360px) / 2)',
  transform: 'translateX(-50%)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 10px',
  borderRadius: 8,
  background: 'rgba(255,255,255,.9)',
};

const zoomButtonStyle: React.CSSProperties = {
  width: 26,
  height: 26,
  border: 0,
  background: 'transparent',
  color: 'var(--fg-2)',
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
};

const primaryEditButtonStyle: React.CSSProperties = {
  height: 40,
  border: 0,
  borderRadius: 8,
  background: '#2D5AF0',
  color: '#fff',
  font: '700 13px var(--font-sans)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  cursor: 'pointer',
};

const secondaryEditButtonStyle: React.CSSProperties = {
  ...primaryEditButtonStyle,
  background: 'var(--n-100)',
  color: 'var(--fg-2)',
};

const categoryBlockStyle: React.CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  marginBottom: 18,
  minHeight: 34,
};

const categoryAddChipStyle: React.CSSProperties = {
  height: 30,
  minWidth: 30,
  padding: '0 9px',
  borderRadius: 6,
  border: 0,
  background: 'var(--n-100)',
  color: 'var(--fg-3)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
};

const categoryChipStyle: React.CSSProperties = {
  height: 30,
  padding: '0 12px',
  borderRadius: 6,
  border: 0,
  background: 'var(--n-100)',
  color: 'var(--fg-2)',
  font: '500 12px var(--font-sans)',
  display: 'inline-flex',
  alignItems: 'center',
  cursor: 'pointer',
};

const pickerBackdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 4,
  background: 'transparent',
};

const categoryPickerStyle: React.CSSProperties = {
  position: 'absolute',
  top: 36,
  left: 0,
  right: 0,
  zIndex: 5,
  maxHeight: 280,
  overflowY: 'auto',
  padding: '4px 0',
  borderRadius: 8,
  border: '1px solid var(--border-1)',
  background: '#fff',
  boxShadow: 'var(--shadow-lg)',
};

function pickerChipStyle(active: boolean): React.CSSProperties {
  return {
    height: 28,
    maxWidth: '100%',
    padding: '0 10px',
    borderRadius: 6,
    border: 0,
    background: active ? 'var(--brand-teal-50)' : 'var(--n-100)',
    color: active ? 'var(--brand-teal-600)' : 'var(--fg-2)',
    font: '500 12px var(--font-sans)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  };
}

const passChipStyle: React.CSSProperties = {
  padding: '3px 8px',
  borderRadius: 6,
  background: '#DDF8E8',
  color: '#1A8B4F',
  font: '700 11px var(--font-sans)',
};

const tagBlockStyle: React.CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  minHeight: 30,
};

const tagChipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 10px',
  borderRadius: 7,
  border: '1px solid var(--border-1)',
  background: '#fff',
  color: 'var(--fg-2)',
  font: 'var(--type-caption)',
};

const ghostAddButtonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '4px 10px',
  borderRadius: 7,
  border: '1px solid var(--border-1)',
  background: 'var(--n-100)',
  color: 'var(--fg-2)',
  font: 'var(--type-caption)',
  cursor: 'pointer',
};

const tagPickerStyle: React.CSSProperties = {
  position: 'absolute',
  top: 36,
  left: 0,
  right: 0,
  zIndex: 5,
  borderRadius: 8,
  border: '1px solid var(--border-1)',
  background: '#fff',
  boxShadow: 'var(--shadow-lg)',
};

const tagPickerInputStyle: React.CSSProperties = {
  flex: 1,
  height: 30,
  padding: '0 10px',
  borderRadius: 6,
  border: '1px solid var(--border-1)',
  outline: 'none',
  font: 'var(--type-body)',
  color: 'var(--fg-1)',
};

function tagPickerAddButtonStyle(enabled: boolean): React.CSSProperties {
  return {
    height: 30,
    padding: '0 12px',
    border: 0,
    borderRadius: 6,
    background: enabled ? 'var(--brand-teal-500)' : 'var(--n-100)',
    color: enabled ? '#fff' : 'var(--fg-4)',
    font: '600 12px var(--font-sans)',
    cursor: enabled ? 'pointer' : 'not-allowed',
  };
}
