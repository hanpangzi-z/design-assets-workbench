import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Plus, X, Check, MoreVertical, RotateCcw, Trash2 } from 'lucide-react';
import { message, Modal, Input, Switch, Spin, Dropdown, Select } from 'antd';
import api from '@/api/index';
import { clearLibrariesCache } from '@/api/libraries';
import useCategoryStore from '@/store/categoryStore';
import { getTags, createTag, deleteTag } from '@/api/tags';
import { createCategory, deleteCategory, updateCategory } from '@/api/categories';
import type { Tag, Category } from 'shared/types';

interface LibDetail {
  id: number;
  name: string;
  description: string | null;
  templateCount: number;
  materialCount: number;
  owner?: { id: number; displayName: string };
}

interface UserOption {
  id: number;
  username: string;
  employeeNo?: string;
  displayName: string;
  role?: { name: string; displayName: string };
}

type PermissionMembers = Record<string, UserOption[]>;

function getUserOptionLabel(user: UserOption) {
  return `${user.displayName || user.employeeNo || user.username}（${user.employeeNo || user.username}）`;
}

const PERM_COLS = ['转让库\n拥有权', '成员管理', '分类标签', '发布内容', '编辑\n管理内容', '入库内容', '使用\n下载内容', '查看\n预览内容'];
const PERM_ROWS = [
  { role: '可查看', perms: [false, false, false, false, false, false, false, true] },
  { role: '可复用', perms: [false, false, false, false, false, false, true, true] },
  { role: '可编辑', perms: [false, false, false, false, true, true, true, true] },
  { role: '可管理', perms: [false, true, true, true, true, true, true, true] },
  { role: '库主', perms: [true, true, true, true, true, true, true, true] },
];

