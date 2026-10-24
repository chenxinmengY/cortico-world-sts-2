# 05 · 台词池

她偶尔会说话：打完一场夸一句，挨一下重的喊声疼。这些话**默认不经过模型**——直接进桌宠气泡，不花 token。

台词存在数据目录的 `chatter.json`，**改完保存即生效**（2 秒内），不用重启。

想让她闭嘴：配置里把 `chatter` 设成 `off`。

---

## 文件在哪

```
<Coopanion 数据目录>/home/.../chatter.json
```

第一次触发闲话时自动生成一份默认的。找不到就去配置里看 `chatterLinesFile`——

- 留空 = 用数据目录下的 `chatter.json`；
- 填了路径 = 用你指定的那份（**换路径要重启**，改内容不用）。

---

## 两套语料

| 池 | 什么时候用 | 人称 |
|---|---|---|
| `watch` | 她看你打（你暂停了她） | 第二人称：「你这血」「看着都疼」 |
| `self` | 她自己打，或求解器接管 | 第一人称：「疼死我了」「这波厉害不？」 |

两份池子分开写，因为"你"和"我"不能混。

---

## 结构

```jsonc
{
  "watch": {
    "hurt": {
      "light": ["【worried】嘶，${loss} 点，看着有点疼。"],
      "heavy": ["【worried】这一下差点把你打飞了。"],
      "lethal": ["【scared】别别别，再来一下你就没了。"]
    },
    "win": {
      "normal": ["【happy】这波打得漂亮。"],
      "lowHp": ["【happy】赢了……就剩 ${hp} 点，吓人。"]
    }
  },
  "self": {
    "hurt": {
      "light": ["【pout】我去，${loss} 点，疼死我了。"],
      "heavy": ["【worried】我去，这一下差点把我打飞了。"],
      "lethal": ["【scared】别别别，再一下我就没了。"]
    },
    "win": {
      "normal": ["【happy】这波厉害不？", "【smug】看到没，这波操作。"],
      "lowHp": ["【happy】赢了……吓死我了，就剩 ${hp} 点。"]
    }
  }
}
```

### 五个档位

| 档位 | 触发条件 |
|---|---|
| `hurt.light` | 一次掉 5–11 点血 |
| `hurt.heavy` | 掉 ≥12 点，**或**血量低于 35% |
| `hurt.lethal` | 血量 ≤ 15% |
| `win.normal` | 赢了，且血量 ≥ 30% |
| `win.lowHp` | 赢了，但血量 < 30% |

档案里没写的档位会退回 `light` / `normal`，所以只写一两句也能跑。

### 四个占位符

| 占位符 | 替换成 |
|---|---|
| `${loss}` | 这一次掉了多少血 |
| `${hp}` | 当前血量 |
| `${maxHp}` | 最大血量 |
| `${floor}` | 当前层数 |

### 表情与动作标记

句首的 `【…】` 是给桌宠的表演指令：

```
【worried】这一下差点把我打飞了。
```

可用表情和动作由**桌宠**决定（不是这个插件），常见的有 `happy` `sad` `worried` `scared` `smug` `pout` `thinking` `determined`。写错不会报错，最多是不表演。

---

## 三条规则

1. **同一个池子里不会连着说同一句。** 两份以上候选时会自动换一条。
2. **频率由三个开关压着**：`chatter`（off/rare/normal）、两个概率（`chatterWinChance` / `chatterHurtChance`）、`chatterCooldownMs`（默认 45 秒）。三者是"与"的关系，任一条不满足就不说。
3. **句尾口癖统一加。** `chatterSuffix` 默认「，库…」，会把原来的句号替换掉；留空就不加。走模型（`chatterDelivery: model`）时不生效，由模型自己带。

---

## 兼容旧格式

老版本把 `hurt` / `win` 直接写在根上：

```jsonc
{ "hurt": { "light": ["…"] }, "win": { "normal": ["…"] } }
```

这种会被当作 `watch` 处理，`self` 用默认。也支持"旧格式 + `self`"混写。

---

## 几个写法示例

**只让她夸，不让她喊疼：**

```jsonc
{ "self": { "win": { "normal": ["【happy】过了。"], "lowHp": ["【happy】差点没了。"] } } }
```

`hurt` 缺失 → 退回默认，想彻底不说疼就把 `chatterHurtChance` 设 0。

**毒舌一点：**

```jsonc
{
  "self": {
    "hurt": { "heavy": ["【smug】这就是你说的稳？"] },
    "win":  { "lowHp": ["【smug】赢得难看也是赢。"] }
  }
}
```

**按层数变化**（打深了更紧张）：

```jsonc
{ "self": { "win": { "normal": ["【happy】第 ${floor} 层，稳。"] } } }
```

---

下一个：[06 出问题了](06-troubleshooting.md) —— 卡住、重复、读不懂，都在这。