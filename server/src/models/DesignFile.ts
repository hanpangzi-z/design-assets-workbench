import { DataTypes, Model, Optional } from 'sequelize';
import sequelize from '../config/database';

interface DesignFileAttributes {
  id: number;
  name: string;
  originalFilename: string;
  fileType: string;
  filePath: string;
  storagePlatform: string;
  contentMd5: string | null;
  relativePath: string | null;
  thumbnailPath: string | null;
  fileSize: number;
  width: number | null;
  height: number | null;
  libraryId: number | null;
  categoryId: number | null;
  sourceFileId: number | null;
  isPersonalCopy: boolean;
  isFavorite: boolean;
  isDraft: boolean;
  isShared: boolean;
  isPublished: boolean;
  uploadedBy: number;
  parseStatus: string;
  parseResult: Record<string, unknown> | null;
  editorState: Record<string, unknown> | null;
  downloadCount: number;
  isDeleted: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

type DesignFileCreation = Optional<DesignFileAttributes, 'id' | 'storagePlatform' | 'contentMd5' | 'relativePath' | 'thumbnailPath' | 'width' | 'height' | 'libraryId' | 'categoryId' | 'sourceFileId' | 'isPersonalCopy' | 'isFavorite' | 'isDraft' | 'isShared' | 'isPublished' | 'parseResult' | 'editorState' | 'downloadCount' | 'isDeleted'>;

class DesignFile extends Model<DesignFileAttributes, DesignFileCreation> implements DesignFileAttributes {
  declare id: number;
  declare name: string;
  declare originalFilename: string;
  declare fileType: string;
  declare filePath: string;
  declare storagePlatform: string;
  declare contentMd5: string | null;
  declare relativePath: string | null;
  declare thumbnailPath: string | null;
  declare fileSize: number;
  declare width: number | null;
  declare height: number | null;
  declare libraryId: number | null;
  declare categoryId: number | null;
  declare sourceFileId: number | null;
  declare isPersonalCopy: boolean;
  declare isFavorite: boolean;
  declare isDraft: boolean;
  declare isShared: boolean;
  declare isPublished: boolean;
  declare uploadedBy: number;
  declare parseStatus: string;
  declare parseResult: Record<string, unknown> | null;
  declare editorState: Record<string, unknown> | null;
  declare downloadCount: number;
  declare isDeleted: boolean;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

DesignFile.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    name: { type: DataTypes.STRING(500), allowNull: false },
    originalFilename: { type: DataTypes.STRING(500), allowNull: false, field: 'original_filename' },
    fileType: { type: DataTypes.STRING(30), allowNull: false, field: 'file_type' },
    filePath: { type: DataTypes.STRING(1000), allowNull: false, field: 'file_path' },
    storagePlatform: { type: DataTypes.STRING(50), allowNull: false, defaultValue: 'local', field: 'storage_platform' },
    contentMd5: { type: DataTypes.STRING(32), allowNull: true, field: 'content_md5' },
    relativePath: { type: DataTypes.STRING(1000), allowNull: true, field: 'relative_path' },
    thumbnailPath: { type: DataTypes.STRING(1000), allowNull: true, field: 'thumbnail_path' },
    fileSize: { type: DataTypes.BIGINT, allowNull: false, field: 'file_size' },
    width: { type: DataTypes.INTEGER, allowNull: true },
    height: { type: DataTypes.INTEGER, allowNull: true },
    libraryId: { type: DataTypes.INTEGER, allowNull: true, field: 'library_id', references: { model: 'libraries', key: 'id' } },
    categoryId: { type: DataTypes.INTEGER, allowNull: true, field: 'category_id', references: { model: 'categories', key: 'id' } },
    sourceFileId: { type: DataTypes.INTEGER, allowNull: true, field: 'source_file_id', references: { model: 'design_files', key: 'id' } },
    isPersonalCopy: { type: DataTypes.TINYINT, defaultValue: 0, field: 'is_personal_copy' },
    isFavorite: { type: DataTypes.TINYINT, defaultValue: 0, field: 'is_favorite' },
    isDraft: { type: DataTypes.TINYINT, defaultValue: 0, field: 'is_draft' },
    isShared: { type: DataTypes.TINYINT, defaultValue: 0, field: 'is_shared' },
    isPublished: { type: DataTypes.TINYINT, defaultValue: 0, field: 'is_published' },
    uploadedBy: { type: DataTypes.INTEGER, allowNull: false, field: 'uploaded_by', references: { model: 'users', key: 'id' } },
    parseStatus: { type: DataTypes.ENUM('pending', 'parsing', 'completed', 'failed'), defaultValue: 'pending', field: 'parse_status' },
    parseResult: { type: DataTypes.JSON, allowNull: true, field: 'parse_result' },
    editorState: { type: DataTypes.JSON, allowNull: true, field: 'editor_state' },
    downloadCount: { type: DataTypes.INTEGER, defaultValue: 0, field: 'download_count' },
    isDeleted: { type: DataTypes.TINYINT, defaultValue: 0, field: 'is_deleted' },
  },
  {
    sequelize,
    tableName: 'design_files',
    modelName: 'DesignFile',
    indexes: [
      { fields: ['category_id'] },
      { fields: ['library_id'] },
      { fields: ['source_file_id'] },
      { fields: ['is_personal_copy'] },
      { fields: ['is_favorite'] },
      { fields: ['is_draft'] },
      { fields: ['is_shared'] },
      { fields: ['is_published'] },
      { fields: ['file_type'] },
      { fields: ['uploaded_by'] },
      { fields: ['parse_status'] },
      { fields: ['content_md5'] },
      { name: 'idx_design_files_library_listing', fields: ['is_deleted', 'is_personal_copy', 'library_id', 'created_at'] },
      { name: 'idx_design_files_my_listing', fields: ['uploaded_by', 'is_personal_copy', 'is_deleted', 'updated_at'] },
      { name: 'idx_design_files_parse_recovery', fields: ['parse_status', 'file_type'] },
    ],
  }
);

export default DesignFile;