export default function LibraryDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const libraryId = Number(id);
  const [lib, setLib] = useState<LibDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const initialTab = (['permissions', 'categories', 'tags'] as const).includes(searchParams.get('tab') as any)
    ? (searchParams.get('tab') as 'permissions' | 'categories' | 'tags')
    : 'permissions';
  const [tab, setTab] = useState<'permissions' | 'categories' | 'tags'>(initialTab);
  const { dimensionCategories, fetchAll: fetchCategories } = useCategoryStore();
  const [tags, setTags] = useState<Tag[]>([]);
  const [newTagName, setNewTagName] = useState('');
  const [users, setUsers] = useState<UserOption[]>([]);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferOwnerId, setTransferOwnerId] = useState<number | undefined>();
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashLibraries, setTrashLibraries] = useState<LibDetail[]>([]);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [permissionRole, setPermissionRole] = useState('');
  const [permissionUserId, setPermissionUserId] = useState<number | undefined>();
  const [permissionMembers, setPermissionMembers] = useState<PermissionMembers>({});
  const [allManageEnabled, setAllManageEnabled] = useState(true);
  const [defaultPublished, setDefaultPublished] = useState(true);
  const tagInputRef = useRef<HTMLInputElement>(null);
  const dimensionInputRef = useRef<HTMLInputElement>(null);
  const categoryInputRef = useRef<HTMLInputElement>(null);
  const [customDimensions, setCustomDimensions] = useState<string[]>([]);
  const [addingDimension, setAddingDimension] = useState(false);
  const [newDimensionName, setNewDimensionName] = useState('');
  const [addingCategoryTag, setAddingCategoryTag] = useState(false);
  const [newCategoryTagName, setNewCategoryTagName] = useState('');
  const [selectedDim, setSelectedDim] = useState('');
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null);
  const [addingSubCategory, setAddingSubCategory] = useState(false);
  const [newSubCategoryName, setNewSubCategoryName] = useState('');
  const subCategoryInputRef = useRef<HTMLInputElement>(null);
  const dimensionKeys = useMemo(
    () => Array.from(new Set([...Object.keys(dimensionCategories), ...customDimensions])),
    [dimensionCategories, customDimensions],
  );

  useEffect(() => {
    if (!id) return;
    api.get(`/libraries/${id}`).then(r => setLib(r.data?.data)).catch(() => {});
    api.get('/users').then(r => setUsers(r.data?.data || [])).catch(() => setUsers([]));
    fetchCategories(libraryId);
    getTags().then(setTags).catch(() => {});
    const savedPermissions = window.localStorage.getItem(`library-permissions:${id}`);
    if (savedPermissions) {
      try { setPermissionMembers(JSON.parse(savedPermissions)); } catch { setPermissionMembers({}); }
    }
    const savedDimensions = window.localStorage.getItem(`library-dimensions:${id}`);
    if (savedDimensions) {
      try { setCustomDimensions(JSON.parse(savedDimensions)); } catch { setCustomDimensions([]); }
    }
    setAllManageEnabled(window.localStorage.getItem(`library-all-manage:${id}`) !== 'false');
    setDefaultPublished(window.localStorage.getItem(`library-default-published:${id}`) !== 'false');
    setLoading(false);
  }, [id]);

  useEffect(() => {
    if (addingDimension) dimensionInputRef.current?.focus();
  }, [addingDimension]);

  useEffect(() => {
    if (addingCategoryTag) categoryInputRef.current?.focus();
  }, [addingCategoryTag]);

  useEffect(() => {
    if (addingSubCategory) subCategoryInputRef.current?.focus();
  }, [addingSubCategory]);

  useEffect(() => {
    if (dimensionKeys.length === 0) {
      if (selectedDim) setSelectedDim('');
      return;
    }
    if (!selectedDim || !dimensionKeys.includes(selectedDim)) {
      setSelectedDim(dimensionKeys[0]);
    }
  }, [dimensionKeys, selectedDim]);

  if (loading || !lib) return <div style={{ padding: 48, textAlign: 'center' }}><Spin /></div>;

  const DIM_LABELS: Record<string, string> = { festival: '节日', design_type: '设计类型', product_type: '品类', version: '版本' };

  const handleCreateTag = async () => {
    const name = newTagName.trim();
    if (!name) return;

    try {
      await createTag({ name });
      setTags(await getTags());
      setNewTagName('');
      message.success('已添加');
    } catch {
      message.error('添加失败');
    }
  };

  const loadTrash = async () => {
    setTrashLoading(true);
    try {
      const res = await api.get('/libraries/trash');
      setTrashLibraries(res.data?.data || []);
    } catch {
      message.error('回收站加载失败');
      setTrashLibraries([]);
    } finally {
      setTrashLoading(false);
    }
  };

  const openTrash = () => {
    setTrashOpen(true);
    loadTrash();
  };

  const restoreLibrary = async (target: LibDetail) => {
    try {
      await api.patch(`/libraries/${target.id}/restore`);
      clearLibrariesCache();
      message.success('已恢复');
      await loadTrash();
    } catch {
      message.error('恢复失败');
    }
  };

  const permanentDeleteLibrary = async (target: LibDetail) => {
    setTrashLoading(true);
    try {
      await api.delete(`/libraries/${target.id}/permanent`);
      clearLibrariesCache();
      message.success('已删除');
      await loadTrash();
    } catch (err: any) {
      message.error(err?.response?.data?.message || '删除失败');
    } finally {
      setTrashLoading(false);
    }
  };

  const openTransfer = () => {
    setTransferOwnerId(lib.owner?.id);
    setTransferOpen(true);
  };

  const confirmTransfer = async () => {
    if (!transferOwnerId) {
      message.warning('请选择新的库主');
      return;
    }
    try {
      const res = await api.put(`/libraries/${lib.id}`, { ownerId: transferOwnerId });
      setLib(res.data?.data || lib);
      clearLibrariesCache();
      setTransferOpen(false);
      message.success('库主已转让');
    } catch {
      message.error('转让失败');
    }
  };

  const persistPermissionMembers = (next: PermissionMembers) => {
    setPermissionMembers(next);
    if (id) window.localStorage.setItem(`library-permissions:${id}`, JSON.stringify(next));
  };

  const openPermissionAdd = (role: string) => {
    setPermissionRole(role);
    setPermissionUserId(undefined);
    setPermissionOpen(true);
  };

  const confirmPermissionAdd = () => {
    const target = users.find((item) => item.id === permissionUserId);
    if (!target || !permissionRole) {
      message.warning('请选择成员');
      return;
    }
    const current = permissionMembers[permissionRole] || [];
    if (current.some((item) => item.id === target.id)) {
      message.warning('该成员已在当前权限组');
      return;
    }
    persistPermissionMembers({
      ...permissionMembers,
      [permissionRole]: [...current, target],
    });
    setPermissionOpen(false);
    message.success('已添加到权限组');
  };

  const removePermissionMember = (role: string, userId: number) => {
    persistPermissionMembers({
      ...permissionMembers,
      [role]: (permissionMembers[role] || []).filter((item) => item.id !== userId),
    });
  };

  const toggleAllManage = (checked: boolean) => {
    setAllManageEnabled(checked);
    if (id) window.localStorage.setItem(`library-all-manage:${id}`, String(checked));
    message.success(checked ? '已开启全员可管理' : '已关闭全员可管理');
  };

  const toggleDefaultPublished = (checked: boolean) => {
    setDefaultPublished(checked);
    if (id) window.localStorage.setItem(`library-default-published:${id}`, String(checked));
    message.success(checked ? '入库后默认发布' : '入库后默认不发布');
  };

  const persistCustomDimensions = (next: string[]) => {
    const unique = Array.from(new Set(next.filter(Boolean)));
    setCustomDimensions(unique);
    if (id) window.localStorage.setItem(`library-dimensions:${id}`, JSON.stringify(unique));
  };

  const createDimensionGroup = () => {
    setNewDimensionName('');
    setAddingDimension(true);
  };

  const commitDimensionGroup = () => {
    const name = newDimensionName.trim().slice(0, 32);
    if (!name) {
      setAddingDimension(false);
      return;
    }
    const exists = Object.keys(dimensionCategories).includes(name) || customDimensions.includes(name);
    if (exists) {
      message.warning('分类已存在');
      return;
    }
    persistCustomDimensions([...customDimensions, name]);
    setSelectedDim(name);
    setAddingDimension(false);
    setNewDimensionName('');
    message.success('已添加分类');
  };

  const startCreateCategoryTag = () => {
    setNewCategoryTagName('');
    setAddingCategoryTag(true);
  };

  const cancelCreateCategoryTag = () => {
    setAddingCategoryTag(false);
    setNewCategoryTagName('');
  };

  const commitCreateCategoryTag = async () => {
    const name = newCategoryTagName.trim();
    if (!name) {
      cancelCreateCategoryTag();
      return;
    }
    if (name.length > 32) {
      message.warning('分类名最多 32 个字符');
      return;
    }
    try {
      await createCategory({ name, dimension: selectedDim, libraryId });
      await fetchCategories(libraryId);
      setNewCategoryTagName('');
      setAddingCategoryTag(true);
      window.setTimeout(() => categoryInputRef.current?.focus(), 0);
      message.success('已添加');
    } catch {
      message.error('添加失败');
    }
  };

  const startCreateSubCategory = () => {
    setNewSubCategoryName('');
    setAddingSubCategory(true);
  };

  const cancelCreateSubCategory = () => {
    setAddingSubCategory(false);
    setNewSubCategoryName('');
  };

  const commitCreateSubCategory = async () => {
    const name = newSubCategoryName.trim();
    if (!name) {
      cancelCreateSubCategory();
      return;
    }
    if (name.length > 32) {
      message.warning('分类名最多 32 个字符');
      return;
    }
    if (!selectedCategoryId) {
      message.warning('请先选择二级分类');
      return;
    }
    try {
      await createCategory({ name, dimension: selectedDim, parentId: selectedCategoryId, libraryId });
      await fetchCategories(libraryId);
      setNewSubCategoryName('');
      setAddingSubCategory(true);
      window.setTimeout(() => subCategoryInputRef.current?.focus(), 0);
      message.success('已添加');
    } catch {
      message.error('添加失败');
    }
  };

  const renameDimension = (dimension: string) => {
    const collectAll = (list: Category[]): Category[] => {
      const out: Category[] = [];
      for (const c of list) {
        out.push(c);
        if (c.children?.length) out.push(...collectAll(c.children));
      }
      return out;
    };
    const cats = collectAll(dimensionCategories[dimension] || []);
    let nextName = DIM_LABELS[dimension] || dimension;
    Modal.confirm({
      title: '重命名分类组',
      content: <Input defaultValue={nextName} onChange={e => { nextName = e.target.value; }} autoFocus />,
      okText: '确定',
      cancelText: '取消',
      onOk: async () => {
        const trimmed = nextName.trim().slice(0, 32);
        if (!trimmed || trimmed === dimension) return;
        const exists = Object.keys(dimensionCategories).includes(trimmed) || customDimensions.includes(trimmed);
        if (exists) {
          message.warning('分类已存在');
          return Promise.reject(new Error('分类已存在'));
        }
        try {
          if (cats.length > 0) {
            await Promise.all(cats.map((cat) => updateCategory(cat.id, { dimension: trimmed })));
          }
          // 同步更新本地保存的自定义维度名称，否则空分类重命名后不生效
          if (customDimensions.includes(dimension)) {
            persistCustomDimensions(customDimensions.map(d => (d === dimension ? trimmed : d)));
          }
          await fetchCategories(libraryId);
          setSelectedDim(trimmed);
          message.success('已重命名');
        } catch {
          message.error('重命名失败');
        }
      },
    });
  };

  const selectedLabel = DIM_LABELS[selectedDim] || selectedDim;
  const selectedItems = dimensionCategories[selectedDim] || [];
  const selectedCategory = selectedItems.find((c) => c.id === selectedCategoryId) || null;
  const subItems = selectedCategory?.children || [];

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '24px 32px', background: 'var(--bg-app)' }}>
      {/* 返回 */}
      <div onClick={() => navigate('/admin/libraries')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--fg-1)', font: '600 14px var(--font-sans)', marginBottom: 22 }}>
        <ArrowLeft size={16} /> 返回
      </div>

      {/* 库信息卡片 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 12, marginBottom: 16 }}>
        <div style={{ background: 'var(--n-50)', borderRadius: 8, padding: '26px 30px', minHeight: 178, position: 'relative' }}>
          <div style={{ position: 'absolute', top: 22, right: 24, display: 'flex', gap: 8 }}>
            <button onClick={openTrash} style={outlineSmallButtonStyle}>回收站</button>
            <button onClick={() => {
                Modal.confirm({ title: '删除资源库', content: `确定删除「${lib.name}」？`, okText: '删除', okButtonProps: { danger: true }, cancelText: '取消',
                  onOk: async () => {
                    await api.delete(`/libraries/${lib.id}`);
                    clearLibrariesCache();
                    message.success('已删除');
                    navigate('/admin/libraries');
                  },
                });
              }}
              style={{ ...outlineSmallButtonStyle, borderColor: 'var(--color-danger-fg)', color: 'var(--color-danger-fg)' }}
            >
              删除资源库
            </button>
          </div>
          <h2 style={{ font: '700 22px var(--font-sans)', color: 'var(--fg-1)', margin: '0 0 20px' }}>{lib.name}</h2>
          <div style={infoLineStyle}>
            <span style={infoLabelStyle}>库主：</span>
            <span>{lib.owner?.displayName || '-'}</span>
            <span onClick={openTransfer} style={{ color: 'var(--brand-teal-500)', cursor: 'pointer', marginLeft: 8, fontWeight: 600 }}>转让</span>
          </div>
          <div style={infoLineStyle}>
            <span style={infoLabelStyle}>简介：</span>
            <span>{lib.description || '统一管理企业内容，共享设计内容，让每一份设计都可以被充分利用～'}</span>
          </div>
          <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', marginTop: 16 }}>
            <label style={settingLineStyle}>
              <span>内容入库后默认状态</span>
              <Switch size="small" checked={defaultPublished} onChange={toggleDefaultPublished} />
              <span>{defaultPublished ? '已发布' : '未发布'}</span>
            </label>
            <label style={settingLineStyle}>
              <span>添加内容时分类</span>
              <Switch size="small" checked={false} disabled />
              <span>不分类</span>
            </label>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateRows: '1fr 1fr', gap: 12 }}>
          <div style={statCardStyle}>
            <StatItem label="已发布模板数量" value={lib.templateCount} />
            <StatItem label="模板总量" value={lib.templateCount} />
          </div>
          <div style={statCardStyle}>
            <StatItem label="已发布素材数量" value={lib.materialCount} />
            <StatItem label="素材总量" value={lib.materialCount} />
          </div>
        </div>
      </div>

      {/* Tab 切换 */}
      <div style={{ display: 'flex', gap: 0, background: 'var(--n-50)', borderRadius: 8, marginBottom: 18, height: 46, alignItems: 'stretch', padding: '0 14px' }}>
        {[
          { key: 'permissions' as const, label: '成员权限' },
          { key: 'categories' as const, label: '分类管理' },
          { key: 'tags' as const, label: '标签管理' },
        ].map(t => (
          <span key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '0 18px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center',
            font: tab === t.key ? '700 14px var(--font-sans)' : 'var(--type-body)',
            color: tab === t.key ? 'var(--fg-1)' : 'var(--fg-3)',
            borderBottom: tab === t.key ? '2px solid var(--fg-1)' : '2px solid transparent',
          }}>{t.label}</span>
        ))}
      </div>

      {/* 成员权限 Tab */}
      {tab === 'permissions' && (
        <div style={{ background: '#fff', borderRadius: 8, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', font: 'var(--type-body)' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-2)' }}>
                <th style={{ padding: '10px 16px', textAlign: 'left', font: 'var(--type-label)', color: 'var(--fg-3)', width: 80 }}></th>
                {PERM_COLS.map(c => (
                  <th key={c} style={{ padding: '10px 12px', textAlign: 'center', font: 'var(--type-caption)', color: 'var(--fg-3)', whiteSpace: 'pre-line', lineHeight: 1.4 }}>{c}</th>
                ))}
                <th style={{ padding: '10px 16px', font: 'var(--type-caption)', color: 'var(--fg-3)' }}></th>
              </tr>
            </thead>
            <tbody>
              {PERM_ROWS.map(row => (
                <tr key={row.role} style={{ borderBottom: '1px solid var(--border-2)' }}>
                  <td style={{ padding: '12px 16px', font: 'var(--type-label)', color: 'var(--fg-1)' }}>{row.role}</td>
                  {row.perms.map((p, i) => (
                    <td key={i} style={{ padding: '12px', textAlign: 'center' }}>
                      {p ? <Check size={16} style={{ color: 'var(--brand-teal-500)' }} /> : <X size={14} style={{ color: 'var(--n-300)' }} />}
                    </td>
                  ))}
                  <td style={{ padding: '12px 16px' }}>
                    {row.role === '可管理' && <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Switch size="small" checked={allManageEnabled} onChange={toggleAllManage} /> <span style={{ font: 'var(--type-caption)', color: 'var(--fg-3)' }}>{allManageEnabled ? '全员可管理已开启' : '全员可管理已关闭'}</span></span>}
                    {row.role === '库主' && <span style={{ font: 'var(--type-body)', color: 'var(--fg-2)' }}>{lib.owner?.displayName}</span>}
                    {['可查看', '可复用', '可编辑'].includes(row.role) && (
                      <div>
                        <span style={{ font: 'var(--type-caption)', color: 'var(--fg-4)' }}>全员{row.role}已关闭</span>
                        {(permissionMembers[row.role] || []).length > 0 && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                            {(permissionMembers[row.role] || []).map((member) => (
                              <span key={member.id} style={{
                                display: 'inline-flex', alignItems: 'center', gap: 4,
                                padding: '2px 6px', borderRadius: 4, background: 'var(--n-50)',
                                color: 'var(--fg-2)', font: 'var(--type-caption)',
                              }}>
                                {member.displayName}
                                <X size={10} style={{ cursor: 'pointer', color: 'var(--fg-4)' }} onClick={() => removePermissionMember(row.role, member.id)} />
                              </span>
                            ))}
                          </div>
                        )}
                        <div onClick={() => openPermissionAdd(row.role)} style={{ color: 'var(--brand-teal-500)', font: 'var(--type-caption)', cursor: 'pointer', marginTop: 6 }}>+ 添加</div>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 分类管理 Tab */}
      {tab === 'categories' && (
        <div style={{ display: 'grid', gridTemplateColumns: '156px 200px minmax(0, 1fr)', gap: 24, padding: '0 18px' }}>
          {/* 第一级：分类树（维度） */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginBottom: 14 }}>
              <span style={{ font: '700 14px var(--font-sans)', color: 'var(--fg-1)' }}>分类树</span>
              <button type="button" onClick={createDimensionGroup} style={inlineAddButtonStyle} title="新增分类" aria-label="新增分类">
                +
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {dimensionKeys.map(dk => {
              const count = (dimensionCategories[dk] || []).length;
              const active = selectedDim === dk;
              return (
                <div key={dk} onClick={() => { setSelectedDim(dk); setSelectedCategoryId(null); }} style={treeItemStyle(active)}>
                  <span style={{ flex: 1 }}>{DIM_LABELS[dk] || dk}分类</span>
                  <span style={{ font: 'var(--type-caption)', color: active ? 'var(--fg-3)' : 'var(--fg-4)' }}>({count})</span>
                  <Dropdown menu={{
                    items: [
                      {
                        key: 'rename', label: '重命名',
                        onClick: ({ domEvent }) => {
                          domEvent.stopPropagation();
                          renameDimension(dk);
                        },
                      },
                      {
                        key: 'delete', label: '删除', danger: true,
                        onClick: ({ domEvent }) => {
                          domEvent.stopPropagation();
                          const cats = dimensionCategories[dk] || [];
                          const dimLabel = DIM_LABELS[dk] || dk;
                          Modal.confirm({
                            title: '删除分类',
                            content: cats.length > 0
                              ? `确定删除「${dimLabel}」下的所有 ${cats.length} 个分类吗？（含其子分类）`
                              : `确定删除「${dimLabel}」吗？`,
                            okText: '删除', okButtonProps: { danger: true }, cancelText: '取消',
                            onOk: async () => {
                              try {
                                if (cats.length > 0) {
                                  await Promise.all(cats.map(c => deleteCategory(c.id)));
                                }
                                const nextCustom = customDimensions.filter(d => d !== dk);
                                persistCustomDimensions(nextCustom);
                                message.success('已删除');
                                await fetchCategories(libraryId);
                                const remaining = Array.from(new Set([
                                  ...Object.keys(useCategoryStore.getState().dimensionCategories),
                                  ...nextCustom,
                                ]));
                                if (!remaining.includes(dk)) {
                                  setSelectedDim(remaining[0] || '');
                                  setSelectedCategoryId(null);
                                }
                              } catch (err: any) { message.error(err?.response?.data?.message || '删除失败'); }
                            },
                          });
                        },
                      },
                    ],
                  }} trigger={['click']}>
                    <span onClick={e => e.stopPropagation()} style={{
                      width: 18, height: 18, display: 'grid', placeItems: 'center',
                      borderRadius: 4, cursor: 'pointer', color: 'var(--fg-4)',
                    }}>
                      <MoreVertical size={13} />
                    </span>
                  </Dropdown>
                </div>
              );
            })}
            {addingDimension && (
              <input
                ref={dimensionInputRef}
                value={newDimensionName}
                onChange={(e) => setNewDimensionName(e.target.value)}
                onBlur={commitDimensionGroup}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitDimensionGroup();
                  if (e.key === 'Escape') {
                    setAddingDimension(false);
                    setNewDimensionName('');
                  }
                }}
                maxLength={32}
                placeholder="请输入分类名"
                style={treeInputStyle}
              />
            )}
            </div>
          </div>

          {/* 第二级：二级分类 */}
          <div>
            {selectedDim ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginBottom: 16, minHeight: 28 }}>
                  <span style={{ font: '700 15px var(--font-sans)', color: 'var(--fg-1)' }}>{selectedLabel}</span>
                  <button type="button" onClick={startCreateCategoryTag} style={inlineAddButtonStyle} title="新增二级分类" aria-label="新增二级分类">+</button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {selectedItems.map((cat) => (
                    <CategoryRow
                      key={cat.id}
                      cat={cat}
                      selectable
                      active={selectedCategoryId === cat.id}
                      countText={`(${cat.children?.length || 0})`}
                      onSelect={() => setSelectedCategoryId(cat.id)}
                      onChanged={() => fetchCategories(libraryId)}
                    />
                  ))}
                  {addingCategoryTag && (
                    <CategoryInlineInput
                      inputRef={categoryInputRef}
                      value={newCategoryTagName}
                      onChange={setNewCategoryTagName}
                      onCommit={commitCreateCategoryTag}
                      onCancel={cancelCreateCategoryTag}
                    />
                  )}
                  {!addingCategoryTag && selectedItems.length === 0 && (
                    <div style={{ color: 'var(--fg-4)', font: 'var(--type-body)', padding: '4px 0 0 4px' }}>
                      暂无二级分类，点击上方 + 添加
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div style={{ padding: 48, textAlign: 'center', color: 'var(--fg-4)', font: 'var(--type-body)' }}>请在左侧选择一个分类</div>
            )}
          </div>

          {/* 第三级：三级分类 */}
          <div>
            {selectedDim && selectedCategory ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginBottom: 16, minHeight: 28 }}>
                  <span style={{ font: '700 15px var(--font-sans)', color: 'var(--fg-1)' }}>{selectedCategory.name}</span>
                  <button type="button" onClick={startCreateSubCategory} style={inlineAddButtonStyle} title="新增三级分类" aria-label="新增三级分类">+</button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 420 }}>
                  {subItems.map((cat) => (
                    <CategoryRow
                      key={cat.id}
                      cat={cat}
                      countText={String(cat.fileCount ?? 0)}
                      onChanged={() => fetchCategories(libraryId)}
                    />
                  ))}
                  {addingSubCategory && (
                    <CategoryInlineInput
                      inputRef={subCategoryInputRef}
                      value={newSubCategoryName}
                      onChange={setNewSubCategoryName}
                      onCommit={commitCreateSubCategory}
                      onCancel={cancelCreateSubCategory}
                    />
                  )}
                  {!addingSubCategory && subItems.length === 0 && (
                    <div style={{ color: 'var(--fg-4)', font: 'var(--type-body)', padding: '4px 0 0 16px' }}>
                      暂无三级分类，点击上方 + 添加
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div style={{ padding: 48, textAlign: 'center', color: 'var(--fg-4)', font: 'var(--type-body)' }}>
                {selectedDim ? '请在中间选择一个二级分类' : ''}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 标签管理 Tab */}
      {tab === 'tags' && (
        <div style={{ display: 'flex', gap: 24 }}>
          <div style={{ width: 200 }}>
            <div style={{ padding: '8px 12px', background: 'var(--bg-selected)', borderRadius: 6, font: '500 13px var(--font-sans)', color: 'var(--brand-teal-600)', display: 'flex', justifyContent: 'space-between' }}>
              <span>全部标签</span><span>{tags.length}</span>
            </div>
            <div style={{ padding: '8px 12px', font: 'var(--type-body)', color: 'var(--fg-3)', display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
              <span>未分组</span><span>{tags.length}</span>
            </div>
            <div style={{ padding: '8px 12px', font: 'var(--type-body)', color: 'var(--fg-3)', display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
              标签 <Plus size={12} onClick={() => tagInputRef.current?.focus()} style={{ color: 'var(--fg-4)', cursor: 'pointer' }} />
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <span style={{ font: '500 15px var(--font-sans)', color: 'var(--fg-1)' }}>全部标签</span>
              <input ref={tagInputRef} value={newTagName} onChange={e => setNewTagName(e.target.value)} placeholder="新标签名" onKeyDown={e => {
                if (e.key === 'Enter') handleCreateTag();
              }} style={{ width: 160, height: 28, padding: '0 8px', border: '1px solid var(--border-1)', borderRadius: 4, font: 'var(--type-body)', outline: 'none' }} />
              <button
                onClick={handleCreateTag}
                disabled={!newTagName.trim()}
                style={{
                  height: 28,
                  padding: '0 10px',
                  borderRadius: 4,
                  border: 'none',
                  background: newTagName.trim() ? 'var(--brand-teal-500)' : 'var(--n-100)',
                  color: newTagName.trim() ? '#fff' : 'var(--fg-4)',
                  font: '500 12px var(--font-sans)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  cursor: newTagName.trim() ? 'pointer' : 'not-allowed',
                }}
              >
                <Plus size={13} /> 新增
              </button>
            </div>
            {/* 按首字母分组 */}
            {(() => {
              const grouped: Record<string, Tag[]> = {};
              tags.forEach(t => {
                const first = t.name.charAt(0).toUpperCase();
                if (!grouped[first]) grouped[first] = [];
                grouped[first].push(t);
              });
              return Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([letter, items]) => (
                <div key={letter} style={{ marginBottom: 16 }}>
                  <div style={{ font: '600 14px var(--font-sans)', color: 'var(--fg-1)', marginBottom: 8 }}>{letter}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {items.map(t => (
                      <span key={t.id} style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        padding: '4px 10px', borderRadius: 4, border: '1px solid var(--border-1)',
                        font: 'var(--type-body)', color: 'var(--fg-1)', background: '#fff',
                      }}>
                        {t.name} <span style={{ font: 'var(--type-caption)', color: 'var(--fg-4)' }}>0</span>
                        <X size={12} style={{ color: 'var(--fg-4)', cursor: 'pointer' }} onClick={() => {
                          deleteTag(t.id).then(() => { getTags().then(setTags); message.success('已删除'); });
                        }} />
                      </span>
                    ))}
                  </div>
                </div>
              ));
            })()}
          </div>
        </div>
      )}

      <Modal
        title="转让库主"
        open={transferOpen}
        onOk={confirmTransfer}
        onCancel={() => setTransferOpen(false)}
        okText="确认转让"
        cancelText="取消"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 0' }}>
          <div style={{ font: 'var(--type-body)', color: 'var(--fg-3)' }}>选择新的资源库库主。</div>
          <Select
            showSearch
            value={transferOwnerId}
            placeholder="选择成员"
            optionFilterProp="label"
            onChange={(value) => setTransferOwnerId(value)}
            options={users.map((item) => ({
              value: item.id,
              label: getUserOptionLabel(item),
            }))}
          />
        </div>
      </Modal>

      <Modal
        title="资源库回收站"
        open={trashOpen}
        onCancel={() => setTrashOpen(false)}
        footer={null}
        width={620}
      >
        {trashLoading ? (
          <div style={{ textAlign: 'center', padding: 32 }}><Spin /></div>
        ) : trashLibraries.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 32, color: 'var(--fg-4)' }}>回收站暂无资源库</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {trashLibraries.map((item) => (
              <div key={item.id} style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto',
                gap: 12,
                alignItems: 'center',
                padding: 12,
                borderRadius: 8,
                border: '1px solid var(--border-2)',
                background: '#fff',
              }}>
                <div>
                  <div style={{ font: '600 14px var(--font-sans)', color: 'var(--fg-1)' }}>{item.name}</div>
                  <div style={{ font: 'var(--type-caption)', color: 'var(--fg-3)', marginTop: 4 }}>
                    库主：{item.owner?.displayName || '-'} · 模板 {item.templateCount} · 素材 {item.materialCount}
                  </div>
                </div>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <button
                    onClick={() => restoreLibrary(item)}
                    style={{
                      height: 30,
                      padding: '0 12px',
                      borderRadius: 6,
                      border: '1px solid var(--brand-teal-500)',
                      background: 'var(--brand-teal-50)',
                      color: 'var(--brand-teal-600)',
                      font: '500 12px var(--font-sans)',
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                    }}
                  >
                    <RotateCcw size={13} /> 恢复
                  </button>
                  <button
                    onClick={() => permanentDeleteLibrary(item)}
                    style={{
                      height: 30,
                      padding: '0 12px',
                      borderRadius: 6,
                      border: '1px solid rgba(212, 60, 53, 0.28)',
                      background: 'rgba(212, 60, 53, 0.08)',
                      color: 'var(--color-danger-fg)',
                      font: '500 12px var(--font-sans)',
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                    }}
                  >
                    <Trash2 size={13} /> 删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>

      <Modal
        title={`添加${permissionRole || ''}成员`}
        open={permissionOpen}
        onOk={confirmPermissionAdd}
        onCancel={() => setPermissionOpen(false)}
        okText="添加"
        cancelText="取消"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 0' }}>
          <div style={{ font: 'var(--type-body)', color: 'var(--fg-3)' }}>选择要放入该权限组的成员。</div>
          <Select
            showSearch
            value={permissionUserId}
            placeholder="选择成员"
            optionFilterProp="label"
            onChange={(value) => setPermissionUserId(value)}
            options={users.map((item) => ({
              value: item.id,
              label: getUserOptionLabel(item),
            }))}
          />
        </div>
      </Modal>
    </div>
  );
}

