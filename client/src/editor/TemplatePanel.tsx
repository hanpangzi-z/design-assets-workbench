import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, Grid2x2, Search, SlidersHorizontal, X } from 'lucide-react';
import { Empty, message, Spin } from 'antd';
import { getCategoryTree } from '@/api/categories';
import { getFileById, getFiles, useTemplate } from '@/api/files';
import { getLibraries } from '@/api/libraries';
import Thumb from '@/components/FileCard/Thumb';
import type { Category, DesignFile } from 'shared/types';

const DIM_LABELS: Record<string, string> = {
  festival: '节日',
  design_type: '设计类型',
  product_type: '品类',
  version: '版本',
};

const TEMPLATE_THUMB_HEIGHT = 86;

interface LibraryItem {
  id: number;
  name: string;
  templateCount?: number;
  materialCount?: number;
}

function getLibraryResourceCount(library: LibraryItem) {
  return (library.templateCount ?? 0) + (library.materialCount ?? 0);
}

type CategoryGroup = {
  dimension: string;
  label: string;
  items: Array<Category & { prefix: string }>;
};

interface TemplatePanelProps {
  libraryId?: number | null;
  onTemplateSelect?: (template: DesignFile) => void;
}

export default function TemplatePanel({ libraryId: preferredLibraryId, onTemplateSelect }: TemplatePanelProps) {
  const navigate = useNavigate();
  const [libraries, setLibraries] = useState<LibraryItem[]>([]);
  const [selectedLibraryId, setSelectedLibraryId] = useState<number>();
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [categoryTree, setCategoryTree] = useState<Category[]>([]);
  const [draftFilters, setDraftFilters] = useState<Record<string, number | undefined>>({});
  const [appliedFilters, setAppliedFilters] = useState<Record<string, number | undefined>>({});
  const [query, setQuery] = useState('');
  const [templates, setTemplates] = useState<DesignFile[]>([]);
  const [loadingLibraries, setLoadingLibraries] = useState(false);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [openingId, setOpeningId] = useState<number | null>(null);

  const selectedLibrary = libraries.find((library) => library.id === selectedLibraryId);

  const categoryGroups = useMemo(() => groupCategoriesByDimension(categoryTree), [categoryTree]);
  const categoryById = useMemo(() => {
    const map = new Map<number, Category>();
    categoryGroups.forEach((group) => group.items.forEach((category) => map.set(category.id, category)));
    return map;
  }, [categoryGroups]);
  const activeCategoryIds = useMemo(() => {
    const selectedIds = Object.values(appliedFilters).filter((value): value is number => typeof value === 'number');
    return expandSelectedCategoryIds(selectedIds, categoryById);
  }, [appliedFilters, categoryById]);

  useEffect(() => {
    let cancelled = false;
    setLoadingLibraries(true);
    getLibraries()
      .then((list) => {
        if (cancelled) return;
        setLibraries(list);
        setSelectedLibraryId((current) => {
          if (current && list.some((library) => library.id === current)) return current;
          if (preferredLibraryId && list.some((library) => library.id === preferredLibraryId)) return preferredLibraryId;
          return list[0]?.id;
        });
      })
      .catch(() => {
        if (cancelled) return;
        setLibraries([]);
        setSelectedLibraryId(undefined);
      })
      .finally(() => {
        if (!cancelled) setLoadingLibraries(false);
      });
    return () => { cancelled = true; };
  }, [preferredLibraryId]);

  useEffect(() => {
    if (!preferredLibraryId || libraries.length === 0) return;
    if (!libraries.some((library) => library.id === preferredLibraryId)) return;
    setSelectedLibraryId((current) => (current === preferredLibraryId ? current : preferredLibraryId));
  }, [preferredLibraryId, libraries]);

  useEffect(() => {
    if (!selectedLibraryId) {
      setCategoryTree([]);
      setTemplates([]);
      return;
    }
    let cancelled = false;
    setDraftFilters({});
    setAppliedFilters({});
    getCategoryTree({ libraryId: selectedLibraryId })
      .then((tree) => {
        if (!cancelled) setCategoryTree(tree || []);
      })
      .catch(() => {
        if (!cancelled) setCategoryTree([]);
      });
    return () => { cancelled = true; };
  }, [selectedLibraryId]);

  useEffect(() => {
    if (!selectedLibraryId) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoadingTemplates(true);
      fetchAllTemplateFiles({
        libraryId: selectedLibraryId,
        keyword: query.trim() || undefined,
        categoryIds: activeCategoryIds.length > 0 ? Array.from(new Set(activeCategoryIds)).join(',') : undefined,
        sortBy: 'created_at',
        sortOrder: 'desc',
      })
        .then((list) => {
          if (!cancelled) setTemplates(list);
        })
        .catch(() => {
          if (!cancelled) setTemplates([]);
        })
        .finally(() => {
          if (!cancelled) setLoadingTemplates(false);
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [selectedLibraryId, query, activeCategoryIds.join(',')]);

  const applyCategoryFilters = () => {
    setAppliedFilters(draftFilters);
    setCategoryOpen(false);
  };

  const clearCategoryFilters = () => {
    setDraftFilters({});
    setAppliedFilters({});
    setCategoryOpen(false);
  };

  const openTemplate = async (template: DesignFile) => {
    const inspectedTemplate = onTemplateSelect
      ? await getFileById(template.id).catch(() => template)
      : template;

    if (onTemplateSelect && !isMultiBoardTemplate(inspectedTemplate)) {
      onTemplateSelect(inspectedTemplate);
      return;
    }

    setOpeningId(template.id);
    try {
      const personalCopy = await useTemplate(inspectedTemplate.id);
      navigate(`/editor/${personalCopy.id}`);
    } catch (error: any) {
      console.error('[TemplatePanel] use template failed:', error);
      message.error(error?.response?.data?.message || '创建我的模板失败');
    } finally {
      setOpeningId(null);
    }
  };

  return (
    <aside style={panelStyle}>
      <div style={panelHeaderStyle}>
        <div style={{ position: 'relative' }}>
          <button type="button" onClick={() => setLibraryOpen((open) => !open)} style={libraryButtonStyle}>
            {selectedLibrary?.name || '选择资源库'}
            <ChevronDown size={13} />
          </button>
          {libraryOpen && (
            <>
              <div onClick={() => setLibraryOpen(false)} style={backdropStyle} />
              <div style={libraryMenuStyle}>
                {loadingLibraries && <div style={emptyLineStyle}>加载中...</div>}
                {!loadingLibraries && libraries.length === 0 && <div style={emptyLineStyle}>暂无资源库</div>}
                {libraries.map((library) => (
                  <button
                    key={library.id}
                    type="button"
                    onClick={() => {
                      setSelectedLibraryId(library.id);
                      setLibraryOpen(false);
                    }}
                    style={libraryMenuItemStyle(library.id === selectedLibraryId)}
                  >
                    <span>{library.name}</span>
                    <span style={libraryCountStyle}>{getLibraryResourceCount(library)}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div style={searchBoxStyle}>
        <Search size={16} style={{ color: '#9aa1aa', flexShrink: 0 }} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索模板"
          style={searchInputStyle}
        />
        {query && (
          <button type="button" onClick={() => setQuery('')} style={clearSearchStyle} title="清空">
            <X size={14} />
          </button>
        )}
      </div>

      <div style={categoryTitleRowStyle}>
        <button type="button" onClick={() => setCategoryOpen((open) => !open)} style={categoryTriggerStyle}>
          选择分类
          <ChevronDown size={13} style={{ transform: categoryOpen ? 'rotate(180deg)' : undefined }} />
        </button>
        <button type="button" onClick={() => setCategoryOpen((open) => !open)} style={miniIconButtonStyle} title="筛选">
          <SlidersHorizontal size={16} />
        </button>
        <button type="button" style={miniIconButtonStyle} title="网格视图">
          <Grid2x2 size={15} />
        </button>
      </div>

      {categoryOpen && (
        <div style={categoryPopoverStyle}>
          <div style={popoverHeaderStyle}>
            <strong>分类</strong>
            <button type="button" onClick={() => setCategoryOpen(false)} style={closeButtonStyle} title="关闭">
              <X size={15} />
            </button>
          </div>
          {categoryGroups.length === 0 ? (
            <div style={{ color: '#8b949e', font: '500 12px var(--font-sans)', padding: '14px 0' }}>
              当前资源库还没有分类
            </div>
          ) : (
            categoryGroups.map((group) => (
              <label key={group.dimension} style={filterRowStyle}>
                <span style={filterLabelStyle}>{group.label}</span>
                <select
                  value={draftFilters[group.dimension] ?? ''}
                  onChange={(event) => {
                    const value = event.target.value ? Number(event.target.value) : undefined;
                    setDraftFilters((current) => ({ ...current, [group.dimension]: value }));
                  }}
                  style={filterSelectStyle}
                >
                  <option value="">全部分类</option>
                  {group.items.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.prefix ? `${category.prefix}${category.name}` : category.name}
                    </option>
                  ))}
                </select>
              </label>
            ))
          )}
          <div style={filterActionsStyle}>
            <button type="button" onClick={clearCategoryFilters} style={secondaryActionStyle}>清空内容</button>
            <button type="button" onClick={applyCategoryFilters} style={primaryActionStyle}>应用</button>
          </div>
        </div>
      )}

      <div style={templateListStyle}>
        {loadingTemplates ? (
          <div style={loadingStyle}><Spin size="small" /></div>
        ) : templates.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无模板" />
        ) : (
          <div style={templateGridStyle}>
            {templates.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => openTemplate(template)}
                style={templateCardStyle}
                title={template.name}
                disabled={openingId === template.id}
              >
                <div style={thumbWrapStyle}>
                  <Thumb
                    thumbnailUrl={template.thumbnailPath}
                    fileType={template.fileType}
                    label={template.name?.charAt(0)}
                    file={template}
                    name={template.name}
                    height={TEMPLATE_THUMB_HEIGHT}
                    showBadge={false}
                  />
                  <span style={badgeStyle}>{openingId === template.id ? '打开中' : getTemplateBadge(template)}</span>
                </div>
                <span style={templateNameStyle}>{template.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

async function fetchAllTemplateFiles(params: Parameters<typeof getFiles>[0]): Promise<DesignFile[]> {
  const pageSize = 200;
  const result: DesignFile[] = [];

  for (let page = 1; page <= 50; page += 1) {
    const data = await getFiles({ ...params, page, pageSize });
    const list = data.list || [];
    result.push(...list);

    const total = data.pagination?.total ?? result.length;
    if (result.length >= total || list.length < pageSize) break;
  }

  return result;
}

function groupCategoriesByDimension(tree: Category[]): CategoryGroup[] {
  const map = new Map<string, Array<Category & { prefix: string }>>();

  const visit = (categories: Category[], inheritedDimension = '', prefix = '') => {
    categories.forEach((category) => {
      const dimension = String(category.dimension || inheritedDimension || 'category');
      if (!map.has(dimension)) map.set(dimension, []);
      map.get(dimension)!.push({ ...category, prefix });
      if (category.children?.length) visit(category.children, dimension, `${prefix}${category.name} / `);
    });
  };

  visit(tree);
  return Array.from(map.entries()).map(([dimension, items]) => ({
    dimension,
    label: DIM_LABELS[dimension] || dimension,
    items,
  }));
}

function expandSelectedCategoryIds(ids: number[], categoryById: Map<number, Category>) {
  const expanded = ids.flatMap((id) => {
    const category = categoryById.get(id);
    return category ? getCategoryAndDescendantIds(category) : [id];
  });
  return Array.from(new Set(expanded));
}

function getCategoryAndDescendantIds(category: Category): number[] {
  return [category.id, ...(category.children || []).flatMap(getCategoryAndDescendantIds)];
}

function getTemplateBadge(template: DesignFile): string {
  if (template.fileType === 'psd' || template.fileType === 'ai' || template.fileType === 'pdf') {
    return template.fileType.toUpperCase();
  }
  return '图片';
}

function isMultiBoardTemplate(template: DesignFile) {
  const parseResult = template.parseResult as Record<string, unknown> | undefined;
  const pages = Array.isArray(parseResult?.pages) ? parseResult.pages : [];
  return pages.length > 1;
}

const panelStyle: CSSProperties = {
  width: 300,
  flexShrink: 0,
  background: '#fff',
  borderRight: '1px solid #eceff3',
  display: 'flex',
  flexDirection: 'column',
  padding: '14px 14px 0',
  overflow: 'hidden',
};

const panelHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  height: 30,
  marginBottom: 14,
};

const libraryButtonStyle: CSSProperties = {
  border: 0,
  background: 'transparent',
  color: '#111827',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: 0,
  font: '700 13px var(--font-sans)',
  cursor: 'pointer',
};

const backdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 50,
  background: 'transparent',
};

const libraryMenuStyle: CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 26,
  zIndex: 51,
  width: 184,
  padding: 6,
  borderRadius: 8,
  background: '#fff',
  boxShadow: '0 12px 36px rgba(17, 24, 39, .12)',
  border: '1px solid #eceff3',
};

const libraryMenuItemStyle = (active: boolean): CSSProperties => ({
  width: '100%',
  height: 32,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '0 9px',
  border: 0,
  borderRadius: 6,
  background: active ? '#eef1f3' : 'transparent',
  color: '#111827',
  font: '600 12px var(--font-sans)',
  cursor: 'pointer',
});

const libraryCountStyle: CSSProperties = {
  color: '#9aa1aa',
  font: '600 11px var(--font-sans)',
};

const emptyLineStyle: CSSProperties = {
  padding: '8px 10px',
  color: '#8b949e',
  font: '500 12px var(--font-sans)',
};

const searchBoxStyle: CSSProperties = {
  height: 40,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '0 12px',
  border: '1px solid #e5e7eb',
  borderRadius: 10,
  background: '#fff',
  marginBottom: 16,
};

const searchInputStyle: CSSProperties = {
  flex: 1,
  border: 0,
  outline: 0,
  minWidth: 0,
  color: '#111827',
  font: '500 13px var(--font-sans)',
};

const clearSearchStyle: CSSProperties = {
  width: 20,
  height: 20,
  display: 'grid',
  placeItems: 'center',
  border: 0,
  borderRadius: 5,
  background: '#f1f3f5',
  color: '#8b949e',
  cursor: 'pointer',
};

const categoryTitleRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  marginBottom: 10,
};

const categoryTriggerStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  border: 0,
  background: 'transparent',
  padding: 0,
  color: '#111827',
  font: '800 14px var(--font-sans)',
  cursor: 'pointer',
};

const miniIconButtonStyle: CSSProperties = {
  width: 28,
  height: 28,
  display: 'grid',
  placeItems: 'center',
  border: 0,
  borderRadius: 7,
  background: 'transparent',
  color: '#525b66',
  cursor: 'pointer',
  marginLeft: 6,
};

const categoryPopoverStyle: CSSProperties = {
  padding: 14,
  marginBottom: 12,
  borderRadius: 10,
  background: '#fff',
  border: '1px solid #e5e7eb',
  boxShadow: '0 12px 28px rgba(17, 24, 39, .1)',
};

const popoverHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 12,
  font: '800 14px var(--font-sans)',
  color: '#111827',
};

const closeButtonStyle: CSSProperties = {
  width: 24,
  height: 24,
  display: 'grid',
  placeItems: 'center',
  border: 0,
  background: 'transparent',
  color: '#9aa1aa',
  cursor: 'pointer',
};

const filterRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '64px 1fr',
  alignItems: 'center',
  gap: 8,
  marginBottom: 8,
};

const filterLabelStyle: CSSProperties = {
  color: '#5f6874',
  font: '600 12px var(--font-sans)',
};

const filterSelectStyle: CSSProperties = {
  minWidth: 0,
  height: 32,
  padding: '0 9px',
  borderRadius: 8,
  border: '1px solid #e5e7eb',
  background: '#fff',
  color: '#111827',
  font: '500 12px var(--font-sans)',
  outline: 0,
};

const filterActionsStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  paddingTop: 6,
};

const secondaryActionStyle: CSSProperties = {
  height: 32,
  padding: '0 12px',
  border: 0,
  borderRadius: 8,
  background: '#eef0f2',
  color: '#4b5563',
  font: '700 12px var(--font-sans)',
  cursor: 'pointer',
};

const primaryActionStyle: CSSProperties = {
  height: 32,
  padding: '0 15px',
  border: 0,
  borderRadius: 8,
  background: '#2f5bea',
  color: '#fff',
  font: '800 12px var(--font-sans)',
  cursor: 'pointer',
};

const templateListStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  paddingBottom: 14,
};

const loadingStyle: CSSProperties = {
  height: 180,
  display: 'grid',
  placeItems: 'center',
};

const templateGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 8,
};

const templateCardStyle: CSSProperties = {
  border: 0,
  padding: 0,
  background: 'transparent',
  textAlign: 'left',
  cursor: 'pointer',
  minWidth: 0,
};

const thumbWrapStyle: CSSProperties = {
  position: 'relative',
  height: TEMPLATE_THUMB_HEIGHT,
  borderRadius: 9,
  overflow: 'hidden',
  background: '#f3f5f7',
};

const badgeStyle: CSSProperties = {
  position: 'absolute',
  left: 6,
  bottom: 6,
  padding: '2px 7px',
  borderRadius: 10,
  background: 'rgba(0, 0, 0, .55)',
  color: '#fff',
  font: '700 10px var(--font-sans)',
};

const templateNameStyle: CSSProperties = {
  display: 'block',
  padding: '5px 2px 0',
  color: '#525b66',
  font: '600 11px var(--font-sans)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
