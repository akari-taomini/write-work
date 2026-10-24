# 写卡工作台（Writer Workbench）

适用于 **SillyTavern** 的写卡、世界书、开场白与预设编辑扩展。当前版本 **0.7.1**。

本项目在原作者 0.6.0 版本基础上扩充；保留原项目的署名及上游链接。版本更新内容、完整使用手册和兼容性说明见 [完整说明](docs/full-guide.md)。

## 安装

在 SillyTavern 的 **扩展 → 安装扩展** 中填入：

```text
https://github.com/akari-taomini/write-work.git
```

刷新酒馆，打开扩展设置里的「写卡工作台」。已有旧版请更新原有扩展，不要重复安装。

**批量替换需要额外安装服务端插件**：将仓库内的 `plugins/writer-workbench-batch/` 放到 SillyTavern 安装根目录的 `plugins/writer-workbench-batch/`，在 `config.yaml` 启用 `enableServerPlugins: true` 并重启。该模块目前假定扩展位于 `data/default-user/extensions/write-work/`，若实际安装路径不同，需要调整服务端插件的导入路径。其余写卡功能不需要服务端模块。

## 功能

- 人物设定、开场白、世界书和预设提示词编辑
- AI 写卡与修改、创作工具、前端正则设计
- 查找替换、草稿历史、导入导出、备份与冲突保护
- 可选服务端批量替换（指定范围扫描、预览、执行及恢复）

## 项目目录

```text
write-work/
├── manifest.json           # SillyTavern 扩展清单（必须保留根目录）
├── index.js                # 浏览器入口（必须保留根目录）
├── style.css               # 样式入口（必须保留根目录）
├── src/
│   ├── app/                # 酒馆交互、布局和草稿存储
│   ├── core/               # 基础工具、预设和正则处理
│   ├── features/           # 前端正则设计、创作工具
│   └── batch/              # 批量替换前端、服务端及算法
├── plugins/
│   └── writer-workbench-batch/  # 需单独复制到酒馆 plugins 的服务端入口
├── tests/                  # 自动化测试
├── docs/                   # 文档
└── package.json
```

文件移动后，入口与模块导入路径已同步更新。**不要单独移动 `src/` 中的文件**，它们互相引用。

详细的文件职责与路径约束见 [目录说明](docs/project-structure.md)，此前完整文档见 [完整说明](docs/full-guide.md)。

## 开发

`package.json` 中保留 `npm test` 测试命令。涉及服务端的测试依赖 SillyTavern 的源码与 Node 依赖，请在完整的开发环境中运行，不要把仅通过静态检查当成端到端验证。

## 备注

- 草稿存储在当前浏览器，正式修改前请备份。
- 批量替换涉及真实用户数据，执行前先看差异预览，保留备份。
- 原作者与历史版本信息请参考 [完整说明](docs/full-guide.md)。
