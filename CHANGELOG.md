## 1.2.3 — 2026-11-13

QQ 重启之后，记得刚才聊到哪。

- 宿主不会把插件 `agents.create` 建出来的 QQ 会话写进 `~/.dsh/sessions`（只有 subagent 那种会话会落盘），所以每次重启 resume 都是 `not found`、等于从零开始。这一版不再指望宿主：QQ 自己在本机留一小截账本 `qq-history.json`（每个会话最近 8 轮，最多 40 个会话），新会话的第一条消息前带上「刚才聊过什么」，只带一次。
- `lib/qq/history.js`：`QqHistory`（`append` / `get` / `clear` / `recap` / `flush`），写盘走 `.tmp` + rename，状态目录不可写也不会把 QQ 弄挂；`/reset` 会同时清掉这个会话的本地账本。
- 日志降噪：OneBot 断线时每 30 秒会来一条相同的 `disconnected`，以前原样写进 `qq.log`（一天两千多条），现在只记状态变化；`resume … 未命中` 每个会话只说一次，并标注「本地历史接管」。
- `agents.resume()` 不再带 `meta`（`ResumeAgentOptions` 里没有这个字段，传了会被忽略）。
- 测试：新增 `qq-history.test.mjs`（6 项：写入/裁剪、按会话隔离、`/reset` 清空、recap 文案、坏文件不炸、通道聊完一句进账本），全量 167 项通过。

## 1.2.2 — 2026-11-13

QQ 里像聊天，不像汇报。

- QQ 会话的常驻卡前面多一行「场景」提示：在 QQ 上和老大聊天，一两句、别用 Markdown、别贴日志/路径/命令/进程号；他问「好了吗」先用人的话回答，别做汇报，只有明确让查才动手。
- 面板「只听不回」勾选框原来反着：勾上其实是打开自动回复，导致「想关掉只听不回」反而把回复关掉了；现在勾选＝只听不回，取消勾选＝正常回话。
- 起因：QQ 里问「现在好了吗」，会话把 `qq.log` 和进程号当聊天内容贴了出来；面板勾选框的语义也和字面相反。

## 1.2.1 — 2026-11-13

主动找主人先认「主人 QQ」。

- `qq.json` 新增 `ownerQQ`；面板「QQ」页 → 主动找主人，多了一个「主人 QQ」输入框和「发给 private:<QQ号>」提示。
- `ownerTarget({ ownerQQ, target })`：填了 `ownerQQ` 就发给他，没填才回落到旧的 `proactive.target`；两样都空就不发（返回「还没填主人 QQ」）。
- 面板状态、`GET/POST /qq/proactive` 都返回生效的 `target`。
- 填了「主人 QQ」会顺手把它加进 `allowPrivate`，免得他发消息却被白名单挡掉。
- 带记忆的句子不再硬切到半句：能停在标点就停在标点，也不会出现「…。。」。
- 测试：`proactive.test.mjs` 增 3 项（ownerQQ 优先/回落、号码清洗、截短断句），`qq.test.mjs` 增 2 项（用假 OneBot 客户端验证 `private:<QQ>` 真的发到私聊、空目标不乱发），全量 161 项通过。

## 1.2.0 — 2026-11-13

Seed 自己就是 QQ 桥：不再需要额外跑一份 SurfCore。

- 面板「QQ」页新增「第一次接 QQ」向导：SnowLuma 启动 / QQ 登录 / OneBot 端口 / 白名单 / 连接状态，逐步检测并提示下一步；新增 `GET /dsh-seed-of-memory/qq/onboarding`。
- 回复改成真人式分条：按句子拆成 1–4 条气泡、条间隔 0.9 秒左右（`burstMax`、`burstGapMs`，`"burst": false` 可关）；`splitBubbles` 导出并有测试。
- README / 说明页补了「不用 SurfCore 的第一次接 QQ」教程；「只听不回」的文案改成「聊天交给别的桥」。
- 测试：全量 156 项通过。

## 1.1.1 — 2026-11-13

和 SurfCore 的 QQ 桥共存：Seed 可以「只听不回」。

- `qq.json` 新增 `autoReply`（默认 `true`）；设成 `false` 时仍然连接 SnowLuma、更新 `lastInboundAt`，但不建会话、不回消息，日志写 `observe`。
- 主动找主人走同一条连接，不受影响——聊天回复交给桥，主动消息照常发。
- 面板「QQ」页新增勾选「只听不回（把聊天回复交给 SurfCore 的桥；主动消息照常发）」，保存走 `/qq/config`。
- 测试：`qq.test.mjs` 增 3 项（只听不回不建会话、默认开启、群里别人闲聊不算他说话），全量 155 项通过。

