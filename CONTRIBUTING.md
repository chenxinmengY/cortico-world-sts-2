# 参与开发

先说结论：**这个项目最需要的是「真机抓包」**。桥给的字段会随游戏版本变，抓包是最有效的贡献方式，比改代码还有用。

---

## 环境

| 需要 | 版本 |
|---|---|
| Node.js | ≥ 22 |
| pnpm | ≥ 9 |
| 游戏 + NekoSpire mod | 只有真机调试才需要；跑测试不需要 |

```bash
pnpm install
pnpm test        # 163 例，夹具全部来自真机抓包
pnpm typecheck
pnpm check       # 两者一起
pnpm describe    # 改过 tools.ts / definition.ts 后重新生成 describe.json
```

`describe.json` 是生成物，**改了工具或事件就要重新生成并一起提交**，否则宿主读到的还是旧的。

## 分层

```
src/
├─ protocol.ts   # 宽容归一化：把桥的花样字段读成统一结构；动作编号映射；回档检测
├─ bridge.ts     # HTTP + SSE、重连、断线后轮询兜底
├─ render.ts     # 分区渲染 + 增量（只报变化段）
├─ world.ts      # 编号仲裁、停手、空动作宽限、事件、接管（最大的一块）
├─ config.ts     # 配置默认值 + 宿主设置页的 schema
├─ tools.ts      # 工具声明（名字、参数、描述）
├─ definition.ts # World 定义：把这堆东西装配起来
├─ solver.ts     # 求解器注记与接管
├─ chatter.ts    # 台词池
├─ passport.ts   # 回档/换局判定
├─ savefile.ts   # 读 current_run.save 的两个字段
├─ intent.ts     # 构筑意图
├─ auto.ts       # 没得选时替玩家推进
└─ index.ts      # 导出入口
```

改代码前先想清楚落在哪一层：

- 桥又改名了 → `protocol.ts`
- 事件流断了没重连上 → `bridge.ts`
- 模型看漏了某个字段 → `render.ts`
- 流程卡住 / 重复动作 / 提醒太吵 → `world.ts`
- 想加开关 → `config.ts`（同时补 schema，否则设置页里没有）

## 加一个新动作要改四处

桥新增一个带编号的动作（例如某个 mod 加的 `choose_blessing`）：

1. **`protocol.ts` 的 `INDEX_ACTIONS`** —— 告诉它编号取自状态里的哪个数组：
   ```ts
   choose_blessing: (state) => asArray(pick(state, 'blessing.options')),
   ```
   漏了这一步，动作会解析出来但没有编号可选，表现为"桥给了动作她却不动"。

2. **`protocol.ts` 的 `ACTION_LABEL`** —— 给模型看的动作名（中文短句）。

3. **`tests/fixtures/`** —— 放一份真机抓包（用 `scripts/dump-state.cmd` 采），再在对应 `*.test.ts` 里断言归一化结果。

4. **`README.md` 的动作表** —— 标清它用 `option_index` 还是 `card_index` / `target_index`。**参数名不统一是这套桥最大的坑**，表格不更新就会有人照着旧表写错。

## 采一份抓包

```powershell
.\scripts\dump-state.cmd
```

自动按界面命名落到 `samples\`（战斗带回合号），同时打印 `界面=COMBAT 动作=7` 这样的摘要。
**摘要里动作是 0，就说明那一屏读不懂** —— 这正是最有价值的样本，请连同游戏版本一起贴进 issue。

夹具入库前要脱敏：`run_id` 换成 `FIXTURE_RUN_N`（同一局用同一个假名，别换乱，否则回档检测的测试会误判）。

## 提交规范

- 一个提交只做一件事，提交信息写**为什么**而不是**改了什么**（`git log` 里能看到历史包袱才好维护）。
- PR 前跑 `pnpm check`。
- 行为变更请补测试；修 bug 请先写出能复现的用例。
- 中文、英文都行，按你顺手来。

## 报 bug 请带上

1. 插件版本（`package.json` 的 `version`）；
2. 宿主版本；
3. 桥的类型与版本（NekoSpire / sts2-mcp-bridge / 其他）；
4. 出问题的界面（战斗 / 地图 / 商店 / 事件…）与当时的 `sts2_probe` 输出（把 `devTools` 打开一次）；
5. 如果是"卡住"，说明是**她不动**还是**动了但被拒**。

## 不开 PR 也能帮上忙

- 贴一份某个界面读不懂的抓包；
- 报一句"这版本改了字段名"；
- 补一条台词（`chatter.json` 的格式见 [docs/05-chatter.md](docs/05-chatter.md)）；
- 在 issue 里回答别人的问题。