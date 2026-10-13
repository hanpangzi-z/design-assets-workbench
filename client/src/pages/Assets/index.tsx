import React, { useEffect, useState, useCallback } from 'react';
import { useOutletContext, useNavigate } from 'react-router-dom';
import { Pagination, Empty, Spin } from 'antd';
import { Grid2x2, List, Search, Download } from 'lucide-react';
import useFileStore from '@/store/fileStore';
import useCategoryStore from '@/store/categoryStore';
import useAuthStore from '@/store/authStore';
import FileCard from '@/components/FileCard';
import PermissionGate from '@/components/common/PermissionGate';
import { useAutoRefreshPendingParses } from '@/hooks/useAutoRefreshPendingParses';

const DIM_LABELS: Record<string, string> = {
  festival: '节日',
  design_type: '设计类型',
  product_type: '品类',
  version: '版本',
};

export default function AssetsPage() {
  const navigate = useNavigate();
  let openUpload: (() => void) | undefined;
  try {
    const ctx = useOutletContext<{ openUpload: () => void }>();
    openUpload = ctx?.openUpload;
  } catch {
    // context not available
  }

  const files = useFileStore((s) => s.files);
  const total = useFileStore((s) => s.total);
  const page = useFileStore((s) => s.page);
  const pageSize = useFileStore((s) => s.pageSize);
  const isLoading = useFileStore((s) => s.isLoading);
  const fetchFiles = useFileStore((s) => s.fetchFiles);
  const setPage = useFileStore((s) => s.setPage);
  const setFilters = useFileStore((s) => s.setFilters);

  const dimensionCategories = useCategoryStore((s) => s.dimensionCategories);
  const fetchCategories = useCategoryStore((s) => s.fetchAll);

  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [dimFilter, setDimFilter] = useState<Record<string, string[]>>({});
  const [loaded, setLoaded] = useState(false);
  const permissions = useAuthStore((s) => s.permissions);
  const canManageResourceLibrary = Boolean(permissions?.manage_categories);

  useEffect(() => {
    if (!loaded) {
      fetchFiles();
      fetchCategories().catch(() => {});
      setLoaded(true);
    }
  }, [loaded, fetchFiles, fetchCategories]);
  useAutoRefreshPendingParses(files, fetchFiles);

  const handleSearch = useCallback(() => {
    setFilters({ keyword: query || undefined });
  }, [query, setFilters]);

  const toggleDimTag = (dimKey: string, tag: string) => {
    setDimFilter((prev) => {
      const current = prev[dimKey] || [];
      const next = current.includes(tag)
        ? current.filter((t) => t !== tag)
        : [...current, tag];
      return { ...prev, [dimKey]: next };
    });
  };

  const clearDim = (dimKey: string) => {
    setDimFilter((prev) => ({ ...prev, [dimKey]: [] }));
  };

  const formatFileSize = (bytes: number): string => {
    const n = Number(bytes);
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  };

  return (
    <div style={{ padding: '0 24px 32px' }}>
      {/* 顶部搜索栏 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '16px 0', borderBottom: '1px solid var(--border-2)',
      }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '4px 12px', borderRadius: 6,
          background: 'var(--brand-teal-50)', color: 'var(--brand-teal-600)',
          font: '500 13px var(--font-sans)',
        }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--brand-teal-500)' }} />
          来福商城
        </span>
        <div style={{ flex: 1 }} />
        {canManageResourceLibrary && (
          <>
            <span style={{ font: 'var(--type-caption)', color: 'var(--fg-3)', cursor: 'pointer' }}>资源库信息</span>
            <span onClick={() => navigate('/admin/resources')} style={{
              padding: '4px 12px', borderRadius: 6,
              border: '1px solid var(--border-1)', background: '#fff',
              font: '500 12px var(--font-sans)', color: 'var(--fg-2)', cursor: 'pointer',
            }}>管理</span>
          </>
        )}
        <PermissionGate permission="upload">
          <button
            onClick={() => openUpload?.()}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '0 16px', height: 34, borderRadius: 6,
              background: 'var(--brand-teal-500)', color: '#fff',
              border: 'none', cursor: 'pointer', font: '500 13px var(--font-sans)',
            }}
          >上传</button>
        </PermissionGate>
      </div>

      {/* 多维度筛选 — 从 API 动态加载 */}
      {Object.entries(dimensionCategories).map(([dimKey, cats]) => (
        <div key={dimKey} style={{
          display: 'flex', alignItems: 'flex-start', gap: 12,
          padding: '10px 0', borderBottom: '1px solid var(--border-2)',
        }}>
          <span style={{ font: 'var(--type-label)', color: 'var(--fg-3)', minWidth: 56, paddingTop: 4 }}>
            {DIM_LABELS[dimKey] || dimKey}
          </span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <span
              onClick={() => clearDim(dimKey)}
              style={{
                display: 'inline-flex', alignItems: 'center',
                height: 26, padding: '0 10px', borderRadius: 4,
                border: `1px solid ${!(dimFilter[dimKey]?.length) ? 'var(--brand-teal-500)' : 'var(--border-1)'}`,
                background: !(dimFilter[dimKey]?.length) ? 'var(--brand-teal-50)' : '#fff',
                color: !(dimFilter[dimKey]?.length) ? 'var(--brand-teal-600)' : 'var(--fg-2)',
                font: '500 12px var(--font-sans)', cursor: 'pointer',
              }}
            >全部</span>
            {cats.map((cat) => {
              const active = dimFilter[dimKey]?.includes(cat.name);
              return (
                <span
                  key={cat.id}
                  onClick={() => toggleDimTag(dimKey, cat.name)}
                  style={{
                    display: 'inline-flex', alignItems: 'center',
                    height: 26, padding: '0 10px', borderRadius: 4,
                    border: `1px solid ${active ? 'var(--brand-teal-500)' : 'transparent'}`,
                    background: active ? 'var(--brand-teal-50)' : 'transparent',
                    color: active ? 'var(--brand-teal-600)' : 'var(--fg-2)',
                    font: '400 12px var(--font-sans)', cursor: 'pointer',
                    transition: 'all .12s',
                  }}
                >{cat.name}</span>
              );
            })}
          </div>
        </div>
      ))}

      {/* Tab + 操作栏 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '14px 0',
      }}>
        {/* Tabs */}
        {['全部', '作品', '上传的'].map((tab, i) => (
          <span key={tab} style={{
            font: i === 0 ? '500 14px var(--font-sans)' : 'var(--type-body)',
            color: i === 0 ? 'var(--fg-1)' : 'var(--fg-3)',
            cursor: 'pointer',
            borderBottom: i === 0 ? '2px solid var(--brand-teal-500)' : 'none',
            paddingBottom: 4,
          }}>
            {tab}{i === 0 ? ` (${total})` : ''}
          </span>
        ))}
        <div style={{ flex: 1 }} />

        {/* 搜索 */}
        <div style={{ position: 'relative', width: 220 }}>
          <Search size={14} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--fg-4)' }} />
          <input
            placeholder="搜索..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            style={{
              width: '100%', height: 30, paddingLeft: 28, paddingRight: 8,
              border: '1px solid var(--border-1)', borderRadius: 5,
              font: 'var(--type-caption)', color: 'var(--fg-1)', outline: 'none',
            }}
          />
        </div>

        {/* 视图切换 */}
        <div style={{ display: 'flex', border: '1px solid var(--border-1)', borderRadius: 5 }}>
          <span
            onClick={() => setView('grid')}
            style={{
              width: 28, height: 28, display: 'grid', placeItems: 'center', cursor: 'pointer',
              background: view === 'grid' ? 'var(--n-100)' : 'transparent',
              color: view === 'grid' ? 'var(--fg-1)' : 'var(--fg-4)',
            }}
          ><Grid2x2 size={14} /></span>
          <span
            onClick={() => setView('list')}
            style={{
              width: 28, height: 28, display: 'grid', placeItems: 'center', cursor: 'pointer',
              background: view === 'list' ? 'var(--n-100)' : 'transparent',
              color: view === 'list' ? 'var(--fg-1)' : 'var(--fg-4)',
            }}
          ><List size={14} /></span>
        </div>
      </div>

      {/* 文件列表 */}
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin size="large" />
        </div>
      ) : files.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '64px 0' }}>
          <Empty description={
            <div>
              <div style={{ font: 'var(--type-body)', color: 'var(--fg-3)', marginBottom: 12 }}>暂无素材</div>
              <PermissionGate permission="upload">
                <button
                  onClick={() => openUpload?.()}
                  style={{
                    padding: '0 20px', height: 36, borderRadius: 6,
                    background: 'var(--brand-teal-500)', color: '#fff',
                    border: 'none', cursor: 'pointer', font: '500 14px var(--font-sans)',
                  }}
                >上传第一个素材</button>
              </PermissionGate>
            </div>
          } />
        </div>
      ) : view === 'grid' ? (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: '28px 24px',
        }}>
          {files.map((file) => (
            <FileCard
              key={file.id}
              file={file}
              selected={selectedId === file.id}
              onClick={() => setSelectedId(file.id)}
              onDoubleClick={() => navigate(`/editor/${file.id}`)}
            />
          ))}
        </div>
      ) : (
        <div>
          <div style={{
            display: 'grid', gridTemplateColumns: '44px 2.5fr 1fr 1fr 1fr 100px',
            padding: '8px 12px', background: 'var(--n-50)', borderRadius: 6,
            font: 'var(--type-caption)', color: 'var(--fg-3)',
          }}>
            <span></span><span>名称</span><span>类型</span><span>大小</span><span>上传者</span><span>操作</span>
          </div>
          {files.map((file) => {
            const uploader = (file as unknown as { uploader?: { displayName?: string } }).uploader;
            return (
              <div key={file.id}
                onClick={() => setSelectedId(file.id)}
                onDoubleClick={() => navigate(`/editor/${file.id}`)}
                style={{
                  display: 'grid', gridTemplateColumns: '44px 2.5fr 1fr 1fr 1fr 100px',
                  padding: '10px 12px', borderBottom: '1px solid var(--border-2)',
                  font: 'var(--type-body)', color: 'var(--fg-2)',
                  cursor: 'pointer',
                  background: selectedId === file.id ? 'var(--bg-selected)' : 'transparent',
                }}
              >
                {/* 缩略图小方块 */}
                <div style={{
                  width: 32, height: 32, borderRadius: 4,
                  background: 'var(--n-100)', display: 'grid', placeItems: 'center',
                  font: '500 10px var(--font-sans)', color: 'var(--fg-3)',
                  textTransform: 'uppercase',
                }}>{file.fileType}</div>
                <span style={{ color: 'var(--fg-1)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', alignSelf: 'center' }}>{file.name}</span>
                <span style={{ textTransform: 'uppercase', alignSelf: 'center' }}>{file.fileType}</span>
                <span style={{ alignSelf: 'center' }}>{formatFileSize(file.fileSize)}</span>
                <span style={{ alignSelf: 'center' }}>{uploader?.displayName || '-'}</span>
                <span style={{ color: 'var(--brand-teal-500)', cursor: 'pointer', alignSelf: 'center', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Download size={13} /> 下载
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* 分页 */}
      {total > pageSize && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 24 }}>
          <Pagination
            current={page}
            pageSize={pageSize}
            total={total}
            onChange={(p) => setPage(p)}
            showSizeChanger={false}
          />
        </div>
      )}
    </div>
  );
}
