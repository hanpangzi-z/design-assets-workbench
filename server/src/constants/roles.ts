export const ROLE_ORDER = ['super_admin', 'admin', 'designer', 'user'];

export const BUILT_IN_ROLES = [
  {
    name: 'super_admin',
    displayName: '超级管理员',
    permissions: {
      upload: true,
      edit: true,
      download: true,
      delete_files: true,
      manage_categories: true,
      manage_users: true,
      manage_tags: true,
      view_all_files: true,
    },
  },
  {
    name: 'admin',
    displayName: '管理员',
    permissions: {
      upload: true,
      edit: true,
      download: true,
      delete_files: true,
      manage_categories: true,
      manage_users: true,
      manage_tags: true,
      view_all_files: true,
    },
  },
  {
    name: 'designer',
    displayName: '设计师',
    permissions: {
      upload: true,
      edit: true,
      download: true,
      delete_files: false,
      manage_categories: true,
      manage_users: false,
      manage_tags: true,
      view_all_files: true,
    },
  },
  {
    name: 'user',
    displayName: '普通用户',
    permissions: {
      upload: false,
      edit: false,
      download: true,
      delete_files: false,
      manage_categories: false,
      manage_users: false,
      manage_tags: false,
      view_all_files: true,
    },
  },
];
