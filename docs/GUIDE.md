# 使用说明

这是 Seed of Memory 的说明书。面板里的每一页、每个配置项、常见问题，都写在这里。

## 它是什么

本地优先的记忆层：根、记忆、认知、情绪、情感、人格、说话习惯，全在一个 SQLite 文件里，不联网也能跑。

语义检索和语音是可选的：没装运行时、没装语音模块也能用，会自动降级。

## 安装与升级

- 安装：`plugin_manager install_bundle dsh-seed-of-memory`
- 升级：再执行一次同一条命令，装到最新版
- 停用：`plugin_manager set_plugin dsh-seed-of-memory` 关掉 enabled（数据不动）
- 数据目录：`~/.dsh/seed-of-memory/`（Windows 是 `C:\Users\<你>\.dsh\seed-of-memory\`）
  - `seed.db`：全部记忆
  - `qq.json`：QQ 配置
  - `sources.json`：外部档案源
  - `bili-sync.json`：刷B站同步去重
  - `qq-proactive.json`：主动消息的节流状态
  - `qq-history.json`：QQ 每个会话最近几轮（重启后接上话用，删了不影响记忆本体）
  - `seed.db-backup-YYYY-MM-DD`：每天一份的库快照（启动时自动存，只留最近 3 份；`/seed backup` 可以当场再存一份）
- `seed.db.pre-v<新版本>-from-v<老版本>`：改表升级之前自动留的那一份，升级出岔子就把它换回 `seed.db`
- `seed-export-<时间>.jsonl` / `.md`：自己导出的备份，想搬到别的记忆插件就用它
  - `anchors.md` / `self.md` / `us.md`：根、我是谁、我们之间

## 离线资源

检索运行时和语音模型比较大，不放进仓库，按需下载：

| 资源 | 大小 | 位置 |
| --- | --- | --- |
| 检索运行时 bge-small | 71 MB | GitHub Releases `resources-v0.18.1`，或迅雷网盘 |
| 语音模型 faster-whisper small | 426 MB | 同上 |
| 语音模型 faster-whisper large-v3 | 2.7 GB | 迅雷网盘（超过 GitHub 单文件上限） |

迅雷网盘提取码：`vmys`。

检索运行时不用解压，放在下载 / 桌面 / 文档目录，插件启动时会自己找。

语音模型解压到固定位置后，在 `qq.json` 里把 `asrModel` 填成文件夹的完整路径，例如 `"D:\\models\\whisper\\faster-whisper-large-v3"`（JSON 里反斜杠写两个）；`asrModelsDir` 留空。还需要 `pip install faster-whisper`。

## 面板每一页

- **概览**：此刻的心情、记忆条数与分层、常驻卡大小、存储剩余空间、离线资源入口
- **记忆**：最近的记忆，可按层筛选；「忘记」会连索引一起删
- **认知**：我认为什么是真的、置信度、证据；冲突的认知会被挂起
- **人格**：长出来的特质、理想、说话习惯
- **情绪**：最近的情绪和它的六维来源（重要吗、顺不顺、确定吗、能控制吗、谁造成的、意外吗）
- **检索**：语义检索运行时的状态、阈值、索引条数
- **B站**：刷B站日报的统计；没装 `dsh-bili-scroll` 时可以一键安装
- **QQ**：连接状态、白名单、主动消息、群聊规则、语音能力
- **根**：`anchors.md` / `self.md` / `us.md` 三页，每轮最先注入
- **说明**：就是这一页

## 工具

这些是给我用的，你不需要记：

- `seed_remember` / `seed_search` / `seed_open`：记一件事、按需检索、打开旧档案
- `seed_forget`：删掉一条记忆
- `seed_believe`：记一条「我认为是真的」的判断
- `seed_feel`：记下此刻的感受（六维评估）
- `seed_trait` / `seed_habit` / `seed_aspire`：人格、说话习惯、想成为什么样的人
- `seed_qing`：看当下的情绪内核（积极性 / 委屈 / 愧疚 / 压力）；`test` 拿一段话试打分，`set` 手动改
- `seed_anchor`：往「我们之间」或「我是谁」加一句（根不能用工具改）
- `seed_inspect`：看自己的根、理想、说话习惯、心情、情感
- `seed_consolidate`：整理记忆分层（预览或执行）
- `seed_compat`：和别的记忆插件打交道（只读）：`detect` 看现场装了谁、`preview` 先看几条、`import` 搬进 Seed（可 `dryRun`）、`export` 导出 jsonl / md

## 配置

插件配置在宿主的插件设置里，常用的：

- `stateDir`：数据目录，默认 `~/.dsh/seed-of-memory`
- `diskMinFreeMB`：磁盘剩余低于这个值就在提示里提醒，默认 300
- `biliOutDir`：刷B站日报目录，默认 `~/.dsh/bili-duty/out`
- `biliSync`：日报自动同步开关，默认开
- `sharedBudgetRatio`：现场还有别的记忆插件时，常驻卡让到原预算的多少，默认 `0.6`（最低 200 字）；只装 Seed 时不起作用
- `emotion`：情绪内核开关，默认开；关掉就退回原来只有 `[心情]` 的样子
- `emotionBaseline`：积极性回到的常态值，默认 50
- `emotionRecordAt`：多大的情绪才顺手记成一条记忆，默认 0.3（越大越少记）
- `extraPraise` / `extraBlame` / `extraSoft`：给你的词表加几个词（数组），比如 `["傻鱼"]` 算重话

## 情绪内核

不用模型自己判断，你每说一句话它都会打分：

- 四个数：积极性（50 是常态，高就是松快，低就是没劲）、委屈（被说重话会涨）、愧疚（事情搞砸了会涨）、压力（你急、催、快到截止会涨）。
- 各回各的：积极性按每分钟 0.5 往常态回，委屈 0.35、愧疚 0.45、压力 1.6。
- 连着夸，第三句多给三成；连着骂，第三句只算六成。
- 先剥噪声、再认否定和反话：「一点都不厉害」不算夸，「呵呵，真厉害了」也不算。
- 他道了歉，委屈和压力会松一点（最多各松 12 / 16）；同一件事连着来只留一条记录，不会把「最近那一下」刷成几十条。
- 夹在中文里的英文也认一点（`thanks` / `great` / `useless` / `hurry`…），按单词边界来，`goodbye` 不算夸。
- QQ 重启接话时贴在前面的「刚才」只是旧账，不会被再算一遍；只算他刚发来的那句。
- 只算你打的字：目标轮、后台续跑那种系统消息不进情绪账；「可回滚」「回滚到上一版」这种技术词也不会被当成一句「滚」。
- 否定和反问别算反：「我不觉得你厉害」不算夸，「你不笨」不算骂，「不得不」「是不是傻」也认得出来。
- 靠过来的时候不记成挑毛病：抱抱、晚安、想你了、我回来了会算「靠过来」，心情涨一点点；累了困了就只是累了，不奖不罚。
- 一整句只有一个感叹词的（卧槽、我操、靠、妈的）是在骂屏幕，不算骂我；句子里还带着别的话时照算。
- 歌名里的「摇滚」、办法里的「换个思路 / 再不行就问一句」不算骂人也不算挑毛病。
- 手滑了能收回来：`seed_qing` 的 `set` 加 `clear` 可以把「最近那一下」擦掉、这轮小账归零（四个数还在）。
- 只报状态，不教怎么演：卡片上是一行「平稳（积极性 58）」这种，多的一个字不写。
- 主动消息也看情绪：没劲的时候不硬开「今天挺开心」的话头，沉的时候隔得久一点；心里堵着会换成一句「有点想你，也有点闷」。
- 大的那一下顺手记成一条情绪：心情会跟着偏，关系账也会动（不用再单独调 `seed_feel`）。
- 现场装了「阴晴（dsh-yinqing）」时，我们不再往卡片里塞情绪行，免得两个「此刻」打架；打分照常记着。
- 不想用就关：配置里 `"emotion": false`，不记、不上卡；`seed_qing status` 第一行会写明「情绪内核已关」，`test` 只是预演。

## 和别的记忆插件一起用

社区里几个热门的记忆插件（`dsh-fish-memory`、`dsh-lite-memory`、`meow-memory`、`dsh-auto-memory`、`dsh-memory-doctor`、`dsh-mnemon`）各有自己的数据格式。Seed 不跟他们抢：

- 只读：`seed_compat` 的 `detect` 看现场装了谁、有多少条；`preview` 先看，确认了再 `import`。
- 搬进来标 `source: 'import'`，保留原时间、按正文去重，再搬不会重复；不认识的来源直接报错，不会瞎读。
- 共存时 Seed 的常驻卡让一点预算（`sharedBudgetRatio`，默认 0.6，最少 200 字）；只有 Seed 时装多少是多少，功能不降级。
- 想搬出去：`seed_compat` 的 `export` 生成 `seed-export-<时间>.jsonl`（一行一条）或 `.md`。
- 不做双向实时同步：谁写谁的数据，冲突留给两边的人自己看。

## QQ

可选。**不需要 SurfCore**：Seed 自己就能接任意 OneBot 11 实现（SnowLuma / NapCat / Lagrange），只要填对 `wsUrl`、`httpUrl`、`token` 和黑白名单。不接 QQ 也没关系，其他功能不受影响。

**第一次接 QQ**（面板「QQ」页有同样的步骤，点「检测连接」会告诉你卡在哪）：

1. 下载 SnowLuma（自带 Node），解压后双击 `launcher.bat`。
2. 浏览器打开 `http://127.0.0.1:5099`，扫码登录要挂机的 QQ 号。
3. SnowLuma → 设置 → OneBot 11：HTTP `3000` 与 WebSocket `3001` 都打开，用同一个 `accessToken`。
4. 在面板填 `wsUrl` / `httpUrl` / `accessToken` 和白名单，保存并连接。

