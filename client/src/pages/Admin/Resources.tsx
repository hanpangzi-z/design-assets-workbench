import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronDown,
  ChevronRight,
  Check,
  Download,
  Edit3,
  Eye,
  FileText,
  Folder,
  Grid2x2,
  List,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Search,
  Settings,
  SlidersHorizontal,
  Trash2,
  Type,
  Upload as UploadIcon,
  X,
} from 'lucide-react';
import { Dropdown, Empty, message, Modal, Spin, type MenuProps } from 'antd';
import api from '@/api/index';
import { getLibraries } from '@/api/libraries';
import useFileStore from '@/store/fileStore';
import useCategoryStore from '@/store/categoryStore';
import useAuthStore from '@/store/authStore';
import Thumb from '@/components/FileCard/Thumb';
import ResourceWaterfall, { ResourceCardInfo, type CardMetrics } from '@/components/ResourceWaterfall';
import { useResourceLoadMore } from '@/hooks/useResourceLoadMore';
import UploadModal from '@/components/Upload/UploadModal';
import { useAutoRefreshPendingParses } from '@/hooks/useAutoRefreshPendingParses';
import { sortLibrariesByPin } from '@/utils/librarySort';
import { getAssetPreviewPath } from '@/utils/assetPreview';
import { deleteFile, deleteFilePermanently, deleteFiles, restoreFile as restoreFileApi, triggerFileDownload, updateFile, type FileListParams } from '@/api/files';
import { FALLBACK_TRANSFER_CHUNK_SIZE, getTransferConfig, uploadFileByTransfer } from '@/api/transfer';
import { createTag, getTags } from '@/api/tags';
import type { Category, DesignFile, Tag } from 'shared/types';

const DIM_LABELS: Record<string, string> = {
  festival: '节日/促销',
  design_type: '设计类别',
  product_type: '本来品类',
  version: '线上渠道',
};

const RESOURCE_TILE_PREVIEW_HEIGHT = 252;

interface LibraryOption {
  id: number;
  name: string;
  templateCount?: number;
  materialCount?: number;
  isPinned?: boolean | number | string | null;
  pinnedAt?: string | Date | null;
}

function getLibraryResourceCount(library: LibraryOption) {
  return (library.templateCount ?? 0) + (library.materialCount ?? 0);
}

