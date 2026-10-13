import { DataTypes, Model, Optional } from 'sequelize';
import sequelize from '../config/database';

interface FileTransferChunkAttributes {
  id: number;
  taskId: string;
  chunkIndex: number;
  etag: string;
  size: number;
  createdAt?: Date;
  updatedAt?: Date;
}

type FileTransferChunkCreation = Optional<FileTransferChunkAttributes, 'id'>;

class FileTransferChunk extends Model<FileTransferChunkAttributes, FileTransferChunkCreation> implements FileTransferChunkAttributes {
  declare id: number;
  declare taskId: string;
  declare chunkIndex: number;
  declare etag: string;
  declare size: number;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

FileTransferChunk.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    taskId: { type: DataTypes.UUID, allowNull: false, field: 'task_id', references: { model: 'file_transfer_tasks', key: 'id' } },
    chunkIndex: { type: DataTypes.INTEGER, allowNull: false, field: 'chunk_index' },
    etag: { type: DataTypes.STRING(80), allowNull: false },
    size: { type: DataTypes.INTEGER, allowNull: false },
  },
  {
    sequelize,
    tableName: 'file_transfer_chunks',
    modelName: 'FileTransferChunk',
    indexes: [
      { unique: true, fields: ['task_id', 'chunk_index'] },
      { fields: ['task_id'] },
    ],
  }
);

export default FileTransferChunk;
