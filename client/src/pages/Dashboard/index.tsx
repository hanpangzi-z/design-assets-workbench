import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useLocation, useNavigate, useOutletContext } from 'react-router-dom';
import { Dropdown, Empty, message, Modal, Spin } from 'antd';
import {
  ChevronDown,
  Eye,
  Grid2x2,
  Library,
  List,
  Plus,
  RotateCcw,
  Search,
  Settings,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import useAuthStore from '@/store/authStore';
import useCategoryStore from '@/store/categoryStore';
import useFileStore from '@/store/fileStore';
import Thumb from '@/components/FileCard/Thumb';
import ResourceWaterfall, { ResourceCardInfo, type CardMetrics } from '@/components/ResourceWaterfall';
import { useResourceLoadMore } from '@/hooks/useResourceLoadMore';
import { getLibraries } from '@/api/libraries';
import { useAutoRefreshPendingParses } from '@/hooks/useAutoRefreshPendingParses';
import { sortLibrariesByPin } from '@/utils/librarySort';
import { getAssetPreviewPath } from '@/utils/assetPreview';
import {
  deleteFile,
  deleteFilePermanently,
  deleteFiles,
  deleteFilesPermanently,
  restoreFile,
  restoreFiles,
  useTemplate,
  type FileListParams,
} from '@/api/files';
import type { Category, DesignFile, Permissions } from 'shared/types';

const DIM_LABELS: Record<string, string> = {
  festival: '节日/促销',
  design_type: '设计类别',
  product_type: '本来品类',
  version: '线上渠道',
};

const RESOURCE_TILE_PREVIEW_HEIGHT = 252;
const LAST_LIBRARY_ID_KEY = 'benlai.dashboard.lastLibraryId';

const RESOURCE_ADMIN_PERMISSION_KEYS: Array<keyof Permissions> = [
  'upload',
  'edit',
  'delete_files',
  'manage_categories',
  'manage_tags',
];

const MY_SPACE_TABS = [
  { key: 'space', label: '我的空间' },
  { key: 'recent', label: '最近' },
  { key: 'trash', label: '回收站' },
] as const;

type MySpaceTabKey = typeof MY_SPACE_TABS[number]['key'];

interface LibraryItem {
  id: number;
  name: string;
  description?: string | null;
  templateCount?: number;
  materialCount?: number;
  isPinned?: boolean | number | string | null;
  pinnedAt?: string | Date | null;
}

interface FontMeta {
  name?: string;
  family?: string;
  originalName?: string;
  aliases?: string[];
}

function getLibraryResourceCount(library: LibraryItem) {
  return (library.templateCount ?? 0) + (library.materialCount ?? 0);
}

function readLastLibraryId() {
  const value = Number(localStorage.getItem(LAST_LIBRARY_ID_KEY));
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function writeLastLibraryId(libraryId?: number) {
  if (libraryId) {
    localStorage.setItem(LAST_LIBRARY_ID_KEY, String(libraryId));
  } else {
    localStorage.removeItem(LAST_LIBRARY_ID_KEY);
  }
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { openCreate } = useOutletContext<{ openCreate: () => void }>();
  const { files, total, page, pageSize, isLoading, hasLoaded, loadError, loadMoreExhausted, filters, fetchFiles, setFilters } = useFileStore();
  const { dimensionCategories, fetchAll: fetchCategories } = useCategoryStore();
  const user = useAuthStore((s) => s.user);
  const permissions = useAuthStore((s) => s.permissions);
  const canManageLibraryInfo = permissions?.manage_categories === true;
  const canOpenResourceAdmin = RESOURCE_ADMIN_PERMISSION_KEYS.some((key) => permissions?.[key] === true);

  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'all' | 'uploaded'>('all');
  const [mySpaceTab, setMySpaceTab] = useState<MySpaceTabKey>('space');
  const [myContentTab, setMyContentTab] = useState<'all' | 'works' | 'uploaded'>('all');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<number[]>([]);
  const [fileTypeFilter, setFileTypeFilter] = useState<string | undefined>();
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [libraries, setLibraries] = useState<LibraryItem[]>([]);
  const [librariesLoading, setLibrariesLoading] = useState(true);
  const [libraryLoadError, setLibraryLoadError] = useState<string | null>(null);
  const libraryRequestRef = useRef(0);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [selectedLibraryId, setSelectedLibraryId] = useState<number | undefined>(() => readLastLibraryId());
  const [openingId, setOpeningId] = useState<number | null>(null);
  const openingRef = useRef<number | null>(null);
  const [myDeleteTarget, setMyDeleteTarget] = useState<{ file: DesignFile; permanent: boolean } | null>(null);
  const [myDeleteLoading, setMyDeleteLoading] = useState(false);
  const [batchMode, setBatchMode] = useState(false);
  const [selectedFileIds, setSelectedFileIds] = useState<number[]>([]);
  const [batchAction, setBatchAction] = useState<'delete' | 'restore' | 'permanent' | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);
  const [fontPreviewFile, setFontPreviewFile] = useState<DesignFile | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const loadingMoreRef = useRef(false);
  const contentRef = useRef<HTMLElement>(null);
  const boundaryRef = useRef<HTMLDivElement>(null);
  const loadGeneration = useRef(0);
  const pageRef = useRef(page);
  const pageSizeRef = useRef(pageSize);
  const filesLengthRef = useRef(files.length);
  const hasMoreFilesRef = useRef(false);
  const isLoadingRef = useRef(isLoading);
  const isMyPage = location.pathname === '/my';
  const isTrashPage = isMyPage && mySpaceTab === 'trash';

  useEffect(() => {
    if (mySpaceTab !== 'space') setMyContentTab('all');
  }, [mySpaceTab]);

  const loadLibraries = useCallback(async (force = false) => {
    const requestId = ++libraryRequestRef.current;
    setLibrariesLoading(true);
    setLibraryLoadError(null);
    try {
      const list = await getLibraries({ force });
      if (requestId !== libraryRequestRef.current) return false;
      const nextLibraries: LibraryItem[] = sortLibrariesByPin(list);
      setLibraries(nextLibraries);
      setSelectedLibraryId((current) => {
        const nextId = current && nextLibraries.some((library) => library.id === current)
          ? current
          : nextLibraries[0]?.id;
        writeLastLibraryId(nextId);
        return nextId;
      });
      return true;
    } catch {
      if (requestId === libraryRequestRef.current) setLibraryLoadError('资源库加载失败，请检查服务连接后重试。');
      return false;
    } finally {
      if (requestId === libraryRequestRef.current) setLibrariesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLibraries();
    return () => { libraryRequestRef.current++; };
  }, [loadLibraries]);

  useEffect(() => {
    if (isMyPage) {
      setSelectedCategoryIds([]);
      setFileTypeFilter(undefined);
      setFilters({
        libraryId: undefined,
        categoryId: undefined,
        categoryIds: undefined,
        includeChildren: undefined,
        uncategorized: undefined,
        fileType: undefined,
        tagIds: undefined,
        keyword: undefined,
        includePersonal: undefined,
        scope: 'my',
        myView: mySpaceTab,
        sortBy: 'updated_at',
        sortOrder: 'desc',
      });
      return;
    }
    if (!selectedLibraryId) return;
    writeLastLibraryId(selectedLibraryId);
    setSelectedCategoryIds([]);
    setFileTypeFilter(undefined);
    fetchCategories(selectedLibraryId).catch(() => {});
    setFilters({
      libraryId: selectedLibraryId,
      categoryId: undefined,
      categoryIds: undefined,
      includeChildren: undefined,
      uncategorized: undefined,
      fileType: undefined,
      tagIds: undefined,
      keyword: undefined,
      includePersonal: undefined,
      scope: isMyPage ? 'my' : undefined,
      myView: undefined,
      sortBy: 'created_at',
      sortOrder: 'desc',
    });
  }, [selectedLibraryId, fetchCategories, setFilters, isMyPage, mySpaceTab]);

  const selectedLibrary = libraries.find((lib) => lib.id === selectedLibraryId);
  const showFileCount = hasLoaded && (isMyPage || Boolean(selectedLibrary));
  const resourceLoadError = (!isMyPage && libraryLoadError) || loadError;

  const categoryGroups = useMemo(() => {
    return Object.entries(dimensionCategories)
      .map(([dimension, categories]) => ({
        dimension,
        label: DIM_LABELS[dimension] || dimension,
        items: categories,
      }))
      .filter((group) => group.items.length > 0);
  }, [dimensionCategories]);

  const allCategories = useMemo(
    () => categoryGroups.flatMap((group) => flattenCategories(group.items)),
    [categoryGroups],
  );

  const categoryById = useMemo(() => {
    const map = new Map<number, Category>();
    allCategories.forEach((category) => map.set(category.id, category));
    return map;
  }, [allCategories]);

  const selectedCategoryIdSet = useMemo(() => new Set(selectedCategoryIds), [selectedCategoryIds]);

  const visibleFiles = useMemo(() => {
    if (isMyPage) {
      if (mySpaceTab === 'space' && myContentTab === 'uploaded') return files.filter((file) => file.uploadedBy === user?.id);
      return files;
    }
    if (tab === 'uploaded') return files.filter((file) => file.uploadedBy === user?.id);
    return files;
  }, [files, isMyPage, myContentTab, mySpaceTab, tab, user?.id]);

  const visibleTotal = isMyPage && mySpaceTab === 'space' && myContentTab !== 'all' ? visibleFiles.length : total;
  const hasVisibleFiles = visibleFiles.length > 0;
  const isClientFilteredList = (!isMyPage && tab === 'uploaded') || (isMyPage && mySpaceTab === 'space' && myContentTab === 'uploaded');
  const hasMoreFiles = !resourceLoadError && !isClientFilteredList && !loadMoreExhausted && files.length < total;

  const refreshLoadedFiles = useCallback(() => {
    const loadedPages = Math.max(1, Math.ceil(Math.max(files.length, pageSize) / pageSize));
    return fetchFiles({ page: 1, pageSize: loadedPages * pageSize }, { preserveLoadedPage: true });
  }, [fetchFiles, files.length, pageSize]);

  const retryResourceLoad = async () => {
    if (!isMyPage && libraryLoadError) {
      const loaded = await loadLibraries(true);
      if (!loaded || !selectedLibraryId) return;
    }
    await refreshLoadedFiles();
  };

  useAutoRefreshPendingParses(visibleFiles, refreshLoadedFiles);

  useEffect(() => {
    pageRef.current = page;
    pageSizeRef.current = pageSize;
    filesLengthRef.current = files.length;
    hasMoreFilesRef.current = hasMoreFiles;
    isLoadingRef.current = isLoading;
  }, [files.length, hasMoreFiles, isLoading, page, pageSize]);

  const loadNextPage = useCallback(() => {
    if (!hasMoreFilesRef.current || isLoadingRef.current || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    const generation = loadGeneration.current;
    isLoadingRef.current = true;
    const loadedPage = Math.max(pageRef.current, Math.ceil(filesLengthRef.current / pageSizeRef.current));
    fetchFiles({ page: loadedPage + 1 }, { append: true }).finally(() => {
      if (generation === loadGeneration.current) {
        loadingMoreRef.current = false;
        isLoadingRef.current = false;
      }
    });
  }, [fetchFiles]);

  const layoutKey = JSON.stringify([location.pathname, filters, tab, mySpaceTab, myContentTab]);
  useEffect(() => {
    loadGeneration.current += 1;
    loadingMoreRef.current = false;
  }, [layoutKey]);
  useResourceLoadMore({
    containerRef: contentRef, sentinelRef: loadMoreRef, boundaryRef, resetKey: layoutKey,
    enabled: hasMoreFiles, loading: isLoading, revision: files.length, onLoad: loadNextPage,
  });

  useEffect(() => {
    setBatchMode(false);
    setSelectedFileIds([]);
    setBatchAction(null);
  }, [isMyPage, mySpaceTab, myContentTab, selectedLibraryId]);

  const changeTab = (nextTab: 'all' | 'uploaded') => {
    setTab(nextTab);
    setFilters(buildCurrentListFilters());
  };

  const buildCurrentListFilters = (
    categoryIds: number[] = selectedCategoryIds,
    overrides: Partial<FileListParams> = {},
  ): FileListParams => ({
    libraryId: isMyPage ? undefined : selectedLibraryId,
    ...(isMyPage
      ? { scope: 'my' as const, myView: mySpaceTab }
      : buildCategoryFilterParams(categoryIds, categoryById)),
    keyword: query.trim() || undefined,
    fileType: fileTypeFilter,
    sortBy: isMyPage ? 'updated_at' : 'created_at',
    sortOrder,
    ...overrides,
  });

  const applyCategorySelection = (ids: number[]) => {
    setFilters(buildCurrentListFilters(ids));
  };

  // 二级（顶级）单选；三级（子级）也单选，但始终保留其父级二级作为上下文，
  // 这样二级和三级是联动的共享关系，而不是互相清空。
  const toggleCategory = (category: Category) => {
    const group = categoryGroups.find((g) =>
      flattenCategories(g.items).some((item) => item.id === category.id),
    );
    if (!group) return;
    const groupIds = new Set(flattenCategories(group.items).map((item) => item.id));
    const parent = group.items.find((p) => (p.children || []).some((c) => c.id === category.id));
    const isSelected = selectedCategoryIdSet.has(category.id);
    const outside = selectedCategoryIds.filter((id) => !groupIds.has(id));

    let nextIds: number[];
    if (!parent) {
      // 二级：替换该维度内的所有选择（再次点击则取消）
      nextIds = isSelected ? outside : [...outside, category.id];
    } else {
      // 三级：保留父级二级作上下文，同一分支下单选（再次点击取消，回到二级）
      nextIds = isSelected ? [...outside, parent.id] : [...outside, parent.id, category.id];
    }
    setSelectedCategoryIds(nextIds);
    applyCategorySelection(nextIds);
  };

  // 点击「全部」/ 二级名称：只保留该二级，清空其下已选的三级。
  const selectOnlySecond = (node: Category) => {
    const group = categoryGroups.find((g) => g.items.some((p) => p.id === node.id));
    const groupIds = new Set(group ? flattenCategories(group.items).map((item) => item.id) : []);
    const nextIds = [...selectedCategoryIds.filter((id) => !groupIds.has(id)), node.id];
    setSelectedCategoryIds(nextIds);
    applyCategorySelection(nextIds);
  };

  const clearCategoryGroup = (categoryIds: number[]) => {
    const groupIds = new Set(categoryIds);
    const nextIds = selectedCategoryIds.filter((id) => !groupIds.has(id));
    setSelectedCategoryIds(nextIds);
    applyCategorySelection(nextIds);
  };

  const handleSearch = () => {
    setFilters(buildCurrentListFilters());
  };

  const applyFileType = (fileType?: string) => {
    setFileTypeFilter(fileType);
    setFilters(buildCurrentListFilters(selectedCategoryIds, { fileType }));
  };

  const toggleSortOrder = () => {
    const next = sortOrder === 'desc' ? 'asc' : 'desc';
    setSortOrder(next);
    setFilters(buildCurrentListFilters(selectedCategoryIds, {
      sortBy: isMyPage ? 'updated_at' : 'created_at',
      sortOrder: next,
    }));
  };

  const openTemplate = async (file: DesignFile) => {
    if (isTrashPage) return;
    if (isFontFile(file)) {
      setFontPreviewFile(file);
      return;
    }
    // Only the dedicated "My" view resumes an existing work. Marketplace cards
    // may reference a personal source internally, but using one must still create
    // a fresh work with its own file id and empty editor state.
    if (isMyPage && file.isPersonalCopy) {
      navigate(`/editor/${file.id}`);
      return;
    }

    if (openingRef.current !== null) return;
    openingRef.current = file.id;
    setOpeningId(file.id);
    try {
      const personalCopy = await useTemplate(file.id);
      navigate(`/editor/${personalCopy.id}`);
    } catch (error: any) {
      console.error('[Dashboard] use template failed:', error);
      message.error(error?.response?.data?.message || '创建我的模板失败');
    } finally {
      openingRef.current = null;
      setOpeningId(null);
    }
  };

  const canDeleteMyFile = (file: DesignFile) => isMyPage && file.uploadedBy === user?.id;

  const selectableFiles = useMemo(() => {
    if (!isMyPage || !user?.id) return [];
    return visibleFiles.filter((file) => file.uploadedBy === user.id);
  }, [isMyPage, user?.id, visibleFiles]);

  const selectedFileIdSet = useMemo(() => new Set(selectedFileIds), [selectedFileIds]);
  const selectedBatchFiles = useMemo(
    () => visibleFiles.filter((file) => selectedFileIdSet.has(file.id)),
    [selectedFileIdSet, visibleFiles],
  );

  const toggleBatchMode = () => {
    setBatchMode((value) => !value);
    setSelectedFileIds([]);
    setBatchAction(null);
  };

  const toggleSelectedFile = (file: DesignFile) => {
    if (!canDeleteMyFile(file)) return;
    setSelectedFileIds((current) => (
      current.includes(file.id)
        ? current.filter((id) => id !== file.id)
        : [...current, file.id]
    ));
  };

  const selectAllVisibleFiles = () => {
    setSelectedFileIds(selectableFiles.map((file) => file.id));
  };

  const clearSelectedFiles = () => {
    setSelectedFileIds([]);
  };

  const confirmDeleteMyFile = (file: DesignFile, permanent = false) => {
    setMyDeleteTarget({ file, permanent });
  };

  const executeDeleteMyFile = async () => {
    if (!myDeleteTarget) return;
    setMyDeleteLoading(true);
    try {
      if (myDeleteTarget.permanent) {
        await deleteFilePermanently(myDeleteTarget.file.id);
        message.success('已永久删除');
      } else {
        await deleteFile(myDeleteTarget.file.id);
        message.success('已移入回收站，保留 7 天');
      }
      setMyDeleteTarget(null);
      fetchFiles();
    } catch (err: any) {
      message.error(err?.response?.data?.message || '删除失败');
    } finally {
      setMyDeleteLoading(false);
    }
  };

  const handleRestoreMyFile = async (file: DesignFile) => {
    try {
      await restoreFile(file.id);
      message.success('已恢复');
      fetchFiles();
    } catch (err: any) {
      message.error(err?.response?.data?.message || '恢复失败');
    }
  };

  const executeBatchAction = async () => {
    if (!batchAction || selectedFileIds.length === 0) return;
    setBatchLoading(true);
    try {
      if (batchAction === 'restore') {
        const result = await restoreFiles(selectedFileIds);
        message.success(`已恢复 ${result.count} 个文件`);
      } else if (batchAction === 'permanent') {
        const result = await deleteFilesPermanently(selectedFileIds);
        message.success(`已永久删除 ${result.count} 个文件`);
      } else {
        const result = await deleteFiles(selectedFileIds);
        message.success(`已移入回收站 ${result.count} 个文件，保留 7 天`);
      }
      setBatchAction(null);
      setSelectedFileIds([]);
      setBatchMode(false);
      fetchFiles();
    } catch (err: any) {
      message.error(err?.response?.data?.message || '批量操作失败');
    } finally {
      setBatchLoading(false);
    }
  };

  return (
    <div style={pageStyle}>
      {isMyPage ? (
        <section style={myHeaderStyle}>
          <div style={myTabsStyle}>
            {MY_SPACE_TABS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setMySpaceTab(item.key)}
                style={mySpaceTabStyle(mySpaceTab === item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
          {!isTrashPage && <button type="button" onClick={openCreate} style={myAddButtonStyle}>
            <Plus size={18} />
            添加
          </button>}
        </section>
      ) : (
        <section style={filterStageStyle}>
          <div style={filterHeaderStyle}>
            <div style={{ position: 'relative' }}>
              <button type="button" onClick={() => setLibraryOpen((value) => !value)} style={libraryButtonStyle}>
                {selectedLibrary?.name || (libraryLoadError ? '资源库加载失败' : librariesLoading ? '正在加载资源库…' : '选择资源库')}
                <ChevronDown size={15} />
              </button>
              {libraryOpen && (
                <>
                  <div onClick={() => setLibraryOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 90 }} />
                  <div style={libraryMenuStyle}>
                    {librariesLoading && libraries.length === 0 && <div style={{ padding: 12 }}><Spin size="small" /></div>}
                    {libraries.map((library) => (
                      <button
                        key={library.id}
                        type="button"
                        onClick={() => {
                          setSelectedLibraryId(library.id);
                          setLibraryOpen(false);
                        }}
                        style={libraryMenuItemStyle(selectedLibraryId === library.id)}
                      >
                        <span>{library.name}</span>
                        <span style={{ color: '#9aa1aa', font: '500 12px var(--font-sans)' }}>{getLibraryResourceCount(library)}</span>
                      </button>
                    ))}
                    <button type="button" disabled={librariesLoading} onClick={() => { void loadLibraries(true); }} style={libraryMenuItemStyle(false)}>
                      <span>刷新资源库</span><RotateCcw size={13} />
                    </button>
                  </div>
                </>
              )}
            </div>

            <div style={{ flex: 1 }} />

            <div style={topSearchStyle}>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && handleSearch()}
                placeholder="搜索当前资源库"
                style={topSearchInputStyle}
              />
              <Search size={16} style={{ color: '#9aa1aa' }} />
            </div>

            {canManageLibraryInfo && (
              <button type="button" onClick={() => navigate('/admin/libraries')} style={plainButtonStyle(false)}>
                资源库信息
              </button>
            )}
            {canOpenResourceAdmin && (
              <button type="button" onClick={() => navigate('/admin/resources')} style={plainButtonStyle(false)}>
                <Settings size={15} />
                管理
              </button>
            )}
            <button type="button" onClick={openCreate} style={createButtonStyle}>
              <Plus size={18} />
              创建
            </button>
          </div>

          <div style={categoryRowsStyle}>
            {categoryGroups.map((group) => {
              const topLevel = dimensionCategories[group.dimension] || [];
              const allIds = flattenCategories(topLevel).map((c) => c.id);
              let selectedSecond: Category | null = null;
              for (const cat of topLevel) {
                if (selectedCategoryIdSet.has(cat.id)) selectedSecond = cat;
                for (const ch of cat.children || []) {
                  if (selectedCategoryIdSet.has(ch.id)) selectedSecond = cat;
                }
              }
              const currentNode = selectedSecond && (selectedSecond.children || []).length > 0 ? selectedSecond : null;
              const selectedThirdCount = currentNode
                ? (currentNode.children || []).filter((c) => selectedCategoryIdSet.has(c.id)).length
                : 0;
              const chips = currentNode ? (currentNode.children || []) : topLevel;
              const allChipActive = currentNode
                ? selectedThirdCount === 0
                : (!selectedSecond);
              const allChipLabel = currentNode
                ? `全部 (${currentNode.branchFileCount ?? currentNode.fileCount ?? 0})`
                : '全部';

              return (
              <div key={group.dimension} style={categoryRowStyle}>
                <div style={categoryLabelStyle}>{group.label}</div>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
                  {currentNode && (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minHeight: 22, paddingTop: 4 }}>
                        <span
                          onClick={() => clearCategoryGroup(allIds)}
                          style={{ cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 500, color: '#8b949e' }}
                        >
                          全部
                        </span>
                        <span style={{ color: '#c4c9cf', fontSize: 13 }}>›</span>
                        <span
                          onClick={() => selectOnlySecond(currentNode)}
                          style={{ cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 700, color: '#1f2937' }}
                        >
                          {currentNode.name}
                        </span>
                      </div>
                      <div style={{ height: 1, background: '#ededed' }} />
                    </>
                  )}
                  <div style={categoryPillsWrapStyle}>
                    <button
                      type="button"
                      onClick={() => (currentNode ? selectOnlySecond(currentNode) : clearCategoryGroup(allIds))}
                      style={categoryPillStyle(allChipActive)}
                    >
                      {allChipLabel}
                    </button>
                    {chips.map((category) => (
                      <button
                        key={category.id}
                        type="button"
                        onClick={() => toggleCategory(category)}
                        style={categoryPillStyle(selectedCategoryIdSet.has(category.id))}
                      >
                        {category.name}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              );
            })}
            {categoryGroups.length === 0 && !librariesLoading && !libraryLoadError && selectedLibrary && (
              <div style={{ padding: '18px 0', color: '#8b949e', font: '500 13px var(--font-sans)' }}>
                当前资源库还没有分类。
              </div>
            )}
          </div>
        </section>
      )}

      <section style={contentHeaderStyle}>
        <div style={tabsStyle}>
          {isMyPage ? (
            mySpaceTab === 'space' ? (
              <>
                <button type="button" onClick={() => setMyContentTab('all')} style={tabStyle(myContentTab === 'all')}>全部{myContentTab === 'all' && showFileCount ? ` (${visibleTotal})` : ''}</button>
                <button type="button" onClick={() => setMyContentTab('works')} style={tabStyle(myContentTab === 'works')}>作品</button>
                <button type="button" onClick={() => setMyContentTab('uploaded')} style={tabStyle(myContentTab === 'uploaded')}>我上传的</button>
              </>
            ) : (
              <div style={mySectionTitleStyle}>
                {MY_SPACE_TABS.find((item) => item.key === mySpaceTab)?.label}
                <span>{showFileCount ? ` (${visibleTotal})` : ''}</span>
              </div>
            )
          ) : (
            <>
              <button type="button" onClick={() => changeTab('all')} style={tabStyle(tab === 'all')}>全部{tab === 'all' && showFileCount ? ` (${total})` : ''}</button>
              <button type="button" onClick={() => changeTab('uploaded')} style={tabStyle(tab === 'uploaded')}>上传的</button>
            </>
          )}
        </div>
        <div style={{ flex: 1 }} />
        {isMyPage && (
          <div style={batchToolbarStyle(batchMode)}>
            <button type="button" onClick={toggleBatchMode} style={batchButtonStyle(batchMode)}>
              {batchMode ? '退出批量' : '批量'}
            </button>
            {batchMode && (
              <>
                <span style={batchCountStyle}>已选 {selectedFileIds.length}</span>
                <button type="button" onClick={selectAllVisibleFiles} disabled={selectableFiles.length === 0} style={batchGhostButtonStyle}>
                  全选已加载
                </button>
                <button type="button" onClick={clearSelectedFiles} disabled={selectedFileIds.length === 0} style={batchGhostButtonStyle}>
                  清空
                </button>
                {isTrashPage ? (
                  <>
                    <button type="button" onClick={() => setBatchAction('restore')} disabled={selectedFileIds.length === 0} style={batchPrimaryButtonStyle}>
                      批量恢复
                    </button>
                    <button type="button" onClick={() => setBatchAction('permanent')} disabled={selectedFileIds.length === 0} style={batchDangerButtonStyle}>
                      批量永久删除
                    </button>
                  </>
                ) : (
                  <button type="button" onClick={() => setBatchAction('delete')} disabled={selectedFileIds.length === 0} style={batchDangerButtonStyle}>
                    批量删除
                  </button>
                )}
              </>
            )}
          </div>
        )}
        <Dropdown menu={{
          items: [
            { key: 'all', label: '全部类型', onClick: () => applyFileType(undefined) },
            { key: 'psd', label: 'PSD', onClick: () => applyFileType('psd') },
            { key: 'ai', label: 'AI', onClick: () => applyFileType('ai') },
            { key: 'pdf', label: 'PDF', onClick: () => applyFileType('pdf') },
            { key: 'png', label: 'PNG', onClick: () => applyFileType('png') },
            { key: 'jpg', label: 'JPG', onClick: () => applyFileType('jpg') },
            { key: 'svg', label: 'SVG', onClick: () => applyFileType('svg') },
            { key: 'ttf', label: 'TTF', onClick: () => applyFileType('ttf') },
            { key: 'otf', label: 'OTF', onClick: () => applyFileType('otf') },
            { key: 'woff', label: 'WOFF', onClick: () => applyFileType('woff') },
            { key: 'woff2', label: 'WOFF2', onClick: () => applyFileType('woff2') },
          ],
          selectedKeys: [fileTypeFilter || 'all'],
        }} trigger={['click']}>
          <button type="button" style={filterToolStyle}>
            <Eye size={15} />
            {fileTypeFilter ? fileTypeFilter.toUpperCase() : '类型'}
            <ChevronDown size={13} />
          </button>
        </Dropdown>
        <button type="button" onClick={toggleSortOrder} style={filterToolStyle}>
          添加时间
          <ChevronDown size={13} style={{ transform: sortOrder === 'asc' ? 'rotate(180deg)' : 'none' }} />
        </button>
        <button type="button" onClick={toggleSortOrder} style={iconButtonStyle} title="排序">
          <SlidersHorizontal size={15} />
        </button>
        <div style={viewSwitchStyle}>
          <button type="button" onClick={() => setView('list')} style={viewButtonStyle(view === 'list')} title="列表">
            <List size={15} />
          </button>
          <button type="button" onClick={() => setView('grid')} style={viewButtonStyle(view === 'grid')} title="网格">
            <Grid2x2 size={15} />
          </button>
        </div>
      </section>

      <main ref={contentRef} style={contentStyle}>
        {resourceLoadError && <div role="alert" style={{ marginBottom: 20, padding: '14px 16px', border: '1px solid #f3c8bc', borderRadius: 8, background: '#fff8f5', display: 'flex', alignItems: 'center', gap: 14 }}>
          <span style={{ flex: 1, color: '#8a3d27' }}>{resourceLoadError}{hasVisibleFiles ? ' 已保留上次加载的内容。' : ''}</span>
          <button type="button" disabled={(!isMyPage && librariesLoading) || isLoading} onClick={() => { void retryResourceLoad(); }} style={loadMoreButtonStyle}>重试加载</button>
        </div>}
        {isLoading && hasVisibleFiles && (
          <div style={contentLoadingHintStyle}>
            <Spin size="small" />
          </div>
        )}
        {(isLoading || (!isMyPage && librariesLoading) || (!hasLoaded && !resourceLoadError && (isMyPage || Boolean(selectedLibraryId)))) && !hasVisibleFiles ? (
          <LoadingTileGrid />
        ) : visibleFiles.length === 0 ? resourceLoadError ? null : (
          <Empty description={!isMyPage && libraries.length === 0 ? '暂无资源库' : '暂无模板'} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : view === 'grid' ? (
          <ResourceWaterfall files={visibleFiles} resetKey={layoutKey} boundaryRef={boundaryRef}
            renderItem={(file, metrics) => (
              <ResourceTile
                file={file}
                metrics={metrics}
                loading={openingId === file.id}
                onOpen={() => openTemplate(file)}
                canDelete={isMyPage && canDeleteMyFile(file)}
                canRestore={isTrashPage}
                onDelete={() => confirmDeleteMyFile(file, isTrashPage)}
                onRestore={() => handleRestoreMyFile(file)}
                batchMode={batchMode}
                selected={selectedFileIdSet.has(file.id)}
                onSelect={() => toggleSelectedFile(file)}
              />
            )}
          />
        ) : (
          <div style={listWrapStyle}>
            <div style={listHeaderStyle}>
              <span>名称</span>
              <span>类型</span>
              <span>大小</span>
              <span>设计师</span>
              <span>操作</span>
            </div>
            {visibleFiles.map((file) => (
              <div
                key={file.id}
                style={batchMode && selectedFileIdSet.has(file.id) ? { ...listRowStyle, background: '#f7f9ff' } : listRowStyle}
                onClick={() => batchMode && toggleSelectedFile(file)}
                onDoubleClick={() => !batchMode && openTemplate(file)}
              >
                <span style={listNameCellStyle}>
                  {batchMode && (
                    <span style={batchCheckStyle(selectedFileIdSet.has(file.id))}>
                      {selectedFileIdSet.has(file.id) ? '✓' : ''}
                    </span>
                  )}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</span>
                </span>
                <span style={{ textTransform: 'uppercase' }}>{file.fileType}</span>
                <span>{formatFileSize(file.fileSize)}</span>
                <span>{file.uploader?.displayName || '-'}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                  {!isTrashPage && !batchMode && <button type="button" onClick={(event) => { event.stopPropagation(); openTemplate(file); }} style={textButtonStyle}>
                    {openingId === file.id ? '打开中...' : '使用模板'}
                  </button>}
                  {isTrashPage && !batchMode && (
                    <button type="button" onClick={(event) => { event.stopPropagation(); handleRestoreMyFile(file); }} style={textButtonStyle}>
                      恢复
                    </button>
                  )}
                  {isMyPage && canDeleteMyFile(file) && !batchMode && (
                    <button
                      type="button"
                      onClick={(event) => { event.stopPropagation(); confirmDeleteMyFile(file, isTrashPage); }}
                      style={dangerTextButtonStyle}
                    >
                      {isTrashPage ? '永久删除' : '删除'}
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}

        {hasMoreFiles && (
          <div ref={loadMoreRef} style={loadMoreSentinelStyle}>
            {isLoading && hasVisibleFiles ? (
              <Spin size="small" />
            ) : (
              <button type="button" onClick={loadNextPage} style={loadMoreButtonStyle}>
                继续加载
              </button>
            )}
          </div>
        )}
      </main>

      <Modal
        open={!!myDeleteTarget}
        onCancel={() => !myDeleteLoading && setMyDeleteTarget(null)}
        footer={null}
        width={420}
        centered
        destroyOnClose
      >
        {myDeleteTarget && (
          <div style={myDeleteModalStyle}>
            <div style={myDeleteIconStyle}>
              <Trash2 size={22} />
            </div>
            <div style={myDeleteTitleStyle}>
              {myDeleteTarget.permanent ? '永久删除文件' : '删除到回收站'}
            </div>
            <div style={myDeleteDescStyle}>
              {myDeleteTarget.permanent
                ? `确定永久删除「${myDeleteTarget.file.name}」吗？此操作不可恢复。`
                : `确定删除「${myDeleteTarget.file.name}」吗？文件会在回收站保留 7 天。`}
            </div>
            <div style={myDeleteActionsStyle}>
              <button
                type="button"
                onClick={() => setMyDeleteTarget(null)}
                disabled={myDeleteLoading}
                style={modalCancelButtonStyle}
              >
                取消
              </button>
              <button
                type="button"
                onClick={executeDeleteMyFile}
                disabled={myDeleteLoading}
                style={modalDangerButtonStyle}
              >
                {myDeleteLoading ? '删除中...' : myDeleteTarget.permanent ? '永久删除' : '删除'}
              </button>
            </div>
          </div>
        )}
      </Modal>
      <Modal
        open={!!batchAction}
        onCancel={() => !batchLoading && setBatchAction(null)}
        footer={null}
        width={420}
        centered
        destroyOnClose
      >
        {batchAction && (
          <div style={myDeleteModalStyle}>
            <div style={myDeleteIconStyle}>
              {batchAction === 'restore' ? <RotateCcw size={22} /> : <Trash2 size={22} />}
            </div>
            <div style={myDeleteTitleStyle}>
              {batchAction === 'restore' ? '批量恢复文件' : batchAction === 'permanent' ? '批量永久删除' : '批量删除到回收站'}
            </div>
            <div style={myDeleteDescStyle}>
              {batchAction === 'restore'
                ? `确定恢复选中的 ${selectedFileIds.length} 个文件吗？`
                : batchAction === 'permanent'
                  ? `确定永久删除选中的 ${selectedFileIds.length} 个文件吗？此操作不可恢复。`
                  : `确定删除选中的 ${selectedFileIds.length} 个文件吗？文件会在回收站保留 7 天。`}
            </div>
            <div style={myDeleteActionsStyle}>
              <button
                type="button"
                onClick={() => setBatchAction(null)}
                disabled={batchLoading}
                style={modalCancelButtonStyle}
              >
                取消
              </button>
              <button
                type="button"
                onClick={executeBatchAction}
                disabled={batchLoading || selectedFileIds.length === 0}
                style={batchAction === 'restore' ? modalPrimaryButtonStyle : modalDangerButtonStyle}
              >
                {batchLoading ? '处理中...' : batchAction === 'restore' ? '恢复' : batchAction === 'permanent' ? '永久删除' : '删除'}
              </button>
            </div>
          </div>
        )}
      </Modal>
      <Modal
        open={!!fontPreviewFile}
        onCancel={() => setFontPreviewFile(null)}
        footer={null}
        width="min(92vw, 1460px)"
        centered
        destroyOnClose
      >
        {fontPreviewFile && <FontDetailModal file={fontPreviewFile} />}
      </Modal>
    </div>
  );
}

function LoadingTileGrid() {
  return (
    <div style={assetGridStyle} aria-busy="true">
      {Array.from({ length: 12 }, (_, index) => (
        <div key={index} style={tileWrapStyle}>
          <div style={skeletonTileImageStyle} />
        </div>
      ))}
    </div>
  );
}

function ResourceTile({
  file,
  metrics,
  loading,
  onOpen,
  canDelete = false,
  canRestore = false,
  onDelete,
  onRestore,
  batchMode = false,
  selected = false,
  onSelect,
}: {
  file: DesignFile;
  metrics: CardMetrics;
  loading?: boolean;
  onOpen: () => void;
  canDelete?: boolean;
  canRestore?: boolean;
  onDelete?: () => void;
  onRestore?: () => void;
  batchMode?: boolean;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const previewPath = getAssetPreviewPath(file);
  const previewHeight = metrics.previewHeight;
  const previewShellStyle: CSSProperties = selected
    ? { ...tileImageShellStyle, height: previewHeight, boxShadow: '0 0 0 2px #2557f6 inset' }
    : { ...tileImageShellStyle, height: previewHeight };

  return (
    <div
      className={`resource-tile${selected ? " is-selected" : ""}`}
      title={file.name}
      aria-label={file.name}
      role="button"
      tabIndex={0}
      onKeyDown={event => { if (event.target === event.currentTarget && !event.repeat && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); event.currentTarget.click(); } }}
      onClick={event => event.detail <= 1 && (batchMode ? onSelect?.() : onOpen())}
    >
      <div style={previewShellStyle}>
        <Thumb
          thumbnailUrl={previewPath}
          fileType={file.fileType}
          label={file.name?.charAt(0)}
          height={previewHeight}
          file={file}
          name={file.name}
          showBadge={false}
          resourceCard
          displayWidth={metrics.width}
          priority={metrics.priority}
          onIntrinsicSize={metrics.onIntrinsicSize}
        />
        {batchMode && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onSelect?.();
            }}
            style={tileSelectButtonStyle(selected)}
            title={selected ? '取消选择' : '选择'}
          >
            {selected ? '✓' : ''}
          </button>
        )}
        {!batchMode && (canRestore || canDelete) && (
          <div className="resource-tile-actions" style={tileActionBarStyle}>
            {canRestore && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onRestore?.();
                }}
                style={tileActionButtonStyle(false)}
                title="恢复"
              >
                <RotateCcw size={13} />
              </button>
            )}
            {canDelete && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete?.();
                }}
                style={tileActionButtonStyle(true)}
                title="删除"
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
        )}
      </div>
      <ResourceCardInfo file={file} loading={loading} />
    </div>
  );
}

function FontDetailModal({ file }: { file: DesignFile }) {
  const font = getFontMeta(file);
  const displayName = cleanFontName(font?.name || file.name || font?.family || 'Font');
  const fontFamily = buildFontFamily(font, displayName);
  const tags = file.tags || [];

  return (
    <div style={fontModalBodyStyle}>
      <div style={fontPreviewPaneStyle}>
        <div
          title={`${displayName} Regular`}
          style={{
            fontFamily,
            fontSize: 'clamp(56px, 8vw, 148px)',
            fontWeight: 400,
            lineHeight: 1.05,
            whiteSpace: 'nowrap',
            color: '#05070a',
            minWidth: 'max-content',
          }}
        >
          {displayName} Regular
        </div>
      </div>
      <aside style={fontInfoPaneStyle}>
        <h2 style={fontInfoTitleStyle}>{displayName}</h2>
        <button type="button" style={fontInfoMoreButtonStyle}>...</button>
        <div style={fontInfoDividerStyle} />
        <FontInfoRow label="格式">{file.fileType.toUpperCase()}</FontInfoRow>
        <FontInfoRow label="大小">{formatFileSize(file.fileSize)}</FontInfoRow>
        <FontInfoRow label="添加时间">{formatDate(file.createdAt)}</FontInfoRow>
        <FontInfoRow label="修改时间">{formatDate(file.updatedAt)}</FontInfoRow>
        <FontInfoRow label="合规检测">
          <span style={fontPassChipStyle}>未涉政</span>
          <span style={fontPassChipStyle}>未涉黄</span>
          <span style={fontPassChipStyle}>未涉暴</span>
        </FontInfoRow>
        <FontInfoRow label="AI 生成">
          <span style={fontSwitchOffStyle} />
        </FontInfoRow>
        <FontInfoRow label="版权标记">未标记</FontInfoRow>
        <div style={fontInfoDividerStyle} />
        <FontInfoSection title="分类">{file.category?.name || '无分类'}</FontInfoSection>
        <FontInfoSection title="标签">
          {tags.length > 0 ? (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {tags.map((tag) => <span key={tag.id} style={fontTagChipStyle}>{tag.name}</span>)}
            </div>
          ) : '无标签'}
        </FontInfoSection>
      </aside>
    </div>
  );
}

function FontInfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={fontInfoRowStyle}>
      <span style={fontInfoLabelStyle}>{label}</span>
      <span style={fontInfoValueStyle}>{children}</span>
    </div>
  );
}

function FontInfoSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={fontInfoSectionStyle}>
      <div style={fontInfoSectionTitleStyle}>{title}</div>
      <div style={fontInfoSectionValueStyle}>{children}</div>
    </section>
  );
}