export default function AdminResources() {
  const navigate = useNavigate();
  const { files, total, page, pageSize, isLoading, loadError, loadMoreExhausted, filters, fetchFiles, setFilters } = useFileStore();
  const { dimensionCategories, fetchAll: fetchCategories } = useCategoryStore();
  const user = useAuthStore((s) => s.user);
  const permissions = useAuthStore((s) => s.permissions);

  const [tab, setTab] = useState<'all' | 'uploaded'>('all');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [query, setQuery] = useState('');
  const [libraries, setLibraries] = useState<LibraryOption[]>([]);
  const [selectedLibraryId, setSelectedLibraryId] = useState<number | undefined>();
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<number[]>([]);
  const [uncategorized, setUncategorized] = useState(false);
  const [fileTypeFilter, setFileTypeFilter] = useState<string | undefined>();
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadMode, setUploadMode] = useState<'file' | 'folder'>('file');
  const [deleteTarget, setDeleteTarget] = useState<DesignFile | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [selectedFileIds, setSelectedFileIds] = useState<number[]>([]);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [batchLoading, setBatchLoading] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [dropUploading, setDropUploading] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashFiles, setTrashFiles] = useState<DesignFile[]>([]);
  const [editingCategoryFiles, setEditingCategoryFiles] = useState<DesignFile[]>([]);
  const [tempCategoryIds, setTempCategoryIds] = useState<number[]>([]);
  const [categorySearch, setCategorySearch] = useState('');
  const [activeCategoryDimension, setActiveCategoryDimension] = useState('');
  const [activeCategoryParentId, setActiveCategoryParentId] = useState<number | null>(null);
  const [editingTagFiles, setEditingTagFiles] = useState<DesignFile[]>([]);
  const [tempTagIds, setTempTagIds] = useState<number[]>([]);
  const [tagSearch, setTagSearch] = useState('');
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [tagsLoading, setTagsLoading] = useState(false);
  const [metaSaving, setMetaSaving] = useState(false);
  const dragDepthRef = useRef(0);
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

  const selectedLibrary = useMemo(
    () => libraries.find((lib) => lib.id === selectedLibraryId),
    [libraries, selectedLibraryId],
  );

  const categoryGroups = useMemo(() => {
    return Object.entries(dimensionCategories)
      .map(([dimension, categories]) => ({
        dimension,
        label: DIM_LABELS[dimension] || dimension,
        items: flattenCategories(categories),
      }))
      .filter((group) => group.items.length > 0);
  }, [dimensionCategories]);

  const allCategories = useMemo(
    () => categoryGroups.flatMap((group) => group.items),
    [categoryGroups],
  );

  const categoryById = useMemo(() => {
    const map = new Map<number, Category>();
    allCategories.forEach((category) => map.set(category.id, category));
    return map;
  }, [allCategories]);

  const categoryNameSet = useMemo(() => new Set(allCategories.map((category) => category.name)), [allCategories]);
  const selectedCategoryIdSet = useMemo(() => new Set(selectedCategoryIds), [selectedCategoryIds]);
  const tempCategoryIdSet = useMemo(() => new Set(tempCategoryIds), [tempCategoryIds]);
  const tempTagIdSet = useMemo(() => new Set(tempTagIds), [tempTagIds]);

  const selectedTempCategories = useMemo(
    () => tempCategoryIds.map((id) => categoryById.get(id)).filter(Boolean) as Category[],
    [categoryById, tempCategoryIds],
  );

  const activeCategoryGroup = useMemo(
    () => categoryGroups.find((group) => group.dimension === activeCategoryDimension) || categoryGroups[0],
    [activeCategoryDimension, categoryGroups],
  );

  const activeCategoryParent = useMemo(
    () => (activeCategoryParentId == null ? null : categoryById.get(activeCategoryParentId) || null),
    [activeCategoryParentId, categoryById],
  );

  const visibleCategoryOptions = useMemo(() => {
    const keyword = categorySearch.trim().toLowerCase();
    if (keyword) {
      return allCategories.filter((category) => category.name.toLowerCase().includes(keyword));
    }
    if (activeCategoryParent) return activeCategoryParent.children || [];
    return dimensionCategories[activeCategoryGroup?.dimension || ''] || [];
  }, [activeCategoryGroup, activeCategoryParent, allCategories, categorySearch, dimensionCategories]);

  const selectableTags = useMemo(
    () => allTags.filter((tag) => !categoryNameSet.has(tag.name)),
    [allTags, categoryNameSet],
  );

  const tagById = useMemo(() => {
    const map = new Map<number, Tag>();
    allTags.forEach((tag) => map.set(tag.id, tag));
    editingTagFiles.forEach((file) => file.tags?.forEach((tag) => map.set(tag.id, tag)));
    return map;
  }, [allTags, editingTagFiles]);

  const selectedTempTags = useMemo(
    () => tempTagIds.map((id) => tagById.get(id)).filter(Boolean) as Tag[],
    [tagById, tempTagIds],
  );

  const visibleTagOptions = useMemo(() => {
    const keyword = tagSearch.trim().toLowerCase();
    if (!keyword) return selectableTags;
    return selectableTags.filter((tag) => tag.name.toLowerCase().includes(keyword));
  }, [selectableTags, tagSearch]);

  const visibleFiles = useMemo(() => {
    if (tab === 'uploaded') return files.filter((file) => file.uploadedBy === user?.id);
    return files;
  }, [files, tab, user?.id]);
  const hasVisibleFiles = visibleFiles.length > 0;
  const hasMoreFiles = !loadError && tab === 'all' && !loadMoreExhausted && files.length < total;

  const refreshLoadedFiles = useCallback(() => {
    const loadedPages = Math.max(1, Math.ceil(Math.max(files.length, pageSize) / pageSize));
    return fetchFiles({ page: 1, pageSize: loadedPages * pageSize }, { preserveLoadedPage: true });
  }, [fetchFiles, files.length, pageSize]);

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

  const layoutKey = JSON.stringify(['admin', filters, tab]);
  useEffect(() => {
    loadGeneration.current += 1;
    loadingMoreRef.current = false;
  }, [layoutKey]);
  useResourceLoadMore({
    containerRef: contentRef, sentinelRef: loadMoreRef, boundaryRef, resetKey: layoutKey,
    enabled: hasMoreFiles, loading: isLoading, revision: files.length, onLoad: loadNextPage,
  });

  const visibleFileIds = useMemo(() => visibleFiles.map((file) => file.id), [visibleFiles]);
  const selectedFileIdSet = useMemo(() => new Set(selectedFileIds), [selectedFileIds]);
  const selectedFiles = useMemo(
    () => visibleFiles.filter((file) => selectedFileIdSet.has(file.id)),
    [selectedFileIdSet, visibleFiles],
  );
  const selectionActive = selectedFileIds.length > 0;

  const canUpload = permissions?.upload === true;
  const canManageUsers = permissions?.manage_users === true;
  const canManageCategories = permissions?.manage_categories === true;
  const canManageTags = permissions?.manage_tags === true;
  const canManageTrash = permissions?.delete_files === true;
  const canEditFileMetadata = permissions?.edit === true;

  useEffect(() => {
    setSelectedFileIds((current) => current.filter((id) => visibleFileIds.includes(id)));
  }, [visibleFileIds]);

  const loadLibraries = async (force = false) => {
    try {
      const libs: LibraryOption[] = sortLibrariesByPin(await getLibraries({ force }));
      setLibraries(libs);
      setSelectedLibraryId((current) => {
        if (current && libs.some((library) => library.id === current)) return current;
        return libs[0]?.id;
      });
    } catch {
      setLibraries([]);
      setSelectedLibraryId(undefined);
    }
  };

  useEffect(() => {
    loadLibraries();
  }, []);

  useEffect(() => {
    if (!selectedLibraryId) return;
    setSelectedCategoryIds([]);
    setUncategorized(false);
    fetchCategories(selectedLibraryId).catch(() => {});
    setFilters({
      libraryId: selectedLibraryId,
      categoryId: undefined,
      categoryIds: undefined,
      includeChildren: undefined,
      uncategorized: undefined,
      keyword: undefined,
      fileType: undefined,
      tagIds: undefined,
      scope: undefined,
      myView: undefined,
      includePersonal: undefined,
      sortBy: 'created_at',
      sortOrder: 'desc',
    });
  }, [selectedLibraryId, fetchCategories, setFilters]);

  const applyCategorySelection = (ids: number[]) => {
    setFilters(buildCurrentResourceFilters(ids, { uncategorized: undefined }));
  };

  const buildCurrentResourceFilters = (
    categoryIds: number[] = selectedCategoryIds,
    overrides: Partial<FileListParams> = {},
  ): FileListParams => ({
    libraryId: selectedLibraryId,
    ...buildCategoryFilterParams(categoryIds, categoryById),
    uncategorized: uncategorized || undefined,
    keyword: query.trim() || undefined,
    fileType: fileTypeFilter,
    sortBy: 'created_at',
    sortOrder,
    ...overrides,
  });

  // 二级（顶级）单选；三级（子级）也单选，但始终保留其父级二级作为上下文，
  // 这样二级和三级是联动的共享关系，而不是互相清空。
  const toggleCategory = (category: Category) => {
    const topLevel = (() => {
      const found = categoryGroups.find((g) => g.items.some((item) => item.id === category.id));
      return found ? (dimensionCategories[found.dimension] || []) : [];
    })();
    if (topLevel.length === 0) return;
    const groupIds = new Set(flattenCategories(topLevel).map((item) => item.id));
    const parent = topLevel.find((p) => (p.children || []).some((c) => c.id === category.id));
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
    setUncategorized(false);
    setSelectedCategoryIds(nextIds);
    applyCategorySelection(nextIds);
  };

  // 点击「全部」/ 二级名称：只保留该二级，清空其下已选的三级。
  const selectOnlySecond = (node: Category) => {
    const found = categoryGroups.find((g) => (dimensionCategories[g.dimension] || []).some((p) => p.id === node.id));
    const topLevel = found ? (dimensionCategories[found.dimension] || []) : [];
    const groupIds = new Set(flattenCategories(topLevel).map((item) => item.id));
    const nextIds = [...selectedCategoryIds.filter((id) => !groupIds.has(id)), node.id];
    setUncategorized(false);
    setSelectedCategoryIds(nextIds);
    applyCategorySelection(nextIds);
  };

  const clearCategoryGroup = (categoryIds: number[]) => {
    const groupIds = new Set(categoryIds);
    const nextIds = selectedCategoryIds.filter((id) => !groupIds.has(id));
    setUncategorized(false);
    setSelectedCategoryIds(nextIds);
    applyCategorySelection(nextIds);
  };

  const toggleUncategorized = () => {
    const next = !uncategorized;
    setUncategorized(next);
    setSelectedCategoryIds([]);
    setFilters(buildCurrentResourceFilters([], { uncategorized: next || undefined }));
  };

  const handleSearch = () => {
    setFilters(buildCurrentResourceFilters());
  };

  const applyFileType = (fileType?: string) => {
    setFileTypeFilter(fileType);
    setFilters(buildCurrentResourceFilters(selectedCategoryIds, { fileType }));
  };

  const openUpload = (mode: 'file' | 'folder') => {
    setUploadMode(mode);
    setUploadOpen(true);
  };

  const refreshResources = () => {
    fetchFiles();
    loadLibraries(true);
    window.setTimeout(() => fetchFiles(), 1500);
    window.setTimeout(() => {
      fetchFiles();
      loadLibraries(true);
    }, 4500);
  };

  const handleDroppedFiles = async (sourceFiles: File[]) => {
    if (!canUpload || !selectedLibraryId || dropUploading) return;
    const validFiles = sourceFiles.filter(isSupportedResourceUploadFile);
    if (validFiles.length === 0) {
      message.warning('请选择支持的文件格式');
      return;
    }

    const config = await getTransferConfig().catch(() => ({
      chunkSize: FALLBACK_TRANSFER_CHUNK_SIZE,
      uploadConcurrency: 3,
      maxBatchFiles: 50,
      maxFileSize: 30 * 1024 * 1024,
      maxTotalSize: 100 * 1024 * 1024,
    }));
    const uploadFiles = validFiles.slice(0, config.maxBatchFiles || 50);
    if (validFiles.length > uploadFiles.length) {
      message.warning(`单次最多上传 ${uploadFiles.length} 个文件，已取前 ${uploadFiles.length} 个`);
    }

    const oversize = uploadFiles.find((file) => file.size > config.maxFileSize);
    if (oversize) {
      message.error(`${oversize.name} 超过 ${formatFileSize(config.maxFileSize)}`);
      return;
    }
    const totalSize = uploadFiles.reduce((sum, file) => sum + file.size, 0);
    if (totalSize > (config.maxTotalSize || 100 * 1024 * 1024)) {
      message.error(`本次上传总大小不能超过 ${formatFileSize(config.maxTotalSize || 100 * 1024 * 1024)}`);
      return;
    }

    if (sourceFiles.length !== validFiles.length) {
      message.warning(`已忽略 ${sourceFiles.length - validFiles.length} 个不支持的文件`);
    }

    const categoryIds = normalizeCategoryIdsByGroup(selectedCategoryIds, categoryGroups);
    const hide = message.loading(`正在上传 ${uploadFiles.length} 个文件...`, 0);
    setDropUploading(true);
    try {
      for (const file of uploadFiles) {
        await uploadFileByTransfer(file, {
          libraryId: selectedLibraryId,
          categoryId: categoryIds[0],
          categoryTagIds: categoryIds,
        });
      }
      refreshFontCss();
      message.success(`已上传 ${uploadFiles.length} 个文件`);
      refreshResources();
    } catch (err: any) {
      message.error(err?.response?.data?.message || err?.message || '上传失败');
    } finally {
      hide();
      setDropUploading(false);
    }
  };

  const handlePageDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    if (canUpload && selectedLibraryId) setDropActive(true);
  };

  const handlePageDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = canUpload && selectedLibraryId ? 'copy' : 'none';
  };

  const handlePageDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDropActive(false);
  };

  const handlePageDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDropActive(false);
    if (!canUpload) {
      message.warning('暂无上传权限');
      return;
    }
    if (!selectedLibraryId) {
      message.warning('请先选择资源库');
      return;
    }
    const droppedFiles = Array.from(event.dataTransfer.files || []);
    if (droppedFiles.length > 0) void handleDroppedFiles(droppedFiles);
  };

  const toggleSortOrder = () => {
    const next = sortOrder === 'desc' ? 'asc' : 'desc';
    setSortOrder(next);
    setFilters(buildCurrentResourceFilters(selectedCategoryIds, { sortBy: 'created_at', sortOrder: next }));
  };

  const canDeleteFile = (file: DesignFile) => {
    const roleName = user?.role?.name;
    return roleName === 'admin'
      || permissions?.delete_files === true
      || (roleName === 'designer' && file.uploadedBy === user?.id);
  };
  const canDeleteSelectedFiles = selectedFiles.length > 0 && selectedFiles.every((file) => canDeleteFile(file));

  const toggleSelectedFile = (file: DesignFile) => {
    setSelectedFileIds((current) => (
      current.includes(file.id)
        ? current.filter((id) => id !== file.id)
        : [...current, file.id]
    ));
  };

  const selectAllVisibleFiles = () => {
    setSelectedFileIds(visibleFileIds);
  };

  const clearSelectedFiles = () => {
    setSelectedFileIds([]);
  };

  const openBatchCategoryEditor = () => {
    if (selectedFiles.length === 0 || !canEditFileMetadata) return;
    const commonIds = getCommonCategoryIds(selectedFiles, allCategories, categoryGroups);
    const activeGroup = categoryGroups.find((group) => group.items.some((category) => commonIds.includes(category.id))) || categoryGroups[0];
    setEditingCategoryFiles(selectedFiles);
    setTempCategoryIds(commonIds);
    setCategorySearch('');
    setActiveCategoryDimension(activeGroup?.dimension || '');
    setActiveCategoryParentId(null);
  };

  const openBatchTagEditor = () => {
    if (selectedFiles.length === 0 || !canEditFileMetadata) return;
    setEditingTagFiles(selectedFiles);
    setTempTagIds(getCommonEditableTagIds(selectedFiles, categoryNameSet));
    setTagSearch('');
    if (allTags.length === 0) void loadTags();
  };

  const executeBatchDownload = async () => {
    if (selectedFiles.length === 0 || batchLoading) return;
    setBatchLoading(true);
    const hide = message.loading(`正在下载 ${selectedFiles.length} 个文件...`, 0);
    try {
      for (const file of selectedFiles) {
        await downloadResourceFile(file);
      }
      message.success(`已开始下载 ${selectedFiles.length} 个文件`);
    } catch (err: any) {
      message.error(err?.response?.data?.message || '下载失败');
    } finally {
      hide();
      setBatchLoading(false);
    }
  };

  const executeBatchDelete = async () => {
    if (selectedFileIds.length === 0 || !canDeleteSelectedFiles) return;
    setBatchLoading(true);
    try {
      const result = await deleteFiles(selectedFileIds);
      message.success(`已移入回收站 ${result.count} 个文件`);
      setBatchDeleteOpen(false);
      setSelectedFileIds([]);
      refreshResources();
    } catch (err: any) {
      message.error(err?.response?.data?.message || '批量删除失败');
    } finally {
      setBatchLoading(false);
    }
  };

  const loadTrash = async () => {
    setTrashLoading(true);
    try {
      const res = await api.get('/files/trash');
      setTrashFiles(res.data?.data || []);
    } catch {
      message.error('回收站加载失败');
      setTrashFiles([]);
    } finally {
      setTrashLoading(false);
    }
  };

  const openTrash = () => {
    setTrashOpen(true);
    loadTrash();
  };

  const restoreFile = async (file: DesignFile) => {
    try {
      await restoreFileApi(file.id);
      message.success('已恢复');
      await loadTrash();
      fetchFiles();
      loadLibraries();
    } catch (err: any) {
      message.error(err?.response?.data?.message || '恢复失败');
    }
  };

  const permanentlyDeleteFile = async (file: DesignFile) => {
    setTrashLoading(true);
    try {
      await deleteFilePermanently(file.id);
      message.success('已删除');
      await loadTrash();
      fetchFiles();
      loadLibraries();
    } catch (err: any) {
      message.error(err?.response?.data?.message || '删除失败');
    } finally {
      setTrashLoading(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      await deleteFile(deleteTarget.id);
      message.success('已删除');
      setDeleteTarget(null);
      fetchFiles();
      loadLibraries();
    } catch (err: any) {
      message.error(err?.response?.data?.message || '删除失败');
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleDownload = async (file: DesignFile) => {
    try {
      await downloadResourceFile(file);
    } catch (err: any) {
      message.error(err?.response?.data?.message || '下载失败');
    }
  };

  const loadTags = async () => {
    setTagsLoading(true);
    try {
      setAllTags(await getTags());
    } catch {
      setAllTags([]);
      message.error('标签加载失败');
    } finally {
      setTagsLoading(false);
    }
  };

  const openCategoryEditor = (file: DesignFile) => {
    const nextIds = normalizeCategoryIdsByGroup(resolveSelectedCategoryIdsForFile(file, allCategories), categoryGroups);
    const activeGroup = categoryGroups.find((group) => group.items.some((category) => nextIds.includes(category.id))) || categoryGroups[0];
    // 若预选的是三级，自动下钻到其父级二级
    let parentId: number | null = null;
    if (activeGroup) {
      const topLevel = dimensionCategories[activeGroup.dimension] || [];
      for (const parent of topLevel) {
        if ((parent.children || []).some((child) => nextIds.includes(child.id))) {
          parentId = parent.id;
          break;
        }
      }
    }
    setEditingCategoryFiles([file]);
    setTempCategoryIds(nextIds);
    setCategorySearch('');
    setActiveCategoryDimension(activeGroup?.dimension || '');
    setActiveCategoryParentId(parentId);
  };

  const openTagEditor = (file: DesignFile) => {
    setEditingTagFiles([file]);
    setTempTagIds(getEditableFileTagIds(file, categoryNameSet));
    setTagSearch('');
    if (allTags.length === 0) void loadTags();
  };

  // 同一维度内单选：选二级或选一个三级，再次点击取消。
  const toggleTempCategory = (categoryId: number) => {
    const group = categoryGroups.find((g) => g.items.some((category) => category.id === categoryId));
    const groupIds = new Set(group?.items.map((category) => category.id) || []);

    setTempCategoryIds((current) => [
      ...current.filter((id) => !groupIds.has(id)),
      ...(current.includes(categoryId) ? [] : [categoryId]),
    ]);
  };

  const removeTempCategory = (categoryId: number) => {
    setTempCategoryIds((current) => current.filter((id) => id !== categoryId));
  };

  const toggleTempTag = (tagId: number) => {
    setTempTagIds((current) => (
      current.includes(tagId)
        ? current.filter((id) => id !== tagId)
        : [...current, tagId]
    ));
  };

  const commitTagSearch = async () => {
    const name = tagSearch.trim();
    if (!name) return;
    if (categoryNameSet.has(name)) {
      message.warning('该名称已经是分类，请换一个标签名');
      return;
    }

    const existing = selectableTags.find((tag) => tag.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      setTempTagIds((current) => current.includes(existing.id) ? current : [...current, existing.id]);
      setTagSearch('');
      return;
    }

    if (!canManageTags) {
      message.warning('暂无新建标签权限');
      return;
    }

    setTagsLoading(true);
    try {
      const created = await createTag({ name });
      setAllTags((current) => [...current, created]);
      setTempTagIds((current) => current.includes(created.id) ? current : [...current, created.id]);
      setTagSearch('');
      message.success('标签已创建');
    } catch (err: any) {
      message.error(err?.response?.data?.message || '标签创建失败');
    } finally {
      setTagsLoading(false);
    }
  };

  const saveEditedCategories = async () => {
    if (editingCategoryFiles.length === 0) return;
    setMetaSaving(true);
    try {
      const categoryIds = normalizeCategoryIdsByGroup(tempCategoryIds, categoryGroups);
      await Promise.all(editingCategoryFiles.map((file) => updateFile(file.id, {
        categoryId: categoryIds[0] || null,
        categoryTagIds: categoryIds,
      })));
      message.success('分类已更新');
      setEditingCategoryFiles([]);
      await fetchFiles();
    } catch (err: any) {
      message.error(err?.response?.data?.message || '分类更新失败');
    } finally {
      setMetaSaving(false);
    }
  };

  const saveEditedTags = async () => {
    if (editingTagFiles.length === 0) return;
    setMetaSaving(true);
    try {
      await Promise.all(editingTagFiles.map((file) => {
        const categoryTagIds = getFileCategoryTagIds(file, categoryNameSet);
        return updateFile(file.id, {
          tagIds: Array.from(new Set([...categoryTagIds, ...tempTagIds])),
        });
      }));
      message.success('标签已更新');
      setEditingTagFiles([]);
      await fetchFiles();
    } catch (err: any) {
      message.error(err?.response?.data?.message || '标签更新失败');
    } finally {
      setMetaSaving(false);
    }
  };

  const managementItems = [
    canManageUsers
      ? { key: 'members', label: '成员信息', icon: <Settings size={14} />, onClick: () => navigate('/admin/members') }
      : null,
    canManageCategories
      ? { key: 'category', label: '分类管理', icon: <Folder size={14} />, onClick: () => selectedLibraryId && navigate(`/admin/libraries/${selectedLibraryId}?tab=categories`) }
      : null,
    canManageTags
      ? { key: 'tags', label: '标签管理', icon: <Type size={14} />, onClick: () => selectedLibraryId && navigate(`/admin/libraries/${selectedLibraryId}?tab=tags`) }
      : null,
    canManageTrash ? { type: 'divider' as const } : null,
    canManageTrash
      ? { key: 'trash', label: '回收站', icon: <Trash2 size={14} />, onClick: openTrash }
      : null,
  ].filter(Boolean) as NonNullable<MenuProps['items']>;

  return (
    <div
      style={pageStyle}
      onDragEnter={handlePageDragEnter}
      onDragOver={handlePageDragOver}
      onDragLeave={handlePageDragLeave}
      onDrop={handlePageDrop}
    >
      <style>{adminResourceTileCss}</style>
      {dropActive && (
        <div style={dropOverlayStyle}>
          <div style={dropOverlayPanelStyle}>
            <UploadIcon />
            <div style={dropOverlayTitleStyle}>释放以上传到「{selectedLibrary?.name || '当前资源库'}」</div>
            <div style={dropOverlayTextStyle}>
              会沿用当前筛选的分类；支持 PSD、AI、图片、PDF、PPT 和字体文件。
            </div>
          </div>
        </div>
      )}
      <section style={filterStageStyle}>
        <div style={filterHeaderStyle}>
          <div style={{ position: 'relative' }}>
            <button type="button" onClick={() => setLibraryOpen((open) => !open)} style={libraryButtonStyle}>
              {selectedLibrary?.name || '选择资源库'}
              <ChevronDown size={15} />
            </button>
            {libraryOpen && (
              <>
                <div onClick={() => setLibraryOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 90 }} />
                <div style={libraryMenuStyle}>
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

          <button type="button" onClick={toggleUncategorized} style={plainButtonStyle(uncategorized)}>
            待分类
          </button>

          {managementItems.length > 0 && (
            <Dropdown menu={{ items: managementItems }} trigger={['click']}>
              <button type="button" style={plainButtonStyle(false)}>
                <Settings size={15} />
                管理
              </button>
            </Dropdown>
          )}

          {canUpload && (
            <Dropdown menu={{
              items: [
                { key: 'upload', label: '上传文件', icon: <FileText size={14} />, onClick: () => openUpload('file') },
                { key: 'upload-folder', label: '上传文件夹', icon: <Folder size={14} />, onClick: () => openUpload('folder') },
              ],
            }} trigger={['click']}>
              <button type="button" style={addButtonStyle}>
                <Plus size={18} />
                添加
              </button>
            </Dropdown>
          )}
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
              : (!selectedSecond && !uncategorized);
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
                  <button
                    type="button"
                    onClick={() => selectedLibraryId && navigate(`/admin/libraries/${selectedLibraryId}?tab=categories`)}
                    style={categoryAddButtonStyle}
                    title="添加分类"
                  >
                    <Plus size={14} />
                  </button>
                </div>
              </div>
            </div>
            );
          })}
          {categoryGroups.length === 0 && (
            <div style={{ padding: '18px 0', color: '#8b949e', font: '500 13px var(--font-sans)' }}>
              当前资源库还没有分类，可在资源库管理中添加。
            </div>
          )}
        </div>
      </section>

      <section style={contentHeaderStyle}>
        <div style={tabsStyle}>
          <button type="button" onClick={() => setTab('all')} style={tabStyle(tab === 'all')}>全部 ({total})</button>
          <button type="button" onClick={() => setTab('uploaded')} style={tabStyle(tab === 'uploaded')}>上传的</button>
        </div>
        <div style={{ flex: 1 }} />
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
        {loadError && <div role="alert" style={{ marginBottom: 20, padding: 14, background: '#fff8f5', display: 'flex', gap: 14, alignItems: 'center' }}>
          <span style={{ flex: 1 }}>{loadError}{hasVisibleFiles ? ' 已保留上次加载的内容。' : ''}</span>
          <button type="button" disabled={isLoading} style={loadMoreButtonStyle} onClick={() => { void refreshLoadedFiles(); }}>重试加载</button>
        </div>}
        {isLoading && hasVisibleFiles && (
          <div style={contentLoadingHintStyle}>
            <Spin size="small" />
          </div>
        )}
        {isLoading && !hasVisibleFiles ? (
          <LoadingTileGrid />
        ) : visibleFiles.length === 0 ? loadError ? null : (
          <Empty description="暂无资源" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : view === 'grid' ? (
          <ResourceWaterfall files={visibleFiles} resetKey={layoutKey} boundaryRef={boundaryRef}
            renderItem={(file, metrics) => (
              <ResourceTile
                file={file}
                metrics={metrics}
                canDelete={canDeleteFile(file)}
                canEdit={canEditFileMetadata}
                selected={selectedFileIdSet.has(file.id)}
                selectionActive={selectionActive}
                onOpen={() => navigate(`/admin/resources/${file.id}`)}
                onSelect={() => toggleSelectedFile(file)}
                onDownload={() => handleDownload(file)}
                onEditCategories={() => openCategoryEditor(file)}
                onEditTags={() => openTagEditor(file)}
                onDelete={() => setDeleteTarget(file)}
              />
            )}
          />
        ) : (
          <div style={listWrapStyle}>
            <div style={listHeaderStyle}>
              <span />
              <span>名称</span>
              <span>类型</span>
              <span>大小</span>
              <span>设计师</span>
              <span>操作</span>
            </div>
            {visibleFiles.map((file) => (
              <div
                key={file.id}
                style={selectedFileIdSet.has(file.id) ? { ...listRowStyle, background: '#f7f9ff' } : listRowStyle}
                onClick={() => (selectionActive ? toggleSelectedFile(file) : navigate(`/admin/resources/${file.id}`))}
              >
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleSelectedFile(file);
                  }}
                  style={selectionCheckButtonStyle(selectedFileIdSet.has(file.id))}
                  title={selectedFileIdSet.has(file.id) ? '取消选择' : '选择'}
                >
                  {selectedFileIdSet.has(file.id) && <Check size={13} />}
                </button>
                <span style={{ color: '#111827', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</span>
                <span style={{ textTransform: 'uppercase' }}>{file.fileType}</span>
                <span>{formatFileSize(file.fileSize)}</span>
                <span>{file.uploader?.displayName || '-'}</span>
                <span>
                  {canDeleteFile(file) && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        setDeleteTarget(file);
                      }}
                      style={dangerTextButtonStyle}
                    >
                      删除
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

      {selectionActive && (
        <div style={selectionBarStyle}>
          <button
            type="button"
            onClick={selectedFileIds.length === visibleFileIds.length ? clearSelectedFiles : selectAllVisibleFiles}
            style={selectionCheckButtonStyle(true)}
            title={selectedFileIds.length === visibleFileIds.length ? '取消全选' : '全选本页'}
          >
            <Check size={13} />
          </button>
          <span style={selectionCountStyle}>已选 {selectedFileIds.length}</span>
          <Dropdown
            menu={{
              items: [
                { key: 'category', label: '编辑分类', icon: <Folder size={14} />, onClick: openBatchCategoryEditor },
                { key: 'tags', label: '编辑标签', icon: <Type size={14} />, onClick: openBatchTagEditor },
              ],
            }}
            trigger={['click']}
          >
            <button
              type="button"
              disabled={!canEditFileMetadata || batchLoading}
              onClick={(event) => event.stopPropagation()}
              style={selectionActionButtonStyle(!canEditFileMetadata || batchLoading)}
              title="编辑分类/标签"
            >
              <Grid2x2 size={16} />
              编辑分类/标签
            </button>
          </Dropdown>
          <button
            type="button"
            onClick={() => void executeBatchDownload()}
            disabled={batchLoading}
            style={selectionIconButtonStyle(batchLoading)}
            title="下载"
          >
            <Download size={17} />
          </button>
          <button
            type="button"
            onClick={() => setBatchDeleteOpen(true)}
            disabled={!canDeleteSelectedFiles || batchLoading}
            style={selectionIconButtonStyle(!canDeleteSelectedFiles || batchLoading, true)}
            title={canDeleteSelectedFiles ? '删除' : '所选文件中有无权删除的文件'}
          >
            <Trash2 size={17} />
          </button>
          <button type="button" onClick={clearSelectedFiles} style={selectionCloseButtonStyle} title="关闭">
            <X size={18} />
          </button>
        </div>
      )}

      <UploadModal
        open={uploadOpen}
        mode={uploadMode}
        libraryId={selectedLibraryId}
        initialCategoryIds={selectedCategoryIds}
        onClose={() => setUploadOpen(false)}
        onSuccess={refreshResources}
      />

      <Modal
        title="编辑分类"
        open={editingCategoryFiles.length > 0}
        onCancel={() => !metaSaving && setEditingCategoryFiles([])}
        footer={null}
        width={680}
        centered
        destroyOnClose
        styles={{ body: { padding: 0 } }}
      >
        {editingCategoryFiles.length > 0 && (
          <div style={metadataModalBodyStyle}>
            <div style={categoryEditorHeaderStyle}>
              <div style={metadataSearchStyle}>
                <Search size={15} style={{ color: '#9aa1aa' }} />
                <input
                  value={categorySearch}
                  onChange={(event) => setCategorySearch(event.target.value)}
                  placeholder="搜索分类"
                  style={metadataSearchInputStyle}
                />
              </div>
              <div>
                <div style={categorySelectedTitleStyle}>已选分类 ({selectedTempCategories.length})</div>
                <div style={categorySelectedWrapStyle}>
                  {selectedTempCategories.length === 0 ? (
                    <span style={metadataMutedTextStyle}>未选择</span>
                  ) : selectedTempCategories.map((category) => (
                    <button
                      key={category.id}
                      type="button"
                      onClick={() => removeTempCategory(category.id)}
                      style={metadataSelectedChipStyle}
                      title={getCategoryPathLabel(category, categoryGroups, dimensionCategories)}
                    >
                      {getCategoryPathLabel(category, categoryGroups, dimensionCategories)}
                      <X size={12} />
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {categorySearch.trim() ? (
              <div style={categorySearchResultsStyle}>
                <div style={categoryPaneTitleStyle}>搜索结果</div>
                {visibleCategoryOptions.length === 0 ? (
                  <span style={metadataMutedTextStyle}>没有匹配分类</span>
                ) : visibleCategoryOptions.map((category) => {
                  const selected = tempCategoryIdSet.has(category.id);
                  return (
                    <button
                      key={category.id}
                      type="button"
                      onClick={() => toggleTempCategory(category.id)}
                      style={categorySearchResultStyle(selected)}
                    >
                      <span style={categorySearchResultNameStyle}>
                        {selected && <Check size={13} />}
                        {category.name}
                      </span>
                      <span style={categoryPathStyle}>{getCategoryPathLabel(category, categoryGroups, dimensionCategories)}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div style={categoryPickColumnsStyle}>
                <div style={categoryPickPaneStyle}>
                  <div style={categoryPaneTitleStyle}>维度</div>
                  <div style={categoryListStyle}>
                    {categoryGroups.length === 0 ? (
                      <span style={metadataMutedTextStyle}>暂无可选分类</span>
                    ) : categoryGroups.map((group) => (
                      <button
                        key={group.dimension}
                        type="button"
                        onClick={() => { setActiveCategoryDimension(group.dimension); setActiveCategoryParentId(null); }}
                        style={categoryChoiceRowStyle((activeCategoryGroup?.dimension || '') === group.dimension, false)}
                      >
                        <span>{group.label}</span>
                        <ChevronRight size={14} />
                      </button>
                    ))}
                  </div>
                </div>

                <div style={categoryPickPaneStyle}>
                  <div style={categoryPaneTitleStyle}>二级分类</div>
                  <div style={categoryListStyle}>
                    {(dimensionCategories[activeCategoryGroup?.dimension || ''] || []).length === 0 ? (
                      <span style={metadataMutedTextStyle}>暂无二级分类</span>
                    ) : (dimensionCategories[activeCategoryGroup?.dimension || ''] || []).map((category) => {
                      const hasChildren = (category.children?.length || 0) > 0;
                      const childSelected = (category.children || []).some((child) => tempCategoryIdSet.has(child.id));
                      const selected = tempCategoryIdSet.has(category.id);
                      const active = activeCategoryParentId === category.id || childSelected;
                      return (
                        <button
                          key={category.id}
                          type="button"
                          onClick={() => {
                            toggleTempCategory(category.id);
                            setActiveCategoryParentId(hasChildren ? category.id : null);
                          }}
                          style={categoryChoiceRowStyle(active, selected)}
                        >
                          <span style={categoryChoiceNameStyle}>
                            {selected && <Check size={13} />}
                            {category.name}
                          </span>
                          {hasChildren && <ChevronRight size={14} />}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div style={categoryPickPaneStyle}>
                  <div style={categoryPaneTitleStyle}>三级分类</div>
                  <div style={categoryListStyle}>
                    {!activeCategoryParent ? (
                      <span style={metadataMutedTextStyle}>选择二级分类</span>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => toggleTempCategory(activeCategoryParent.id)}
                          style={categoryChoiceRowStyle(tempCategoryIdSet.has(activeCategoryParent.id), tempCategoryIdSet.has(activeCategoryParent.id))}
                        >
                          <span style={categoryChoiceNameStyle}>
                            {tempCategoryIdSet.has(activeCategoryParent.id) && <Check size={13} />}
                            全部
                          </span>
                          <span style={categoryPathStyle}>{activeCategoryParent.name}</span>
                        </button>
                        {(activeCategoryParent.children || []).length === 0 ? (
                          <span style={metadataMutedTextStyle}>暂无三级分类</span>
                        ) : (activeCategoryParent.children || []).map((category) => (
                          <button
                            key={category.id}
                            type="button"
                            onClick={() => toggleTempCategory(category.id)}
                            style={categoryChoiceRowStyle(tempCategoryIdSet.has(category.id), tempCategoryIdSet.has(category.id))}
                          >
                            <span style={categoryChoiceNameStyle}>
                              {tempCategoryIdSet.has(category.id) && <Check size={13} />}
                              {category.name}
                            </span>
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}

            <div style={metadataModalFooterStyle}>
              <button type="button" onClick={() => setEditingCategoryFiles([])} disabled={metaSaving} className="ui-btn">
                取消
              </button>
              <button type="button" onClick={saveEditedCategories} disabled={metaSaving} className="ui-btn ui-btn-primary" style={{ opacity: metaSaving ? 0.72 : 1 }}>
                {metaSaving ? '保存中...' : '确定'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        title="编辑标签"
        open={editingTagFiles.length > 0}
        onCancel={() => !metaSaving && setEditingTagFiles([])}
        footer={null}
        width={680}
        centered
        destroyOnClose
        styles={{ body: { padding: 0 } }}
      >
        {editingTagFiles.length > 0 && (
          <div style={metadataModalBodyStyle}>
            <div style={metadataModalColumnsStyle}>
              <div style={metadataLeftPaneStyle}>
                <div style={metadataSearchStyle}>
                  <Search size={15} style={{ color: '#9aa1aa' }} />
                  <input
                    value={tagSearch}
                    onChange={(event) => setTagSearch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        commitTagSearch();
                      }
                    }}
                    placeholder={canManageTags ? '创建或搜索标签' : '搜索标签'}
                    maxLength={32}
                    style={metadataSearchInputStyle}
                  />
                </div>
                <div style={metadataTagGroupHeaderStyle}>* 未分组</div>
                <div style={metadataTagOptionsStyle}>
                  {tagsLoading ? (
                    <Spin size="small" />
                  ) : visibleTagOptions.length === 0 ? (
                    <span style={metadataMutedTextStyle}>没有匹配标签</span>
                  ) : visibleTagOptions.map((tag) => {
                    const active = tempTagIdSet.has(tag.id);
                    return (
                      <button
                        key={tag.id}
                        type="button"
                        onClick={() => toggleTempTag(tag.id)}
                        style={metadataOptionChipStyle(active)}
                      >
                        {tag.name}
                      </button>
                    );
                  })}
                  {tagSearch.trim() && !visibleTagOptions.some((tag) => tag.name.toLowerCase() === tagSearch.trim().toLowerCase()) && canManageTags && (
                    <button type="button" onClick={commitTagSearch} disabled={tagsLoading} style={metadataCreateChipStyle}>
                      <Plus size={12} />
                      新建“{tagSearch.trim()}”
                    </button>
                  )}
                </div>
              </div>

              <div style={metadataRightPaneStyle}>
                <div style={metadataPaneHeaderStyle}>
                  <span>已选 {tempTagIds.length} 个标签</span>
                </div>
                <div style={metadataSelectedWrapStyle}>
                  {selectedTempTags.length === 0 ? (
                    <span style={metadataMutedTextStyle}>暂未选择标签</span>
                  ) : selectedTempTags.map((tag) => (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() => toggleTempTag(tag.id)}
                      style={metadataSelectedChipStyle}
                    >
                      {tag.name}
                      <X size={12} />
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div style={metadataModalFooterStyle}>
              <button type="button" onClick={() => setEditingTagFiles([])} disabled={metaSaving} className="ui-btn">
                取消
              </button>
              <button type="button" onClick={saveEditedTags} disabled={metaSaving} className="ui-btn ui-btn-primary" style={{ opacity: metaSaving ? 0.72 : 1 }}>
                {metaSaving ? '保存中...' : '确定'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      <Modal title="文件回收站" open={trashOpen} onCancel={() => setTrashOpen(false)} footer={null} width={720}>
        {trashLoading ? (
          <div style={{ textAlign: 'center', padding: 32 }}><Spin /></div>
        ) : trashFiles.length === 0 ? (
          <Empty description="回收站暂无文件" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {trashFiles.map((file) => (
              <div key={file.id} style={trashRowStyle}>
                <div style={trashThumbStyle}>
                  <Thumb thumbnailUrl={file.thumbnailPath} fileType={file.fileType} label={file.name?.charAt(0)} height={48} file={file} name={file.name} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ font: '700 14px var(--font-sans)', color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</div>
                  <div style={{ font: 'var(--type-caption)', color: '#8b949e', marginTop: 4 }}>
                    {file.uploader?.displayName || '-'} · {file.fileType.toUpperCase()} · {formatFileSize(file.fileSize)}
                  </div>
                </div>
                <div style={trashActionsStyle}>
                  <button type="button" onClick={() => restoreFile(file)} className="ui-btn">
                    <RotateCcw size={13} />
                    恢复
                  </button>
                  <button type="button" onClick={() => permanentlyDeleteFile(file)} className="ui-btn ui-btn-danger">
                    <Trash2 size={13} />
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>

      <Modal
        open={batchDeleteOpen}
        onCancel={() => !batchLoading && setBatchDeleteOpen(false)}
        footer={null}
        width={420}
        centered
        destroyOnClose
      >
        <div style={{ padding: '8px 4px 2px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 18 }}>
            <div style={deleteIconStyle}>
              <Trash2 size={20} />
            </div>
            <div>
              <div style={{ font: '700 18px var(--font-sans)', color: '#111827', marginBottom: 4 }}>批量删除文件</div>
              <div style={{ font: 'var(--type-body)', color: '#68717b', lineHeight: 1.6 }}>
                将所选 {selectedFileIds.length} 个文件移入回收站。
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button type="button" onClick={() => setBatchDeleteOpen(false)} disabled={batchLoading} className="ui-btn">
              取消
            </button>
            <button type="button" onClick={executeBatchDelete} disabled={batchLoading || !canDeleteSelectedFiles} className="ui-btn ui-btn-danger" style={{ opacity: batchLoading ? 0.7 : 1 }}>
              {batchLoading ? '删除中...' : '确认删除'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!deleteTarget}
        onCancel={() => !deleteLoading && setDeleteTarget(null)}
        footer={null}
        width={440}
        centered
        destroyOnClose
        styles={{ body: { padding: 0 } }}
      >
        {deleteTarget && (
          <div style={{ padding: 22 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 18 }}>
              <div style={deleteIconStyle}>
                <Trash2 size={20} />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ font: '700 18px var(--font-sans)', color: '#111827', marginBottom: 4 }}>删除模板</div>
                <div style={{ font: 'var(--type-body)', color: '#68717b', lineHeight: 1.6 }}>
                  删除后前台将不再展示该模板，请确认不再需要继续使用。
                </div>
              </div>
            </div>

            <div style={deletePreviewStyle}>
              <div style={{ borderRadius: 6, overflow: 'hidden', border: '1px solid #ececec', background: '#fff' }}>
                <Thumb thumbnailUrl={deleteTarget.thumbnailPath} fileType={deleteTarget.fileType} label={deleteTarget.name?.charAt(0)} height={76} file={deleteTarget} name={deleteTarget.name} />
              </div>
              <div style={{ minWidth: 0, alignSelf: 'center' }}>
                <div style={{ font: '700 14px var(--font-sans)', color: '#111827', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: 8 }}>
                  {deleteTarget.name}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', font: 'var(--type-caption)', color: '#8b949e' }}>
                  <span style={{ textTransform: 'uppercase' }}>{deleteTarget.fileType}</span>
                  <span>{formatFileSize(deleteTarget.fileSize)}</span>
                  <span>{deleteTarget.uploader?.displayName || '-'}</span>
                </div>
              </div>
            </div>

            <div style={deleteNoticeStyle}>
              此操作只会从资源库移除模板记录。管理员可以删除所有模板，设计师只能删除自己上传的模板。
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button type="button" onClick={() => setDeleteTarget(null)} disabled={deleteLoading} className="ui-btn">
                取消
              </button>
              <button type="button" onClick={confirmDelete} disabled={deleteLoading} className="ui-btn ui-btn-danger" style={{ opacity: deleteLoading ? 0.7 : 1 }}>
                {deleteLoading ? '删除中...' : '确认删除'}
              </button>
            </div>
          </div>
        )}
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
  canDelete,
  canEdit,
  selected,
  selectionActive,
  onOpen,
  onSelect,
  onDownload,
  onEditCategories,
  onEditTags,
  onDelete,
}: {
  file: DesignFile;
  metrics: CardMetrics;
  canDelete: boolean;
  canEdit: boolean;
  selected: boolean;
  selectionActive: boolean;
  onOpen: () => void;
  onSelect: () => void;
  onDownload: () => void;
  onEditCategories: () => void;
  onEditTags: () => void;
  onDelete: () => void;
}) {
  const previewPath = getAssetPreviewPath(file);
  const previewHeight = metrics.previewHeight;
  const previewShellStyle: CSSProperties = selected
    ? { ...tileImageShellStyle, height: previewHeight, boxShadow: '0 0 0 2px #2557f6 inset' }
    : { ...tileImageShellStyle, height: previewHeight };

  const menuItems = [
    {
      key: 'detail',
      label: '查看详情',
      icon: <FileText size={14} />,
      onClick: (info: any) => {
        info.domEvent.stopPropagation();
        onOpen();
      },
    },
    ...(canEdit ? [
      {
        key: 'edit-categories',
        label: '编辑分类',
        icon: <Folder size={14} />,
        onClick: (info: any) => {
          info.domEvent.stopPropagation();
          onEditCategories();
        },
      },
      {
        key: 'edit-tags',
        label: '编辑标签',
        icon: <Type size={14} />,
        onClick: (info: any) => {
          info.domEvent.stopPropagation();
          onEditTags();
        },
      },
    ] : []),
    {
      key: 'download',
      label: '下载',
      icon: <Download size={14} />,
      onClick: (info: any) => {
        info.domEvent.stopPropagation();
        onDownload();
      },
    },
    ...(canDelete ? [{
      key: 'delete',
      label: '移入回收站',
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: (info: any) => {
        info.domEvent.stopPropagation();
        onDelete();
      },
    }] : []),
  ];

  return (
    <div
      className={`resource-tile admin-resource-tile${selected ? ' is-selected' : ''}${selectionActive ? ' is-selection-active' : ''}`}
      title={file.name}
      aria-label={file.name}
      role="button"
      tabIndex={0}
      onKeyDown={event => { if (event.target === event.currentTarget && !event.repeat && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); event.currentTarget.click(); } }}
      onClick={event => event.detail <= 1 && (selectionActive ? onSelect() : onOpen())}
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
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onSelect();
          }}
          className="admin-resource-tile-select"
          style={tileSelectButtonStyle(selected)}
          title={selected ? '取消选择' : '选择'}
        >
          {selected && <Check size={13} />}
        </button>
        {!selectionActive && (
        <div className="admin-resource-tile-actions" style={tileOverlayActionsStyle}>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
            style={tileEditButtonStyle}
            title="编辑"
          >
            <Edit3 size={13} />
          </button>
          <Dropdown menu={{ items: menuItems }} trigger={['click']} placement="bottomRight" onOpenChange={metrics.onMenuOpenChange}>
            <button
              type="button"
              onClick={(event) => event.stopPropagation()}
              style={tileMoreButtonStyle}
              title="更多操作"
            >
              <MoreHorizontal size={16} />
            </button>
          </Dropdown>
        </div>
        )}
      </div>
      <ResourceCardInfo file={file} />
    </div>
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

function resolveSelectedCategoryIdsForFile(file: DesignFile, categories: Category[]) {
  const ids = new Set<number>();
  if (file.categoryId) ids.add(file.categoryId);
  (file.categoryAssignments || []).forEach((category) => ids.add(category.id));

  const categoriesByName = new Map<string, Category[]>();
  categories.forEach((category) => {
    categoriesByName.set(category.name, [...(categoriesByName.get(category.name) || []), category]);
  });
  (file.tags || []).forEach((tag) => {
    const matches = categoriesByName.get(tag.name) || [];
    if (matches.length === 1) ids.add(matches[0].id);
  });

  return Array.from(ids);
}

function normalizeCategoryIdsByGroup(ids: number[], groups: Array<{ items: Category[] }>) {
  const selectedIds = new Set(ids);
  return groups.flatMap((group) => {
    const selectedInGroup = group.items.filter((category) => selectedIds.has(category.id));
    // 父级若有被选中的子级，则只取最具体的子级（叶子），避免回退成父级二级
    return selectedInGroup
      .filter((category) => !(category.children || []).some((child) => selectedIds.has(child.id)))
      .map((category) => category.id);
  });
}

function getCategoryPathLabel(
  category: Category,
  groups: Array<{ dimension: string; label: string; items: Category[] }>,
  dimensionCategories: Record<string, Category[]>,
) {
  const group = groups.find((item) => item.items.some((cat) => cat.id === category.id));
  const groupLabel = group?.label || '分类';
  const topLevel = group ? (dimensionCategories[group.dimension] || []) : [];
  const parent = topLevel.find((item) => item.id === category.parentId || (item.children || []).some((child) => child.id === category.id));
  if (!parent || parent.id === category.id) return `${groupLabel} · ${category.name}`;
  return `${groupLabel} · ${parent.name} · ${category.name}`;
}

function getFileCategoryTagIds(file: DesignFile, categoryNameSet: Set<string>) {
  return (file.tags || [])
    .filter((tag) => categoryNameSet.has(tag.name))
    .map((tag) => tag.id);
}

function getEditableFileTagIds(file: DesignFile, categoryNameSet: Set<string>) {
  return (file.tags || [])
    .filter((tag) => !categoryNameSet.has(tag.name))
    .map((tag) => tag.id);
}

const FONT_FILE_TYPES = new Set(['ttf', 'otf', 'ttc', 'woff', 'woff2']);

function formatFileSize(bytes: number): string {
  const n = Number(bytes);
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

const SUPPORTED_RESOURCE_UPLOAD_EXTENSIONS = new Set([
  'psd', 'psb', 'ai', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'pptx', 'ppt',
  'ttf', 'otf', 'ttc', 'woff', 'woff2',
]);

function isSupportedResourceUploadFile(file: File) {
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  return SUPPORTED_RESOURCE_UPLOAD_EXTENSIONS.has(ext);
}

function hasDraggedFiles(event: DragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer.types || []).includes('Files');
}

function downloadResourceFile(file: DesignFile) {
  triggerFileDownload(file.id, file.originalFilename || file.name);
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

function getCommonCategoryIds(
  files: DesignFile[],
  categories: Category[],
  groups: Array<{ items: Category[] }>,
) {
  return normalizeCategoryIdsByGroup(
    intersectNumberLists(files.map((file) => resolveSelectedCategoryIdsForFile(file, categories))),
    groups,
  );
}

function getCommonEditableTagIds(files: DesignFile[], categoryNameSet: Set<string>) {
  return intersectNumberLists(files.map((file) => getEditableFileTagIds(file, categoryNameSet)));
}

function intersectNumberLists(lists: number[][]) {
  if (lists.length === 0) return [];
  const [first, ...rest] = lists.map((list) => Array.from(new Set(list)));
  return first.filter((id) => rest.every((list) => list.includes(id)));
}

const pageStyle: CSSProperties = {
  position: 'relative',
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  background: '#fff',
  overflow: 'hidden',
};

const dropOverlayStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 120,
  display: 'grid',
  placeItems: 'center',
  background: 'rgba(37, 87, 246, .07)',
  border: '2px dashed rgba(37, 87, 246, .55)',
  pointerEvents: 'none',
};

const dropOverlayPanelStyle: CSSProperties = {
  width: 360,
  maxWidth: 'calc(100% - 48px)',
  padding: '24px 28px',
  borderRadius: 10,
  background: 'rgba(255,255,255,.96)',
  boxShadow: '0 16px 45px rgba(15,23,42,.16)',
  border: '1px solid #dbe5ff',
  color: '#111827',
  textAlign: 'center',
};

const dropOverlayTitleStyle: CSSProperties = {
  marginTop: 10,
  font: '800 16px var(--font-sans)',
};

const dropOverlayTextStyle: CSSProperties = {
  marginTop: 6,
  color: '#68717b',
  font: '500 13px var(--font-sans)',
  lineHeight: 1.6,
};

const filterStageStyle: CSSProperties = {
  padding: '28px 34px 20px',
  borderBottom: '1px solid #f0f0ef',
  background: '#fff',
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

const addButtonStyle: CSSProperties = {
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

const categoryAddButtonStyle: CSSProperties = {
  width: 30,
  height: 30,
  border: 0,
  borderRadius: 6,
  background: 'transparent',
  color: '#111827',
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
};

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

const iconButtonStyle: CSSProperties = {
  width: 30,
  height: 30,
  border: 0,
  borderRadius: 6,
  background: 'transparent',
  color: '#4b5563',
  display: 'grid',
  placeItems: 'center',
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
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
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

const tileQuickButtonStyle: CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 8,
  width: 30,
  height: 30,
  border: 0,
  borderRadius: 8,
  background: 'rgba(255,255,255,.92)',
  color: '#111827',
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
  boxShadow: '0 2px 8px rgba(15,23,42,.12)',
};

function tileSelectButtonStyle(selected: boolean): CSSProperties {
  return {
    position: 'absolute',
    top: 36,
    left: 8,
    width: 22,
    height: 22,
    borderRadius: 6,
    border: selected ? '1px solid #2557f6' : '1px solid #d1d5db',
    background: selected ? '#2557f6' : 'rgba(255,255,255,.96)',
    color: '#fff',
    display: 'grid',
    placeItems: 'center',
    cursor: 'pointer',
    boxShadow: '0 2px 8px rgba(15,23,42,.12)',
    zIndex: 2,
  };
}

const tileOverlayActionsStyle: CSSProperties = {
  position: 'absolute',
  right: 8,
  top: 8,
  width: 66,
  display: 'grid',
  gridTemplateColumns: '30px 30px',
  gap: 6,
};

const tileEditButtonStyle: CSSProperties = {
  width: 30,
  height: 30,
  border: '1px solid rgba(255,255,255,.75)',
  borderRadius: 8,
  background: 'rgba(255,255,255,.96)',
  color: '#111827',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  boxShadow: '0 4px 14px rgba(15,23,42,.12)',
};

const tileMoreButtonStyle: CSSProperties = {
  width: 30,
  height: 30,
  border: '1px solid rgba(255,255,255,.75)',
  borderRadius: 8,
  background: 'rgba(255,255,255,.96)',
  color: '#111827',
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
  boxShadow: '0 4px 14px rgba(15,23,42,.12)',
};

const adminResourceTileCss = `
  .admin-resource-tile .admin-resource-tile-actions,
  .admin-resource-tile .admin-resource-tile-select {
    opacity: 0;
    pointer-events: none;
    transform: translateY(-3px);
    transition: opacity .16s ease, transform .16s ease;
  }
  .admin-resource-tile:hover .admin-resource-tile-actions,
  .admin-resource-tile:hover .admin-resource-tile-select,
  .admin-resource-tile:focus-within .admin-resource-tile-actions,
  .admin-resource-tile:focus-within .admin-resource-tile-select,
  .admin-resource-tile.is-selected .admin-resource-tile-select,
  .admin-resource-tile.is-selection-active .admin-resource-tile-select {
    opacity: 1;
    pointer-events: auto;
    transform: translateY(0);
  }
  @media (hover: none) {
    .admin-resource-tile .admin-resource-tile-actions,
    .admin-resource-tile .admin-resource-tile-select { opacity: 1; pointer-events: auto; transform: none; }
  }
`;

const listWrapStyle: CSSProperties = {
  borderTop: '1px solid #f0f0ef',
};

const listHeaderStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '28px 2.4fr .7fr .8fr 1fr 80px',
  gap: 12,
  padding: '10px 0',
  color: '#8b949e',
  font: '700 12px var(--font-sans)',
};

const listRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '28px 2.4fr .7fr .8fr 1fr 80px',
  gap: 12,
  padding: '14px 0',
  borderTop: '1px solid #f0f0ef',
  color: '#5f6872',
  font: '500 13px var(--font-sans)',
  cursor: 'pointer',
};

const selectionBarStyle: CSSProperties = {
  position: 'fixed',
  left: '50%',
  bottom: 28,
  transform: 'translateX(-50%)',
  zIndex: 200,
  minHeight: 52,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 10px',
  borderRadius: 12,
  border: '1px solid #e5e7eb',
  background: 'rgba(255,255,255,.96)',
  boxShadow: '0 16px 42px rgba(15,23,42,.16)',
  backdropFilter: 'blur(8px)',
};

const selectionCountStyle: CSSProperties = {
  color: '#111827',
  font: '800 13px var(--font-sans)',
  paddingRight: 4,
  whiteSpace: 'nowrap',
};

function selectionCheckButtonStyle(selected: boolean): CSSProperties {
  return {
    width: 22,
    height: 22,
    borderRadius: 6,
    border: selected ? '1px solid #2557f6' : '1px solid #d1d5db',
    background: selected ? '#2557f6' : '#fff',
    color: '#fff',
    display: 'inline-grid',
    placeItems: 'center',
    cursor: 'pointer',
    flexShrink: 0,
  };
}

function selectionActionButtonStyle(disabled: boolean): CSSProperties {
  return {
    height: 36,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    padding: '0 12px',
    borderRadius: 8,
    border: '1px solid #e5e7eb',
    background: disabled ? '#f5f6f7' : '#fff',
    color: disabled ? '#a0a7b0' : '#111827',
    font: '800 13px var(--font-sans)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    whiteSpace: 'nowrap',
  };
}

function selectionIconButtonStyle(disabled: boolean, danger = false): CSSProperties {
  return {
    width: 36,
    height: 36,
    borderRadius: 8,
    border: '1px solid #e5e7eb',
    background: disabled ? '#f5f6f7' : '#fff',
    color: disabled ? '#a0a7b0' : danger ? '#dc2626' : '#111827',
    display: 'inline-grid',
    placeItems: 'center',
    cursor: disabled ? 'not-allowed' : 'pointer',
  };
}

const selectionCloseButtonStyle: CSSProperties = {
  width: 38,
  height: 38,
  borderRadius: 9,
  border: '1px solid #f1d3d3',
  background: '#fff',
  color: '#dc2626',
  display: 'inline-grid',
  placeItems: 'center',
  cursor: 'pointer',
};

const dangerTextButtonStyle: CSSProperties = {
  border: 0,
  background: 'transparent',
  color: '#d43c35',
  cursor: 'pointer',
  font: '700 12px var(--font-sans)',
};

const trashRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '72px 1fr auto',
  gap: 12,
  alignItems: 'center',
  padding: 12,
  borderRadius: 8,
  border: '1px solid #ececec',
  background: '#fff',
};

const trashThumbStyle: CSSProperties = {
  borderRadius: 6,
  overflow: 'hidden',
  border: '1px solid #ececec',
  background: '#fff',
};

const trashActionsStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
};

const deleteIconStyle: CSSProperties = {
  width: 42,
  height: 42,
  borderRadius: 10,
  display: 'grid',
  placeItems: 'center',
  background: 'var(--brand-vermilion-50)',
  color: 'var(--color-danger-fg)',
  flexShrink: 0,
};

const deletePreviewStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '112px 1fr',
  gap: 14,
  padding: 12,
  borderRadius: 8,
  border: '1px solid #ececec',
  background: '#fafafa',
  marginBottom: 16,
};

const deleteNoticeStyle: CSSProperties = {
  padding: '10px 12px',
  borderRadius: 8,
  background: 'var(--brand-vermilion-50)',
  color: 'var(--color-danger-fg)',
  font: 'var(--type-caption)',
  lineHeight: 1.6,
  marginBottom: 20,
};

const metadataModalBodyStyle: CSSProperties = {
  padding: '0 0 14px',
};

const categoryEditorHeaderStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '260px minmax(0, 1fr)',
  gap: 18,
  padding: '14px 16px 12px',
  borderTop: '1px solid #eef0f2',
  borderBottom: '1px solid #eef0f2',
};

const categorySelectedTitleStyle: CSSProperties = {
  marginBottom: 8,
  color: '#111827',
  font: '700 13px var(--font-sans)',
};

const categorySelectedWrapStyle: CSSProperties = {
  minHeight: 38,
  display: 'flex',
  alignContent: 'flex-start',
  alignItems: 'flex-start',
  flexWrap: 'wrap',
  gap: 7,
};

const categoryPickColumnsStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '170px 210px minmax(0, 1fr)',
  minHeight: 330,
  borderBottom: '1px solid #eef0f2',
};

const categoryPickPaneStyle: CSSProperties = {
  minWidth: 0,
  padding: '14px 12px 16px',
  borderRight: '1px solid #eef0f2',
};

const categoryPaneTitleStyle: CSSProperties = {
  height: 24,
  color: '#8b949e',
  font: '800 12px var(--font-sans)',
};

const categoryListStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  maxHeight: 284,
  overflowY: 'auto',
};

const categoryChoiceNameStyle: CSSProperties = {
  minWidth: 0,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const categoryPathStyle: CSSProperties = {
  color: '#8b949e',
  font: '600 11px var(--font-sans)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

function categoryChoiceRowStyle(active: boolean, selected: boolean): CSSProperties {
  return {
    width: '100%',
    minHeight: 36,
    border: selected ? '1px solid #2f62f6' : '1px solid transparent',
    borderRadius: 8,
    background: selected ? '#eff4ff' : active ? '#f4f6fb' : 'transparent',
    color: selected ? '#2557f6' : '#111827',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '0 9px',
    font: selected || active ? '800 13px var(--font-sans)' : '600 13px var(--font-sans)',
    cursor: 'pointer',
    textAlign: 'left',
  };
}

const categorySearchResultsStyle: CSSProperties = {
  minHeight: 330,
  maxHeight: 330,
  overflowY: 'auto',
  padding: '14px 16px 16px',
  borderBottom: '1px solid #eef0f2',
};

const categorySearchResultNameStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
};

function categorySearchResultStyle(selected: boolean): CSSProperties {
  return {
    width: '100%',
    minHeight: 38,
    display: 'grid',
    gridTemplateColumns: '160px minmax(0, 1fr)',
    alignItems: 'center',
    gap: 12,
    border: 0,
    borderRadius: 8,
    background: selected ? '#eff4ff' : 'transparent',
    color: selected ? '#2557f6' : '#111827',
    padding: '0 10px',
    font: selected ? '800 13px var(--font-sans)' : '600 13px var(--font-sans)',
    cursor: 'pointer',
    textAlign: 'left',
  };
}

const metadataModalColumnsStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '330px minmax(0, 1fr)',
  minHeight: 390,
  borderTop: '1px solid #eef0f2',
  borderBottom: '1px solid #eef0f2',
};

const metadataLeftPaneStyle: CSSProperties = {
  padding: '14px 16px 16px',
  borderRight: '1px solid #eef0f2',
  minWidth: 0,
};

const metadataRightPaneStyle: CSSProperties = {
  padding: '18px 18px 16px',
  minWidth: 0,
};

const metadataSearchStyle: CSSProperties = {
  height: 38,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '0 10px',
  border: '1px solid #2f62f6',
  borderRadius: 8,
  background: '#fff',
  boxShadow: '0 0 0 2px rgba(47,98,246,.08)',
  marginBottom: 12,
};

const metadataSearchInputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: 0,
  outline: 'none',
  background: 'transparent',
  color: '#111827',
  font: '500 13px var(--font-sans)',
};

const metadataNavListStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

function metadataNavRowStyle(active: boolean): CSSProperties {
  return {
    width: '100%',
    height: 38,
    border: 0,
    borderRadius: 7,
    background: active ? '#f4f6fb' : 'transparent',
    color: active ? '#111827' : '#4b5563',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 8px',
    font: active ? '700 13px var(--font-sans)' : '500 13px var(--font-sans)',
    cursor: 'pointer',
  };
}

const metadataPaneHeaderStyle: CSSProperties = {
  height: 28,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  color: '#111827',
  font: '700 13px var(--font-sans)',
  marginBottom: 8,
};

const metadataSelectedWrapStyle: CSSProperties = {
  minHeight: 86,
  display: 'flex',
  alignContent: 'flex-start',
  alignItems: 'flex-start',
  flexWrap: 'wrap',
  gap: 8,
  paddingBottom: 12,
  borderBottom: '1px solid #f0f0ef',
};

const metadataOptionTitleStyle: CSSProperties = {
  margin: '14px 0 10px',
  color: '#8b949e',
  font: '700 12px var(--font-sans)',
};

const metadataOptionWrapStyle: CSSProperties = {
  maxHeight: 174,
  overflowY: 'auto',
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  alignContent: 'flex-start',
};

const metadataTagGroupHeaderStyle: CSSProperties = {
  color: '#8b949e',
  font: '700 12px var(--font-sans)',
  margin: '8px 0 9px',
};

const metadataTagOptionsStyle: CSSProperties = {
  maxHeight: 292,
  overflowY: 'auto',
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  alignContent: 'flex-start',
};

const metadataSelectedChipStyle: CSSProperties = {
  minHeight: 28,
  maxWidth: '100%',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '0 10px',
  border: '1px solid #d8dde5',
  borderRadius: 999,
  background: '#fff',
  color: '#111827',
  font: '600 13px var(--font-sans)',
  cursor: 'pointer',
};

function metadataOptionChipStyle(active: boolean): CSSProperties {
  return {
    minHeight: 28,
    maxWidth: '100%',
    display: 'inline-flex',
    alignItems: 'center',
    padding: '0 10px',
    border: active ? '1px solid #2f62f6' : '1px solid #d8dde5',
    borderRadius: 999,
    background: active ? '#eff4ff' : '#fff',
    color: active ? '#2557f6' : '#111827',
    font: active ? '700 13px var(--font-sans)' : '500 13px var(--font-sans)',
    cursor: 'pointer',
  };
}

const metadataCreateChipStyle: CSSProperties = {
  minHeight: 28,
  maxWidth: '100%',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '0 10px',
  border: '1px dashed #2f62f6',
  borderRadius: 999,
  background: '#f8fbff',
  color: '#2557f6',
  font: '700 13px var(--font-sans)',
  cursor: 'pointer',
};

const metadataMutedTextStyle: CSSProperties = {
  color: '#8b949e',
  font: '500 13px var(--font-sans)',
  lineHeight: 1.7,
};

const metadataModalFooterStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 10,
  padding: '14px 18px 0',
};
