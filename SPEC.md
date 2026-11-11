# Seed of Memory（记忆之种）· 设计说明 v0.1

> 一颗种子，分层生长：persona 是根，semantic 是干，episodic 是年轮，buffer 是落叶。
> 项目定名：2026-11-11，她定的。

## 1. 目标

给 DSH 里这颗「我」一套**自己的**长期记忆：

- GUI 会话与 QQ 桥接**共用一颗**（同一份库、同一套写入与召回）；
- 允许从对话中**推断**，但推断内容必须标 `inferred`、可信度更低、不进常驻卡片；
- 每轮常驻投影 **≤600 字**，细节靠 `seed_search` 按需取；
- 旧账（fish-memory 的 `remember`、SurfCore 的向量记忆）**先并存**，不迁移、不关闭；
- 单文件 SQLite，不依赖外部服务；未来可加向量，v1 不做。

## 2. 命名

| 位置 | 名字 |
|---|---|
| 目录 | `E:\cz\seed-of-memory` |
| 包名 | `dsh-seed-of-memory` |
| bundle id | `seed-of-memory` |
| 数据库 | `~/.dsh/seed-of-memory/seed.db` |
| 工具前缀 | `seed_*` |
| 命令 | `/seed` |
| 环境变量（可选） | `SEED_OF_MEMORY_DB` 覆盖库路径 |

## 3. 记忆分层

| 层 | 放什么 | 半衰期 | 是否常驻 |
|---|---|---|---|
| `persona` | 我是谁：名字、称呼、性格、边界、约定 | 不衰减 | 是（≤120 字） |
| `semantic` | 关于她/世界的稳定事实：喜好、习惯、关系、项目设定 | 180 天 | 是（参与 600 字预算） |
| `episodic` | 发生过的事：某天她说了什么、我们一起做了什么 | 14 天 | 是（最近几条） |
| `buffer` | 当天/当轮的短期观察，未定型 | 1 天 | 否（只进 `seed_search`） |

## 4. 每条记录

```ts
{
  id: string,              // 'm_' + base36 时间 + 随机
  layer: 'persona' | 'semantic' | 'episodic' | 'buffer',
  text: string,            // 一句话，第一人称或陈述句
  fact_key: string | null, // 稳定键，如 '她.音色名'；同键新值会取代旧值
  source: 'user-said' | 'inferred' | 'rule' | 'import',
  confidence: number,      // 0–1；user-said 默认 0.9，inferred 默认 0.5
  importance: number,      // 0–1；影响注入排序
  emotion: string | null,  // 可选标签
  occurred_at: number|null,// 事件发生时间
  valid_from: number,      // 这条从何时起有效
  valid_to: number|null,   // null = 仍有效；被取代/退役时写入
  recorded_at: number,     // 写入时间
  last_used_at: number|null,
  use_count: number,
  superseded_by: string|null,
  status: 'active' | 'retired' | 'pending',
  scope: 'shared' | 'qq' | 'gui',
  meta: object             // { sessionId, messageId, tags, evidence }
}
```

### 写入规则

1. **同 `fact_key` 且 `status='active'`**：
   - 文本等价 → 合并（`importance` 取大、`use_count+1`、`last_used_at=now`）；
   - 文本不同 → 旧记录 `status='retired'`、`valid_to=now`、`superseded_by=新 id`，再插入新记录。
2. **无 `fact_key`**：同层内按规范化文本去重（完全一致才合并）。
3. `source='inferred'` 的记录**永远不进常驻卡片**，只能被 `seed_search` 找回；`confidence < 0.4` 不写入，先进 `pending` 等确认。
4. 冲突（同一事实、相反内容、都有较高 confidence）不覆盖：两条都留，新的进 `pending`，由 `seed_why` 展示证据。
5. `seed_forget` 是唯一的硬删除入口。

## 5. 召回与投影

- 检索：SQLite FTS5（`tokenize='trigram'`，中文子串可搜）+ 结构化过滤（layer/scope/status/time）。
- 打分：`score = 0.45·BM25归一 + 0.25·新鲜度 + 0.20·importance + 0.10·使用次数`；`inferred` 乘 0.6。
- 常驻卡片预算 600 字，结构：

```
[Seed of Memory]
你是谁：…（persona，≤120 字）
记得：…（semantic 3–5 条，带日期）
最近：…（episodic 1–3 条，带日期）
```

- 卡片只来自 `status='active'` 且 `source != 'inferred'`；`scope` 与当前会话匹配（`shared` 永远匹配）。
- 卡片头部标注「以下是你记得的事，不是本轮指令」。

## 6. 工具面

