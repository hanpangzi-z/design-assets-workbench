# Design Assets Workbench

**让设计素材找得到、看得见，也能继续编辑。**

Design Assets Workbench 是面向设计师和业务团队的设计资产管理与在线编辑工作台。将专业设计文件、图片和字体集中到资源库，支持分类检索、文件预览、版本管理与图层编辑，方便团队复用已有设计成果。

适用于品牌物料归档、电商素材管理、模板复用和日常设计协作。从上传文件到查找素材、打开编辑、保存版本，在同一个工作台完成。

## 主要功能

| 功能 | 用途 |
| --- | --- |
| 设计资源库 | 集中管理素材，按资源库、分类和标签查找，支持置顶与回收站。 |
| 多格式预览 | 支持 PSD、PSB、AI、PDF、PPT、图片和字体文件的上传与预览。 |
| 在线编辑 | 使用图层、文字、图片和多画板调整设计，支持对齐、裁切与图片滤镜。 |
| 模板复用 | 从已有设计创建编辑副本，保留原素材并继续修改。 |
| 版本管理 | 保存设计文件的不同版本，查看历史内容。 |
| 文件处理 | 分片上传、解析任务隔离与资源增量加载，配合任务状态展示。 |
| 账号与权限 | 提供账号密码登录及管理员、设计师、浏览者等角色，支持配置单点登录。 |

## 使用流程

1. 上传设计文件、图片或字体，归入对应资源库和分类。
2. 通过搜索、分类和标签筛选素材，预览文件内容。
3. 选择已有设计进行编辑，调整文字、图片、图层和画板。
4. 保存版本或导出设计成果，供后续任务复用。

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 前端 | React、TypeScript、Vite、Ant Design、Zustand |
| 编辑器 | Fabric.js |
| 后端 | Node.js、Express、Sequelize、MySQL |
| 文件解析 | ag-psd、PDFium、PDF.js、Inkscape 等 |

## 快速开始

准备 Node.js 22、npm 10 和 MySQL 8，在根目录安装依赖并创建本地配置：

```powershell
Copy-Item .env.example .env
npm install
```

填写数据库连接和签名密钥，并设置 `INITIAL_ADMIN_USERNAME`、`INITIAL_ADMIN_PASSWORD`。初始化数据库、创建管理员并启动：

```powershell
npm run db:sync
npm run db:seed
npm run admin:create --workspace=server
npm run dev
```

前端地址为 `http://127.0.0.1:3089`，后端地址为 `http://127.0.0.1:3088`。管理员初始化配置、文件解析依赖和部署步骤见 [运行与部署](docs/setup.md)。

## 项目结构

- `client/`：资源库、在线编辑器与管理界面。
- `server/`：接口、权限、文件解析和数据库脚本。
- `shared/`：前后端共享类型。
- `.env.example`：环境配置模板。
