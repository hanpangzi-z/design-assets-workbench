import { DataTypes, Model, Optional } from 'sequelize';
import sequelize from '../config/database';

interface RoleAttributes {
  id: number;
  name: string;
  displayName: string;
  permissions: Record<string, boolean>;
  createdAt?: Date;
  updatedAt?: Date;
}

type RoleCreationAttributes = Optional<RoleAttributes, 'id'>;

class Role extends Model<RoleAttributes, RoleCreationAttributes> implements RoleAttributes {
  declare id: number;
  declare name: string;
  declare displayName: string;
  declare permissions: Record<string, boolean>;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

Role.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    name: { type: DataTypes.STRING(50), allowNull: false },
    displayName: { type: DataTypes.STRING(100), allowNull: false, field: 'display_name' },
    permissions: { type: DataTypes.JSON, allowNull: false },
  },
  {
    sequelize,
    tableName: 'roles',
    modelName: 'Role',
    indexes: [{ name: 'roles_name_unique', unique: true, fields: ['name'] }],
  }
);

export default Role;