function flattenCategories(categories: Category[]): Category[] {
  const seen = new Set<number>();
  const result: Category[] = [];

  const visit = (items: Category[]) => {
    items.forEach((category) => {
      if (!seen.has(category.id)) {
        seen.add(category.id);
        result.push(category);
      }
      if (category.children?.length) visit(category.children);
    });
  };

  visit(categories);
  return result;
}

function getCategoryAndDescendantIds(category: Category): number[] {
  return [category.id, ...(category.children || []).flatMap(getCategoryAndDescendantIds)];
}

const FONT_FILE_TYPES = new Set(['ttf', 'otf', 'ttc', 'woff', 'woff2']);

function isFontFile(file: DesignFile): boolean {
  return FONT_FILE_TYPES.has(file.fileType.toLowerCase());
}

function getFontMeta(file: DesignFile): FontMeta | undefined {
  const parseResult = file.parseResult as { font?: FontMeta } | undefined;
  return parseResult?.font;
}

function buildFontFamily(font: FontMeta | undefined, fallbackName: string) {
  const names = [font?.family, font?.name, ...(font?.aliases || []), fallbackName, 'var(--font-sans)']
    .filter((value): value is string => Boolean(value));
  return names.map((value) => value.startsWith('var(') ? value : `"${value.replace(/"/g, '\\"')}"`).join(', ');
}

