# 写卡工作台 · Writer Workbench

适用于 SillyTavern 与兼容前端扩展的 TauriTavern：写卡、开场白、世界书、预设、正则设计与创作工具。版本 **0.8.3**。

## 安装（普通用户只做这一步）

在酒馆「扩展 → 安装扩展」中粘贴：

```text
https://github.com/akari-taomini/write-work.git
```

刷新酒馆后，在扩展设置打开「写卡工作台」。**不用复制 `plugins`，不用改文件路径，不用改 `config.yaml`。**

## 批量替换：自动选择兼容路径

- **普通 SillyTavern：** 直接使用酒馆已有的角色卡、独立世界书、聊天/群聊 API。可按范围扫描、预览、备份、执行及恢复；无需额外服务端插件。暂不开放 User Persona、预设、正则和任意文件的跨资源替换。工作台原有的「当前预设/世界书全部替换」照常使用，不在此限制之内。
- **TauriTavern：** 使用原有 TT 原生适配层，支持范围仍以 [TT 说明](docs/tauritavern.md) 为准。Windows TT 2.4.0 的实机记录来自此前 0.8.2；当前版本未新增真机测试。
- **两种宿主：** 任何跨资源替换都须用户主动扫描、检查预览并确认。执行前保存可用备份、复读校验；中途发现其他修改则中止。不能保证多个资源之间的原子事务。

SillyTavern 的备份位于**当前浏览器、当前酒馆账号的 IndexedDB**，可以下载/重新导入 ZIP；清除网站数据会删除本地备份。请在清理浏览器数据前自行下载备份。TT 备份存储方式不同，不能跨宿主直接恢复。

**不需要手动安装旧 Node 插件。** 仓库中的 `plugins/writer-workbench-batch/` 与 `src/batch/batch-server.js` 仅作为原有进阶部署的兼容遗留源码保留；0.8.3 前端不会调用它们。它们有更高的磁盘权限，也不适用于 TT。普通用户无需理会。

## 目录

```text
write-work/
├── manifest.json            # 扩展清单，固定放在根目录
├── index.js                 # 主入口
├── style.css                # 主样式
├── src/
│   ├── app/                 # 酒馆交互与草稿存储
│   ├── core/                # 通用工具与编辑器功能
│   ├── features/            # 正则设计、创作工具
│   └── batch/               # TT/ST 前端批量适配和共享规则
├── vendor/                  # 浏览器备份 ZIP 依赖及授权
├── plugins/                 # 旧版服务端模块（普通用户不用）
├── tests/                   # 自动化测试
└── docs/                    # 文档和历史说明
```

详细说明见 [目录说明](docs/project-structure.md)、[普通 ST 免配置适配](docs/sillytavern.md)、[TT 适配](docs/tauritavern.md) 和 [旧版完整使用文档](docs/full-guide.md)。

## 测试与限制

可在 Node 22+ 运行与前端相关的测试：

```sh
node --test tests/batch-st.test.js tests/batch-tt.test.js tests/batch-targets.test.js tests/replace.test.js tests/minimize.test.js
```

基于模拟 API 的测试不能等同于在所有真实 SillyTavern/TT 版本和设备上验证。涉及 Node 服务端的旧测试仍需要完整酒馆源码和对应依赖。

> 修改聊天、角色卡或世界书前，请备份重要资料；跨资源替换期间避免多窗口同时编辑。
