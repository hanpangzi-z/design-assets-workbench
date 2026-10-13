import { DataTypes, Model, Optional } from 'sequelize';
import sequelize from '../config/database';

interface LibraryAttributes {
  id: number;
  name: string;
  description: string | null;
  ownerId: number | null;
  templateCount: number;
  materialCount: number;
  isPinned: boolean;
  pinnedAt: Date | null;
  isDeleted: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

type LibraryCreation = Optional<LibraryAttributes, 'id' | 'description' | 'ownerId' | 'templateCount' | 'materialCount' | 'isPinned' | 'pinnedAt' | 'isDeleted'>;

class Library extends Model<LibraryAttributes, LibraryCreation> implements LibraryAttributes {
  declare id: number;
  declare name: string;
  declare description: string | null;
  declare ownerId: number | null;
  declare templateCount: number;
  declare materialCount: number;
  declare isPinned: boolean;
  declare pinnedAt: Date | null;
  declare isDeleted: boolean;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

Library.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    name: { type: DataTypes.STRING(200), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    ownerId: { type: DataTypes.INTEGER, allowNull: true, field: 'owner_id', references: { model: 'users', key: 'id' } },
    templateCount: { type: DataTypes.INTEGER, defaultValue: 0, field: 'template_count' },
    materialCount: { type: DataTypes.INTEGER, defaultValue: 0, field: 'material_count' },
    isPinned: { type: DataTypes.TINYINT, defaultValue: 0, field: 'is_pinned' },
    pinnedAt: { type: DataTypes.DATE, allowNull: true, field: 'pinned_at' },
    isDeleted: { type: DataTypes.TINYINT, defaultValue: 0, field: 'is_deleted' },
  },
  { sequelize, tableName: 'libraries', modelName: 'Library' }
);

export default Library;
