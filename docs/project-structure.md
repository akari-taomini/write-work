# 源码目录与维护说明

本仓库将**普通前端扩展**作为 GitHub 安装入口；扩展加载清单必须保留在仓库根目录。

| 路径 | 用途 |
| --- | --- |
| `manifest.json`、`index.js`、`style.css` | 酒馆前端扩展的固定入口 |
| `src/app/` | 酒馆 Bridge、布局和本地草稿存储 |
| `src/core/` | 核心函数、查找、预设、正则预览 |
| `src/features/` | AI 创作工具、前端正则设计 |
| `src/batch/batch-engine.js`、`batch-adapters.js` | TT/PC 共用匹配与可编辑字段处理 |
| `src/batch/batch-runtime.js` | 运行环境选择；检测 TT / SillyTavern |
| `src/batch/batch-tt.js` | TT 客户端数据读写、备份与恢复 |
| `src/batch/batch-panel.js` | 批量替换交互面板 |
| `src/batch/batch-server.js` | 仅 PC SillyTavern 服务器运行的磁盘批量替换 |
| `vendor/fflate.js` | TT ZIP 备份与导入依赖，必须保留 LICENSE |
| `plugins/writer-workbench-batch/` | 可选 Node 服务端插件入口，须手动安装在酒馆服务器根目录 |
| `tests/` | 测试源文件，用户不需要单独操作 |
| `docs/` | 安装文档及 TT 兼容性实测记录 |

### 关键约束

1. `manifest.json` 的 `js` 和 `css` 字段仍分别指向根目录 `index.js` 与 `style.css`。
2. `plugins/writer-workbench-batch/index.js` 固定指向 `../../data/default-user/extensions/write-work/src/batch/batch-server.js`。只有复制到 SillyTavern 的根目录 `plugins/` 才能正常解析相对路径。
3. `src/batch/batch-server.js` 的 `../../../../../../src/png/encode.js` 指向安装根目录的 SillyTavern 原生模块，**不是**扩展目录内部文件。
4. TT 的 `src/batch/batch-tt.js` 相对导入 `../../vendor/fflate.js`，不能把 `vendor` 排除在扩展安装包之外。
5. `tests/batch.test.js` 依赖 SillyTavern 源码，无法通过纯前端测试代替。

**请不要再为 TT 新建 Node 服务端插件或混用 PC 的服务端 API。** 0.8.2 已按宿主分别选择后端适配。
