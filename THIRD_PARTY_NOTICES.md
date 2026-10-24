# Third-party notices

本文件列出本项目**使用、参照或依赖**的全部外部成果，以及各自的权利状态。
代码许可证见 [`LICENSE`](LICENSE)（MIT）。本仓库**不包含**任何游戏文件、游戏 mod、美术或音频素材。

---

## 1. 宿主与运行时

| 名称 | 关系 | 许可证 | 本项目做了什么 |
|---|---|---|---|
| [Cortico](https://github.com/Pal-AI-Lab/Cortico)（Coopanion） | 宿主应用；本插件是其 World 扩展 | 以其项目为准 | 通过其 World 契约（api 6）注册 `sts-2` World，调用其工具/事件/配置接口；**非官方组件，未获背书** |
| [`cortico`](https://www.npmjs.com/package/cortico) 0.2.5 | 宿主提供的 SDK（devDependency） | MIT | 只用类型与接口声明，不打包分发 |
| Node.js ≥ 22 | 运行时 | MIT | 不随本仓库分发 |

## 2. 架构参照

| 名称 | 参照了什么 | 许可证 | 是否复制代码 |
|---|---|---|---|
| [cortico-world-sts-1](https://github.com/Phantivia/cortico-world-sts-1)（作者 Phantivia） | 三个已验证的做法：**状态码绑定动作编号**、**回执只报变化段**、**截图作为兜底观察** | MIT | **没有**。塔 1 走 Java + ModTheSpine + CommunicationMod 的 TCP sidecar，塔 2 走 Godot + C# 的 HTTP/SSE；桥、状态结构、动作参数全不同，代码按塔 2 重写 |

## 3. 游戏内桥（运行时外部依赖，**不由本仓库分发**）

本 World 只消费它们的本地 HTTP 接口，不打包、不链接、不复制其代码。

| 名称 | 提供什么 | 许可证 | 说明 |
|---|---|---|---|
| **NekoSpire**（猫娘尖塔，`zhaijiunknow/n.e.k.o_plugin_sts2_autoplay`） | `/state`、`/action`、`/events/stream`、`/solver/plan`、`/capture` | **AGPL-3.0** | 需使用者自行从创意工坊安装（工坊 ID `3794941932`）。它与本项目是**两个独立程序**，仅通过 `127.0.0.1:18080` 的 HTTP 通信，不构成衍生作品 |
| **RitsuLib 0.6.0+** | NekoSpire 的通用前置 mod | 以其项目为准 | 不涉及 |
| **sts2-mcp-bridge / Communication_Mod** | 另一套把塔 2 状态与动作暴露出来的实现 | 以其项目为准 | 文档中作为备选桥提及，未捆绑 |

> 换桥只需改 `baseUrl` 与路径配置；本 World 不假设桥的具体实现。

## 4. 游戏

| 名称 | 说明 |
|---|---|
| **《杀戮尖塔 2》**（Slay the Spire 2，Mega Crit） | 商业软件。本仓库不含任何游戏文件、美术、音频、剧情文本或反编译代码；使用者需自备正版。游戏内状态字段与卡牌名称为事实性名词，测试夹具只保留判定所需的字段。Slay the Spire 为 Mega Crit 的商标，本项目与其无隶属关系、未获背书 |

## 5. 开发工具链（devDependencies，不进发布产物）

<!-- deps:begin 由 scripts/gen-notices.mjs 生成，勿手改 -->
| 名称 | 用途 | 许可证 |
|---|---|---|
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped) 22.20.5 | Node 类型声明 | MIT |
| [cortico](https://www.npmjs.com/package/cortico) 0.2.5 | 宿主 SDK，只用类型与接口 | MIT |
| [tsx](https://www.npmjs.com/package/tsx) 4.23.15 | 跑 TS 脚本 | MIT |
| [typescript](https://www.npmjs.com/package/typescript) 5.9.3 | 编译器 | Apache-2.0 |
| [vitest](https://www.npmjs.com/package/vitest) 2.1.9 | 单元测试 | MIT |
<!-- deps:end -->

## 6. 方法与灵感

| 名称 | 借鉴了什么 | 说明 |
|---|---|---|
| `dsh-bili-scroll` | 从攻略视频采集打法的思路 | 见 [`docs/dev/sts2-learn-from-bili.md`](docs/dev/sts2-learn-from-bili.md)，属实验性设想，尚未进入代码 |
| [LLM Agent 的 token 成本优化实践](docs/dev/token-cost-notes.md) | 状态重建而非历史摘要、前缀缓存、diff 回执 | 本 World 的「局面只报变化、编号不复用、求解器只作注记」都来自这套判断 |

## 7. AI 辅助声明

部分代码、测试与文档在 AI 编程助手的辅助下完成；所有提交由维护者审阅并负责。

---

## 附：如何核对本文件

```bash
pnpm licenses list          # 依赖许可证
pnpm notices                # 重新生成本文件的第 5 节
```

发现遗漏或标注有误，请开 issue 或直接提 PR —— 这类修正永远欢迎。