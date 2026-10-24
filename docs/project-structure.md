# 文件目录与依赖关系

这个目录结构将 **酒馆可直接识别的入口文件留在仓库根目录**，其余按职责收纳。整理仅改变仓库源码的存放位置与相对导入路径，不主动重写业务逻辑。

| 路径 | 用途 |
| --- | --- |
| `manifest.json` | SillyTavern 扩展加载清单；仍指向根目录 `index.js`、`style.css` |
| `index.js` | 前端主入口；从 `src/` 加载模块 |
| `style.css` | 样式入口 |
| `src/app/bridge.js` | SillyTavern 数据接口与写入 |
| `src/app/layout-controls.js` | 工作台布局、滚动与元素定位 |
| `src/app/storage.js` | 草稿及历史版本存储 |
| `src/core/core.js` | 通用数据结构与合并工具 |
| `src/core/search.js` | 搜索、高亮 |
| `src/core/regex-preview.js` | 正则解析与预览 |
| `src/core/preset-tools.js` | 预设条目编辑工具 |
| `src/features/frontend-designer.js` | 前端正则设计 |
| `src/features/writer-lab.js` | 创作工具 |
| `src/batch/batch-engine.js` | 批量替换匹配算法 |
| `src/batch/batch-adapters.js` | 可编辑字段与数据适配 |
| `src/batch/batch-panel.js` | 批量替换前端面板 |
| `src/batch/batch-server.js` | 批量替换服务端路由与备份 |
| `plugins/writer-workbench-batch/index.js` | 独立安装的服务端插件入口 |
| `tests/` | 现有测试，导入路径已更新 |
| `docs/full-guide.md` | 旧版完整 README 归档，保留详细功能文档 |

## 关键路径（勿随意挪动）

1. `manifest.json` 的 `js`、`css` 使用扩展根目录的相对路径，所以 `index.js` 和 `style.css` 仍保留在仓库根目录。
2. 服务端插件的 `index.js` 目前使用 `../../data/default-user/extensions/write-work/src/batch/batch-server.js`。**仓库中的 `plugins/` 文件夹不会被 SillyTavern 自动当作服务端插件安装**，需要复制到酒馆安装根目录的 `plugins/`。自定义用户目录与不同扩展文件夹名须调整这个固定路径。
3. `src/batch/batch-server.js` 对 SillyTavern 本体 `src/png/encode.js` 的相对导入已增加两级 `../`。这依赖酒馆的实际安装目录结构。
4. `tests/batch.test.js` 与 `tests/batch-routes.test.js` 依赖完整 SillyTavern 环境，独立下载仓库后无法保证直接运行。

## 后续维护建议

- 新增纯函数放 `src/core/`；UI 交互放 `src/features/` 或 `src/app/`。
- 批量替换相关功能统一放 `src/batch/`，不要重新在仓库根目录新增同名模块。
- 修改模块位置后同步更新引用它的源文件、服务端入口和测试。
- 旧的详细功能说明保存在 `docs/full-guide.md`；以后可以按主题继续拆成安装、功能和历史更新文档。
