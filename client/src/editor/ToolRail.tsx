import React from 'react';
import { Image, Layers, ListTree, Plus, Square, Type, UserRound } from 'lucide-react';
import useEditorStore, { type ActiveTool } from '@/store/editorStore';

export type EditorPanelKey = 'add' | 'templates' | 'text' | 'shapes' | 'images' | 'mine' | 'layers';

interface Props {
  activePanel: EditorPanelKey;
  onPanelChange: (panel: EditorPanelKey) => void;
}

const TOOLS: Array<{ key: EditorPanelKey; icon: React.ElementType; label: string; tool?: ActiveTool }> = [
  { key: 'add', icon: Plus, label: '添加', tool: 'select' },
  { key: 'templates', icon: Layers, label: '模板', tool: 'select' },
  { key: 'text', icon: Type, label: '文字', tool: 'text' },
  { key: 'shapes', icon: Square, label: '形状', tool: 'shape' },
  { key: 'images', icon: Image, label: '图片', tool: 'image' },
  { key: 'mine', icon: UserRound, label: '我的', tool: 'select' },
  { key: 'layers', icon: ListTree, label: '图层', tool: 'select' },
];

export default function ToolRail({ activePanel, onPanelChange }: Props) {
  const { setActiveTool } = useEditorStore();

  return (
    <div style={{
      width: 54,
      background: '#fff',
      borderRight: '1px solid #eceff3',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      padding: '8px 0',
      gap: 4,
      flexShrink: 0,
    }}>
      {TOOLS.map((tool) => {
        const active = activePanel === tool.key;
        return (
          <button
            key={tool.key}
            title={tool.label}
            onClick={() => {
              onPanelChange(tool.key);
              if (tool.tool) setActiveTool(tool.tool);
            }}
            style={{
              width: 46,
              minHeight: 50,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 3,
              background: active ? '#eef1f3' : 'transparent',
              color: active ? '#111827' : '#4b5563',
              border: 'none',
              borderRadius: 10,
              cursor: 'pointer',
              transition: 'all .12s',
            }}
          >
            <tool.icon size={18} />
            <span style={{
              maxWidth: 42,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              font: '700 11px var(--font-sans)',
            }}>
              {tool.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