function cleanFontName(value: string) {
  return value.replace(/\.(ttf|otf|ttc|woff2?)$/i, '');
}

function buildCategoryFilterParams(
  selectedIds: number[],
  categoryById: Map<number, Category>,
): { categoryId: number | undefined; categoryIds: string | undefined; includeChildren: boolean | undefined } {
  const selectedSet = new Set(selectedIds);
  const ids: number[] = [];
  let includeChildren = false;
  for (const id of selectedIds) {
    const category = categoryById.get(id);
    if (!category) {
      ids.push(id);
      continue;
    }
    // 若该分类下有被选中的子分类，则它只是上下文父级，由子分类承担过滤
    const hasSelectedChild = (category.children || []).some((c) => selectedSet.has(c.id));
    if (hasSelectedChild) continue;
    // 否则按整条分支过滤（含全部后代），这样选中二级或点「全部」能看到分支下所有内容
    if ((category.children || []).length > 0) includeChildren = true;
    ids.push(...getCategoryAndDescendantIds(category));
  }
  const unique = Array.from(new Set(ids));

  return {
    categoryId: unique.length === 1 ? unique[0] : undefined,
    categoryIds: unique.length > 1 ? unique.join(',') : undefined,
    includeChildren: includeChildren || undefined,
  };
}