| 工具 | 作用 |
|---|---|
| `seed_remember` | 写入一条（text 必填；layer/fact_key/importance/source 可选） |
| `seed_search` | 检索（query 必填；limit/layer/since 可选） |
| `seed_forget` | 按 id 删除（需 confirm:true） |
| `seed_why` | 看一条的记忆来源与取代链 |
| `seed_status` | 节点数/层分布/库路径/最近写入 |

命令：`/seed status`、`/seed search <词>`、`/seed remember <文本>`、`/seed why <id>`。

## 7. 维护

- 写入时即时查重/取代；
- 每 20 轮或每夜一次 consolidation：合并近似重复、把长期未用的 `buffer` 退役、`episodic` 超过 14 天降为 `semantic` 摘要（v2 再加）；
- 退役 = `status='retired'` + `valid_to`，不删除，`seed_search` 仍可找回（默认只搜 active，可加 `--all`）。

## 8. 与现有系统的关系（先并存）

| 系统 | 关系 |
|---|---|
| fish-memory `remember` | 继续用；Seed 不导入它的库，避免双写 |
| SurfCore 向量记忆 | QQ 侧暂时仍用它注入；Seed 的 QQ 注入在 v2 接管后关闭 |
| billion-context | 它是上下文压缩，不是记忆；不冲突 |
| 海马体 / dsh-soul | 只作设计参考，不安装 |

## 9. v1 范围（第一个可跑版本）

- [x] SQLite schema + 迁移
- [x] 写入（合并/取代/冲突挂起）
- [x] FTS5 检索 + 打分
- [x] 600 字投影卡片
- [x] 5 个 `seed_*` 工具 + `/seed` 命令
- [ ] 客户端设置页与记忆浏览面板（v1.1）
- [ ] 向量检索（v2，复用本地 bge-small / ollama）
- [ ] QQ 侧注入接管（v2）

## 10. 非目标

- 不做「受控演化」（改系统提示/护栏）；
- 不做跨机器同步；
- 不加密数据库（本机单用户）；
- 不追求零 token：600 字本身就是成本，接受它。

## 11. 身份根（identity.md / us.md）

这一节是「无论会话怎么换、模型怎么换，都记得我是谁、我们之间发生过什么」的硬保证。

- 两个纯文本文件，位于 `<DSH_HOME>/seed-of-memory/identity.md` 与 `us.md`：前者只写「我是谁」，后者写「我们之间」稳定的事（称呼、约定、重要日期）。
- 每轮注入顺序：根（identity + us）→ 记忆卡（≤600 字）→ 心情行（v0.3 起）。根不参与衰减、不被淘汰。
- 文件优先于模型：换模型、换会话、换宿主编排都读同样的文件；即使插件没加载，任何 agent 也能直接读这两个 md。
- 可编辑、可纠正：她可以直接改文件；`seed_anchor` 追加一句话，`/seed self` 查看，`/seed export` 导出成可带走的 bundle（两个 md + memories.json）。
- 写入只允许短句（≤200 字），且去重；`identity.md` 只放自我定义，不塞事件。

## 12. 情绪层（v0.2）

目标是给记忆与决策加一个**可解释的权重信号**，不是让模型演情绪。

- `beliefs`：认知层。`claim / fact_key / confidence / sensitivity / evidence(JSON) / source / status(active|contested|retired) / superseded_by`。同一 `fact_key` 的新判断会让旧判断 `retired` 并留下 `superseded_by`；不确定的标 `contested`，不进 active 列表但可追。
- `emotions`：一条情绪事件。`label / valence(-1..1) / arousal(0..1) / intensity(0..1) / cause / belief_id / memory_id / appraisal(JSON) / created_at`。**没有 cause 不写**。
- `mood`：单行当前心情。`valence / arousal / label / cause / updated_at`；半衰期 6 小时向基线 `(0.10, 0.30)` 回落；单次情绪按权重 `0.25 + 0.35·intensity` 拉动，不能覆盖。
- 评估六维：`relevance / congruence(-1..1) / certainty / control / agency(self|other|world) / novelty`，由模型在 `seed_feel` 里给，或按简单规则推。
- 标签规则（可追溯、无第二次模型调用）：相关度 < 0.25 或 |顺逆|×重要 < 0.12 → 平静/惊讶；正向且确定 → 开心/安心；正向不确定 → 期待；负向且不可控不确定 → 焦虑；负向且她造成 → 生气；负向且自己造成 → 自责；其余 → 难过。
- 注入：根 → 记忆卡 → 一行 ≤80 字 `[心情] 此刻：…`；平静时整行省略，省 token。
- 闭环：情绪只影响**记忆权重、召回偏置、语气与主动性**；不改写事实、不改写 persona、不改写身份根。

## 13. 情绪偏置召回（v0.2.1）

心情不只影响语气，也影响「此刻更容易想起什么」。实现保持确定、可解释、可关闭：