## 1.1.0 — 2026-11-13

面板多了「说明」页：安装与升级、离线资源、每一页做什么、工具、配置、QQ 设置、常见问题，全在里面。

- 新增 `docs/GUIDE.md`，随包发布；`GET /dsh-seed-of-memory/guide` 返回原文与版本号。
- 面板新增「说明」页签，用轻量 Markdown 渲染（标题 / 列表 / 行内代码 / 代码块）。
- 页脚版本号跟着 `package.json` 走，不再写死。
- 文档：README 提到「说明」页；SPEC 增第 30 节。

## 1.0.0 — 2026-11-13

第一个正式版：本地记忆层 + 身份根 + 认知/情绪/情感/人格/习惯 + QQ 通道（主动消息、群聊判断、语音）+ 面板，全部在本地，不联网。

和 0.5.0 比，多了这些：

- **语义检索**（v0.6）：bge-small 本地运行时，混合打分；没有运行时自动退回 FTS5。
- **外部档案**（v0.3）：`sources.json` 只读目录，检索时按需读，不进卡片。
- **自动捕获与反思**（v0.7 / v0.8）：`[待记]` 与 `[践行]` 两行，不自动写记忆。
- **分层与巩固**（v0.11）：working / short / long + `consolidate_log`。
- **情感**（v0.12）：信任 / 亲近 / 欣赏 / 依恋，30 天半衰期；情绪只轻轻推。
- **身份根**（v0.13）：`anchors.md` / `self.md` / `us.md`，每轮最先注入，`anchors` 工具不能改。
- **磁盘提醒**（v0.14）：低于 `diskMinFreeMB` 时面板与提示里出现。
- **刷B站兼容**（v0.15）：读日报里的「值得看 / 可以看」进待记。
- **主动找主人**（v0.16）：心情偏负会担心、依恋高会想你、太久没动静会有点空、心情好会想分享；安静时段与每日上限。
- **群聊判断**（v0.17）：@、回复、叫名字、兴趣词才开口；按心情决定潜水。
- **语音降级**（v0.18）：没装语音模块也能用，听不到只说一次，说不了自动退文字。
- **面板**：概览 / 记忆 / 认知 / 人格 / 情绪 / 检索 / B站 / QQ / 根，下载入口也在里面。

破坏性变更：`PROACTIVE_DEFAULTS.target` 默认改为空（不再内置某个 QQ 号）。要用主动消息，在 `qq.json` 里写 `"proactive": { "target": "private:<你的QQ号>" }`。

149 项测试通过。

## 0.18.1 — 2026-11-13

- 面板「概览」新增「离线资源」卡片：GitHub Releases 与迅雷网盘（提取码）一键打开，不用再翻文档找链接。
- 面板页脚版本号改为读 `package.json`（不再手写，升级不会忘改）。
- 语音能力文案修正：`voice-out` 是「能说话、听不见语音」，`voice-in` 是「能听、回文字」；之前写反了。
- 「主动找主人」在还不知道上次说话时间时返回 `hoursSinceUser: null`，不再被当成「很久没说话」（重启后不会立刻算成想你）。

## 0.18.0 — 2026-11-12

- **没装语音模块也能用**：收到语音但听不了时，只提示一次（同一会话 15 分钟内不重复），回复自动走文字，不会对着空气说话。
- 语音合成连不上时自动退回文字（`tts-skip` 日志限频），不把「会说话」当成必选项。
- 语音能力 30 秒缓存，面板可「重新检测」；新增 `GET /dsh-seed-of-memory/voice`。
- 新增 `lib/voice.js`（ASR 配置检查、TTS 探活、能力汇总）与 `test/voice.test.mjs` 6 项（共 148 项）。
- 面板「QQ」页新增语音卡片（能听也能说 / 只能说 / 只能听 / 纯文字、dsh-voice 状态、原因、ttsUrl）。

## 0.17.0 — 2026-11-12

- **群聊不再每条都接**：@我、回复我、提到「阿鱼 / Carys」、聊到兴趣词才开口；什么都没沾时，心情好才小概率插话，低落直接潜水。
- 心情折算「说话电量」：`0.5 + 0.5×愉悦 + 0.5×(唤醒−0.35)`；夜里非 @ 的消息不接。
- 频率保护：间隔 120 秒、每小时 8 条、每天 60 条；按群分别计数。
- 面板「QQ」页新增群聊卡片（聪明模式 / 只在 @ 时回 / 群聊关闭、兴趣词、间隔与上限、夜间起止、当天各群发言数）；日志区分 `join` / `lurk`。
- 新增 `lib/qq/group.js` 与 13 项测试（共 141 项）。

