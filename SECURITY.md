# 安全策略

## 这个插件能做什么、不能做什么

本 World 是一个**本地客户端**：它读取一个**由你自己安装的游戏内 mod** 通过 HTTP 暴露出来的局面，并把动作提交回去。

| 能做 | 不能做 |
|---|---|
| 读 `http://127.0.0.1:18080/state` 的 JSON | 读取游戏进程内存 |
| 向 `/action` 提交结构化的动作编号 | 模拟键鼠、注入坐标点击 |
| 读 `/events/stream` 的事件流 | 读写游戏存档（只读 `current_run.save` 的 `num_reloads` 与 `rng.seed` 用于回档判定） |
| 读 `/solver/plan` 的战斗建议 | 上传任何数据到外部服务器 |
| 读 `/capture` 的截图（桥支持时） | 联网（除 `baseUrl` 指向的本地地址外） |

**没有键鼠注入是刻意设计**：看不到的界面就停住等人，不用坐标硬点。这也是它不会误触你其他窗口的原因。

`save_and_quit` 与 `abandon_run` 两个动作**不提供编号**，模型无法通过本插件退掉你的局。

## 数据流向

```
游戏 ←→ 游戏内 mod（第三方，自行安装）  ←HTTP 127.0.0.1→  本 World  ←→  宿主（Coopanion）
```

- 本 World 不发起任何外网请求；
- 台词池、配置、日志都落在宿主的数据目录，不外传；
- 局面文本会进入模型上下文——**这是功能本身**，请注意你的模型服务商数据政策与你自己安装的 mod 的政策。

## 报告漏洞

请用 GitHub 的 [Private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)（仓库 → Security → Report a vulnerability），不要开公开 issue。

请包含：版本号、宿主版本、复现步骤、影响范围。48 小时内会收到回应。

## 范围之外

以下不属于本项目的安全问题，请找对应项目：

- 游戏内 mod 自身的漏洞 → 它的仓库；
- 宿主应用（Coopanion / Cortico）的漏洞 → 它的仓库；
- 游戏本身的漏洞 → 游戏厂商。