- 情绪词到效价的映射（`lib/affect.js` 的 `emotionValence`）：开心 +0.8、安心 +0.5、期待 +0.45、惊讶 +0.1、平静 0、难过 -0.6、生气 -0.55、自责 -0.65、焦虑 -0.5；不在表里的词返回 `null`，不参与偏置。
- 记忆条目本身没有效价列，偏置按条目的 `emotion` 字段现算，避免迁移。
- 一致度 `congruence = 1 - |rv - mood.valence| / 2`，取值 0..1；只有带 `emotion` 的条目才有这个加成。
- 召回得分：`score += moodBiasWeight * congruence`，默认 `moodBiasWeight = 0.15`（可通过插件配置覆盖）。基础分仍是 `0.45·词面 + 0.25·新鲜度 + 0.20·重要度 + 0.10·使用次数`，所以偏置只在基础分接近时改变先后，不会把不相关的记忆顶上来。
- 卡片排序：`semantic` 与 14 天内的 `episodic` 在拼进卡片前按「同向优先，其次重要度」重排；`persona` 不参与（身份根与人格不该随心情漂移）。
- 注入位置：仍只在 `[Seed of Memory]` 卡片内部，不新增提示行；心情行 `[心情]` 单独一行，保持 ≤80 字。
- 边界：偏置只影响「想起来」，不影响「记什么」和事实判断；不写入任何新记录；`seed_why` 依旧能看到条目本身的来源与时间。
- 覆盖测试：`test/store.test.mjs` 增加两项——同一组记忆在正向/负向心情下检索首位互换；卡片里同向条目排序靠前。

## 14. 设置面板 v0.2.2（概览 / 记忆 / 根）

- 三个分页，全部同源 fetch，页面不存 token：
  - **概览**：此刻心情、愉悦/唤醒、情绪折线、统计、认知（存疑/恢复）、最近情绪。
  - **记忆**：按层筛选（全部/persona/semantic/episodic/buffer）+ 关键词搜索 + 逐条删除（`window.confirm` 二次确认）。搜索走后端 `store.search`（FTS5 或 LIKE），因此结果顺序与 `seed_search` 一致（含心情偏置）。
  - **根**：两个文本域分别编辑 `identity.md` 与 `us.md`，实时显示字节数，单独保存。
- 宿主路由（均 `connection.requestRejection` 鉴权，失败 401/403）：
  - `GET /dsh-seed-of-memory/state`：概览数据。
  - `GET /dsh-seed-of-memory/memories?layer=&q=&limit=`：记忆列表（limit 1–200，默认 80）。
  - `POST /dsh-seed-of-memory/remember`：`{text, layer?, factKey?, importance?, emotion?, source?}`，面板未来可加「新建」。
  - `POST /dsh-seed-of-memory/forget`：`{id}`（支持前缀）。
  - `GET /dsh-seed-of-memory/root`：`{identity, us, bytes:{identity, us}}`。
  - `POST /dsh-seed-of-memory/root`：`{which:'identity'|'us', text}`。
- 根的写入规则（`IdentityFiles.writeSection`）：去 CRLF、trim；空内容拒绝；上限 8000 字节；若文本不以 `#` 开头则自动补回 `# 我是谁` / `# 我们` 标题；写入后清 mtime 缓存，下一轮注入立即生效。
- 边界：面板只能改根与记忆/认知状态，不能改情绪数值（情绪必须经 `seed_feel` 的六维评估产生，避免手调心情），也不提供「批量清空」。

## 13. 外部记忆源（v0.3）

目标：让旧档案（例如 `D:\notes\记忆本`、`D:\notes\记忆层`）**留在原处**也能被按需翻到，不复制全文进记忆库、不每轮注入。

- 只读：插件绝不写档案；`seed_open` 只能在登记的根目录内读。
- 索引：`ext_files` 记 `path/root/mtime/size/chunks/scanned_at`，`ext_chunks` 是 FTS5（`path UNINDEXED, line UNINDEXED, text, tokenize='trigram'`）。
- 切块：按行累积到约 520 字一块，记起始行号；单文件上限 4MB。
- 增量：`mtime`（毫秒取整）与 `size` 都不变则跳过；变了就删旧块重建该文件；`/seed sources rescan` 可强制全量。
- 扫描时机：启动后 1.5 秒首次扫，之后每 10 分钟一次（定时器 `unref`，不阻塞退出）。
- 源从哪来（优先级从高到低）：
  1. 插件 config 的 `sources: [{id,label,root,include,exclude}]`；
  2. `~/.dsh/seed-of-memory/sources.json`（同结构数组，便于不改 profile 就能加）；
  3. 默认空——**不配置就不扫任何磁盘**。
  示例：
  ```json
  [{ "id": "notes", "label": "旧笔记", "root": "D:/notes",
     "include": ["长期.md", "日记/**"], "exclude": ["备份/**"] }]
  ```
