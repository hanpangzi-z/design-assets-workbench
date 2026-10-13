import { DataTypes, Model } from 'sequelize';
import sequelize from '../config/database';

class FileCategory extends Model {
  declare fileId: number;
  declare categoryId: number;
}

FileCategory.init(
  {
    fileId: { type: DataTypes.INTEGER, primaryKey: true, field: 'file_id', references: { model: 'design_files', key: 'id' } },
    categoryId: { type: DataTypes.INTEGER, primaryKey: true, field: 'category_id', references: { model: 'categories', key: 'id' } },
  },
  {
    sequelize,
    tableName: 'file_categories',
    modelName: 'FileCategory',
    timestamps: false,
    indexes: [{ fields: ['category_id'] }],
  }
);

export default FileCategory;
