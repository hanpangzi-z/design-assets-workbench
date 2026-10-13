import { DataTypes, Model, Optional } from 'sequelize';
import sequelize from '../config/database';

interface FileVersionAttributes {
  id: number;
  fileId: number;
  versionNumber: number;
  filePath: string;
  thumbnailPath: string | null;
  editorState: Record<string, unknown> | null;
  createdBy: number;
  comment: string | null;
  createdAt?: Date;
}

type FileVersionCreation = Optional<FileVersionAttributes, 'id' | 'thumbnailPath' | 'editorState' | 'comment'>;

class FileVersion extends Model<FileVersionAttributes, FileVersionCreation> implements FileVersionAttributes {
  declare id: number;
  declare fileId: number;
  declare versionNumber: number;
  declare filePath: string;
  declare thumbnailPath: string | null;
  declare editorState: Record<string, unknown> | null;
  declare createdBy: number;
  declare comment: string | null;
  declare readonly createdAt: Date;
}

FileVersion.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    fileId: { type: DataTypes.INTEGER, allowNull: false, field: 'file_id', references: { model: 'design_files', key: 'id' } },
    versionNumber: { type: DataTypes.INTEGER, allowNull: false, field: 'version_number' },
    filePath: { type: DataTypes.STRING(1000), allowNull: false, field: 'file_path' },
    thumbnailPath: { type: DataTypes.STRING(1000), allowNull: true, field: 'thumbnail_path' },
    editorState: { type: DataTypes.JSON, allowNull: true, field: 'editor_state' },
    createdBy: { type: DataTypes.INTEGER, allowNull: false, field: 'created_by', references: { model: 'users', key: 'id' } },
    comment: { type: DataTypes.STRING(500), allowNull: true },
  },
  { sequelize, tableName: 'file_versions', modelName: 'FileVersion', updatedAt: false }
);

export default FileVersion;