function formatFileSize(bytes: number): string {
  const n = Number(bytes);
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function formatDate(value?: string) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).replace(/\//g, '/');
}

const pageStyle: CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  flexDirection: 'column',
  background: '#fff',
};

const filterStageStyle: CSSProperties = {
  padding: '28px 34px 20px',
  borderBottom: '1px solid #f0f0ef',
  background: '#fff',
};

const myHeaderStyle: CSSProperties = {
  minHeight: 86,
  padding: '26px 34px 0',
  display: 'flex',
  alignItems: 'flex-start',
  gap: 18,
  borderBottom: '1px solid #f0f0ef',
  background: '#fff',
};

const myTabsStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  gap: 34,
  minWidth: 0,
};

function mySpaceTabStyle(active: boolean): CSSProperties {
  return {
    height: 38,
    border: 0,
    borderBottom: active ? '2px solid #111827' : '2px solid transparent',
    background: 'transparent',
    color: active ? '#111827' : '#8b949e',
    font: active ? '800 17px var(--font-sans)' : '700 16px var(--font-sans)',
    cursor: 'pointer',
    padding: 0,
  };
}

const myAddButtonStyle: CSSProperties = {
  height: 38,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '0 17px',
  borderRadius: 9,
  border: 0,
  background: '#2557f6',
  color: '#fff',
  font: '800 14px var(--font-sans)',
  cursor: 'pointer',
};

