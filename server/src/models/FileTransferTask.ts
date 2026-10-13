import { DataTypes, Model, Optional } from 'sequelize';
import sequelize from '../config/database';

export type FileTransferStatus =
  | 'initialized'
  | 'uploading'
  | 'merging'
  | 'completed'
  | 'error'
  | 'canceled';

interface FileTransferTaskAttributes {
  id: string;
  userId: number;
  storagePlatform: string;
  status: FileTransferStatus;
  originalFilename: string;
  fileType: string;
  fileSize: number;
  fileMd5: string | null;
  chunkSize: number;
  totalChunks: number;
  uploadedChunks: number;
  libraryId: number | null;
  categoryId: number | null;
  categoryTagIds: number[] | null;
  tagIds: number[] | null;
  storageScope: string | null;
  relativePath: string | null;
  objectKey: string | null;
  uploadId: string | null;
  fileId: number | null;
  errorMessage: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

type FileTransferTaskCreation = Optional<
  FileTransferTaskAttributes,
  | 'id'
  | 'storagePlatform'
  | 'status'
  | 'fileMd5'
  | 'uploadedChunks'
  | 'libraryId'
  | 'categoryId'
  | 'categoryTagIds'
  | 'tagIds'
  | 'storageScope'
  | 'relativePath'
  | 'objectKey'
  | 'uploadId'
  | 'fileId'
  | 'errorMessage'
>;

class FileTransferTask extends Model<FileTransferTaskAttributes, FileTransferTaskCreation> implements FileTransferTaskAttributes {
  declare id: string;
  declare userId: number;
  declare storagePlatform: string;
  declare status: FileTransferStatus;
  declare originalFilename: string;
  declare fileType: string;
  declare fileSize: number;
  declare fileMd5: string | null;
  declare chunkSize: number;
  declare totalChunks: number;
  declare uploadedChunks: number;
  declare libraryId: number | null;
  declare categoryId: number | null;
  declare categoryTagIds: number[] | null;
  declare tagIds: number[] | null;
  declare storageScope: string | null;
  declare relativePath: string | null;
  declare objectKey: string | null;
  declare uploadId: string | null;
  declare fileId: number | null;
  declare errorMessage: string | null;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

FileTransferTask.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.INTEGER, allowNull: false, field: 'user_id', references: { model: 'users', key: 'id' } },
    storagePlatform: { type: DataTypes.STRING(50), allowNull: false, defaultValue: 'local', field: 'storage_platform' },
    status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'initialized' },
    originalFilename: { type: DataTypes.STRING(500), allowNull: false, field: 'original_filename' },
    fileType: { type: DataTypes.STRING(30), allowNull: false, field: 'file_type' },
    fileSize: { type: DataTypes.BIGINT, allowNull: false, field: 'file_size' },
    fileMd5: { type: DataTypes.STRING(32), allowNull: true, field: 'file_md5' },
    chunkSize: { type: DataTypes.INTEGER, allowNull: false, field: 'chunk_size' },
    totalChunks: { type: DataTypes.INTEGER, allowNull: false, field: 'total_chunks' },
    uploadedChunks: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'uploaded_chunks' },
    libraryId: { type: DataTypes.INTEGER, allowNull: true, field: 'library_id', references: { model: 'libraries', key: 'id' } },
    categoryId: { type: DataTypes.INTEGER, allowNull: true, field: 'category_id', references: { model: 'categories', key: 'id' } },
    categoryTagIds: { type: DataTypes.JSON, allowNull: true, field: 'category_tag_ids' },
    tagIds: { type: DataTypes.JSON, allowNull: true, field: 'tag_ids' },
    storageScope: { type: DataTypes.STRING(30), allowNull: true, field: 'storage_scope' },
    relativePath: { type: DataTypes.STRING(1000), allowNull: true, field: 'relative_path' },
    objectKey: { type: DataTypes.STRING(1000), allowNull: true, field: 'object_key' },
    uploadId: { type: DataTypes.STRING(80), allowNull: true, field: 'upload_id' },
    fileId: { type: DataTypes.INTEGER, allowNull: true, field: 'file_id', references: { model: 'design_files', key: 'id' } },
    errorMessage: { type: DataTypes.STRING(1000), allowNull: true, field: 'error_message' },
  },
  {
    sequelize,
    tableName: 'file_transfer_tasks',
    modelName: 'FileTransferTask',
    indexes: [
      { fields: ['user_id'] },
      { fields: ['status'] },
      { fields: ['file_md5'] },
      { fields: ['file_id'] },
      { fields: ['created_at'] },
    ],
  }
);

export default FileTransferTask;
