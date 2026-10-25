# 写卡工作台 · Writer Workbench

一个适用于 SillyTavern 的写卡扩展，包含人物设定、开场白、世界书、预设编辑、正则预览与创作工具。版本 **0.8.2**。

## 安装

普通用户在酒馆的「扩展 → 安装扩展」粘贴以下地址即可：

```text
https://github.com/akari-taomini/write-work.git
```

安装后刷新页面，在扩展设置打开「写卡工作台」。**不需要手动创建 `data/default-user/extensions/` 目录，也不要把整个 ZIP 外层的 `data/` 目录上传为仓库根目录。**

## 兼容性

- **SillyTavern：** 写卡、世界书、预设和编辑器内的查找/替换使用普通前端扩展即可。跨文件批量替换额外依赖服务端插件，需要管理员单独安装。
- **TauriTavern：** 0.8.2 内置 `src/batch/batch-tt.js` 适配层；TT 跨资源批量替换不依赖 Node 服务端插件。随包测试说明记录了 **Windows TauriTavern 2.4.0** 的实际读写及恢复测试；**Android/iOS/macOS/Linux 尚未实机验证**。TT 可用范围和备份注意事项见 [TT 适配说明](docs/tauritavern.md)。
- **普通安装：** 服务器端 `plugins/` 目录是可选 PC 功能的源码，不是普通用户必须复制的安装步骤。缺少该模块时，PC 的跨文件批量替换不可用，但普通写卡功能不受影响。

## 目录

```text
write-work/
├── manifest.json          # 必须位于仓库根目录
├── index.js               # 前端入口
├── style.css              # 样式入口
├── src/
│   ├── app/               # 酒馆接口、布局、存储
│   ├── core/              # 通用逻辑、正则、搜索、预设
│   ├── features/          # 创作工具和正则设计器
│   └── batch/             # 批量替换：共享逻辑、TT 与 PC 适配
├── vendor/                # TT 备份 ZIP 所需依赖及其许可证
├── plugins/               # 可选 PC 服务端插件（需要单独部署）
├── tests/                 # 自动化测试
└── docs/                  # 完整说明和兼容性记录
```

详见 [目录和开发说明](docs/project-structure.md)、[0.8.2 完整使用文档](docs/full-guide.md)、[旧版手动安装说明](docs/install-original.md)。

## 额外安装：仅 PC 跨文件批量替换

如果使用 **SillyTavern Node.js 版本**，且确实需要扫描、备份与替换不同角色卡、聊天及数据文件，可由有权限的管理员把仓库的 `plugins/writer-workbench-batch/` 复制到**酒馆安装根目录**的 `plugins/writer-workbench-batch/`，并在 `config.yaml` 启用 `enableServerPlugins: true`，然后重启。当前服务端入口使用 `data/default-user/extensions/write-work/` 的固定路径；改过用户或安装文件夹名时需要同步修改。

TauriTavern **不要安装**这个 Node 服务端插件，它使用自己的适配层。

## 开发与测试

开发人员可运行 `npm test`；部分测试依赖完整的 SillyTavern 源码与依赖，未必能在单独下载的扩展目录内通过。整理仅按职责移动文件并修正相对引用，不主动改动批量替换业务流程。

> 更新前请备份个人资料及工作台草稿。此仓库不附带私人备份或个人数据。
