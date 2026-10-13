import { DataTypes, Model, Optional } from 'sequelize';
import sequelize from '../config/database';

interface ParsedLayerAttributes {
  id: number;
  fileId: number;
  layerName: string | null;
  layerType: string;
  parentLayerId: number | null;
  sortOrder: number;
  visible: boolean;
  opacity: number;
  blendMode: string;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  imagePath: string | null;
  textContent: string | null;
  textStyle: Record<string, unknown> | null;
  properties: Record<string, unknown> | null;
  createdAt?: Date;
}

type ParsedLayerCreation = Optional<ParsedLayerAttributes, 'id' | 'layerName' | 'parentLayerId' | 'sortOrder' | 'visible' | 'opacity' | 'blendMode' | 'x' | 'y' | 'width' | 'height' | 'imagePath' | 'textContent' | 'textStyle' | 'properties'>;

class ParsedLayer extends Model<ParsedLayerAttributes, ParsedLayerCreation> implements ParsedLayerAttributes {
  declare id: number;
  declare fileId: number;
  declare layerName: string | null;
  declare layerType: string;
  declare parentLayerId: number | null;
  declare sortOrder: number;
  declare visible: boolean;
  declare opacity: number;
  declare blendMode: string;
  declare x: number;
  declare y: number;
  declare width: number | null;
  declare height: number | null;
  declare imagePath: string | null;
  declare textContent: string | null;
  declare textStyle: Record<string, unknown> | null;
  declare properties: Record<string, unknown> | null;
  declare readonly createdAt: Date;

  public children?: ParsedLayer[];
}

ParsedLayer.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    fileId: { type: DataTypes.INTEGER, allowNull: false, field: 'file_id', references: { model: 'design_files', key: 'id' } },
    layerName: { type: DataTypes.STRING(500), allowNull: true, field: 'layer_name' },
    layerType: { type: DataTypes.ENUM('group', 'image', 'text', 'shape', 'adjustment'), allowNull: false, field: 'layer_type' },
    parentLayerId: { type: DataTypes.INTEGER, allowNull: true, field: 'parent_layer_id', references: { model: 'parsed_layers', key: 'id' } },
    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0, field: 'sort_order' },
    visible: { type: DataTypes.TINYINT, defaultValue: 1 },
    opacity: { type: DataTypes.FLOAT, defaultValue: 1.0 },
    blendMode: { type: DataTypes.STRING(50), defaultValue: 'normal', field: 'blend_mode' },
    x: { type: DataTypes.INTEGER, defaultValue: 0 },
    y: { type: DataTypes.INTEGER, defaultValue: 0 },
    width: { type: DataTypes.INTEGER, allowNull: true },
    height: { type: DataTypes.INTEGER, allowNull: true },
    imagePath: { type: DataTypes.STRING(1000), allowNull: true, field: 'image_path' },
    textContent: { type: DataTypes.TEXT, allowNull: true, field: 'text_content' },
    textStyle: { type: DataTypes.JSON, allowNull: true, field: 'text_style' },
    properties: { type: DataTypes.JSON, allowNull: true },
  },
  {
    sequelize, tableName: 'parsed_layers', modelName: 'ParsedLayer', updatedAt: false,
    indexes: [{ fields: ['file_id'] }, { fields: ['parent_layer_id'] }],
  }
);

export default ParsedLayer;
