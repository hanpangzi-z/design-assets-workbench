import { DataTypes, Model, Optional } from 'sequelize';
import sequelize from '../config/database';

interface TagAttributes {
  id: number;
  name: string;
  color: string;
  createdAt?: Date;
}

type TagCreationAttributes = Optional<TagAttributes, 'id' | 'color'>;

class Tag extends Model<TagAttributes, TagCreationAttributes> implements TagAttributes {
  declare id: number;
  declare name: string;
  declare color: string;
  declare readonly createdAt: Date;

  public useCount?: number;
}

Tag.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    name: { type: DataTypes.STRING(100), allowNull: false },
    color: { type: DataTypes.STRING(7), defaultValue: '#1A6B6B' },
  },
  {
    sequelize,
    tableName: 'tags',
    modelName: 'Tag',
    updatedAt: false,
    indexes: [{ name: 'tags_name_unique', unique: true, fields: ['name'] }],
  }
);

export default Tag;
