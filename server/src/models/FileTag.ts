import { DataTypes, Model } from 'sequelize';
import sequelize from '../config/database';

class FileTag extends Model {
  declare fileId: number;
  declare tagId: number;
}

FileTag.init(
  {
    fileId: { type: DataTypes.INTEGER, primaryKey: true, field: 'file_id', references: { model: 'design_files', key: 'id' } },
    tagId: { type: DataTypes.INTEGER, primaryKey: true, field: 'tag_id', references: { model: 'tags', key: 'id' } },
  },
  {
    sequelize,
    tableName: 'file_tags',
    modelName: 'FileTag',
    timestamps: false,
    indexes: [{ name: 'idx_file_tags_tag_id', fields: ['tag_id'] }],
  }
);

export default FileTag;
