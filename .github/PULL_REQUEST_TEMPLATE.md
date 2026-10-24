## 这个 PR 做了什么

<!-- 一句话。如是修 bug，写清症状；如是新功能，写清它解决谁的什么问题。 -->

## 改动落在哪一层

- [ ] `protocol.ts`（桥字段归一化 / 动作编号映射）
- [ ] `bridge.ts`（HTTP / SSE / 重连）
- [ ] `render.ts`（渲染与增量）
- [ ] `world.ts`（编号仲裁 / 停手 / 事件 / 接管）
- [ ] `config.ts` + 设置页 schema
- [ ] `tools.ts` / `definition.ts`（**记得跑 `pnpm describe`**）
- [ ] 测试夹具 / 测试
- [ ] 文档

## 核对

- [ ] `pnpm check` 通过
- [ ] 改了工具或事件 → 跑过 `pnpm describe` 并提交 `describe.json`
- [ ] 新增了动作 → `INDEX_ACTIONS`、`ACTION_LABEL`、README 动作表三处都更新了
- [ ] 夹具里的 `run_id` 已替换为 `FIXTURE_RUN_N`（同一局保持同一个假名）
- [ ] 没有提交 `samples/`、`node_modules/`、个人路径或 token

## 怎么验证的

<!-- 真机？哪个界面？跑了多少局？测试里新增了哪个用例？ -->

## 备注

<!-- 已知限制、后续要做的、或者你不确定的地方 -->