function StatItem({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div style={{ font: '700 13px var(--font-sans)', color: 'var(--fg-1)', marginBottom: 8 }}>{label}</div>
      <div style={{ font: '800 26px var(--font-sans)', color: 'var(--fg-1)', lineHeight: 1 }}>{value}</div>
    </div>
  );
}

function CategoryInlineInput({
  inputRef,
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  inputRef: React.RefObject<HTMLInputElement>;
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={categoryInputRowStyle}>
      <span style={{ width: 3, height: 3, borderRadius: '50%', background: 'var(--n-300)', flexShrink: 0 }} />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          if (value.trim()) onCommit();
          else onCancel();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onCommit();
          }
          if (e.key === 'Escape') onCancel();
        }}
        maxLength={32}
        placeholder="请输入分类名 (最多 32 个字符)"
        style={categoryInputStyle}
      />
    </div>
  );
}


function CategoryRow({
  cat,
  active = false,
  countText,
  selectable = false,
  onSelect,
  onChanged,
}: {
  cat: Category;
  active?: boolean;
  countText: string;
  selectable?: boolean;
  onSelect?: () => void;
  onChanged: () => Promise<void>;
}) {
  const renameCategory = () => {
    let nextName = cat.name;
    Modal.confirm({
      title: '重命名分类',
      content: <Input defaultValue={cat.name} onChange={e => { nextName = e.target.value; }} autoFocus />,
      okText: '确定',
      cancelText: '取消',
      onOk: async () => {
        const trimmed = nextName.trim().slice(0, 32);
        if (!trimmed || trimmed === cat.name) return;
        try {
          await updateCategory(cat.id, { name: trimmed });
          await onChanged();
          message.success('已重命名');
        } catch {
          message.error('重命名失败');
        }
      },
    });
  };

  const removeCategory = () => {
    const childCount = cat.children?.length || 0;
    Modal.confirm({
      title: '删除分类',
      content: childCount > 0
        ? `确定删除「${cat.name}」吗？其下 ${childCount} 个子分类也会一并删除。`
        : `确定删除「${cat.name}」吗？`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await deleteCategory(cat.id);
          await onChanged();
          message.success('已删除');
        } catch (err: any) {
          message.error(err?.response?.data?.message || '删除失败');
        }
      },
    });
  };

  return (
    <div
      onClick={selectable ? onSelect : undefined}
      style={selectable ? treeItemStyle(active) : tagRowStyle}
    >
      <span style={{ width: 3, height: 3, borderRadius: '50%', background: 'var(--n-300)', flexShrink: 0 }} />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cat.name}</span>
      <span style={{ font: 'var(--type-caption)', color: 'var(--fg-4)', minWidth: 20, textAlign: 'right' }}>{countText}</span>
      <Dropdown menu={{
        items: [
          { key: 'rename', label: '重命名', onClick: ({ domEvent }) => { domEvent.stopPropagation(); renameCategory(); } },
          { key: 'delete', label: '删除', danger: true, onClick: ({ domEvent }) => { domEvent.stopPropagation(); removeCategory(); } },
        ],
      }} trigger={['click']}>
        <span onClick={e => e.stopPropagation()} style={{
          width: 20, height: 20, display: 'grid', placeItems: 'center',
          borderRadius: 4, cursor: 'pointer', color: 'var(--fg-4)',
        }}>
          <MoreVertical size={13} />
        </span>
      </Dropdown>
    </div>
  );
}

