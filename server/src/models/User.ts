import { DataTypes, Model, Optional } from 'sequelize';
import sequelize from '../config/database';
import bcrypt from 'bcryptjs';

interface UserAttributes {
  id: number;
  username: string;
  passwordHash: string;
  displayName: string;
  email?: string;
  avatarUrl?: string;
  authSubject?: string;
  departmentIds?: unknown;
  departmentLevels?: Record<string, unknown>;
  departmentPath?: string;
  employeeNo?: string;
  extattr?: Record<string, unknown>;
  roleId: number;
  isActive: boolean;
  lastLoginAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

type UserCreationAttributes = Optional<UserAttributes, 'id' | 'isActive'>;

class User extends Model<UserAttributes, UserCreationAttributes> implements UserAttributes {
  declare id: number;
  declare username: string;
  declare passwordHash: string;
  declare displayName: string;
  declare email: string;
  declare avatarUrl: string;
  declare authSubject: string;
  declare departmentIds: unknown;
  declare departmentLevels: Record<string, unknown>;
  declare departmentPath: string;
  declare employeeNo: string;
  declare extattr: Record<string, unknown>;
  declare roleId: number;
  declare isActive: boolean;
  declare lastLoginAt: Date;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;

  public async validatePassword(password: string): Promise<boolean> {
    return bcrypt.compare(password, this.passwordHash);
  }

  public toSafeJSON() {
    const values = this.toJSON() as unknown as Record<string, unknown>;
    delete values.passwordHash;
    delete values.password_hash;
    return values;
  }
}

User.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    username: { type: DataTypes.STRING(100), allowNull: false },
    passwordHash: { type: DataTypes.STRING(255), allowNull: false, field: 'password_hash' },
    displayName: { type: DataTypes.STRING(100), allowNull: false, field: 'display_name' },
    email: { type: DataTypes.STRING(255), allowNull: true },
    avatarUrl: { type: DataTypes.STRING(500), allowNull: true, field: 'avatar_url' },
    authSubject: { type: DataTypes.STRING(255), allowNull: true, field: 'auth_subject' },
    departmentIds: { type: DataTypes.JSON, allowNull: true, field: 'department_ids' },
    departmentLevels: { type: DataTypes.JSON, allowNull: true, field: 'department_levels' },
    departmentPath: { type: DataTypes.STRING(500), allowNull: true, field: 'department_path' },
    employeeNo: { type: DataTypes.STRING(100), allowNull: true, field: 'employee_no' },
    extattr: { type: DataTypes.JSON, allowNull: true },
    roleId: { type: DataTypes.INTEGER, allowNull: false, field: 'role_id', references: { model: 'roles', key: 'id' } },
    isActive: { type: DataTypes.TINYINT, defaultValue: 1, field: 'is_active' },
    lastLoginAt: { type: DataTypes.DATE, allowNull: true, field: 'last_login_at' },
  },
  {
    sequelize,
    tableName: 'users',
    modelName: 'User',
    indexes: [{ name: 'users_username_unique', unique: true, fields: ['username'] }],
  }
);

export default User;