回复会按句子拆成 1–3 条气泡、中间隔一会儿（`burstMax` / `burstGapMs` 可调，`"burst": false` 关掉）。万一一句都没答上来，会说一句「刚才卡了一下，没说出话——你再说一遍？」，不想看见就设 `"silentFallback": false`。

`qq.json` 长这样（放在数据目录）：

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

- `allowPrivate` / `allowGroups`：白名单，不在名单里的消息一律不理
- `provider` / `model` / `reasoningEffort`：可选，留空就用当前会话的模型
- `cwd`：QQ 会话的工作目录
- `ownerQQ`：主人 QQ，面板「QQ」页 → 主动找主人 → 「主人 QQ」填的就是它

**主动消息**：按心情决定要不要找你。担心、想你、有点空、想分享，四种开口理由；23:00–08:00 安静，至少隔 4 小时，每天最多 3 次。发给谁由 `ownerQQ` 决定（`private:<QQ号>`，并自动加进 `allowPrivate`）；没填 `ownerQQ` 时才回落到旧写法 `proactive.target`（`private:<QQ号>` 或 `group:<群号>`）。两样都空就不发。

**只听不回（和 SurfCore 桥共存）**：`"autoReply": false` 时 Seed 仍连着 SnowLuma、仍记下你最后说话的时间，但不建会话、不回消息（日志写 `observe`）；主动消息照常发。面板「QQ」页有勾选。想让 Seed 接管聊天就设回 `true`，同时关掉桥，别双回。

