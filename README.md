# cortico-world-sts-2

[![CI](https://github.com/chenxinmengY/cortico-world-sts-2/actions/workflows/ci.yml/badge.svg)](https://github.com/chenxinmengY/cortico-world-sts-2/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-163%20passing-brightgreen.svg)](tests)

给 Coopanion（Cortico）的**《杀戮尖塔 2》** World：她自己连着打——出牌、选路、领奖励都由她决定；
你只在忍不了的时候说一句，那句话就是打断。想停就说停。

> **非官方项目。** 与 Mega Crit（《杀戮尖塔 2》）、Pal-AI-Lab（Coopanion / Cortico）、
> NekoSpire 作者均无隶属或背书关系。
> **本仓库不包含任何游戏文件、游戏 mod、美术或音频素材**；使用时需自备正版游戏，并自行安装桥 mod。
> 仅供个人学习与自用，请遵守游戏与各 mod 的许可条款。

<!-- TODO(维护者)：这里放一张 20 秒的 GIF —— 她打完一层，弹气泡「这波厉害不？」 -->

<details>
<summary>本页目录（13 节）</summary>

1. [30 秒安装](#30-秒安装)
2. [文档](#文档)
3. [前置](#前置)
4. [安装](#安装)
5. [她怎么打](#她怎么打)
6. [台词池（dataDir/chatter.json）](#台词池datadirchatterjson)
7. [工具与事件](#工具与事件)
8. [动作与参数（按 mod 源码核对）](#动作与参数按-mod-源码核对)
9. [校准状态](#校准状态)
10. [取数据（需要时）](#取数据需要时)
11. [已知限制](#已知限制)
12. [开发](#开发)
13. [许可与致谢](#许可与致谢)

</details>

## 30 秒安装

前置三件：正版游戏 + NekoSpire（工坊 `3794941932`）+ Coopanion / Cortico 0.2.x。

1. 把本目录作为本地 World 扩展装进 Coopanion，重启进程；
2. 在 World 概览里启用 `worlds.sts-2`；
3. 开游戏进一局，自检桥：

```powershell
curl.exe http://127.0.0.1:18080/health   # 期望 {"ok":true,...,"status":"ready"}
```

看到绿灯就成了。**装不上？** → [docs/01-install.md](docs/01-install.md)
**它为什么这么打？** → [docs/07-architecture.md](docs/07-architecture.md)

## 文档

| 想干什么 | 去哪 |
|---|---|
| 装起来、跑通、排错 | [01 安装](docs/01-install.md) · [06 出问题了](docs/06-troubleshooting.md) |
| 第一次用，看它怎么动 | [02 第一次运行](docs/02-first-run.md) |
| 改配置、调性格、换台词 | [03 配置全解](docs/03-config.md) · [05 台词池](docs/05-chatter.md) |
| 搞清工具与事件 | [04 工具与事件](docs/04-tools.md) |
| 想改代码 / 接别的游戏 | [07 架构](docs/07-architecture.md) · [CONTRIBUTING](CONTRIBUTING.md) |

## 前置

| 需要 | 说明 |
|---|---|
| 《杀戮尖塔 2》 | 抢先体验版；实测 `0.111.0` 可用 |
| **RitsuLib 0.6.0+** | 塔 2 mod 的通用前置（NekoSpire 的 `mod_manifest.json` 要求 0.6.0） |
| **NekoSpire**（猫娘尖塔） | 工坊 `3794941932`。它提供 `/state`、`/action`、`/events/stream`；**不用装 NEKO 客户端** |
| Coopanion / Cortico | World 契约 6（Cortico 0.2.x） |
| 直连气泡（可选） | 需要宿主提供一条不唤醒模型的发言通道；没有就自动退回 `sts-2.murmur` 事件，功能不受影响。接口形状见 [docs/core-speak.md](docs/core-speak.md) |

桥默认监听 `127.0.0.1:18080`（mod 侧可用 `STS2_API_PORT` 改），只绑本机。

> 不是 `cortico-world-sts-1` 的移植：塔 1 是 Java + ModTheSpire + CommunicationMod，塔 2 是
> Godot + C#，两边的桥、状态结构、动作参数完全不同。这里直接吃塔 2 侧 mod 的 **HTTP 桥**。

## 安装

1. 本目录作为本地 World 扩展装进 Coopanion，重启进程，在 World 概览里启用 `worlds.sts-2`。
2. 确认 **桥地址** 与 mod 端口一致（默认 `http://127.0.0.1:18080`）。
3. 先开游戏进一局，再启用 World。
4. 自检：`curl.exe http://127.0.0.1:18080/health` 应回 `{"ok":true,..."status":"ready"}`。

**游戏没开也没关系**：World 会亮 error 灯并每 5 秒重连，不影响 Coopanion 启动；游戏开起来后自动接上。

## 她怎么打

- 局面一变就推 `sts-2.state`，她看编号动手；一轮只动一次。**没有"每步请示"**。
- 状态码绑编号：局面一变旧编号立刻作废，她拿到新状态重来——所以你偶尔插手不会和她打架。
- 她动过手而游戏仍在等，会补一条 `sts-2.decision`；不动手就不提醒。
- `sts2_pause` 后进入**观战模式**：不推局面、不自己动，只看你打；`sts2_resume` 接着打。
- **观战也会说话**：你掉血、你打赢，她用第二人称说一句（「你这血」「这一下差点把你打飞了」）。
  台词池分两套，观战用 `watch`、自己打用 `self`，互不串味。
- **没得选就替她点**（`sts-2.auto`）：只剩"结束回合 / 领完继续 / 打开宝箱 / 离开商店"这类推进动作时自动执行；
  只要还剩一项需要取舍（选牌、路线、事件、买什么、喝不喝药水），就停下等她或你。
- **同一个操作失败过就不再提交**；同一局面连着被拒到阈值，会停手并在面板上说一句。
- **偶尔说一句**：战斗结束夸一句、挨打喊一声疼，概率 + 冷却双重压着。默认**直连桌宠气泡**（不进模型、0 token、<0.3 秒）；
  台词池在数据目录的 `chatter.json`，按伤情分档，可热改；`chatterDelivery:"model"` 才退回 `sts-2.murmur` 让模型复述。
- **回档判定读存档**：`current_run.save` 里的 `num_reloads` 与 `rng.seed` 是硬证据；读不到就退回纯内存判定。
  篝火回满血不再被误判成读档。
- 战斗里桥短暂不给动作（敌方回合 / 动画）不算卡住；宽限期按 `combatGraceMs` 走。
- **求解器只作注记**：战斗里提前读桥自带的 `/solver/plan`，把「下一步 → 编号」贴一行到局面尾部；
  搜索没算完、有它不认识的牌、置信不够时干脆不贴。它永远不会替她出牌。
- **也可以让它整场代打**（`solverAutoplay`，默认关）：战斗里由求解器一步步打，**整场不叫醒模型**，
  只在需要决策时交回——它算不出、编号对不上、生命低于 `solverAutoplayStopHpPct`、结束回合会死、
  步数到 `solverAutoplayMaxSteps`，或者已经离开战斗。每场只发一条 `sts-2.auto` 摘要，
  敌方回合的空动作在接管里等着，不会把模型拽出来。
- **她自己不算账**：战斗局面里直接给出「入射 / 最多可挡 / 缺口 / 预计剩血 / 会不会死」。
- **一次给一整轮**：`sts2_play` 按"牌名 + 目标"执行整批步骤（≤8），一回合只占一轮模型调用。
- **局面会攒着**：她还在想的时候，新变化先合并，等下一次工具调用或回合结束再推（`queueStateEvents` 可关）。
- **局面不反复读**：每份回执和事件都带局面与编号；`sts2_observe` 默认保留（求解器交回/回档后要靠它拿新码），
  想省调用可以关 `exposeObserve`。要看牌组构成、全图或完整局面，用 `sts2_inspect({what:"deck"|"map"|"full"})`。
- **单步会提醒批处理**：战斗里 `sts2_do` 之后，回执末尾会提示「还能打 N 张，用 sts2_play 一次提交」；`batchHint` 可关。
- **玩家的话有两层**：`sts2_steer` 记临时指令（下一步 / 本层 / 本界面 / 直到撤销），自动过期；
  `sts2_intent` 记这一局的构筑意图（"走毒"），换局自动作废。两者都会挂在之后每份局面上。

## 台词池（dataDir/chatter.json）

首次触发闲话时会自动写一份默认的，改完保存即生效（2 秒内），不用重启。两套语料：

- `watch`：她看你打，用第二人称（「你这血」「看着都疼」）；
- `self`：她自己打，用第一人称（「疼死我了」「这波厉害不？」）。

```jsonc
{
  "watch": {
    "hurt": { "light": ["【worried】嘶，${loss} 点，看着有点疼。"],
              "heavy": ["【worried】这一下差点把你打飞了。"] },
    "win":  { "normal": ["【happy】这波打得漂亮。"] }
  },
  "self": {
    "hurt": { "light": ["【pout】我去，${loss} 点，疼死我了。"],
              "heavy": ["【worried】我去，这一下差点把我打飞了。"],
              "lethal": ["【scared】别别别，再一下我就没了。"] },
    "win":  { "normal": ["【happy】这波厉害不？", "【smug】看到没，这波操作。"],
              "lowHp": ["【happy】赢了……吓死我了，就剩 ${hp} 点。"] }
  }
}
```

- 模式按 `sts2_pause` 判断：观战 = `watch`，自己打 / 求解器接管 = `self`。
- 旧格式（根上直接写 `hurt` / `win`）自动当作 `watch`，`self` 用默认；也支持旧格式 + `self` 混写。
- 档位：掉血 5–11 → light，≥12 或血 <35% → heavy，血 ≤15% → lethal；赢了血 <30% → lowHp。
- 支持 `${loss}` `${hp}` `${maxHp}` `${floor}`；`【…】` 是桌宠的表情/动作标记。
- 同一个池子里不会连着说同一句；频率由 `chatterCooldownMs`、两个概率和 `chatter` 档位控制。
- 句尾口癖由 `chatterSuffix` 统一加（默认「，库…」；留空就不加）。

## 工具与事件

| 工具 | 作用 |
|---|---|
| `sts2_inspect` | 看牌组 / 地图 / 完整局面；按需拉取，不重发整屏 |
| `sts2_observe` | 重读局面与编号；求解器交回/回档后拿新码用（`exposeObserve` 可关） |
| `sts2_do` | 按编号执行一个动作，等结算后回报结果与变化 |
| `sts2_play` | 一次提交一整轮（≤8 步），只回一份回执 |
| `sts2_pause` / `sts2_resume` | 停手 / 恢复 |
| `sts2_capture` | 截图；桥没有 `/capture` 时**明确失败**，不编造画面 |
| `sts2_probe` | 排障：原样吐 `/state` + 归一化摘要；默认不暴露（`devTools` 打开） |

| 事件 | 何时 |
|---|---|
| `sts-2.state` | 局面变了 |
| `sts-2.decision` | 她动过手，游戏仍在等 |
| `sts-2.connection` | 桥断了（已提交动作的结果可能未确认） |
| `sts-2.blocked` | 这一屏桥没给动作，需要人点一下；**宽限 1.5 秒确认后才提醒，每个状态只提醒一次** |
| `sts-2.rollback` | 检测到回档/重开（快速 SL、节点回退、换局），旧判断作废 |

## 动作与参数（按 mod 源码核对）

参数名不统一，这是这套桥最容易踩的坑：**出牌用 `card_index` + `target_index`，其余带编号的动作一律 `option_index`**。

| 动作 | 编号字段 | 编号空间 |
|---|---|---|
| `play_card` | `card_index` / `target_index` | 手牌 `index` / 该牌的 `valid_target_indices` |
| `choose_map_node` | `option_index` | 可走节点（`agent_view.map.options` 的顺序） |
| `claim_reward` | `option_index` | `reward.rewards` |
| `choose_reward_card` | `option_index` | `reward.card_options`（-1 = 跳过） |
| `select_deck_card` | `option_index` | `selection.cards` |
| `choose_treasure_relic` | `option_index` | `chest.relic_options` |
| `choose_event_option` | `option_index` | `event.options` |
| `choose_rest_option` | `option_index` | `rest.options` |
| `buy_card` / `buy_relic` / `buy_potion` | `option_index` | `shop.cards` / `relics` / `potions` |
| `use_potion` / `discard_potion` | `option_index` | `run.potions[].index`（只列当前能用的槽） |
| `choose_bundle` / `choose_capstone_option` | `option_index` | `bundles.*` |
| `end_turn` / `open_chest` / `proceed` / `confirm_selection` … | 无 | — |

**不给编号的动作**：`save_and_quit`、`abandon_run`——她不该顺手把局退了。

## 校准状态

规则不是抄文档，是拿真机抓包和 mod 源码（`GameActionService.cs`）对齐的。
代表样本已脱敏固化成 `tests/fixtures/`，测试直接跑真数据（**163 个用例**）。

| 界面 | 覆盖 |
|---|---|
| 主菜单 / 先古事件 / **13 个**普通问号事件 | ✓ |
| 战斗（t1 出牌前后、t2–t4、双敌人） | ✓ |
| 地图（第 0/1/2 幕，分别 16/15/14 行） | ✓ |
| 战利品、奖励选牌（3 候选） | ✓ |
| 牌组选牌：升级 / 移除 / 附魔三种 `kind` | ✓ |
| 商店（未开 / 开） | ✓ |
| 篝火（含遗物带来的挖掘等附加选项） | ✓ |
| 宝箱（开前 / 开后） | ✓ |
| 游戏结束 | ✓ |

**唯一缺口**：事件里点开选牌屏的那种（`event` 与 `selection` 同时非空）。现有 13 个事件都没进二级选牌，
这一屏的块优先级还没实证。遇到时导一份即可（`scripts\dump-state.cmd` 会自动命名）。

另外没测到：需要选 2 张并确认的多选屏（`requires_confirmation=true`）、3 个以上敌人的战斗。

## 取数据（需要时）

```powershell
cd "<你的插件目录>"; .\scripts\dump-state.cmd
```

自动按界面命名（战斗带回合号），文件落在 `samples\`（**不进版本库**），同时打印 `界面=COMBAT 动作=7`
这样的摘要——摘要里动作为 0 就说明那一屏读不懂，这种样本最有价值。

## 已知限制

- **求解器不在这个世界里**：动作质量取决于桥。NekoSpire 自带 Combat Solver，打得像样；
  只给状态的桥，她得读卡面自己判断。
- **有些屏没人能替**：桥侧没有动作的界面（例如某些遗物选择）她会停下等你点。
- **没有键鼠注入**：故意不做。看不到的界面就停住，不用坐标硬点。
- **beta 风险**：塔 2 beta 改得快，靠反射读私有成员的 mod 会先崩；这个 World 只读 HTTP 文本，受影响最小。
- **多人局**：能读局面、能出自己那份手牌。地图进图后先压 `coopRouteWaitMs`（默认 4 秒）给队友投票，
  局面里会带「投票：P2 → (1,3)」和每个节点的票数，她优先跟随多数；同机双开当第二名玩家不在本 World 范围。

## 开发

```bash
pnpm install
pnpm test        # 163 个用例，夹具全部来自真机抓包
pnpm typecheck
pnpm check       # typecheck + test
pnpm describe    # 改了工具/事件后重新生成 describe.json
pnpm notices     # 重新生成依赖清单
```

分层：`protocol.ts`（宽容归一化 + 动作编号映射 + 回档检测）、`bridge.ts`（HTTP/SSE + 重连 + 轮询兜底）、
`render.ts`（分区渲染 + 增量）、`world.ts`（编号仲裁、停手、空动作宽限、事件）、`config.ts` / `tools.ts` / `definition.ts`。
细节见 [docs/07-architecture.md](docs/07-architecture.md)。

## 许可与致谢

MIT，见 [LICENSE](LICENSE)。完整的外部成果清单（含许可证与"用了什么/没复制什么"）见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

- 架构参照 [cortico-world-sts-1](https://github.com/Phantivia/cortico-world-sts-1)（MIT，作者 Phantivia）的三个做法——
  状态码绑定编号、回执只报变化、截图兜底；代码按塔 2 的 HTTP 桥重写，未复制其实现。
- 桥属于各自作者（NekoSpire 为 **AGPL-3.0**）。本仓库不打包、不链接、不分发它们，只通过本地 HTTP 接口调用，
  许可证以原项目为准。
- 部分代码与文档在 AI 编程助手辅助下完成，所有提交由维护者审阅并负责。