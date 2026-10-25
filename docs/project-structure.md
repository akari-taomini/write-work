# 写卡工作台目录说明

目标：保留标准 SillyTavern 前端扩展结构，让普通用户通过仓库地址直接安装；不需要部署 Node.js 服务端插件。

| 文件 / 路径 | 职责 |
| --- | --- |
| `manifest.json` | 必须位于扩展根目录，指向根目录的 `index.js`、`style.css` |
| `index.js` | 工作台 UI 入口与编辑逻辑 |
| `style.css` | 主题布局与移动端样式 |
| `src/app/bridge.js` | SillyTavern 前端 API 接口 |
| `src/app/layout-controls.js` | 窗口布局与滚动 |
| `src/app/storage.js` | 草稿和历史存储 |
| `src/core/core.js` | 数据结构与三方合并 |
| `src/core/search.js` | 查找与高亮 |
| `src/core/regex-preview.js` | 正则预览 |
| `src/core/preset-tools.js` | 预设条目管理与全部替换辅助 |
| `src/features/frontend-designer.js` | 前端正则设计器 |
| `src/features/writer-lab.js` | 创作工具 |
| `tests/` | 原有编辑器自动测试 |
| `docs/full-guide.md` | 历史完整说明（旧服务端模块章节仅供历史参考） |

## 关于不再附带的服务端模块

之前的 `plugins/writer-workbench-batch/` 与 `src/batch/` 属于额外的 **Node.js 后端跨文件批量替换**，依赖服务器文件扫描、备份与专有 API。它不是可在 TauriTavern 运行的前端监听器；TauriTavern 不兼容上游 Node.js 后端扩展。

为避免默认安装入口出现不能用的「批量替换」按钮，已连同其无关测试一起从默认仓库移除。用户在写卡工作台使用的 **当前预设/世界书范围内的查找、全部替换、草稿撤回** 保持不变。

如将来需要跨文件修改，必须单独设计并验证目标客户端支持的实现，不应声称前端脚本能获得文件系统的任意读写权限。
