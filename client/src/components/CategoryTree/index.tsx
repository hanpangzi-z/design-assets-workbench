import React, { useState } from 'react';
import { Tree, Input, Button, Modal, Dropdown } from 'antd';
import type { TreeDataNode } from 'antd';
import { Folder, FolderPlus, Pencil, Trash2, MoreHorizontal } from 'lucide-react';
import type { Category } from 'shared/types';
import useCategoryStore from '@/store/categoryStore';
import CategoryModal from './CategoryModal';

interface Props {
  categories: Category[];
  onSelect?: (category: Category) => void;
  editable?: boolean;
}

function categoriesToTreeData(cats: Category[]): TreeDataNode[] {
  return cats.map((c) => ({
    key: c.id,
    title: c.name,
    children: c.children?.length ? categoriesToTreeData(c.children) : undefined,
    isLeaf: !c.children?.length,
  }));
}

export default function CategoryTree({ categories, onSelect, editable = false }: Props) {
  const { editCategory, removeCategory } = useCategoryStore();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [parentId, setParentId] = useState<number | null>(null);

  const handleSelect = (selectedKeys: React.Key[]) => {
    if (selectedKeys.length === 0 || !onSelect) return;
    const findCat = (cats: Category[], id: number): Category | undefined => {
      for (const c of cats) {
        if (c.id === id) return c;
        if (c.children) {
          const found = findCat(c.children, id);
          if (found) return found;
        }
      }
      return undefined;
    };
    const cat = findCat(categories, selectedKeys[0] as number);
    if (cat) onSelect(cat);
  };

  const handleDelete = (cat: Category) => {
    Modal.confirm({
      title: '删除分类',
      content: `确定要删除「${cat.name}」及其所有子分类吗？`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => removeCategory(cat.id),
    });
  };

  const treeData = categoriesToTreeData(categories);

  const titleRender = (nodeData: TreeDataNode) => {
    const catId = nodeData.key as number;
    const catName = nodeData.title as string;
    const findCat = (cats: Category[], id: number): Category | undefined => {
      for (const c of cats) {
        if (c.id === id) return c;
        if (c.children) {
          const found = findCat(c.children, id);
          if (found) return found;
        }
      }
      return undefined;
    };
    const cat = findCat(categories, catId);

    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '2px 0' }}>
        <Folder size={14} style={{ color: 'var(--fg-3)', flexShrink: 0 }} />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {catName}
        </span>
        {editable && cat && (
          <Dropdown
            menu={{
              items: [
                {
                  key: 'add-child',
                  label: '新建子分类',
                  icon: <FolderPlus size={14} />,
                  onClick: () => { setParentId(cat.id); setEditingCategory(null); setModalOpen(true); },
                },
                {
                  key: 'rename',
                  label: '重命名',
                  icon: <Pencil size={14} />,
                  onClick: () => { setEditingCategory(cat); setParentId(null); setModalOpen(true); },
                },
                { type: 'divider' as const },
                {
                  key: 'delete',
                  label: '删除',
                  icon: <Trash2 size={14} />,
                  danger: true,
                  onClick: () => handleDelete(cat),
                },
              ],
            }}
            trigger={['click']}
          >
            <span
              onClick={(e) => e.stopPropagation()}
              style={{
                width: 20, height: 20, display: 'grid', placeItems: 'center',
                borderRadius: 4, cursor: 'pointer', color: 'var(--fg-4)',
                opacity: 0,
                transition: 'opacity .12s',
              }}
              className="cat-tree-action"
            >
              <MoreHorizontal size={14} />
            </span>
          </Dropdown>
        )}
      </div>
    );
  };

  return (
    <div>
      <style>{`
        .cat-tree .ant-tree-treenode:hover .cat-tree-action { opacity: 1 !important; }
      `}</style>
      <Tree
        className="cat-tree"
        treeData={treeData}
        onSelect={handleSelect}
        titleRender={titleRender}
        defaultExpandAll
        blockNode
        style={{ background: 'transparent' }}
      />

      {editable && (
        <Button
          type="dashed"
          size="small"
          onClick={() => { setParentId(null); setEditingCategory(null); setModalOpen(true); }}
          style={{ marginTop: 8, width: '100%' }}
          icon={<FolderPlus size={14} />}
        >
          新建分类
        </Button>
      )}

      <CategoryModal
        open={modalOpen}
        editingCategory={editingCategory}
        parentId={parentId}
        onClose={() => { setModalOpen(false); setEditingCategory(null); setParentId(null); }}
      />
    </div>
  );
}
