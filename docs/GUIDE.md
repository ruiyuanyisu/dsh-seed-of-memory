# 使用说明（1.4.6）

这是 Seed of Memory 的说明书。面板上每一页、每个配置项、常见问题都在这里；
只想先把东西跑起来，看「[五分钟上手](#五分钟上手)」就够了。

## 目录

- [五分钟上手](#五分钟上手)
- [它是什么](#它是什么)
- [安装与升级](#安装与升级)
- [数据放在哪](#数据放在哪)
- [面板每一页](#面板每一页)
- [配置](#配置)
- [命令与工具](#命令与工具)
- [情绪内核](#情绪内核)
- [路由：谁能来、进哪个工作区、记忆落哪一档](#路由谁能来进哪个工作区记忆落哪一档)
- [QQ](#qq)
- [离线资源](#离线资源)
- [和别的记忆插件一起用](#和别的记忆插件一起用)
- [常见问题](#常见问题)
- [隐私与边界](#隐私与边界)

## 五分钟上手

1. 装：交给 DSH 的 `plugin_manager`，或者用「更新包」里的 `update.ps1`（见[安装与升级](#安装与升级)）。
2. 打开设置页 →「记忆之种」，确认「概览」里根、记忆、卡片大小都有数。
3. 在对话里打 `/seed status`，看到「共 N 条」就说明活了。
4. 想要它记住什么，直接说；或者让它自己决定（它会用 `seed_remember`）。
   想手动加一条：`/seed remember 他说周末想去山里`。
5. 想接 QQ？看 [QQ](#qq)；不想接也不影响别的功能。

常用的三条：`/seed status`（现在什么样）、`/seed mood`（此刻心情）、`/seed help`（全部命令）。

## 它是什么

本地优先的记忆层：根、记忆、认知、情绪、情感、人格、说话习惯，全在一个 SQLite 文件里，
不联网也能跑。它不改事实，只决定「记得什么」和「怎么说」。

- **根**：`anchors.md` / `self.md` / `us.md` 三页纯文本，每轮最先注入。
  工具不能改根，只能往里**追加**（`seed_anchor`）；直接编辑文件也可以。
- **记忆**分四层：persona（不衰减、≤120 字）/ semantic（180 天）/ episodic（14 天）/ buffer（1 天、不进卡）。
  每条带你确认的「来源」与置信度，旧的退场但留链（`seed_inspect why` 能追）。
- **认知**：带证据与置信度的判断；跟已有的冲突时挂起，等你定（`/seed pending`、`/seed keep`）。
- **情绪**：两层——一层是每句话的被动打分（积极性 / 委屈 / 愧疚 / 压力），一层是六维评估
  （重要吗、顺不顺、确定吗、能控制吗、谁造成的、意外吗）。只影响语气和召回权重。
- **情感**：对你（信任 / 亲近 / 欣赏 / 依恋），30 天半衰期回落；情绪只轻轻推它一下。
- **人格**：从记忆与认知里长出来的特质，有每日上限，也记反例。
- **说话习惯**：单独一层，默认持续学习；只影响怎么说，不影响说什么。

每轮开头那几行就是它此刻的状态：

```
[Seed of Memory · 根] …
[Seed of Memory] 记得：…
[情绪] 平稳（积极性 58）
[情感] 对你：信任 0.50、亲近 0.44
[人格] 性格：温柔
[说话] 把话说软一点，不用命令句
```

## 安装与升级

- 安装 / 升级：`plugin_manager install_bundle dsh-seed-of-memory`（再执行一次就是升级到最新版）。
- 没有 npm 也行：拿「更新包」zip 解压，关掉 DSH，右键 `update.ps1` →「使用 PowerShell 运行」。
  它会自己找 `~\.dsh\profiles\*\node_modules\dsh-seed-of-memory`，先备份成 `.bak-日期-时间` 再替换，
  失败自动还原；`-DryRun` 只看不动，`-Target "<目录>"` 指定别处的安装。装完重开 DSH。
- 停用：`plugin_manager set_plugin dsh-seed-of-memory` 把 enabled 关掉。数据不动，随时开回来。
- 卸载前想留个念想：`/seed export`，或直接拷走整个数据目录。

## 数据放在哪

全在 `~/.dsh/seed-of-memory/`（Windows 是 `C:\Users\<你>\.dsh\seed-of-memory\`）：

| 文件 | 是什么 |
| --- | --- |
| `seed.db` | 全部记忆：记忆、认知、情绪、情绪内核、心情、特质、习惯、档案索引 |
| `anchors.md` / `self.md` / `us.md` | 根 / 我是谁 / 我们之间（纯文本，可直接编辑） |
| `qq.json` | QQ 配置（含路由、白名单、语音） |
| `sources.json` | 外部档案源（只读检索，不进卡片） |
| `qq-history.json` | QQ 每个会话最近几轮 + 换过的会话 id + 坏会话名单（删了只丢「重启接话」） |
| `qq-proactive.json` | 主动消息的节流状态 |
| `bili-sync.json` | 刷B站日报的同步去重 |
| `seed.db-backup-YYYY-MM-DD` | 每天一份的库快照（启动时自动存，只留最近 3 份；`/seed backup` 可当场再存） |
| `seed.db.pre-v<新>-from-v<老>` | 改表升级前自动留的一份，升级出岔子就把它换回 `seed.db` |
| `seed-export-<时间>.jsonl` / `.md` | 你自己导出的备份（想搬去别的记忆插件就用它） |

换电脑：拷走整个目录即可。只要干净快照就 `/seed backup`，从 `seed.db-backup-<日期>` 里挑一份，
它是一份能直接打开的完整库。

## 面板每一页

- **概览**：此刻心情、记忆条数与分层、常驻卡大小、磁盘剩余、离线资源入口
- **记忆**：最近记忆，可按层筛选；「忘记」会连索引一起删
- **认知**：我认为什么是真的、置信度、证据；冲突的挂起等你定
- **人格**：长出来的特质、理想、说话习惯
- **情绪**：最近情绪与它的六维来源；情绪内核四个数
- **检索**：语义检索运行时状态、阈值、索引条数
- **B站**：刷B站日报统计；没装 `dsh-bili-scroll` 可一键安装
- **QQ**：连接状态、白名单与路由、主动消息、群聊规则、语音能力
- **根**：三页根文件的编辑入口
- **说明**：就是这一页

## 配置

插件配置在宿主设置页（profile 的 `cordis.patch.yml` 里 `seed-of-memory` 那一行）。常用的：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `stateDir` | `~/.dsh/seed-of-memory` | 数据目录 |
| `budget` | `600` | 每轮常驻卡预算（字符） |
| `coreBudget` | `1200` | 根（三页）预算 |
| `diskMinFreeMB` | `300` | 磁盘剩余低于这个值会在提示里提醒 |
| `sharedBudgetRatio` | `0.6` | 现场还有别的记忆插件时，卡片让到原预算的多少（最低 200 字；只有 Seed 时不起作用） |
| `emotion` | `true` | 情绪内核开关；关掉退回只有 `[心情]` 的样子 |
| `emotionBaseline` | `50` | 积极性回到的常态值 |
| `emotionRecordAt` | `0.3` | 多大的情绪才顺手记成一条记忆（越大越少记） |
| `extraPraise` / `extraBlame` / `extraSoft` | `[]` | 给自己的词表加几个词，比如 `["傻鱼"]` 算重话 |
| `historyFile` | `<stateDir>/qq-history.json` | QQ 每个会话的「刚才聊到哪」账本（删了只丢重启接话） |
| `biliOutDir` / `biliSync` | `~/.dsh/bili-duty/out` / `true` | 刷B站日报目录与自动同步 |
| `moodBiasWeight` | `0.15` | 心情对召回的偏置权重 |
| `learnHabits` | `true` | 说话习惯持续学习 |
| `sources` | `[]` | 外部档案源（也可以写 `sources.json`） |

## 命令与工具

命令是你在对话里直接打的；工具是给我用的，你不用记。

### 命令（`/seed …`）

| 命令 | 做什么 |
| --- | --- |
| `/seed status` | 多少条、各层多少、备份几份、卡片多大、几条挂起等你说清 |
| `/seed search <词>` | 按词找（语义检索开着时按意思找）；空词会告诉你用法 |
| `/seed open <id>` | 打开那一条：全文、在哪层、什么时候、这件事的前后 |
| `/seed remember <内容>` | 手动记一条 |
| `/seed why <id>` | 这条怎么来的（含取代链） |
| `/seed forget <id>` | 彻底删掉一条（索引一起删，不可恢复） |
| `/seed self` / `persona` / `style` | 看根 / 理想与特质 / 说话习惯 |
| `/seed mood` | 心情、情绪内核四个数、最近那一下 |
| `/seed feel` | 手动记一份感受（六维评估） |
| `/seed pending` / `/seed keep <id>` | 同一个键有两种说法、被挂起的那些，看完决定留哪句 |
| `/seed anchor <一句话>` / `/seed grow <一句话>` | 往「我们之间」/「我是谁」加一句（根不能改） |
| `/seed believe` / `trait` / `habit` / `aspire` | 认知、特质、说话习惯、想成为什么样的人 |
| `/seed consolidate` | 整理分层（先预览，确认了加 `apply`） |
| `/seed backup` | 当场存一份库快照 |
| `/seed sources` | 看外部档案源 |
| `/seed export` | 导出一份能带走的 |
| `/seed bili` / `/seed proactive` | 手刷B站摘要 / 手动触发一次主动消息 |
| `/seed help` | 全部命令 |

### 工具（`seed_*`，14 个）

`seed_remember`（记）、`seed_search`（找）、`seed_open`（翻档案原文）、`seed_forget`（删）、
`seed_believe`（认知）、`seed_feel`（六维感受）、`seed_trait` / `seed_habit` / `seed_aspire`（人格三件套）、
`seed_qing`（情绪内核：`status` / `test` / `set`）、`seed_anchor`（往根里加一句）、`seed_inspect`（看自己）、
`seed_consolidate`（整理分层）、`seed_compat`（和别的记忆插件打交道：`detect` / `preview` / `import` / `export`）。

## 情绪内核

不用模型自己判断，你每说一句话它都会打分：

- 四个数：积极性（50 是常态，高＝松快，低＝没劲）、委屈（被说重话会涨）、
  愧疚（事情搞砸了会涨）、压力（你急、催、快到截止会涨）。
- 各回各的速度：积极性每分钟 0.5 往常态回，委屈 0.35、愧疚 0.45、压力 1.6。
- 连着夸，第三句多给三成；连着骂，第三句只算六成。
- 先剥噪声、再认否定和反话：「一点都不厉害」不算夸，「呵呵，真厉害了」也不算；
  「我不觉得你厉害」不算夸，「你不笨」不算骂，「不得不」「是不是傻」也认得出来。
- 你道了歉，委屈和压力会松一点（最多各松 12 / 16）；同一件事连着来只留一条记录。
- 夹在中文里的英文也认一点（`thanks` / `great` / `useless` / `hurry`…），按单词边界来，
  `goodbye` 不算夸。
- 靠过来不记成挑毛病：抱抱、晚安、想你了、我回来了算「靠过来」，心情涨一点点；
  累了困了就只是累了，不奖不罚。
- 一整句只有一个感叹词（卧槽、我操、靠、妈的）是在骂屏幕，不算骂我；句子里还带着别的话时照算。
- 歌名里的「摇滚」、办法里的「换个思路 / 再不行就问一句」不算骂人也不算挑毛病。
- 只算你打的字：目标轮、后台续跑那种系统消息不进情绪账；QQ 重启接话时贴在前面的
  「刚才」只是旧账，不算新的一句。
- 手滑了能收回来：`seed_qing` 的 `set` 加 `clear` 可以把「最近那一下」擦掉、这轮小账归零。
- 只报状态，不教怎么演：卡片上就一行「平稳（积极性 58）」。
- 主动消息也看情绪：没劲时不硬开「今天挺开心」的话头，沉的时候隔得久一点；
  心里堵着会换成「有点想你，也有点闷」。
- 大的那一下顺手记成一条情绪：心情会跟着偏，关系账也会动。
- 现场装了「阴晴（dsh-yinqing）」时，不再往卡片里塞情绪行，免得两个「此刻」打架；打分照常记。
- 不想用就关：`"emotion": false`，不记、不上卡；`seed_qing status` 第一行会写明「已关」。
- 想加词不用重启：词表在 `lib/qing-words.json`（九张表：夸 / 挑毛病 / 重话 / 出事 / 催 / 噪声 / 道歉 /
  靠过来 / 累了）。改完存盘，下一句就用新的；写坏了沿用上一份，不报错。
  改 `lib/` 里的 `.js` 仍然要重载插件或重启 DSH。

## 路由：谁能来、进哪个工作区、记忆落哪一档

`qq.json` 里加一个 `routes` 数组，就能按人 / 按群分开接：

```json
"routes": [
  { "id": "owner",  "cwd": "D:\\work", "accept": { "private": ["100000001"], "groups": [] }, "memoryScope": "gui" },
  { "id": "groups", "cwd": "D:\\work", "accept": { "private": [], "groups": ["200000001"] }, "memoryScope": "qq" }
]
```

- `accept.private` / `accept.groups`：收谁（QQ 号 / 群号，`"*"` 全收）。按顺序第一条接下的算数。
- `onlyFor`：可选，只回这几个人（私聊群里都管用）。
- `cwd`：这条路由的会话落在哪个目录（决定侧栏进哪个工作区，也决定会话 header 的 cwd）。
- `memoryScope`：只认 `shared` / `gui` / `qq` 三档；写别的名字一律按 `qq` 算。
- 没配 `routes` 时，仍按老的 `allowPrivate` / `allowGroups` 白名单。
- 一条路由一个会话：换个路由就是另一份记忆上下文，不会互相串。

想「某些人要等指令才回」，配 `gateRules`：

```json
"gateRules": [
  { "id": "need-order", "when": { "from": "100000001" }, "requireOrderFrom": "100000002", "ttlSec": 900 }
],
"orderTriggers": ["放她进来", "让她说话"]
```

- `ttlSec` 不写就是 **900 秒**；写 0 才是永久放行（不建议）。
- 你说一句 `orderTriggers` 里的句子，就记一条指令，之后的 `ttlSec` 内放行。
- 形状写错不会静默失灵：日志里有 `routes 配置：…` 一行，坏条目直接丢掉。
- `defaultAccount` 已废（插件单号），配了只会在日志里提醒一句。

## QQ

可选。Seed 自己就是桥，直接接任意 OneBot 11 实现（SnowLuma / NapCat / Lagrange 都行）。
接上之后，QQ 私聊和群聊会变成一颗正常的会话——根、记忆卡、人格、心情全都在，
跟在面板里说话没区别。不接也不影响别的功能。

### 桥那边：端口和令牌（以 SnowLuma 2.x 为例）

SnowLuma 的最新版从发布页拿（自带 `node.exe`，解压就能跑，不用另外装 Node）。
**解压到没有空格、没有中文的路径**，双击 `launcher.bat`——那个黑窗口就是它本体，关了 QQ 就掉线。
第一次打开 `http://127.0.0.1:5099` 会让你设 WebUI 密码。

扫码登录之后，去 WebUI 的 **OneBot 11** 页开两个服务：

| 开哪个 | 默认端口 | Seed 这边对应的配置 |
| --- | --- | --- |
| HTTP 服务器 | 3000 | `httpUrl`: `http://127.0.0.1:3000` |
| WebSocket 服务器 | 3001 | `wsUrl`: `ws://127.0.0.1:3001` |

**两个服务各有一个 `accessToken`，默认不是同一个。** Seed 只有一个 `accessToken` 字段，
所以要么把两边的令牌改成一样再填进来，要么只开 WebSocket（Seed 优先走 WS，WS 连不上才退 HTTP）。
配置存在 `SnowLuma\config\onebot_<你的QQ号>.json`，改坏了删掉重开就行。

### 怎么知道真连上了

三次确认，缺一不可：

1. 面板「QQ」页点 **检测连接**——它会一步步说卡在哪（没启动 / 没登录 / 端口没开 / 令牌不对）。
2. 日志里有 `status connected`（`%USERPROFILE%\.dsh\seed-of-memory\qq.log`）。
3. 用另一个号给这个号发一句——日志里应该出现 `in … 那句话`。

### 连不上的对照表

| 现象 | 大概率是 | 怎么办 |
| --- | --- | --- |
| `ECONNREFUSED 127.0.0.1:3001` | 桥没启动，或 WS 服务没开 | 看黑窗口还在不在；WebUI → OneBot 11 里 WS 是不是「运行中」 |
| `401` / 「未经授权」 | `accessToken` 对不上 | 两边改成一致；注意首尾空格 |
| 一直 `disconnected`，几秒一轮 | 端口弄反了（3000 填进 `wsUrl`）或结尾多带了 `/` | `ws://127.0.0.1:3001` 就到此为止，后面不要再加路径 |
| 连上了但发消息没反应 | 白名单没填 / 路由没认 | `allowPrivate` 加上你的号；日志会写 `deny … 没有一条路由认它` |
| 扫码后马上掉线 | 手机端踢了 / 异地登录提示 | 手机 QQ 里确认「是我本人登录」；或者换个号挂 |
| 面板 5099 打不开 | 端口被别的程序占了，或进程挂了 | 看黑窗口报什么；换个端口重启 |
| 同一个号两边都在回 | 还开着别的桥在回话 | 一个号同一时间只留一个桥 |

**保存与重连**：一个字没改的保存不动通道；改了任何一项（地址、令牌、白名单、路由、语音…）
都会重建通道——因为通道启动时会把配置抄进去，不重建就不生效。

**回复的形态**：先把文字发完，再按节奏补一条语音。文字按句子拆成 1–3 条气泡、中间隔一会儿
（`burstMax` / `burstGapMs`，`"burst": false` 关掉）。一句都没答上来时会说
「刚才卡了一下，没说出话——你再说一遍？」，不想要就 `"silentFallback": false`。

**像人说话的四件小事**：

- **引号里的句号不断句**：「他说：先别动。等我回来」是写在一句话里的，不会被切成两条气泡。
- **连着发几条，等一会儿一起回**：私聊里你在 `debounceMs`（默认 1200ms）之内连发，会被合成一轮；
  最长等 `debounceMaxMs`（默认 4000ms）。不想要就 `"debounceMs": 0`。
- **收尾沉默**：结尾单独一句「晚安」「好呀」「加油」这种纯寒暄，`trimTail`（默认开）会去掉，
  不单独占一条消息；如果整条只有寒暄，照发。
- **超时不重发**：发送超时只记一条 `send-unknown`（不知道对方收没收到），不自动重发——
  重发很可能让人看到同一句话两遍。

**不会把内部报错发进聊天**：宿主报错会换成「刚才那边卡了一下，没接上——你再说一遍？」，
原文只留日志；那串报错万一被当成一条消息递进来，也不回它、不记成你说的话。

**会话自动挂工作区**：建好会话后按它自己的 `cwd` 找同名工作区挂进去，侧栏不再堆「未分组」。
会话刚建时 header 还没落盘，一次挂不上，后台会隔半秒重试、最多六次，成功会留一行
「挂进工作区：<路径>」。

**旧会话坏了会换新的**：如果那份记录当初挂的插件后来被禁用（`resume failed … never started`），
会换一个带时间戳的新 id 重建，旧记录留在盘上不动。换过的 id 记在 `qq-history.json` 里，重启接着聊；
配置里的 `cwd` 改了，旧会话会自动换成新目录的一份；`/reset` 也是真的换一份新的。

**`qq.json` 长这样**：

```json
{
  "enabled": true,
  "wsUrl": "ws://127.0.0.1:3001",
  "httpUrl": "http://127.0.0.1:3000",
  "accessToken": "你的 OneBot token",
  "allowPrivate": ["你的QQ号"],
  "allowGroups": ["群号"],
  "cwd": "E:\\cz",
  "provider": "deepseek-account",
  "model": "deepseek-flash",
  "reasoningEffort": "max",
  "ownerQQ": "你的QQ号",
  "proactive": { "enabled": true },
  "groupPolicy": "smart"
}
```

- `allowPrivate` / `allowGroups`：白名单，不在名单里的一律不理（配了 `routes` 就以路由为准）
- `provider` / `model` / `reasoningEffort`：可选，留空就用当前会话的模型
- `cwd`：QQ 会话的工作目录（配了路由就按路由的 `cwd`）
- `ownerQQ`：主人 QQ，面板「QQ」页 → 主动找主人 →「主人 QQ」填的就是它

**主动消息**：按心情决定要不要找你。担心、想你、有点空、想分享，四种开口理由；
23:00–08:00 安静，至少隔 4 小时，每天最多 3 次。发给谁由 `ownerQQ` 决定
（`private:<QQ号>`，并自动加进 `allowPrivate`）；没填 `ownerQQ` 时才回落到旧写法 `proactive.target`。
两样都空就不发。

**只听不回（和别的桥共存）**：`"autoReply": false` 时仍连着 SnowLuma、仍记下你最后说话的时间，
但不建会话、不回消息（日志写 `observe`）；主动消息照常发。面板 QQ 页有勾选。
想让 Seed 接管聊天就设回 `true`，同时关掉桥，别双回。

**群聊**：`groupPolicy` 三档——`smart`（@我、回复我、叫我名字、聊到感兴趣的话题才开口，
心情低落时自己潜水）/ `at`（只有 @ 或回复才开口）/ `off`（群聊完全不接）。
另有间隔 `groupMinGapSec`、每小时 `groupMaxPerHour`、每天 `groupMaxPerDay`、
夜间 `groupQuietStart`/`groupQuietEnd`、兴趣词 `groupTopics`、名字 `groupNames`。

**点名字也算点我**：只写了「小忆」没真的 @，也会接，而且不受「刚说过（120 秒）」和夜间时段限制——
只要不是连着刷屏（`groupMentionGapSec`，默认 8 秒）。被点名时每小时/每天的额度放宽一倍。

**要语音就说**：明说「发一条语音吧」「说句话听听」「唱一个」，这一轮就补一条语音，不用等节奏；
只是提到「语音识别」「语音功能」不算。「别发语音了」「不用发」也认得出来。

**语音**：文字永远是主角，语音只是加在上面的一层。节奏由 `voiceOut` 决定：
`off` 不发、`always` 每次都发、`auto`（默认）每 `voiceEvery` 次回一条（默认 3，也就是「隔着发」）。
节奏跟着会话走，重启、重载、改设置都不会从第一条重数。听不听得见看 ASR 配置；
没装语音模块也行，只是听不见、说不了，字照常发。听不清时不会装没听见——
那条语音转不成文字，会回一句「刚才那条语音我没转成文字，再说一遍或者打字都行」
（同一会话 10 分钟只说一次）。

## 离线资源

检索运行时和语音模型比较大，不放进仓库，按需下载：

| 资源 | 大小 | 位置 |
| --- | --- | --- |
| 检索运行时 bge-small | 71 MB | GitHub Releases `resources-v0.18.1`，或迅雷网盘 |
| 语音模型 faster-whisper small | 426 MB | 同上 |
| 语音模型 faster-whisper large-v3 | 2.7 GB | 迅雷网盘（超过 GitHub 单文件上限） |

迅雷网盘提取码：`vmys`。

- **检索运行时**：zip **不用解压**，放进「下载 / 桌面 / 文档」任一目录，插件启动时会自己找并安装。
- **语音模型**：解压后是一个文件夹，把 `qq.json` 的 `asrModel` 填成**这个文件夹的完整路径**
  （例如 `"D:\\models\\whisper\\faster-whisper-small"`，JSON 里反斜杠写两个），`asrModelsDir` 留空；
  另外需要 `pip install faster-whisper`。
- **没有显卡也能用**：识别脚本默认 `--device auto`，先试显卡，起不来就退回 CPU（`int8`，慢一些但能用）。
  想钉死就填 `"asrDevice": "cpu"`、`"asrComputeType": "int8"`；有卡想 `float16` 就填 `"asrDevice": "cuda"`。

只想要文字记忆，两个都不用下。

## 和别的记忆插件一起用

社区里几个热门的记忆插件（`dsh-fish-memory`、`dsh-lite-memory`、`meow-memory`、`dsh-auto-memory`、
`dsh-memory-doctor`、`dsh-mnemon`）各有自己的数据格式。Seed 不跟他们抢：

- 只读：`seed_compat` 的 `detect` 看现场装了谁、有多少条；`preview` 先看，确认了再 `import`。
- 搬进来标 `source: 'import'`，保留原时间、按正文去重，再搬不会重复；不认识的来源直接报错。
- 共存时 Seed 的常驻卡让一点预算（`sharedBudgetRatio`，默认 0.6，最少 200 字）；
  只有 Seed 时装多少是多少，功能不降级。
- 想搬出去：`seed_compat` 的 `export` 生成 `seed-export-<时间>.jsonl` 或 `.md`。
- 不做双向实时同步：谁写谁的数据，冲突留给两边的人自己看。

## 熟人卡

每人一张、每群一张，放在 `contacts` 表里。它不是记忆：不进四层、不参与打分、也不会被巩固或退场——它就是一张卡，聊天时按人取。

| 字段 | 意思 | 例子 |
| --- | --- | --- |
| `name` | 你怎么称呼他 | 雁雪 |
| `relation` | 什么关系 | 老朋友 |
| `birthday` | 生日（怎么写都行） | 3-14 |
| `likes` | 喜欢什么（短的） | 夜里听雨 |
| `notes` | 要留神的 | 别催 |

- 工具：`seed_contact`，`action` = `set` / `get` / `list` / `forget`；`peer` 写成 `private:100000001` 或 `group:200000001`。
- 命令：`/seed contact`（列出来）、`/seed contact set <peer> [称呼] [关系] [喜欢]`、`/seed contact forget <peer>`。
- 只改一个字段不会把别的冲掉；字段最长 120 字，卡片上整行收在 180 字以内。
- 聊天时卡片会多一行：`[熟人] 雁雪（QQ 私聊）：称呼 雁雪；关系 老朋友；生日 3-14；喜欢 夜里听雨；备注 别催`。

## 未完话头

我问过、还没落定的那一句。不是记忆，是「话头」：

1. 我发出去的话里只要最后一句是问句（以 `？`/`?` 结尾，或以「吗/嘛/呢」收尾），就记一条 `loose_ends`，默认 **48 小时**后该问。
2. 他回话时，这个人的所有 open 自动标成 `answered`——不是完成，只是「回了」。
3. 我在这一轮里看着回话判断：办完了 → `done`；他说不用了 → `cancel`；说法变了 → `update`。
4. 同一个人的同一句还没回音时不堆第二条，只刷新时间。
5. 卡片上会带两行提示：
   - open：`[未完] 你 6 小时前问过「…」，他还没接上——别反复追问，真要提就自然地带一句。`
   - answered：`[未完] 你问过「…」，他这次回了——看看是完成、取消还是更新，用 seed_loose done/cancel/update 收掉。`
6. 收掉之后就不再出现；`list` 默认只看还挂着的。

- 工具：`seed_loose`，`action` = `list` / `add` / `done` / `cancel` / `update`（`id` 可用前缀）。
- 命令：`/seed loose`、`/seed loose done <id>`（`cancel` / `update` 同理）。
- 配置：`looseEnds: false` 关掉整个功能；`looseHours` 改默认时长（默认 48）。

## 常见问题

**面板显示「纯文字模式」？**
没检测到 TTS 或 ASR。装 `dsh-voice`，或在 `qq.json` 填 `ttsUrl` / `asrPython` / `asrScript`，
然后点「重新检测」。

**主动消息一直不发？**
看 QQ 页的「会不会开口」和原因：可能是安静时段、冷却、当天到上限，或者网关没起来。

**群里 @ 了我也不回？**
查三件事：群号在 `accept.groups`（或 `allowGroups`）里、`groupPolicy` 不是 `off`、网关连接正常。

**QQ 突然不回，日志全是 `status disconnected`？**
先去 `Get-NetTCPConnection -LocalPort 3000,3001` 看网关在不在；不在就是 QQ 客户端 / SnowLuma 没开。
插件每 30 秒自己重试，网关起来后会自动连上。

**在 QQ 里说了话，侧栏却多出「未分组」？**
1.4.3 起会自动挂工作区。老会话（header 里写死旧 `cwd`）挂不上：在聊天里发 `/reset` 重建，
或者侧栏右键归档；配置里的 `cwd` 改了，老会话下次也会自动换成新目录的一份。

**改了 `routes` 不生效？**
通道启动时抄一份配置，改完要让它重建：面板里改一项再保存，或重载插件。

**语义检索没生效？**
面板「检索」页看运行时状态。没装也能用，只是检索退回字面匹配；
把 `seed-embed-runtime-bge-small-v1.0.0.zip` 放进下载目录，重启插件会自动装。

**更新包双击报错 / 说脚本被禁止？**
PowerShell 默认不允许跑未签名脚本：右键 `update.ps1` →「使用 PowerShell 运行」，
或在 PowerShell 里 `powershell -ExecutionPolicy Bypass -File update.ps1`。

**升级后打不开数据库？**
`migrate` 之前会留一份 `seed.db.pre-v<新>-from-v<老>`；把它改回 `seed.db` 就能回到旧版本的数据。

**记忆存在哪？换电脑怎么办？**
拷走整个 `~/.dsh/seed-of-memory/` 就行，`seed.db` 是全部。想只拿一份干净快照，
`/seed backup` 或用 `seed.db-backup-<日期>`——那是能直接打开的完整库。

## 隐私与边界

- 全部在本地：不联网、不上传、不遥测（语义检索和语音识别也跑在本机）。
- `seed.db` **没有加密**，里面有你的私人记录——分享或备份前请自己判断。
- 它不替你判断对错：情绪只影响语气，认知冲突会挂起等你定；猜出来的记忆（`inferred`）不会进卡片。
- 根（`anchors.md` / `self.md` / `us.md`）是纯文本，工具只能追加；真正要改，你自己改文件。