const outlineSmallButtonStyle: React.CSSProperties = {
  height: 30,
  padding: '0 13px',
  borderRadius: 6,
  border: '1px solid var(--border-1)',
  background: '#fff',
  color: 'var(--fg-2)',
  font: '600 12px var(--font-sans)',
  cursor: 'pointer',
};

const statCardStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 20,
  padding: '24px 22px',
  borderRadius: 8,
  background: 'var(--n-50)',
};

const infoLineStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minHeight: 26,
  font: 'var(--type-body)',
  color: 'var(--fg-2)',
};

const infoLabelStyle: React.CSSProperties = {
  color: 'var(--fg-3)',
  flexShrink: 0,
};

const settingLineStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  font: 'var(--type-body)',
  color: 'var(--fg-2)',
};

const inlineAddButtonStyle: React.CSSProperties = {
  width: 26,
  height: 26,
  border: 0,
  background: 'transparent',
  color: 'var(--fg-1)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  borderRadius: 6,
  padding: 0,
  font: '700 20px/1 var(--font-sans)',
};

const treeInputStyle: React.CSSProperties = {
  width: '100%',
  height: 34,
  padding: '0 10px',
  borderRadius: 8,
  border: '1px solid var(--border-focus)',
  background: '#fff',
  color: 'var(--fg-1)',
  font: 'var(--type-body)',
  outline: 'none',
  boxShadow: 'var(--shadow-focus)',
};

function treeItemStyle(active: boolean): React.CSSProperties {
  return {
    height: 38,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 12px',
    borderRadius: 8,
    cursor: 'pointer',
    background: active ? 'var(--n-100)' : 'transparent',
    color: active ? 'var(--fg-1)' : 'var(--fg-2)',
    font: active ? '700 13px var(--font-sans)' : 'var(--type-body)',
  };
}

const tagRowStyle: React.CSSProperties = {
  minHeight: 28,
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  font: 'var(--type-body)',
  color: 'var(--fg-2)',
};

const categoryInputRowStyle: React.CSSProperties = {
  minHeight: 28,
  display: 'flex',
  alignItems: 'center',
  gap: 14,
};

const categoryInputStyle: React.CSSProperties = {
  flex: 1,
  height: 34,
  padding: '0 12px',
  borderRadius: 6,
  border: '1px solid var(--border-focus)',
  outline: 'none',
  background: '#fff',
  color: 'var(--fg-1)',
  font: 'var(--type-body)',
  boxShadow: 'var(--shadow-focus)',
};