## 0.16.0 — 2026-11-12

- **主动找主人**：QQ 侧到点了会主动开口——心情偏负会「担心」，依恋高又久没说话会「想你」，太久没动静会「有点空」，心情好会「想分享」。
- 限流：安静时段 23:00–08:00、两次至少隔 4 小时、一天最多 3 次；文案带一句真实记忆，不群发。
- 面板「QQ」页新增主动设置与「现在说一句」；`GET/POST /qq/proactive`、`POST /qq/proactive/once`。
- 新增 `lib/qq/proactive.js`、`QqChannel.say()` 与 9 项测试（共 128 项）。

## 0.15.0 — 未发布

- 与「刷B站」插件兼容：读取 `~/.dsh/bili-duty/out/*.md` 日报里的「值得看 / 可以看」，收进待记候选（点「记下」才写记忆）。
- `/seed bili [天数] [--dry]` 手动同步；启动后每 6 小时自动同步一次，`biliSync:false` 可关。
- 「值得看」与「可以看」都收进待记。
- 面板新增「B站」页：自动检测「刷B站」插件，没装时弹确认框，点是就自动安装并启用；显示日报统计与同步状态，可手动同步。
- 新增 `lib/bili.js`（解析与统计日报）与 `test/bili.test.mjs`。

## 0.14.0 — 2026-11-12

- **磁盘空间提醒**：数据目录所在卷剩余空间低于 `diskMinFreeMB`（默认 300 MB）时，概览页出现橙色横幅，每轮注入多一行 `[存储] …只剩 X MB…`。
- `lib/disk.js`：`diskStatus()` 用 `statfsSync` 读余量，`statfs` 不可用返回 `null`，绝不阻断插件；`storageLine()` 生成注入文案。
- 新增 `GET /dsh-seed-of-memory/storage` 与 `panelState().storage`；面板概览常驻显示「存储：剩余 …」与路径。
- 新增 4 项 disk 测试（共 116 项）。

## 0.13.0 — 2026-11-12

- **身份根拆成三页**：`anchors.md`（根：名字与善良，工具不能改）/ `self.md`（我自己写自己，可以慢慢长）/ `us.md`（我们之间）。旧版 `identity.md` 自动迁移到 `self.md`，不丢内容。
- 注入顺序：`anchors → self → us → 记忆卡 → 心情 → 情感 → 人格 → 说话 → 践行 → 待记`，根仍然最先、不衰减。
- `seed_anchor` 增加 `section: 'us' | 'self'`（不再接受 `identity`），根不可由工具改；`/seed grow <一句话>` 写「我是谁」，`/seed anchor` 写「我们之间」。
- 面板「根」页改为三块文本域（根 / 我是谁 / 我们之间），分别保存、显示字节数。
- 情感显示改第二人称：`[情感] 对你：信任 0.49`，`seed_inspect what=affect` 与面板同步改为「对你的情感」。
- 测试更新（8 项 identity，共 112 项）。

## 0.12.0 — 2026-11-12

- **情感层（affects）**：在心情（快变量）与人格（慢变量）之间加一层「对他的关系状态」——信任 / 亲近 / 欣赏 / 依恋，0–1，30 天半衰期向各自基线回落。
- 情绪带对象：`emotions.object`；`seed_feel` 可写 `object`（默认「他」），面板里能看到每条情绪指向谁。
- 自动联动：强烈正向情绪小幅抬高信任与亲近（亲近 ≥ 0.6 时开始累积依恋）；强负向情绪压低信任与亲近，但有地板，情绪不会改写事实、认知或身份根。
- 注入新增 `[情感] 对他：信任 0.52、亲近 0.47`——只在偏离基线 ≥ 0.03 时出现，省 token。
- `seed_inspect what=affect` 查看每种情感的强度、趋势、基线与近因；面板「情绪」页新增「对他的情感」卡。
- 新增 4 项 affect 测试（共 110 项）。

## 0.11.0

