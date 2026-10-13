import React, { useEffect, useMemo, useState } from 'react';
import { Button, Input, message, Modal, Select, Switch, Table, Tag } from 'antd';
import { UserPlus } from 'lucide-react';
import api from '@/api/index';
import useAuthStore from '@/store/authStore';

interface UserRow {
  id: number;
  username: string;
  displayName: string;
  departmentPath?: string;
  departmentLevels?: Record<string, { id?: string | number; name?: string }>;
  employeeNo?: string;
  email?: string;
  roleId: number;
  isActive: number | boolean;
  role?: { name: string; displayName: string };
  createdAt: string;
  lastLoginAt: string | null;
}

interface RoleOption {
  id: number;
  name: string;
  displayName: string;
  assignable?: boolean;
}

const TEXT = {
  superAdmin: '\u8d85\u7ea7\u7ba1\u7406\u5458',
  admin: '\u7ba1\u7406\u5458',
  designer: '\u8bbe\u8ba1\u5e08',
  user: '\u666e\u901a\u7528\u6237',
  unknownRole: '\u672a\u77e5\u89d2\u8272',
  membersLoadFailed: '\u6210\u5458\u5217\u8868\u52a0\u8f7d\u5931\u8d25',
  fillRequired: '\u8bf7\u586b\u5199\u5b8c\u6574\u4fe1\u606f',
  createSuccess: '\u521b\u5efa\u6210\u529f',
  createFailed: '\u521b\u5efa\u5931\u8d25',
  roleUpdated: '\u6743\u9650\u5df2\u66f4\u65b0',
  roleUpdateFailed: '\u6743\u9650\u66f4\u65b0\u5931\u8d25',
  enabled: '\u8d26\u53f7\u5df2\u542f\u7528',
  disabled: '\u8d26\u53f7\u5df2\u505c\u7528',
  statusUpdateFailed: '\u8d26\u53f7\u72b6\u6001\u66f4\u65b0\u5931\u8d25',
  pageTitle: '\u6210\u5458\u7ba1\u7406',
  pageDesc: '\u7ba1\u7406\u56e2\u961f\u6210\u5458\u548c\u89d2\u8272\u6743\u9650',
  addMember: '\u6dfb\u52a0\u6210\u5458',
  userColumn: '\u7528\u6237',
  jobNo: '\u5de5\u53f7',
  department: '\u90e8\u95e8',
  roleColumn: '\u89d2\u8272\u6743\u9650',
  status: '\u72b6\u6001',
  enable: '\u542f\u7528',
  disable: '\u505c\u7528',
  lastLogin: '\u6700\u540e\u767b\u5f55',
  neverLogin: '\u4ece\u672a\u767b\u5f55',
  newMember: '\u65b0\u589e\u6210\u5458',
  employeeNo: '\u5de5\u53f7',
  displayName: '\u59d3\u540d',
  password: '\u5bc6\u7801',
  role: '\u89d2\u8272',
  cancel: '\u53d6\u6d88',
  create: '\u521b\u5efa',
};

const DEFAULT_ROLE_OPTIONS: RoleOption[] = [
  { id: 4, displayName: TEXT.superAdmin, name: 'super_admin', assignable: false },
  { id: 1, displayName: TEXT.admin, name: 'admin', assignable: true },
  { id: 2, displayName: TEXT.designer, name: 'designer', assignable: true },
  { id: 3, displayName: TEXT.user, name: 'user', assignable: true },
];

const ROLE_CARD_TONE: Record<string, { bg: string; fg: string }> = {
  super_admin: { bg: '#F5F0FF', fg: '#6D28D9' },
  admin: { bg: 'var(--brand-vermilion-50)', fg: 'var(--brand-vermilion-600)' },
  designer: { bg: 'var(--brand-teal-50)', fg: 'var(--brand-teal-600)' },
  user: { bg: 'var(--n-50)', fg: 'var(--fg-3)' },
};

function getDepartmentText(user: UserRow) {
  if (user.departmentPath) return user.departmentPath;
  const levels = user.departmentLevels || {};
  const names = Object.entries(levels)
    .sort(([a], [b]) => {
      const aLevel = Number(a.replace(/\D/g, '')) || 0;
      const bLevel = Number(b.replace(/\D/g, '')) || 0;
      return aLevel - bLevel;
    })
    .map(([, level]) => level?.name)
    .filter(Boolean);
  return names.length ? names.join(' / ') : '-';
}

function getApiMessage(error: unknown, fallback: string) {
  return (error as { response?: { data?: { message?: string } } })?.response?.data?.message || fallback;
}

function isEnabled(value: number | boolean) {
  return value === true || value === 1;
}

