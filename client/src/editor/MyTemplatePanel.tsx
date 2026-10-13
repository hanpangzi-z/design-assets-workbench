import { useEffect, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { Empty, Spin } from 'antd';
import { ExternalLink, Search, X } from 'lucide-react';
import { getFileById, getFiles } from '@/api/files';
import Thumb from '@/components/FileCard/Thumb';
import type { DesignFile } from 'shared/types';

const MY_TEMPLATE_THUMB_HEIGHT = 78;

interface MyTemplatePanelProps {
  onTemplateSelect?: (template: DesignFile) => void;
}

export default function MyTemplatePanel({ onTemplateSelect }: MyTemplatePanelProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<DesignFile[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      getFiles({
        scope: 'my',
        myView: 'space',
        keyword: query.trim() || undefined,
        page: 1,
        pageSize: 200,
        sortBy: 'updated_at',
        sortOrder: 'desc',
      })
        .then((data) => {
          if (!cancelled) setFiles(data.list || []);
        })
        .catch(() => {
          if (!cancelled) setFiles([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  return (
    <aside style={panelStyle}>
      <div style={panelHeaderStyle}>
        <button type="button" onClick={() => navigate('/my')} style={titleButtonStyle}>
          我的空间
          <ExternalLink size={13} />
        </button>
      </div>

      <div style={searchBoxStyle}>
        <Search size={16} style={{ color: '#9aa1aa', flexShrink: 0 }} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索我的模板"
          style={searchInputStyle}
        />
        {query && (
          <button type="button" onClick={() => setQuery('')} style={clearSearchStyle} title="清空">
            <X size={14} />
          </button>
        )}
      </div>

      <div style={listStyle}>
        {loading ? (
          <div style={loadingStyle}><Spin size="small" /></div>
        ) : files.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无我的模板" />
        ) : (
          <div style={gridStyle}>
            {files.map((file) => (
              <button
                key={file.id}
                type="button"
                onClick={async () => {
                  const inspectedFile = onTemplateSelect
                    ? await getFileById(file.id).catch(() => file)
                    : file;

                  if (onTemplateSelect && !isMultiBoardTemplate(inspectedFile)) {
                    onTemplateSelect(inspectedFile);
                    return;
                  }
                  navigate(`/editor/${inspectedFile.id}`);
                }}
                style={cardStyle}
                title={file.name}
              >
                <div style={thumbWrapStyle}>
                  <Thumb
                    thumbnailUrl={file.thumbnailPath}
                    fileType={file.fileType}
                    label={file.name?.charAt(0)}
                    file={file}
                    name={file.name}
                    height={MY_TEMPLATE_THUMB_HEIGHT}
                    showBadge={false}
                  />
                  <span style={badgeStyle}>{getFileBadge(file)}</span>
                </div>
                <span style={nameStyle}>{file.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function getFileBadge(file: DesignFile): string {
  if (file.fileType === 'psd' || file.fileType === 'ai' || file.fileType === 'pdf') return file.fileType.toUpperCase();
  return '图片';
}

function isMultiBoardTemplate(file: DesignFile) {
  const parseResult = file.parseResult as Record<string, unknown> | undefined;
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
  height: 30,
  marginBottom: 14,
};

const titleButtonStyle: CSSProperties = {
  border: 0,
  background: 'transparent',
  color: '#111827',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: 0,
  font: '800 14px var(--font-sans)',
  cursor: 'pointer',
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

const listStyle: CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  paddingBottom: 18,
};

const loadingStyle: CSSProperties = {
  height: 160,
  display: 'grid',
  placeItems: 'center',
};

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 10,
};

const cardStyle: CSSProperties = {
  border: 0,
  background: 'transparent',
  padding: 0,
  textAlign: 'left',
  cursor: 'pointer',
};

const thumbWrapStyle: CSSProperties = {
  position: 'relative',
  height: MY_TEMPLATE_THUMB_HEIGHT,
  borderRadius: 8,
  overflow: 'hidden',
  background: '#f4f6f8',
  border: '1px solid #eef1f3',
};

const badgeStyle: CSSProperties = {
  position: 'absolute',
  left: 5,
  bottom: 5,
  padding: '1px 5px',
  borderRadius: 999,
  background: 'rgba(17, 24, 39, .56)',
  color: '#fff',
  font: '700 10px var(--font-sans)',
};

const nameStyle: CSSProperties = {
  display: 'block',
  minWidth: 0,
  marginTop: 6,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: '#374151',
  textAlign: 'center',
  font: '600 12px var(--font-sans)',
};