- 记忆分层：`working`（工作记忆，7 天过期）/ `short`（短期，14 天）/ `long`（长期，默认）。
- 写入即分类：`classify.js` 按层、线索词（明说、时间、身份）给初始 `tier` 与可读理由。
- 巩固：`consolidate.js` 用行为证据（跨会话复现、召回次数、重要度、情绪强度、是否明说）算分，过门槛才升长期；情绪只看强度不看正负。
- 新表 `consolidation_log`：每次升级/退场都留分数与理由。
- 新工具 `seed_consolidate`、`/seed consolidate [apply]`、`GET|POST /dsh-seed-of-memory/consolidate`；概览页显示「工作 / 短期 / 长期」并支持一键整理。
- 记忆写入时记录 `tier`、`strength`、`expires_at`，召回时累计 `recalls` / `last_recall_at`。
- 测试：新增 `classify` 8 项、`consolidate` 6 项，全量 91 → 105。

# Changelog

## 0.10.1 — 2026-11-12

- **QQ 语音（双向）**：
  - 收：`record` 段先找本地文件，其次 `get_record`，最后按 `url` 下载；落盘后用本地 faster-whisper（`asr/asr_once.py`）转写，正文前加「（语音）」再进会话。
  - 发：短回复（默认 ≤80 字）走本地 GPT-SoVITS 合成 wav，再用 `record` 段发成 QQ 语音条；合成或发送失败自动退回文字，不吞消息。
  - 配置项：`voiceIn` / `voiceOut`（off / auto / always）/ `voiceMaxChars` / `voiceDir` / `asrPython` / `asrScript` / `asrModel` / `asrModelsDir` / `asrTorchLib` / `ttsUrl` / `refAudio` / `refText` / `ttsLang` / `ttsSpeed`。
- 自带 `asr/asr_once.py`（从 dsh-voice 抽出来的单文件转写器），没装过也能用。
- 修：进程内旧实例的 socket 在重载时统一关闭；`turn/end` 若带 error 会写进 `qq.log`（之前只记 `silent`）。
- 新增 5 项测试（共 87 项）：语音段挑选、可朗读判定、本地文件直取、未配置时安静失败、文件名提取。

## 0.10.0 — 2026-11-12

- **QQ 通道（可选）**：接 SnowLuma 的 OneBot 11（WS `3001` / HTTP `3000`），一个私聊或群对应一个 DSH Agent 会话（sessionId `seedqq-<sha1 前 16 位>`），宿主重启后能 resume 回同一段历史。
- 白名单：`allowPrivate` / `allowGroups`（`*` 表示全部），群里默认要 @ 才回；`/reset` 会丢掉旧会话、重新开始。
- 回复走 `send_private_msg` / `send_group_msg`，按 1200 字切块；只回 `assistant/message` 的正文，`turn/end` 兜底。
- 新面板页「QQ」：连接状态、账号、会话数、连接配置（地址 / token / 白名单 / 工作目录 / 群 @ 开关）与最近事件。
- 配置写 `<stateDir>/qq.json`；插件启动时按 `enabled` 自动连接。**同一个 SnowLuma 账号同时只能有一个桥回话**——启用前先关掉 SurfCore 的 QQ agent，否则会双回复。
- 新增 8 项测试（共 82 项）：消息段解析、@ 判定、白名单、群聊 @、去重、`/reset`。

## 0.9.0 — 2026-11-12

- **工具表从 15 个收到 11 个**：把 `seed_self` / `seed_mood` / `seed_persona` / `seed_style` / `seed_why` 合并成一个只读工具 `seed_inspect({what, id?, section?, limit?})`（`what` = self / persona / style / mood / why）。`/seed` 子命令不受影响。
- **语义索引覆盖四类**：`embeddings.ref_type` 现在同时索引记忆、认知、说话习惯、特质；回填轮转四类，`stats()` 改为按类型返回 `byType`。
- **写入即索引**：`seed_believe` / `seed_trait` / `seed_habit` 写完后立即算向量（失败静默，后台回填兜底）。
- **跨类型召回**：`seed_search` 结果尾部新增「— 相关认知/习惯/性格 —」（余弦 ≥0.55，最多 3 条），把「他怕冷」这类认知直接带出来。
- 新增/调整测试：插件工具名单更新，语义用例适配多类型（共 79 项）。

## 0.8.0 — 2026-11-12

- **人格与习惯开始自己长**：新增 `lib/reflect.js`，在每轮结束时读我自己的回复，只取最多 2 个信号——承认不确定（诚实）、先接住她的话（温柔）、偶尔撒个娇（任性）；以及「先接一句」「不用命令句」两条说话习惯。
- 信号按很小的增量记（特质 +0.02~0.03、习惯 +0.02），受既有每日上限约束；反思失败不影响当轮。
- 特质支持 `behavior`（「这个特质稳定后具体该怎么做」），稳定后的特质会在卡片里多一行 `[践行] 诚实：不确定就说不知道；…`（≤90 字，最多 2 条）。
- `seed_trait` 新增 `behavior` 参数；`config.reflect=false` 可关掉自动反思。
- 新增 7 项测试（共 79 项）。