const mySectionTitleStyle: CSSProperties = {
  height: 58,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  color: '#111827',
  font: '800 14px var(--font-sans)',
};

const filterHeaderStyle: CSSProperties = {
  height: 36,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  marginBottom: 18,
};

const libraryButtonStyle: CSSProperties = {
  height: 34,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  border: 0,
  background: 'transparent',
  color: '#111827',
  font: '800 18px var(--font-sans)',
  cursor: 'pointer',
};

const libraryMenuStyle: CSSProperties = {
  position: 'absolute',
  top: 38,
  left: 0,
  zIndex: 100,
  width: 230,
  padding: 6,
  border: '1px solid #e5e7eb',
  borderRadius: 8,
  background: '#fff',
  boxShadow: '0 16px 38px rgba(15, 23, 42, .14)',
};

function libraryMenuItemStyle(active: boolean): CSSProperties {
  return {
    width: '100%',
    height: 34,
    border: 0,
    borderRadius: 6,
    padding: '0 10px',
    background: active ? '#f0f1ee' : 'transparent',
    color: '#111827',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    cursor: 'pointer',
    font: '600 13px var(--font-sans)',
  };
}

const topSearchStyle: CSSProperties = {
  width: 230,
  height: 34,
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  padding: '0 10px',
  border: '1px solid #e5e7eb',
  borderRadius: 7,
  background: '#fff',
};

const topSearchInputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: 0,
  outline: 'none',
  background: 'transparent',
  color: '#111827',
  font: '500 13px var(--font-sans)',
};

function plainButtonStyle(active: boolean): CSSProperties {
  return {
    height: 34,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 12px',
    borderRadius: 7,
    border: '1px solid #e5e7eb',
    background: active ? '#eff6ff' : '#fff',
    color: active ? '#2563eb' : '#111827',
    font: '700 13px var(--font-sans)',
    cursor: 'pointer',
  };
}

const createButtonStyle: CSSProperties = {
  height: 36,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '0 15px',
  borderRadius: 8,
  border: 0,
  background: '#2557f6',
  color: '#fff',
  font: '800 14px var(--font-sans)',
  cursor: 'pointer',
};

const categoryRowsStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const categoryRowStyle: CSSProperties = {
  minHeight: 30,
  display: 'flex',
  alignItems: 'flex-start',
  gap: 18,
};

const categoryLabelStyle: CSSProperties = {
  width: 80,
  flexShrink: 0,
  paddingTop: 6,
  color: '#b2b8bf',
  font: '700 13px var(--font-sans)',
};

const categoryPillsWrapStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexWrap: 'wrap',
  gap: '7px 22px',
  alignItems: 'center',
};

function categoryPillStyle(active: boolean): CSSProperties {
  return {
    minWidth: active ? 48 : 0,
    height: 30,
    padding: active ? '0 14px' : 0,
    border: 0,
    borderRadius: 6,
    background: active ? '#e9e9e9' : 'transparent',
    color: active ? '#111827' : '#1f2937',
    font: active ? '700 13px var(--font-sans)' : '500 13px var(--font-sans)',
    cursor: 'pointer',
  };
}

