# 文档

三条阅读路径，挑一条走：

| 你是 | 想干什么 | 从这读 |
|---|---|---|
| **玩家** | 装上、能说话、能换装 | [01 安装](01-install.md) → [02 第一次运行](02-first-run.md) |
| **折腾党** | 改配置、调性格、换台词 | [03 配置全解](03-config.md) → [05 台词池](05-chatter.md) |
| **开发者** | 搞清协议、改代码、接别的游戏 | [07 架构](07-architecture.md) → [CONTRIBUTING](../CONTRIBUTING.md) |

---

## 全部文档

| 文档 | 内容 | 大概要读多久 |
|---|---|---|
| [01 安装](01-install.md) | 四样前置、注册扩展、验收、卸载 | 10 分钟 |
| [02 第一次运行](02-first-run.md) | 她什么时候动、怎么停、怎么插话 | 8 分钟 |
| [03 配置全解](03-config.md) | 46 个配置项 + 常见需求对照 | 查表 |
| [04 工具与事件](04-tools.md) | 10 个工具、8 个事件、局面长什么样 | 15 分钟 |
| [05 台词池](05-chatter.md) | 两套语料、五个档位、占位符、热改 | 10 分钟 |
| [06 出问题了](06-troubleshooting.md) | 按症状查：不动、重复、卡顿、太吵 | 卡住时读 |
| [07 架构](07-architecture.md) | 分层、六个不变量、为什么只报 diff | 20 分钟 |
| [core-speak.md](core-speak.md) | 直连气泡的接口需求（给宿主开发者） | 5 分钟 |

## 开发向

| 文档 | 内容 |
|---|---|
| [CONTRIBUTING](../CONTRIBUTING.md) | 环境、分层、加一个新动作要改哪四处 |
| [SECURITY](../SECURITY.md) | 这个插件能做什么、不能做什么 |
| [dev/token-cost-notes.md](dev/token-cost-notes.md) | 为什么这样设计上下文：O(n²) 与实测数据 |
| [dev/sts2-learn-from-bili.md](dev/sts2-learn-from-bili.md) | 一个没做完的设想：从攻略视频采打法 |

## 约定

- 命令一律可粘贴，路径用 `<你的插件目录>` / `<Coopanion 安装目录>` 占位；
- 每步都写"你应该看到什么"，对不上就跳 [06](06-troubleshooting.md)；
- 术语保留英文（world / tool / event），第一次出现加中文注解。