export default function MembersPage() {
  const currentUser = useAuthStore((state) => state.user);
  const isSuperAdmin = currentUser?.role?.name === 'super_admin';
  const [users, setUsers] = useState<UserRow[]>([]);
  const [roleOptions, setRoleOptions] = useState<RoleOption[]>(DEFAULT_ROLE_OPTIONS);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ employeeNo: '', displayName: '', password: '123456', roleId: 3 });
  const [updatingRoleUserId, setUpdatingRoleUserId] = useState<number | null>(null);
  const [updatingStatusUserId, setUpdatingStatusUserId] = useState<number | null>(null);

  const assignableRoleOptions = useMemo(
    () => roleOptions.filter((role) => role.assignable !== false && role.name !== 'super_admin'),
    [roleOptions],
  );

  const getDefaultRoleId = () =>
    assignableRoleOptions.find((role) => role.name === 'user')?.id ||
    assignableRoleOptions[assignableRoleOptions.length - 1]?.id ||
    3;

  const loadUsers = async () => {
    setLoading(true);
    try {
      const rolesRequest = api.get('/users/roles').catch(() => ({ data: { data: DEFAULT_ROLE_OPTIONS } }));
      const [usersRes, rolesRes] = await Promise.all([api.get('/users'), rolesRequest]);
      const nextRoles = rolesRes.data?.data || DEFAULT_ROLE_OPTIONS;
      setUsers(usersRes.data?.data || []);
      setRoleOptions(nextRoles.length ? nextRoles : DEFAULT_ROLE_OPTIONS);
    } catch (error) {
      setUsers([]);
      message.error(getApiMessage(error, TEXT.membersLoadFailed));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadUsers();
  }, []);

  const getRoleSelectOptions = (user?: UserRow) => {
    const options: Array<{ value: number; label: string; disabled?: boolean }> = assignableRoleOptions.map((role) => ({
      value: role.id,
      label: role.displayName,
    }));
    if (user && !options.some((option) => option.value === user.roleId)) {
      options.unshift({
        value: user.roleId,
        label: user.role?.displayName || TEXT.superAdmin,
        disabled: true,
      });
    }
    return options;
  };

  const openCreate = () => {
    setForm((prev) => ({ ...prev, roleId: getDefaultRoleId() }));
    setCreateOpen(true);
  };

  const handleCreate = async () => {
    if (!form.employeeNo || !form.displayName) {
      message.warning(TEXT.fillRequired);
      return;
    }
    try {
      await api.post('/users', form);
      message.success(TEXT.createSuccess);
      setCreateOpen(false);
      setForm({ employeeNo: '', displayName: '', password: '123456', roleId: getDefaultRoleId() });
      await loadUsers();
    } catch (error: unknown) {
      message.error(getApiMessage(error, TEXT.createFailed));
    }
  };

  const handleRoleChange = async (user: UserRow, roleId: number) => {
    if (user.roleId === roleId) return;
    setUpdatingRoleUserId(user.id);
    try {
      await api.put(`/users/${user.id}`, { roleId });
      message.success(TEXT.roleUpdated);
      await loadUsers();
    } catch (error: unknown) {
      message.error(getApiMessage(error, TEXT.roleUpdateFailed));
    } finally {
      setUpdatingRoleUserId(null);
    }
  };

  const handleStatusChange = async (user: UserRow, enabled: boolean) => {
    setUpdatingStatusUserId(user.id);
    try {
      await api.put(`/users/${user.id}`, { isActive: enabled ? 1 : 0 });
      message.success(enabled ? TEXT.enabled : TEXT.disabled);
      await loadUsers();
    } catch (error: unknown) {
      message.error(getApiMessage(error, TEXT.statusUpdateFailed));
    } finally {
      setUpdatingStatusUserId(null);
    }
  };

  const handleImpersonate = (user: UserRow) => {
    Modal.confirm({
      title: '模拟登录',
      content: `将以「${user.displayName || user.employeeNo || user.username}」的身份进入应用，用于检查该角色下的权限与功能。`,
      okText: '开始模拟',
      cancelText: '取消',
      onOk: async () => {
        try {
          await useAuthStore.getState().impersonate(user.id);
          window.location.href = '/';
        } catch (error: unknown) {
          message.error(getApiMessage(error, '模拟登录失败'));
        }
      },
    });
  };

  return (
    <div style={{ padding: '24px 32px', flex: 1, overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h2 style={{ font: 'var(--type-h2)', color: 'var(--fg-1)', marginBottom: 4 }}>{TEXT.pageTitle}</h2>
          <p style={{ font: 'var(--type-body)', color: 'var(--fg-3)' }}>{TEXT.pageDesc}</p>
        </div>
        <Button type="primary" icon={<UserPlus size={14} />} onClick={openCreate}>
          {TEXT.addMember}
        </Button>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${Math.min(roleOptions.length, 4)}, minmax(160px, 1fr))`,
          gap: 16,
          marginBottom: 24,
        }}
      >
        {roleOptions.map((role) => {
          const tone = ROLE_CARD_TONE[role.name] || { bg: 'var(--n-50)', fg: 'var(--fg-3)' };
          return (
            <div
              key={role.name}
              style={{ padding: 20, borderRadius: 10, background: '#fff', border: '1px solid var(--border-2)' }}
            >
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '3px 8px',
                  borderRadius: 999,
                  background: tone.bg,
                  color: tone.fg,
                  font: 'var(--type-label)',
                  marginBottom: 8,
                }}
              >
                {role.displayName}
              </div>
              <div style={{ font: '600 24px var(--font-sans)', color: 'var(--fg-1)' }}>
                {users.filter((user) => user.role?.name === role.name).length}
              </div>
            </div>
          );
        })}
      </div>

      <Table
        dataSource={users}
        rowKey="id"
        loading={loading}
        pagination={false}
        style={{ background: '#fff', borderRadius: 10 }}
        columns={[
          {
            title: TEXT.userColumn,
            dataIndex: 'username',
            render: (_: unknown, row: UserRow) => (
              <div>
                <div style={{ fontWeight: 500 }}>{row.displayName || row.employeeNo || row.username}</div>
                <div style={{ font: 'var(--type-caption)', color: 'var(--fg-3)' }}>
                  {row.employeeNo ? `${TEXT.jobNo} ${row.employeeNo}` : row.username}
                </div>
              </div>
            ),
          },
          {
            title: TEXT.department,
            dataIndex: 'departmentPath',
            render: (_: unknown, row: UserRow) => (
              <span style={{ color: getDepartmentText(row) === '-' ? 'var(--fg-4)' : 'var(--fg-2)' }}>
                {getDepartmentText(row)}
              </span>
            ),
          },
          {
            title: TEXT.roleColumn,
            dataIndex: 'role',
            render: (_: unknown, row: UserRow) => (
              <Select
                size="small"
                value={row.roleId}
                options={getRoleSelectOptions(row)}
                onChange={(roleId) => handleRoleChange(row, roleId)}
                disabled={updatingRoleUserId === row.id || row.role?.name === 'super_admin'}
                style={{ width: 136 }}
              />
            ),
          },
          {
            title: TEXT.status,
            dataIndex: 'isActive',
            render: (value: number | boolean, row: UserRow) => {
              const enabled = isEnabled(value);
              const canToggle = isSuperAdmin && row.role?.name !== 'super_admin' && row.id !== currentUser?.id;
              if (!canToggle) {
                return <Tag color={enabled ? 'success' : 'default'}>{enabled ? TEXT.enable : TEXT.disable}</Tag>;
              }
              return (
                <Switch
                  size="small"
                  checked={enabled}
                  checkedChildren={TEXT.enable}
                  unCheckedChildren={TEXT.disable}
                  loading={updatingStatusUserId === row.id}
                  onChange={(nextEnabled) => handleStatusChange(row, nextEnabled)}
                />
              );
            },
          },
          {
            title: TEXT.lastLogin,
            dataIndex: 'lastLoginAt',
            render: (value: string | null) => (value ? new Date(value).toLocaleString() : TEXT.neverLogin),
          },
          {
            title: '操作',
            dataIndex: 'id',
            render: (_: unknown, row: UserRow) => {
              if (
                !isSuperAdmin
                || row.id === currentUser?.id
                || row.role?.name === 'super_admin'
                || !isEnabled(row.isActive)
              ) {
                return <span style={{ color: 'var(--fg-4)' }}>-</span>;
              }
              return (
                <Button size="small" onClick={() => handleImpersonate(row)}>
                  模拟登录
                </Button>
              );
            },
          },
        ]}
      />

      <Modal
        title={TEXT.newMember}
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        footer={[
          <Button key="cancel" onClick={() => setCreateOpen(false)}>
            {TEXT.cancel}
          </Button>,
          <Button key="ok" type="primary" onClick={handleCreate}>
            {TEXT.create}
          </Button>,
        ]}
        destroyOnHidden
      >
        <div style={{ display: 'grid', gap: 12, paddingTop: 8 }}>
          <Input
            placeholder={TEXT.employeeNo}
            value={form.employeeNo}
            onChange={(e) => setForm((prev) => ({ ...prev, employeeNo: e.target.value }))}
          />
          <Input
            placeholder={TEXT.displayName}
            value={form.displayName}
            onChange={(e) => setForm((prev) => ({ ...prev, displayName: e.target.value }))}
          />
          <Input.Password
            placeholder={TEXT.password}
            value={form.password}
            onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
          />
          <Select
            placeholder={TEXT.role}
            value={form.roleId}
            options={getRoleSelectOptions()}
            onChange={(roleId) => setForm((prev) => ({ ...prev, roleId }))}
          />
        </div>
      </Modal>
    </div>
  );
}