const contentHeaderStyle: CSSProperties = {
  height: 58,
  padding: '0 34px',
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  borderBottom: '1px solid #f0f0ef',
  background: '#fff',
};

const tabsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 22,
};

function tabStyle(active: boolean): CSSProperties {
  return {
    height: 58,
    border: 0,
    borderBottom: active ? '2px solid #111827' : '2px solid transparent',
    background: 'transparent',
    color: active ? '#111827' : '#8b949e',
    font: active ? '800 14px var(--font-sans)' : '600 14px var(--font-sans)',
    cursor: 'pointer',
  };
}

const filterToolStyle: CSSProperties = {
  height: 30,
  border: 0,
  background: 'transparent',
  color: '#4b5563',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  font: '600 13px var(--font-sans)',
  cursor: 'pointer',
};

function batchToolbarStyle(active: boolean): CSSProperties {
  return {
    minHeight: 34,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: active ? '3px 6px' : 0,
    borderRadius: 9,
    background: active ? '#f7f9ff' : 'transparent',
    border: active ? '1px solid #dbe5ff' : '1px solid transparent',
  };
}

function batchButtonStyle(active: boolean): CSSProperties {
  return {
    height: 30,
    padding: '0 12px',
    borderRadius: 7,
    border: active ? '1px solid #2557f6' : '1px solid #e5e7eb',
    background: active ? '#2557f6' : '#fff',
    color: active ? '#fff' : '#111827',
    font: '800 13px var(--font-sans)',
    cursor: 'pointer',
  };
}

const batchCountStyle: CSSProperties = {
  minWidth: 48,
  color: '#4b5563',
  font: '700 12px var(--font-sans)',
};

const batchGhostButtonStyle: CSSProperties = {
  height: 28,
  padding: '0 10px',
  borderRadius: 7,
  border: '1px solid #e5e7eb',
  background: '#fff',
  color: '#4b5563',
  font: '700 12px var(--font-sans)',
  cursor: 'pointer',
};

const batchPrimaryButtonStyle: CSSProperties = {
  height: 28,
  padding: '0 11px',
  borderRadius: 7,
  border: 0,
  background: '#2557f6',
  color: '#fff',
  font: '800 12px var(--font-sans)',
  cursor: 'pointer',
};

const batchDangerButtonStyle: CSSProperties = {
  height: 28,
  padding: '0 11px',
  borderRadius: 7,
  border: 0,
  background: '#fee2e2',
  color: '#dc2626',
  font: '800 12px var(--font-sans)',
  cursor: 'pointer',
};

const iconButtonStyle: CSSProperties = {
  width: 30,
  height: 30,
  border: 0,
  borderRadius: 6,
  background: 'transparent',
  color: '#4b5563',
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
};

const viewSwitchStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
};

function viewButtonStyle(active: boolean): CSSProperties {
  return {
    width: 30,
    height: 30,
    border: 0,
    borderRadius: 6,
    background: active ? '#f0f1ee' : 'transparent',
    color: active ? '#111827' : '#4b5563',
    display: 'grid',
    placeItems: 'center',
    cursor: 'pointer',
  };
}

const contentStyle: CSSProperties = {
  flex: '0 0 auto',
  overflowAnchor: 'none',
  padding: '24px 34px 48px',
  background: '#fff',
  position: 'relative',
};

const contentLoadingHintStyle: CSSProperties = {
  position: 'absolute',
  top: 18,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 5,
  width: 34,
  height: 34,
  borderRadius: 8,
  border: '1px solid #e5e7eb',
  background: 'rgba(255, 255, 255, .92)',
  boxShadow: '0 8px 22px rgba(15, 23, 42, .10)',
  display: 'grid',
  placeItems: 'center',
};

const loadMoreSentinelStyle: CSSProperties = {
  minHeight: 42,
  marginTop: 22,
  display: 'grid',
  placeItems: 'center',
};

const loadMoreButtonStyle: CSSProperties = {
  height: 30,
  padding: '0 12px',
  borderRadius: 7,
  border: '1px solid #e5e7eb',
  background: '#fff',
  color: '#4b5563',
  font: '700 12px var(--font-sans)',
  cursor: 'pointer',
};

const assetGridStyle: CSSProperties = {
  width: '100%',
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 240px), 1fr))',
  gap: 20,
};

const skeletonTileImageStyle: CSSProperties = {
  height: RESOURCE_TILE_PREVIEW_HEIGHT,
  borderRadius: 8,
  border: '1px solid #eceff3',
  background: 'linear-gradient(90deg, #f1f3f5 0%, #e9edf2 45%, #f1f3f5 100%)',
};

const tileWrapStyle: CSSProperties = {
  minWidth: 0,
  width: '100%',
  cursor: 'pointer',
  display: 'inline-flex',
  flexDirection: 'column',
  gap: 0,
  marginBottom: 14,
  breakInside: 'avoid',
  pageBreakInside: 'avoid',
  verticalAlign: 'top',
};