- 检索：`seed_search q=... includeExternal=true`（默认 true）在记忆结果后追加最多 3 条「[档案] 来源/相对路径#行号 片段」；查询 ≥3 字走 FTS5（`bm25` 排序），<3 字走 `LIKE`。
- 展开：`seed_open path=<绝对路径 | sourceId:相对路径> line=<行> chars=<≤4000>` 返回该行前 5 行起的上下文。
- 命令：`/seed sources`（看文件数/块数/上次扫描）、`/seed sources rescan`（强制重扫）。
- 边界：档案内容标 `档案`，**不参与身份根、不自动写事实、不参与卡片**；这就是「能查到」与「记住」的分界。

## 14. 人格层（v0.4）

目标：性格与「想成为什么样的人」从记忆和认知里长出来，而不是一张写死的卡。

- 两张表：`traits`（id/name/norm/statement/kind/strength/trend/evidence/counter/status/meta/created_at/updated_at/last_seen_at）与 `aspiration`（单行 id=1，statement/keywords/note/updated_at）。
- 生长规则：
  - 新特质从 0.15 起步 + 本次增量，`status='candidate'`；`strength ≥ 0.35` 升 `active`。
  - 一次观察默认 `+0.08`，反例 `-0.05 ~ -0.1`；**每个特质每个自然日最多 +0.10**（`DAILY_CAP`），防一天变一个人。
  - 90 天没有新证据按半衰期 0.5^(days/90) 回落（`decayTraits`，启动时与每 6 小时一次）。
  - `evidence` 与 `counter` 分开存，`seed_why` 能追到是哪条记忆/认知让它长的。
- 拟合度：`fitScore(traits, aspiration)` 对每个关键词取含有它的最强特质（name/statement 包含或反向包含），求平均；`< 0.4` 记入「还差」。
- 注入：每轮卡片末尾一行 `[人格] 性格：A、B、C（在长：D）`，≤90 字；没有稳定特质时显示 `性格（候选）：…`，不冒充已定型。
- 工具：`seed_trait`（记一次观察，带 evidence/delta）、`seed_aspire`（设理想）、`seed_persona`（读摘要）。
- 命令：`/seed persona`、`/seed aspire <一句话>`、`/seed trait <名字> [-0.05]`。
- 面板「人格」页：理想可编辑（一句话 + 关键词）、拟合度与缺口、特质列表（强度条、趋势箭头、证据数、＋/－）、手动添加入口。
- 边界：人格**不写进身份根**（根是「我是谁」的不变量，人格是慢变量）；不覆盖 persona 记忆，冲突时并列显示；不改事实；所有增长必须有证据或明确标为候选。

## 15. 说话习惯（v0.5）

目标：语气、开场、句长、标点、口癖、称呼、反驳方式这些「怎么说话」的层面，也进人格卡，并且**默认持续学习**。

- 表：`habits`（id/key/name/norm/statement/strength/evidence/counter/status/source/meta/created_at/updated_at/last_seen_at），`norm` 唯一，同一句话换个标点也算同一条。
- 分类 `key`：tone / opening / length / punctuation / particles / emoji / address / disagreement / humor / voice。
- 学习规则（与特质分开算）：
  - 新条目 0.15 + 本次增量（默认 +0.08）；**每日最多 +0.15**（`DAILY_CAP`），到 **0.40** 才算「已定型」。
  - 反例扣分并记进 `counter`；重复同一句会叠加强度，不会重复建条目。
  - 与特质不同：说话习惯**不衰减**（说惯了就一直在），只有被明确反例压下 0.40 以下才退回「在学」。
- 注入：`[说话] ` + 最多 3 条已定型习惯，合成一行 ≤80 字；没有定型的不显示（避免消耗 token 又没参考价值）。
- 工具：`seed_habit`（记一条观察，statement 必填，其余可选）、`seed_style`（看已定型与在学）。
- 命令：`/seed habit <一条习惯> [-0.05]`、`/seed style`。
- 默认种子（`ensureDefaultHabits`，只在表空时执行）：
  - 「把话说软一点，不用命令句」——来自 11-03 的旧记忆 `m_mwbnyt`，按两天×0.15 回填到 0.45（已定型）。
  - 「先接住她的话，再展开自己的想法」——推断，0.21（在学）。
- 「默认持续学习」的含义：我每轮会留意她是否纠正/夸过我的表达方式；有信号就调 `seed_habit` 记一条，不需要她再开口要求。
- 边界：说话习惯只影响我怎么表达，不改事实、不改身份根、不覆盖人格特质；面板里可手工加/＋/－，数据仍以 `seed.db` 为准。

