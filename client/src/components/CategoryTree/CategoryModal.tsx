import { useState, useEffect } from 'react';
import { Modal, Input, message } from 'antd';
import type { Category } from 'shared/types';
import useCategoryStore from '@/store/categoryStore';

interface Props {
  open: boolean;
  editingCategory: Category | null;
  parentId: number | null;
  onClose: () => void;
}

export default function CategoryModal({ open, editingCategory, parentId, onClose }: Props) {
  const { addCategory, editCategory } = useCategoryStore();
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setName(editingCategory?.name || '');
    }
  }, [open, editingCategory]);

  const isEditing = !!editingCategory;
  const title = isEditing ? '重命名分类' : parentId ? '新建子分类' : '创建分类';

  const handleOk = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      message.warning('请输入分类名称');
      return;
    }

    setLoading(true);
    try {
      if (isEditing) {
        await editCategory(editingCategory!.id, { name: trimmed });
        message.success('重命名成功');
      } else {
        await addCategory({ name: trimmed, parentId });
        message.success('创建成功');
      }
      onClose();
    } catch {
      message.error(isEditing ? '重命名失败' : '创建失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title={title}
      open={open}
      onOk={handleOk}
      onCancel={onClose}
      confirmLoading={loading}
      okText={isEditing ? '保存' : '确认'}
      cancelText="取消"
      destroyOnClose
    >
      <div style={{ padding: '12px 0' }}>
        <Input
          placeholder="请输入分类名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onPressEnter={handleOk}
          autoFocus
          size="large"
        />
      </div>
    </Modal>
  );
}
