import { DataTypes, Model, Optional } from 'sequelize';
import sequelize from '../config/database';

interface CategoryAttributes {
  id: number;
  name: string;
  parentId: number | null;
  sortOrder: number;
  description: string | null;
  icon: string | null;
  dimension: string | null;
  libraryId: number | null;
  createdBy: number | null;
  createdAt?: Date;
  updatedAt?: Date;
}

type CategoryCreationAttributes = Optional<CategoryAttributes, 'id' | 'sortOrder' | 'description' | 'icon' | 'dimension' | 'libraryId' | 'createdBy'>;

class Category extends Model<CategoryAttributes, CategoryCreationAttributes> implements CategoryAttributes {
  declare id: number;
  declare name: string;
  declare parentId: number | null;
  declare sortOrder: number;
  declare description: string | null;
  declare icon: string | null;
  declare dimension: string | null;
  declare libraryId: number | null;
  declare createdBy: number | null;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;

  public children?: Category[];
  public fileCount?: number;
}

Category.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    name: { type: DataTypes.STRING(200), allowNull: false },
    parentId: { type: DataTypes.INTEGER, allowNull: true, field: 'parent_id', references: { model: 'categories', key: 'id' } },
    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0, field: 'sort_order' },
    description: { type: DataTypes.TEXT, allowNull: true },
    icon: { type: DataTypes.STRING(100), allowNull: true },
    dimension: { type: DataTypes.STRING(50), allowNull: true },
    libraryId: { type: DataTypes.INTEGER, allowNull: true, field: 'library_id', references: { model: 'libraries', key: 'id' } },
    createdBy: { type: DataTypes.INTEGER, allowNull: true, field: 'created_by', references: { model: 'users', key: 'id' } },
  },
  {
    sequelize, tableName: 'categories', modelName: 'Category',
    indexes: [
      { fields: ['parent_id'] },
      { fields: ['parent_id', 'sort_order'] },
      { fields: ['dimension'] },
      { fields: ['library_id'] },
      { name: 'idx_categories_library_name', fields: ['library_id', 'name'] },
      { name: 'idx_categories_library_dimension_sort', fields: ['library_id', 'dimension', 'parent_id', 'sort_order'] },
    ],
  }
);

export default Category;
