import { useState, useEffect } from 'react';
import { Tag as AntTag, Input, message, Popover, Button } from 'antd';
import { Plus } from 'lucide-react';
import type { Tag } from 'shared/types';
import { getTags, createTag } from '@/api/tags';

interface Props {
  value?: number[];
  onChange?: (tagIds: number[]) => void;
  editable?: boolean;
}

export default function TagSelect({ value = [], onChange, editable = false }: Props) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [newName, setNewName] = useState('');
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    getTags().then(setTags).catch(() => {});
  }, []);

  const handleToggle = (tagId: number) => {
    if (!onChange) return;
    if (value.includes(tagId)) {
      onChange(value.filter((id) => id !== tagId));
    } else {
      onChange([...value, tagId]);
    }
  };

  const handleAdd = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    try {
      const tag = await createTag({ name: trimmed });
      setTags([...tags, tag]);
      setNewName('');
      setAddOpen(false);
      message.success('标签已创建');
    } catch {
      message.error('创建失败');
    }
  };

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      {tags.map((tag) => (
        <AntTag
          key={tag.id}
          color={value.includes(tag.id) ? tag.color : undefined}
          style={{
            cursor: 'pointer',
            borderColor: value.includes(tag.id) ? tag.color : 'var(--border-1)',
          }}
          onClick={() => handleToggle(tag.id)}
        >
          {tag.name}
        </AntTag>
      ))}

      {editable && (
        <Popover
          open={addOpen}
          onOpenChange={setAddOpen}
          trigger="click"
          content={
            <div style={{ display: 'flex', gap: 8 }}>
              <Input
                size="small"
                placeholder="标签名称"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onPressEnter={handleAdd}
                style={{ width: 120 }}
                autoFocus
              />
              <Button size="small" type="primary" onClick={handleAdd}>
                添加
              </Button>
            </div>
          }
        >
          <AntTag
            style={{ cursor: 'pointer', borderStyle: 'dashed' }}
          >
            <Plus size={12} /> 新标签
          </AntTag>
        </Popover>
      )}
    </div>
  );
}