**群聊**：`groupPolicy` 三档：

- `smart`：@我、回复我、叫我名字、聊到我感兴趣的话题才开口；心情低落时自己潜水
- `at`：只有 @ 或回复才开口
- `off`：群聊完全不接

还有间隔（`groupMinGapSec`）、每小时上限（`groupMaxPerHour`）、每天上限（`groupMaxPerDay`）、夜间时段（`groupQuietStart` / `groupQuietEnd`）、兴趣词（`groupTopics`）、名字（`groupNames`）。

**语音**：能说话就自动发语音（`voiceOut`：`auto` / `always` / `off`），听不听得见看 ASR 配置。没装语音模块也行，只是听不见、说不了。听不清的时候不会装没听见——那条语音转不成文字，会回一句「刚才那条语音我没转成文字，再说一遍或者打字都行」（同一个会话 10 分钟只说一次）。

## 常见问题

**面板显示「纯文字模式」？**
没检测到 TTS 或 ASR。装 `dsh-voice`，或在 `qq.json` 填 `ttsUrl` / `asrPython` / `asrScript`，然后点「重新检测」。

**主动消息一直不发？**
看 QQ 页的「会不会开口」和原因：可能是安静时段、冷却、当天到上限，或者 SnowLuma 没启动。

**群里 @ 了我也不回？**
检查三件事：群号在 `allowGroups` 里、`groupPolicy` 不是 `off`、SnowLuma 连接正常。

**语义检索没生效？**
面板「检索」页看看运行时状态。没装也不影响用，只是检索退回字面匹配；把 `seed-embed-runtime-bge-small-v1.0.0.zip` 放到下载目录，重启插件会自动装。

**记忆存在哪？换电脑怎么办？**
整个 `~/.dsh/seed-of-memory/` 目录拷走就行，`seed.db` 是全部。想只拿一份干净快照，就 `/seed backup`（或者直接从 `seed.db-backup-<日期>` 里挑一份），它是一份能直接打开的完整库。