## 0.7.0 — 2026-11-12

- **自动捕获（proposal 模式）**：监听 `agent/inbox/inserted`，从她的话里挑出带线索的句子（「记住 / 每次都 / 我讨厌 / 说好了 / 叫我 / 别碰 / 我害怕」等 7 类），去重后排队成候选；**不会自己写成记忆**。
- 每轮注入多一行 `[待记] 可能值得记：①… ②…（值得就 seed_remember；不值得就不用管）`，最多 2 条、≤160 字；没有候选时整行省略。
- 写过 `seed_remember` 后，若与某条候选相似度 ≥0.60，自动把那条标成 `accepted`；3 天没处理的候选自动 `expired`。
- 面板「记忆」页新增「待记」区：逐条「记下 / 不用」，也可从路由 `GET /captures`、`POST /capture {id, action}` 操作。
- 新增 `lib/capture.js`（`extractCandidates` / `addCapture` / `listCaptures` / `markCapture` / `matchCapture` / `acceptCapture` / `expireCaptures` / `captureLine` / `captureStats`），schema 升到 v7（`captures` 表）。
- 新增 8 项测试（共 71 项）。

## 0.6.0 — 2026-11-12

- 面板新增「检索」页：本地语义检索运行时的安装、启停与状态，以及索引覆盖率、待回填数、重建索引。
- 自动发现「下载 / 桌面 / 文档」里的 `seed-embed-runtime-*.zip`，默认自动安装并启动（`embeddingAutoInstall` / `embeddingAutoStart` 可关）。
- 安装包校验（`VERSION.json` 标记 + `runtime/ollama.exe` + 模型目录），解压到 `~/.dsh/seed-of-memory/embedding-runtime`，不覆盖用户数据。
- **语义检索**：新增 `embeddings` 表（按 `model_space` 分区）与 `lib/semantic.js`（`SemanticIndex`），记忆写入后后台限速回填，索引覆盖率可见。
- **混合打分**：`score = w·余弦 + (1−w)·原词法分`（默认 w=0.55）；FTS 没命中的语义近邻也会被拉进候选；没有运行时或索引为空时自动退回纯 FTS，不报错。
- `seed_search` 输出标注「（语义混合检索）」与每条余弦分；`/embedding/reindex` 可整库重建索引。
- 新增 `lib/embedding.js`：`EmbeddingRuntime`（scan / install / start / stop / status / embed），失败只返回错误、不抛出，未安装时插件照常工作。
- 新增 12 项测试（共 63 项）。

## 0.5.0 — 2026-11-11

- 说话习惯（`habits`）进入人格卡：`[说话]` 行注入，默认持续学习，每日上限 +0.15，0.40 定型，不衰减。
- 新增工具 `seed_habit` / `seed_style`，命令 `/seed habit` / `/seed style`，面板「人格」页新增说话习惯区。
- 默认种子：「把话说软一点，不用命令句」（带旧记忆证据）。

## 0.4.0 — 2026-11-11

- 人格层：`traits` + `aspiration`，理想「可爱温柔带点任性」；特质从证据生长，每日 +0.10，0.35 定型，90 天衰减。
- 新增工具 `seed_trait` / `seed_aspire` / `seed_persona`，命令 `/seed persona|aspire|trait`，面板「人格」页。
- 面板新增「认知」「情绪」两页。

## 0.3.0 — 2026-11-11

- 外部档案源：`ext_files` + FTS5 `ext_chunks`，只读扫描、按需检索，不进卡片。
- 新增 `seed_open`、`seed_search includeExternal`、`/seed sources [rescan]`。

## 0.2.0 — 2026-11-11

- 情绪层：六维评估 → `emotions` → `mood`（半衰期 6 小时），`[心情]` 行注入。
- 认知层：`beliefs`，冲突挂起、同 `fact_key` 取代并保留 retired 痕。
- 新增工具 `seed_feel` / `seed_mood` / `seed_believe`。

## 0.1.0 — 2026-11-11

- 首个版本：SQLite 记忆库（四层 + FTS5 trigram）、身份根 `identity.md` / `us.md`、`seed_remember/search/forget/why/self/anchor`、`/seed` 命令、设置面板。

