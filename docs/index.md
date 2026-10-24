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

## 仓库长这样

```
cortico-world-sts-2/
├─ src/                 源码，按层分（读局面 / 传输 / 渲染 / 流程）
│  ├─ protocol.ts       桥的 JSON → 统一结构；动作 → 编号；回档检测
│  ├─ bridge.ts         HTTP + SSE、重连、断线后轮询兜底
│  ├─ render.ts         局面 → 几百字文本（只报变化段）
│  ├─ world.ts          编号仲裁、停手/观战、空动作宽限、事件、求解器接管
│  ├─ config.ts         46 个配置项（含默认值 + 设置页 schema）
│  ├─ tools.ts          10 个工具的声明
│  ├─ definition.ts     把上面这些装配成 World
│  ├─ solver.ts         求解器注记与接管
│  ├─ chatter.ts        台词池与档位（观战用 watch，自己打用 self）
│  ├─ passport.ts       回档 / 换局 / 漂移判定
│  ├─ savefile.ts       只读存档里的两个字段
│  ├─ intent.ts         这一局的构筑意图
│  ├─ auto.ts           没得选时替玩家推进
│  └─ ENV_PROMPT.md     给模型的环境提示词
├─ tests/               163 个用例 + 来自真机抓包的 fixtures
├─ scripts/             抓包、探针、生成 describe.json 与依赖清单
├─ docs/                就是你在读的这套（01–07 + dev/）
├─ .github/             CI、Release、issue / PR 模板
├─ describe.json        工具/事件/提示词的清单（由 pnpm describe 生成）
├─ CHANGELOG.md         27 个版本的真实记录，含踩过的坑
└─ README.md            门面 + 完整技术细节
```

不想看结构，只想改东西：先读 [CONTRIBUTING](../CONTRIBUTING.md) 的「加一个新动作要改四处」。

## 约定

- 命令一律可粘贴，路径用 `<你的插件目录>` / `<Coopanion 安装目录>` 占位；
- 每步都写"你应该看到什么"，对不上就跳 [06](06-troubleshooting.md)；
- 术语保留英文（world / tool / event），第一次出现加中文注解。