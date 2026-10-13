# 运行与部署

## 环境准备

- Node.js 22、npm 10、MySQL 8。
- AI/PDF 等专业文件处理按所用功能安装 Inkscape 及相应原生依赖。

在仓库根目录运行：

```powershell
Copy-Item .env.example .env
npm install
```

在 `.env` 中填写数据库连接、`JWT_SECRET` 和 `JWT_REFRESH_SECRET`。两项签名密钥使用不同的随机值，本地初始化使用独立开发数据库。

## 数据库与管理员

```powershell
npm run db:sync
npm run db:seed
```

在 `.env` 中设置 `INITIAL_ADMIN_USERNAME` 和 `INITIAL_ADMIN_PASSWORD`。密码至少 12 个字符，且不超过 72 个 UTF-8 字节。创建管理员：

```powershell
npm run admin:create --workspace=server
```

命令会检查同名账号，不覆盖已有账号。创建成功后移除本地配置中的初始化密码。

## 开发与构建

```powershell
npm run dev
npm run build
npm test --workspace=server
```

开发前端为 `http://127.0.0.1:3089`，后端为 `http://127.0.0.1:3088`。

## 部署配置

- 配置生产环境、独立数据库、持久化上传目录和 HTTPS。
- 配置允许访问的前端来源，并关闭 `LOCAL_DEV_NO_LOGIN`。
- 更新程序前备份数据库及配置，保留上传内容。
- 使用单点登录时，设置自己的服务地址与密钥；票据接入需设置 `DESIGN_LIBRARY_SSO_SECRET`。
- 环境文件、数据库及上传内容保存在部署环境，不提交到 Git。
