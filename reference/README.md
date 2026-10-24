# 写角色卡用的参考资料

两份资料，各有侧重：

| 目录 | 内容 | 适合查什么 | 能否进仓库 |
|---|---|---|---|
| `wiki/zh/`、`wiki/en/` | 星露谷官方 wiki 的 NPC 页面，另有友谊、婚姻、节日三个通用页面 | 生日、住处、家人、日程、送礼喜好、心事件梗概、趣闻 | 可以，许可是 CC BY-NC-SA，需要署名、不能商用 |
| `game/` | 从本机游戏（1.6.15）里导出的官方中文文本 | 角色的原话：说话语气、口头禅、心事件里的台词、信件 | 不行，这是游戏的版权内容，已经写进 `.gitignore` |

两份资料都是 2026-10-18 生成的。

## 建议的用法

1. 先读 `wiki/zh/<Npc>.md` 的开头、人际关系、心事件，建立对这个角色的整体印象。
   - 中文 wiki 是英文 wiki 的翻译，偶尔会落后几个版本；对不上的时候以 `wiki/en/` 为准。
2. 再翻 `game/<Npc>.md` 的日常台词和事件台词，体会这个角色怎么说话。“示例台词”按原版语气重新创作，不直接摘抄游戏原文。
3. 写“不能说的内容”时，对照 wiki 的心事件部分，以及 `game/` 里事件台词标注的条件。

## `game/` 里的标记

导出时把引擎的标记换成了容易读的写法：

| 显示为 | 原文 | 含义 |
|---|---|---|
| `／` | `#$b#` | 同一段对话的下一页 |
| `／／` | `#$e#` | 这段对话结束，剩下的部分玩家下次点击时才说 |
| `〈玩家〉` | `@` | 玩家的名字 |
| `〔开心〕〔难过〕〔害羞〕〔生气〕〔特殊〕` | `$h $s $l $a $u` | 说这句话时的头像表情 |
| `〔表情N〕` | `$N` | 该角色专属的第 N 号头像表情 |

下面这些保留了原样：
- `男版^女版`：按玩家性别选一句。（在信件里，`^` 是换行，已经替换成空格。）
- 以 `%` 开头的句子是旁白，比如 `%阿比盖尔脸红了`。`%adj`、`%noun` 是随机填入的词。
- `$c 0.5#A#B` 表示随机说 A 或 B；`$q`、`$r`、`$p`、`$y` 是原版的提问和分支。
- 信件末尾的 `%item …` 和 `[#]标题` 是附带物品和信件标题。

## 日常台词的键名

键名决定这句话什么时候出现，写“按心数解锁的话题”时可以参考：

| 键名 | 什么时候说 |
|---|---|
| `Introduction` | 第一次见面 |
| `Mon` … `Sun` | 星期几 |
| `Mon4`、`Fri6` 这类带数字的 | 那天好感达到这个心数以上 |
| `spring_Mon`、`fall_Wed6` | 某季节的星期几（可以带心数） |
| `summer_12` | 某季节的某一天 |
| `AcceptGift_(O)66` | 收到某件物品时的专属反应（括号里是物品 ID） |
| `AcceptBirthdayGift_*` | 生日收礼 |
| `eventSeen_<事件ID>_memory_oneday` / `_oneweek` | 看过某个事件之后一天 / 一周内会提起这件事。原版自带的“记忆”台词，可以参考 NPC 怎么回忆往事 |
| `dating_<NPC>`、`married_<NPC>` | 玩家和某人约会或结婚后，对这件事的反应 |
| `Resort_*` | 在姜岛度假村 |
| `GreenRain*` | 绿雨天 |
| `cc_*`、`joja_*` | 社区中心或 Joja 的进度 |
| `breakUp`、`divorced`、`dumped_*`、`secondChance_*` | 分手、离婚、被甩、和好 |

事件台词的标题里写了事件出现的条件。最有用的一项是 `f <NPC> <点数>`，表示需要多少好感点数，250 点 = 1 心。

## 重新生成

游戏或 wiki 更新后，可以用 `tools/reference/` 里的脚本重新生成。脚本只读取游戏文件，不会改动游戏目录。

```sh
# wiki：下载，再转换成 Markdown
python3 -I tools/reference/fetch_wiki.py <临时目录>/raw-wiki
python3 -I tools/reference/html2md.py <临时目录>/raw-wiki reference/wiki

# 游戏文本：需要 xnb@1.3.0。它的 1.3.0 版没有导出注册类型定义的接口，所以复制一份并补上导出
npm install --prefix <临时目录>/xnb --ignore-scripts xnb@1.3.0
mkdir <临时目录>/xnb-patched
cp <临时目录>/xnb/node_modules/xnb/dist/xnb.module.js <临时目录>/xnb-patched/xnb.module.mjs
echo 'export { TypeReader };' >> <临时目录>/xnb-patched/xnb.module.mjs
node tools/reference/extract_game.mjs <临时目录>/xnb-patched \
  "$HOME/Library/Application Support/Steam/steamapps/common/Stardew Valley/Contents/Resources/Content" \
  reference/game
```

`Data/Characters`、`Data/Objects` 这类带结构的数据，xnb@1.3.0 的类型定义跟不上 1.6.15，解不开，所以没有导出。它们的内容（生日、家人、物品）wiki 上都有。物品名到 ID 的对应已由 SMAPI Mod 在游戏里直接查询，123 个可送物品完成过游戏内识别核对，见 `docs/npc-mail.md`。
