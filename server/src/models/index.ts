import sequelize from '../config/database';
import Role from './Role';
import User from './User';
import Category from './Category';
import Tag from './Tag';
import DesignFile from './DesignFile';
import FileTag from './FileTag';
import FileCategory from './FileCategory';
import FileVersion from './FileVersion';
import ParsedLayer from './ParsedLayer';
import Library from './Library';
import FileTransferTask from './FileTransferTask';
import FileTransferChunk from './FileTransferChunk';

// 角色-用户
Role.hasMany(User, { foreignKey: 'role_id', as: 'users' });
User.belongsTo(Role, { foreignKey: 'role_id', as: 'role' });

// 分类自引用树
Category.hasMany(Category, { foreignKey: 'parent_id', as: 'children' });
Category.belongsTo(Category, { foreignKey: 'parent_id', as: 'parent' });
Category.belongsTo(User, { foreignKey: 'created_by', as: 'creator' });
Category.belongsTo(Library, { foreignKey: 'library_id', as: 'library' });
Library.hasMany(Category, { foreignKey: 'library_id', as: 'categories' });

// 文件-分类
DesignFile.belongsTo(Category, { foreignKey: 'category_id', as: 'category' });
Category.hasMany(DesignFile, { foreignKey: 'category_id', as: 'files' });

// 文件-资源库
DesignFile.belongsTo(Library, { foreignKey: 'library_id', as: 'library' });
Library.hasMany(DesignFile, { foreignKey: 'library_id', as: 'files' });

// 文件-上传者
DesignFile.belongsTo(User, { foreignKey: 'uploaded_by', as: 'uploader' });
User.hasMany(DesignFile, { foreignKey: 'uploaded_by', as: 'uploadedFiles' });

// 文件-标签（多对多）
DesignFile.belongsToMany(Tag, { through: FileTag, foreignKey: 'file_id', otherKey: 'tag_id', as: 'tags' });
Tag.belongsToMany(DesignFile, { through: FileTag, foreignKey: 'tag_id', otherKey: 'file_id', as: 'files' });

// 文件-多维分类（多对多）
DesignFile.belongsToMany(Category, { through: FileCategory, foreignKey: 'file_id', otherKey: 'category_id', as: 'categoryAssignments' });
Category.belongsToMany(DesignFile, { through: FileCategory, foreignKey: 'category_id', otherKey: 'file_id', as: 'assignedFiles' });

// 文件-版本
DesignFile.hasMany(FileVersion, { foreignKey: 'file_id', as: 'versions' });
FileVersion.belongsTo(DesignFile, { foreignKey: 'file_id', as: 'file' });
FileVersion.belongsTo(User, { foreignKey: 'created_by', as: 'creator' });

// 文件-解析图层
DesignFile.hasMany(ParsedLayer, { foreignKey: 'file_id', as: 'layers' });
ParsedLayer.belongsTo(DesignFile, { foreignKey: 'file_id', as: 'file' });

// 图层自引用树
ParsedLayer.hasMany(ParsedLayer, { foreignKey: 'parent_layer_id', as: 'children' });
ParsedLayer.belongsTo(ParsedLayer, { foreignKey: 'parent_layer_id', as: 'parentLayer' });

// 资源库-拥有者
Library.belongsTo(User, { foreignKey: 'owner_id', as: 'owner' });

// 单文件上传任务-分片
FileTransferTask.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
FileTransferTask.belongsTo(DesignFile, { foreignKey: 'file_id', as: 'file' });
FileTransferTask.hasMany(FileTransferChunk, { foreignKey: 'task_id', as: 'chunks' });
FileTransferChunk.belongsTo(FileTransferTask, { foreignKey: 'task_id', as: 'task' });

export { sequelize, Role, User, Category, Tag, DesignFile, FileTag, FileCategory, FileVersion, ParsedLayer, Library, FileTransferTask, FileTransferChunk };
