import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Plus, Info, Trash2, RotateCcw, Pin, PinOff } from 'lucide-react';
import { Modal, Input, message, Spin } from 'antd';
import api from '@/api/index';
import { clearLibrariesCache, getLibraries } from '@/api/libraries';
import useAuthStore from '@/store/authStore';
import { isLibraryPinned, sortLibrariesByPin } from '@/utils/librarySort';

interface LibraryItem {
  id: number;
  name: string;
  description: string | null;
  templateCount: number;
  materialCount: number;
  owner?: { id: number; displayName: string };
  isPinned?: boolean | number | string | null;
  pinnedAt?: string | Date | null;
}

export default function LibrariesPage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const [libraries, setLibraries] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [query, setQuery] = useState('');
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashLibraries, setTrashLibraries] = useState<LibraryItem[]>([]);
  const [hoveredLibraryId, setHoveredLibraryId] = useState<number | null>(null);
  const [pinLoadingId, setPinLoadingId] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      setLibraries(sortLibrariesByPin(await getLibraries<LibraryItem>({ force: true })));
    } catch {}
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) { message.warning('请输入资源库名称'); return; }
    try {
      await api.post('/libraries', { name, description: newDescription.trim() || undefined });
      clearLibrariesCache();
      message.success('创建成功');
      setCreateOpen(false);
      setNewName('');
      setNewDescription('');
      await load();
    } catch { message.error('创建失败'); }
  };

  const handleDelete = (lib: LibraryItem) => {
    Modal.confirm({
      title: '删除资源库',
      content: `确定删除「${lib.name}」？库内资源不会被删除。`,
      okText: '删除', okButtonProps: { danger: true }, cancelText: '取消',
      onOk: async () => {
        try {
          await api.delete(`/libraries/${lib.id}`);
          clearLibrariesCache();
          message.success('已删除');
          await load();
        } catch { message.error('删除失败'); }
      },
    });
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

  const handleRestore = async (lib: LibraryItem) => {
    try {
      await api.patch(`/libraries/${lib.id}/restore`);
      clearLibrariesCache();
      message.success('已恢复');
      await loadTrash();
      await load();
    } catch {
      message.error('恢复失败');
    }
  };

  const handlePermanentDelete = async (lib: LibraryItem) => {
    setTrashLoading(true);
    try {
      await api.delete(`/libraries/${lib.id}/permanent`);
      clearLibrariesCache();
      message.success('已删除');
      await loadTrash();
      await load();
    } catch (err: any) {
      message.error(err?.response?.data?.message || '删除失败');
    } finally {
      setTrashLoading(false);
    }
  };

  const showInfo = (lib: LibraryItem) => {
    Modal.info({
      title: lib.name,
      content: (
        <div style={{ lineHeight: 1.8 }}>
          <div>库主：{lib.owner?.displayName || '-'}</div>
          <div>模板：{lib.templateCount}</div>
          <div>素材：{lib.materialCount}</div>
          <div>简介：{lib.description || '暂无简介'}</div>
        </div>
      ),
      okText: '知道了',
    });
  };

  const handleTogglePin = async (lib: LibraryItem) => {
    const nextPinned = !isLibraryPinned(lib.isPinned);
    setPinLoadingId(lib.id);
    try {
      const res = await api.patch(`/libraries/${lib.id}/pin`, { isPinned: nextPinned });
      const updated: LibraryItem | undefined = res.data?.data;
      clearLibrariesCache();
      setLibraries((current) => sortLibrariesByPin(current.map((item) => (
        item.id === lib.id
          ? {
              ...item,
              ...(updated || {}),
              isPinned: updated?.isPinned ?? nextPinned,
              pinnedAt: updated?.pinnedAt ?? (nextPinned ? new Date().toISOString() : null),
            }
          : item
      ))));
      message.success(nextPinned ? '已置顶' : '已取消置顶');
    } catch (err: any) {
      message.error(err?.response?.data?.message || '置顶失败');
    } finally {
      setPinLoadingId(null);
    }
  };

  const filtered = query ? libraries.filter(l => l.name.includes(query)) : libraries;

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '24px 32px' }}>
      {/* 标题 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h2 style={{ font: 'var(--type-h2)', color: 'var(--fg-1)' }}>资源库管理</h2>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            height: 32, padding: '0 10px', border: '1px solid var(--border-1)',
            borderRadius: 6, background: '#fff', width: 200,
          }}>
            <Search size={14} style={{ color: 'var(--fg-3)' }} />
            <input placeholder="搜索资源库" value={query} onChange={e => setQuery(e.target.value)}
              style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', font: 'var(--type-body)', color: 'var(--fg-1)' }} />
          </div>
          <button onClick={() => setCreateOpen(true)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '0 16px', height: 32, borderRadius: 6,
            border: 'none', background: 'var(--brand-teal-500)', color: '#fff',
            font: '500 13px var(--font-sans)', cursor: 'pointer',
          }}>
            <Plus size={14} /> 新建资源库
          </button>
          <button onClick={openTrash} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '0 12px', height: 32, borderRadius: 6,
            border: '1px solid var(--border-1)', background: '#fff', color: 'var(--fg-2)',
            font: '500 13px var(--font-sans)', cursor: 'pointer',
          }}>
            <Trash2 size={14} /> 回收站
          </button>
        </div>
      </div>

      {/* 表头 */}
      <div style={{
        display: 'grid', gridTemplateColumns: '2fr 1fr 1fr',
        padding: '10px 16px', background: 'var(--n-50)', borderRadius: '8px 8px 0 0',
        font: 'var(--type-caption)', color: 'var(--fg-3)',
      }}>
        <span>基本信息</span><span>库主</span><span>操作</span>
      </div>

      {/* 列表 */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 48 }}><Spin /></div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 48, color: 'var(--fg-4)' }}>暂无资源库</div>
      ) : (
        filtered.map(lib => (
          <div
            key={lib.id}
            onMouseEnter={() => setHoveredLibraryId(lib.id)}
            onMouseLeave={() => setHoveredLibraryId((current) => (current === lib.id ? null : current))}
            style={{
            display: 'grid', gridTemplateColumns: '2fr 1fr 1fr',
            padding: '16px', borderBottom: '1px solid var(--border-2)',
            background: hoveredLibraryId === lib.id ? 'var(--n-50)' : '#fff', alignItems: 'center',
          }}>
            {/* 基本信息 */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ font: '600 15px var(--font-sans)', color: 'var(--fg-1)' }}>{lib.name}</span>
                <Info size={14} onClick={() => showInfo(lib)} style={{ color: 'var(--fg-4)', cursor: 'pointer' }} />
                <button
                  type="button"
                  title={isLibraryPinned(lib.isPinned) ? '取消置顶' : '置顶'}
                  aria-label={isLibraryPinned(lib.isPinned) ? '取消置顶' : '置顶'}
                  disabled={pinLoadingId === lib.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleTogglePin(lib);
                  }}
                  style={pinButtonStyle(hoveredLibraryId === lib.id, isLibraryPinned(lib.isPinned), pinLoadingId === lib.id)}
                >
                  {isLibraryPinned(lib.isPinned) ? <PinOff size={13} /> : <Pin size={13} />}
                </button>
              </div>
              <div style={{ font: 'var(--type-caption)', color: 'var(--fg-3)', marginTop: 4 }}>
                模板{lib.templateCount}  素材{lib.materialCount}
              </div>
            </div>

            {/* 库主 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{
                width: 24, height: 24, borderRadius: '50%', background: 'var(--n-200)',
                display: 'grid', placeItems: 'center', font: '500 11px var(--font-sans)', color: 'var(--fg-3)',
              }}>
                {lib.owner?.displayName?.charAt(0) || '?'}
              </div>
              <span style={{ font: 'var(--type-body)', color: 'var(--fg-2)' }}>
                {lib.owner?.displayName || '-'}
              </span>
            </div>

            {/* 操作 */}
            <div style={{ display: 'flex', gap: 16, font: 'var(--type-body)' }}>
              <span onClick={() => navigate(`/admin/libraries/${lib.id}`)} style={{ color: 'var(--brand-teal-500)', cursor: 'pointer' }}>库管理</span>
              <span onClick={() => navigate('/admin/resources')} style={{ color: 'var(--brand-teal-500)', cursor: 'pointer' }}>企业资源管理</span>
              <span onClick={() => handleDelete(lib)} style={{ color: 'var(--color-danger-fg)', cursor: 'pointer' }}>移入回收站</span>
            </div>
          </div>
        ))
      )}

      {/* 底部 */}
      {filtered.length > 0 && (
        <div style={{ textAlign: 'center', padding: 16, color: 'var(--fg-4)', font: 'var(--type-caption)' }}>
          已全部加载完成
        </div>
      )}

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
            {trashLibraries.map((lib) => (
              <div key={lib.id} style={{
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
                  <div style={{ font: '600 14px var(--font-sans)', color: 'var(--fg-1)' }}>{lib.name}</div>
                  <div style={{ font: 'var(--type-caption)', color: 'var(--fg-3)', marginTop: 4 }}>
                    库主：{lib.owner?.displayName || '-'} · 模板 {lib.templateCount} · 素材 {lib.materialCount}
                  </div>
                </div>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <button
                    onClick={() => handleRestore(lib)}
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
                    onClick={() => handlePermanentDelete(lib)}
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

      {/* 新建弹窗 */}
      <Modal title="新建资源库" open={createOpen} onOk={handleCreate} onCancel={() => setCreateOpen(false)} okText="创建" cancelText="取消">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '12px 0' }}>
          <Input placeholder="资源库名称" value={newName} onChange={e => setNewName(e.target.value)} onPressEnter={handleCreate} autoFocus size="large" />
          <Input.TextArea placeholder="资源库简介（可选）" value={newDescription} onChange={e => setNewDescription(e.target.value)} rows={3} />
        </div>
      </Modal>
    </div>
  );
}

function pinButtonStyle(visible: boolean, pinned: boolean, loading: boolean): React.CSSProperties {
  return {
    width: 22,
    height: 22,
    display: 'inline-grid',
    placeItems: 'center',
    border: pinned ? '1px solid rgba(37, 99, 235, 0.28)' : '1px solid var(--border-1)',
    borderRadius: '50%',
    background: pinned ? 'rgba(37, 99, 235, 0.08)' : '#fff',
    color: pinned ? 'var(--brand-teal-600)' : 'var(--fg-3)',
    cursor: loading ? 'not-allowed' : 'pointer',
    opacity: visible ? (loading ? 0.58 : 1) : 0,
    pointerEvents: visible && !loading ? 'auto' : 'none',
    transition: 'opacity .12s ease, background .12s ease, color .12s ease',
  };
}