const tileImageShellStyle: CSSProperties = {
  position: 'relative', overflow: 'hidden', background: '#f5f6f8',
};

const tileImageStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  objectFit: 'contain',
  display: 'block',
};

const tileFallbackStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  display: 'grid',
  placeItems: 'center',
  color: '#9aa1aa',
  font: '800 22px var(--font-sans)',
};

const tileActionBarStyle: CSSProperties = {
  position: 'absolute',
  right: 8,
  top: 8,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
};

function tileActionButtonStyle(danger: boolean): CSSProperties {
  return {
    width: 30,
    height: 30,
    border: '1px solid rgba(17, 24, 39, .08)',
    borderRadius: 8,
    background: 'rgba(255, 255, 255, .94)',
    color: danger ? '#dc2626' : '#2557f6',
    display: 'grid',
    placeItems: 'center',
    cursor: 'pointer',
    boxShadow: '0 8px 18px rgba(15, 23, 42, .12)',
  };
}

function tileSelectButtonStyle(checked: boolean): CSSProperties {
  return {
    position: 'absolute',
    left: 8,
    top: 34,
    width: 28,
    height: 28,
    borderRadius: 8,
    border: checked ? '1px solid #2557f6' : '1px solid rgba(17, 24, 39, .12)',
    background: checked ? '#2557f6' : 'rgba(255, 255, 255, .95)',
    color: '#fff',
    display: 'grid',
    placeItems: 'center',
    cursor: 'pointer',
    font: '900 14px var(--font-sans)',
    boxShadow: '0 8px 18px rgba(15, 23, 42, .12)',
  };
}

const fontModalBodyStyle: CSSProperties = {
  height: 'min(78vh, 760px)',
  minHeight: 560,
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) 360px',
  background: '#fff',
  overflow: 'hidden',
};

const fontPreviewPaneStyle: CSSProperties = {
  minWidth: 0,
  padding: '48px 58px',
  display: 'flex',
  alignItems: 'center',
  overflowX: 'auto',
  overflowY: 'hidden',
  background: '#fff',
};

const fontInfoPaneStyle: CSSProperties = {
  borderLeft: '1px solid #eef0f2',
  padding: '28px 28px 34px',
  background: '#fff',
  overflowY: 'auto',
};

const fontInfoTitleStyle: CSSProperties = {
  margin: '0 0 18px',
  color: '#a7adb7',
  font: '800 18px var(--font-sans)',
  wordBreak: 'break-word',
};

const fontInfoMoreButtonStyle: CSSProperties = {
  width: 38,
  height: 34,
  border: 0,
  borderRadius: 8,
  background: '#eef0f2',
  color: '#4b5563',
  font: '800 18px var(--font-sans)',
  cursor: 'pointer',
};

const fontInfoDividerStyle: CSSProperties = {
  height: 1,
  background: '#eef0f2',
  margin: '26px 0 18px',
};

const fontInfoRowStyle: CSSProperties = {
  minHeight: 30,
  display: 'grid',
  gridTemplateColumns: '88px minmax(0, 1fr)',
  gap: 10,
  alignItems: 'center',
  font: '500 13px var(--font-sans)',
};

const fontInfoLabelStyle: CSSProperties = {
  color: '#8b949e',
};

const fontInfoValueStyle: CSSProperties = {
  minWidth: 0,
  color: '#1f2937',
  display: 'flex',
  justifyContent: 'flex-end',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
  textAlign: 'right',
};

const fontPassChipStyle: CSSProperties = {
  padding: '3px 8px',
  borderRadius: 6,
  background: '#dff7e7',
  color: '#1f9a55',
  font: '800 11px var(--font-sans)',
};

const fontSwitchOffStyle: CSSProperties = {
  width: 32,
  height: 18,
  borderRadius: 99,
  background: '#e5e7eb',
  position: 'relative',
  boxShadow: 'inset 0 0 0 1px rgba(15,23,42,.04)',
};

const fontInfoSectionStyle: CSSProperties = {
  padding: '4px 0 18px',
};

const fontInfoSectionTitleStyle: CSSProperties = {
  marginBottom: 10,
  color: '#8b949e',
  font: '700 13px var(--font-sans)',
};

const fontInfoSectionValueStyle: CSSProperties = {
  color: '#6b7280',
  font: '500 13px var(--font-sans)',
  minHeight: 22,
};

const fontTagChipStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  height: 24,
  padding: '0 9px',
  borderRadius: 7,
  background: '#f3f4f6',
  color: '#4b5563',
  font: '700 12px var(--font-sans)',
};

const listWrapStyle: CSSProperties = {
  borderTop: '1px solid #f0f0ef',
};

const listHeaderStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '2.4fr .7fr .8fr 1fr 132px',
  gap: 12,
  padding: '10px 0',
  color: '#8b949e',
  font: '700 12px var(--font-sans)',
};

const listRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '2.4fr .7fr .8fr 1fr 132px',
  gap: 12,
  padding: '14px 0',
  borderTop: '1px solid #f0f0ef',
  color: '#5f6872',
  font: '500 13px var(--font-sans)',
  cursor: 'pointer',
};

const listNameCellStyle: CSSProperties = {
  minWidth: 0,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  color: '#111827',
  fontWeight: 600,
  overflow: 'hidden',
};

function batchCheckStyle(checked: boolean): CSSProperties {
  return {
    width: 18,
    height: 18,
    flexShrink: 0,
    borderRadius: 5,
    border: checked ? '1px solid #2557f6' : '1px solid #d1d5db',
    background: checked ? '#2557f6' : '#fff',
    color: '#fff',
    display: 'inline-grid',
    placeItems: 'center',
    font: '900 12px var(--font-sans)',
  };
}

const textButtonStyle: CSSProperties = {
  border: 0,
  background: 'transparent',
  color: '#2557f6',
  cursor: 'pointer',
  font: '700 12px var(--font-sans)',
};

const dangerTextButtonStyle: CSSProperties = {
  border: 0,
  background: 'transparent',
  color: '#dc2626',
  cursor: 'pointer',
  font: '700 12px var(--font-sans)',
};

const myDeleteModalStyle: CSSProperties = {
  padding: '10px 4px 2px',
  textAlign: 'center',
};

const myDeleteIconStyle: CSSProperties = {
  width: 48,
  height: 48,
  borderRadius: 14,
  margin: '0 auto 14px',
  display: 'grid',
  placeItems: 'center',
  background: '#fef2f2',
  color: '#dc2626',
};

const myDeleteTitleStyle: CSSProperties = {
  color: '#111827',
  font: '800 18px var(--font-sans)',
  marginBottom: 8,
};

const myDeleteDescStyle: CSSProperties = {
  color: '#68717b',
  font: '500 13px var(--font-sans)',
  lineHeight: 1.7,
  marginBottom: 22,
};

const myDeleteActionsStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  gap: 10,
};

const modalCancelButtonStyle: CSSProperties = {
  height: 36,
  padding: '0 18px',
  borderRadius: 8,
  border: '1px solid #e5e7eb',
  background: '#fff',
  color: '#111827',
  cursor: 'pointer',
  font: '700 13px var(--font-sans)',
};

const modalDangerButtonStyle: CSSProperties = {
  height: 36,
  padding: '0 18px',
  borderRadius: 8,
  border: 0,
  background: '#dc2626',
  color: '#fff',
  cursor: 'pointer',
  font: '800 13px var(--font-sans)',
};

const modalPrimaryButtonStyle: CSSProperties = {
  height: 36,
  padding: '0 18px',
  borderRadius: 8,
  border: 0,
  background: '#2557f6',
  color: '#fff',
  cursor: 'pointer',
  font: '800 13px var(--font-sans)',
};
