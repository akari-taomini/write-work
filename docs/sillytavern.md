# SillyTavern 免配置批量替换（0.8.3）

普通用户只需通过 GitHub 安装扩展，不需要安装 Node 服务端插件或修改配置文件。

## 支持范围

当前仅开放角色卡、开场白、角色卡内嵌世界书、独立世界书、角色聊天及群聊。通过 `/api/characters/all`、`/api/characters/chats`、`/api/characters/get`、`/api/characters/merge-attributes`、`/api/worldinfo/list`、`/api/worldinfo/get`、`/api/worldinfo/edit`、`/api/chats/get`、`/api/chats/save`、群聊与分支相关接口。

用户身份、预设、全局正则及任意文件等缺少统一且充分验证的批量事务接口，跨资源模式暂不支持；原工作台的普通编辑与当前预设/世界书全部替换不受影响。

## 备份

- 使用浏览器 IndexedDB，账号标识来自工作台已有的 `accountStorage` 命名空间。
- 先完整保存原文及预期内容，角色卡额外保存原始 PNG；备份复读确认后才允许修改业务资料。
- 每项写入前后均进行语义哈希校验。出现冲突即停止，并在可能的情况下恢复已经写入的资源。此流程不是跨资源原子事务。
- 备份支持 ZIP 下载和同一宿主/账号的导入。清理浏览器数据会影响本地备份，建议长期保留 ZIP。
- 宿主 API 出错、浏览器存储不可用、资源格式无法校验时会停止或跳过，而不是尝试写磁盘路径。

当前版本已完成模拟宿主 API 的自动化测试，**还未在真实 SillyTavern 端到端实测**，不保证所有版本都支持相同接口。
