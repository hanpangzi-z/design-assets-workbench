// ========== 通用响应 ==========
export interface ApiResponse<T = unknown> {
  code: number;
  message: string;
  data: T;
}

export interface PaginatedData<T> {
  list: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
  };
}

// ========== 角色与权限 ==========
export interface Permissions {
  upload: boolean;
  edit: boolean;
  download: boolean;
  delete_files: boolean;
  manage_categories: boolean;
  manage_users: boolean;
  manage_tags: boolean;
  view_all_files: boolean;
}

export interface Role {
  id: number;
  name: 'super_admin' | 'admin' | 'designer' | 'user';
  displayName: string;
  permissions: Permissions;
}

// ========== 用户 ==========
export interface User {
  id: number;
  username: string;
  displayName: string;
  email?: string;
  avatarUrl?: string;
  authSubject?: string;
  departmentIds?: Array<string | number>;
  departmentLevels?: Record<string, { id?: string | number; name?: string }>;
  departmentPath?: string;
  employeeNo?: string;
  extattr?: Record<string, unknown>;
  roleId: number;
  role?: Role;
  isActive: boolean;
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: User;
}

// ========== 分类 ==========
export interface Category {
  id: number;
  name: string;
  parentId: number | null;
  sortOrder: number;
  description?: string;
  icon?: string;
  dimension?: 'festival' | 'design_type' | 'product_type' | 'version';
  libraryId?: number | null;
  createdBy: number;
  children?: Category[];
  fileCount?: number;
  branchFileCount?: number;
  createdAt: string;
  updatedAt: string;
}

// ========== 标签 ==========
export interface Tag {
  id: number;
  name: string;
  color: string;
  createdAt: string;
  useCount?: number;
}

// ========== 设计文件 ==========
export type FileType = 'psd' | 'ai' | 'svg' | 'png' | 'jpg' | 'gif' | 'webp' | 'pdf' | 'pptx' | 'ttf' | 'otf' | 'ttc' | 'woff' | 'woff2';
export type ParseStatus = 'pending' | 'parsing' | 'completed' | 'failed';
export interface ParseFreshness {
  state: 'ready' | 'queued' | 'parsing' | 'syncing' | 'failed';
  requiredVersion: number;
  resultVersion: number;
  revision: string | null;
}

export interface DesignFile {
  id: number;
  name: string;
  originalFilename: string;
  fileType: FileType;
  filePath: string;
  storagePlatform?: string;
  contentMd5?: string | null;
  relativePath?: string | null;
  thumbnailPath?: string;
  fileSize: number;
  width?: number;
  height?: number;
  libraryId?: number;
  library?: { id: number; name: string };
  categoryId?: number;
  category?: Category;
  categoryAssignments?: Category[];
  sourceFileId?: number | null;
  isPersonalCopy?: boolean;
  isFavorite?: boolean;
  isDraft?: boolean;
  isShared?: boolean;
  isPublished?: boolean;
  uploadedBy: number;
  uploader?: User;
  parseStatus: ParseStatus;
  parseFreshness?: ParseFreshness;
  sourceParseStatus?: ParseStatus;
  sourceParseError?: string;
  autoParseBlocked?: boolean;
  parseResult?: Record<string, unknown>;
  editorState?: Record<string, unknown>;
  downloadCount: number;
  isDeleted: boolean;
  tags?: Tag[];
  createdAt: string;
  updatedAt: string;
}

// ========== 解析图层 ==========
export type LayerType = 'group' | 'image' | 'text' | 'shape' | 'adjustment';

export interface ParseDiagnostic {
  code: string;
  severity: 'warning' | 'error';
  message: string;
  layerKey?: string;
  layerName?: string;
}

export interface PsdMaskResource {
  imagePath: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Alpha outside the mask patch, after density and feathering. */
  defaultColor: number;
  disabled?: boolean;
  linked?: boolean;
}

export interface PsdLayerProperties extends Record<string, unknown> {
  psdSourceKey?: string;
  psdClipBaseKey?: string;
  psdMask?: PsdMaskResource;
  psdUserMask?: PsdMaskResource;
  psdMaskIncludesVectorGeometry?: boolean;
  psdIntrinsicVectorMaskBaked?: boolean;
  psdRasterRole?: 'content';
  psdPreviewPath?: string;
  psdAdjustment?: Record<string, unknown>;
  psdVectorMask?: Record<string, unknown>;
  psdVectorOrigination?: Record<string, unknown>;
  psdPlacedLayer?: Record<string, unknown>;
  effects?: Record<string, unknown>;
}

export interface PsdParseResult extends Record<string, unknown> {
  psdParserVersion: number;
  rasterContentMode: 'raw';
  artifactDirectory: string;
  compositePath?: string;
  exportedImageCount: number;
  diagnostics: ParseDiagnostic[];
}

export interface ParsedLayer {
  id: number;
  fileId: number;
  layerName?: string;
  layerType: LayerType;
  parentLayerId: number | null;
  sortOrder: number;
  visible: boolean;
  opacity: number;
  blendMode: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  imagePath?: string;
  textContent?: string;
  textStyle?: Record<string, unknown>;
  properties?: PsdLayerProperties;
  children?: ParsedLayer[];
}

// ========== 文件版本 ==========
export interface FileVersion {
  id: number;
  fileId: number;
  versionNumber: number;
  filePath: string;
  thumbnailPath?: string;
  editorState?: Record<string, unknown>;
  createdBy: number;
  creator?: User;
  comment?: string;
  createdAt: string;
}
