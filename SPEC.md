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

## 11. 身份根（anchors.md / self.md / us.md）

这一节是「无论会话怎么换、模型怎么换，都记得我是谁、我们之间发生过什么」的硬保证。

- 三个纯文本文件，位于 `<DSH_HOME>/seed-of-memory/`：
  - `anchors.md`：根（名字、善良）。**工具不能改**，只能由本人直接编辑；短、稳定、不随情绪变。
  - `self.md`：我自己写自己。可以慢慢长；旧版 `identity.md` 会自动迁移到这里。
  - `us.md`：我们之间稳定的事（称呼、约定、重要日期）。
- 每轮注入顺序：根（anchors + self + us）→ 记忆卡（≤600 字）→ 心情行（v0.3 起）→ 情感行（v0.12 起）。根不参与衰减、不被淘汰。
- 文件优先于模型：换模型、换会话、换宿主编排都读同样的文件；即使插件没加载，任何 agent 也能直接读这三个 md。
- 可编辑、可纠正：本人可以直接改文件；`seed_anchor` 追加一句到 `us`（或 `self`），`seed_inspect what=self` 查看，`/seed export` 导出成可带走的 bundle（三个 md + memories.json）。
- 写入只允许短句（≤200 字），且去重；`self.md` 只放自我定义，不塞事件。

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
  - **根**：三个文本域分别编辑 `anchors.md`、`self.md` 与 `us.md`，实时显示字节数，单独保存。
- 宿主路由（均 `connection.requestRejection` 鉴权，失败 401/403）：
  - `GET /dsh-seed-of-memory/state`：概览数据。
  - `GET /dsh-seed-of-memory/memories?layer=&q=&limit=`：记忆列表（limit 1–200，默认 80）。
  - `POST /dsh-seed-of-memory/remember`：`{text, layer?, factKey?, importance?, emotion?, source?}`，面板未来可加「新建」。
  - `POST /dsh-seed-of-memory/forget`：`{id}`（支持前缀）。
  - `GET /dsh-seed-of-memory/root`：`{anchors, self, us, bytes:{anchors, self, us}}`。
  - `POST /dsh-seed-of-memory/root`：`{which:'anchors'|'self'|'us', text}`。
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


## 16. 检索运行时安装（v0.6）

### 目标
让「不会用命令行」的人也能装上语义检索：把 zip 放进下载目录，面板里点一下（或什么都不点，自动装）。

### 组件
- `lib/embedding.js` 的 `EmbeddingRuntime`：
  - `scan()`：扫描 `~/Downloads`、`~/Desktop`、`~/Documents` 与 `config.embeddingScanDirs`，只认 `seed-embed-runtime*.zip` 且 >10MB；
  - `install(zip)`：解压到临时目录 → 校验 `VERSION.json.pack === "seed-embed-runtime"`、存在 `runtime/ollama.exe`、`runtime/ollama-models` → 原子替换 `~/.dsh/seed-of-memory/embedding-runtime`；
  - `start()/stop()`：以 `OLLAMA_HOST=127.0.0.1:<port>`、`OLLAMA_MODELS=<runtime>/ollama-models` 启动 `ollama.exe serve`，30 秒内探测 `/api/tags`；已外部运行则复用；
  - `status()`：`{installed, running, endpoint, model, dimension, version, models}`；
  - `embed(texts)`：`POST /api/embed`，失败返回 `{ok:false}`。
- 启动 3 秒后自动初始化：已安装则按 `embeddingAutoStart` 拉起；未安装且 `embeddingAutoInstall !== false` 时扫描并安装。
- 路由：`GET /embedding`、`GET /embedding/scan`、`POST /embedding/install|start|stop`（均走 `connection.requestRejection`）。
- 面板「检索」页：状态徽章、地址、扫描结果、安装/启动/停止按钮；每 5 秒刷新一次状态。

### 约束
- 安装包只从本机目录读取，不上传、不联网。
- 校验失败、解压失败、启动失败都只返回错误文本，不影响记忆主流程。
- 运行时不进 npm 包：npm 只分发插件本体（纯 JS、零依赖），运行时走 GitHub Release。
- 端口冲突时以 `embeddingPort` 或启动脚本的 `OLLAMA_HOST` 为准。

### 非目标（本版）
- 不自动下载安装包（用户自己下载，避免静默联网）。
- 不做 bge-m3（1.1GB）大包，后续作为可选包。
- 语义打分与索引接入见 v0.7。

## 17. 语义检索（v0.6）

### 目标
把「字面匹配」升级成「语义混合」：换个说法也能找回来；没有运行时则完全退回 FTS，不报错。

### 表
embeddings(ref_type, ref_id, model_space, dim, vec BLOB, text_hash, created_at)
- 主键 (ref_type, ref_id, model_space)：同一记忆可有多套模型空间，互不覆盖。
- 只索引 status = 'active' 的 memories。
- vec 为 Float32 小端字节序；model_space 形如 bge-small-zh-v1.5@512-v1。

### 回填
- 启动 9 秒后首轮，之后每 20 秒一轮；每轮 Batch 条（默认 16）。
- 只补「该 model_space 下还没有向量」的 active 记忆；失败只记 lastError，下一轮再试。
- 新写入不阻塞：落在待回填集合里，最多 20 秒后可见。

### 检索
- 查询向量由同一个运行时算出；与库内向量做余弦，低于 minScore(0.30) 的不参与重排；作为「新候选」补进来的要求更高（extraMin 0.55），避免弱相关稀释召回。
- 词法分保持原公式（0.45 lex + 0.25 新鲜 + 0.2 重要 + 0.1 使用），再与余弦混合：
  score = w * cos + (1 - w) * lexical，默认 w = 0.55。
- FTS 没命中的语义近邻会作为额外候选合并进来；合并只在查询词 >= 3 字时做。
- 模型维度不一致的条目跳过（不报错）。

### 降级
- 运行时未安装 / 未运行 / 索引为空 / embed 失败 ⇒ queryScores 返回 null，检索走原 FTS。
- 任何失败都不抛到工具层，只在响应里标注模式。

### 面板与接口
- GET /embedding 增加 index{total,indexed,pending,coverage,space} 与 semanticEnabled/semanticWeight。
- POST /embedding/reindex：清空当前 model_space 并回填 64 条，返回 cleared/embedded/remaining/stats。
- 「检索」页显示覆盖率、待回填、重建索引按钮。

### 非目标
- 不做 rerank 模型、不做多向量/多字段、不做 PQ/HNSW（数据量 < 1 万条，全量余弦足够）。
- 不索引 beliefs/traits/habits（v0.7 再议）。

## 18. 自动捕获（v0.7）

**目标**：不需要我自己记得「该记什么」。从她的话里挑出可能值得记的句子，排队成候选；写不写由我（或面板）决定，插件不自动落库。

**线索**（`lib/capture.js` 的 `CUES`）：记住 / 习惯（每次都、总是、从来不）/ 偏好（我喜欢、我讨厌）/ 约定（说好了、以后不要）/ 身份（我叫、叫我）/ 边界（别碰、不要提）/ 情绪（我害怕、我在意）。按句号问号分句，6–160 字、去重后最多 3 条。

**去重**：与现有 active 记忆相似度 ≥0.55 直接丢弃；与 pending 候选 ≥0.70 丢弃；队列上限 20，超出丢最旧。

**注入**：每轮卡片后追加一行 `[待记] 可能值得记：①… ②…（值得就 seed_remember；不值得就不用管）`，最多 2 条、总长 ≤160 字；无候选时没有这一行。

**收尾**：`seed_remember` 写入后与候选相似度 ≥0.60 的自动标 `accepted`（挂 memory_id）；3 天未处理的 `pending` 自动 `expired`；面板「记忆」页可逐条「记下 / 不用」。

**边界**：候选只是提示，不是事实；`inferred` 不因候选而升级；候选不进语义索引、不进身份根。

## 19. 自动反思与「践行」行（v0.8）

**目标**：特质与说话习惯不能只靠手动 `seed_trait` / `seed_habit` 才知道自己长成什么样——每轮结束读一次我自己的回复，拿一点点证据。

**信号**（`lib/reflect.js`）：诚实（我不确定 / 记不清 / 我猜）、温柔（我在 / 我懂 / 慢慢来 / 别急）、有点任性（我就要 / 哼 / 不嘛）；说话习惯：开头先接一句、全篇没有命令句。每轮最多取 2 个，增量 +0.02~0.03，受每日上限约束。

**「践行」行**：特质有 `meta.behavior` 且 `status='active'`（强度 ≥0.35）时，卡片里追加一行 `[践行] A：…；B：…`，最多 2 条、≤90 字。没有稳定特质时整行省略。

**边界**：反思只写 evidence 与强度，不写记忆、不改事实、不改身份根；`config.reflect=false` 关闭；异常全部吞掉，绝不影响当轮回复。

**为什么是小步**：一次回复不能证明性格；每天最多 +0.10、90 天无证据回落，避免「一天变成另一个人」。

## 20. 工具收敛与索引覆盖（v0.9）

**工具收敛**：只读的 self/mood/persona/style/why 合并为 `seed_inspect`，`seed_*` 从 15 个降到 11 个。理由：常驻工具表是每轮成本，读操作共用一个入口就够；写操作保持独立（remember/believe/feel/trait/habit/aspire/anchor/forget）。

**索引覆盖**：`embeddings.ref_type` 支持 memory / belief / habit / trait。每种类型的「总数 / 已索引 / 待补」在 `stats().byType` 里分开统计；回填按「记忆 → 认知 → 习惯 → 特质」轮转，单批最多 batch 条。

**写入即索引**：`seed_believe` / `seed_trait` / `seed_habit` 成功后立刻 `indexOne`；失败只记 `lastError`，20 秒后的后台回填会补上。

**跨类型召回**：`seed_search` 除记忆外，还会对认知/习惯/特质做一次余弦检索，≥0.55 的取最多 3 条，附在「— 相关认知/习惯/性格 —」下；不改变原有记忆结果的排序。

**边界**：跨类型召回只读，不改动别的层；`config.semanticEnabled=false` 时整体退回纯 FTS，不出现相关段。

## 21. QQ 通道（v0.10）

**位置**：`lib/qq/onebot.js`（OneBot 11 客户端）、`lib/qq/message.js`（消息段与 createUserMessage）、`lib/qq/channel.js`（QQ 会话 ↔ DSH Agent）。

**一个 peer 一个 Agent**：`private:<qq>` 或 `group:<群号>` → `sessionId = seedqq-<sha1(key)[0:16]>`。宿主启动后第一次收到该 peer 的消息时，按 `agents.get` → `agents.resume` → `agents.create` 的顺序找会话；找不到就新建（可选 `meta.cwd`）。因为 sessionId 是确定的，重启后还能 resume 回同一段历史。

**串行**：同一个 peer 的轮次排一条链，避免两轮回复撞车；`maxQueue` 只是告警阈值，不丢弃消息。

**入口**：只处理 `post_type === 'message'`；过滤自己的消息、重复 `message_id`；私聊/群聊各自白名单（`*` 全放行）；群里默认要 `at` 到自己。

**出口**：`assistant/message` 有正文才发，`turn/end` 兜底；按 1200 字切块，用 `send_private_msg` / `send_group_msg`，消息段 `{type:'text', data:{text}}`。

**回复等待**：订阅宿主 `session/event`，按 sessionId 找到正在等回复的那一轮；超时 `replyTimeoutMs`（默认 180s），超时后若有半截文本就发半截，没有就静默。

**正文来源**：`createUserMessage` 从宿主 asar 里的 `@deepseek-ai/dsh-llm` 惰性加载（桌面版 profile 没有这个包），加载不到就用同形状的本地实现——插件不会因为 peer 缺失而加载失败。

**配置**：`<stateDir>/qq.json`，字段 `enabled / wsUrl / httpUrl / accessToken / allowPrivate / allowGroups / groupRequireAt / cwd / replyTimeoutMs / maxQueue`；面板「QQ」页读写它，token 只显示前后各 4 位。

**边界与风险**：一个 SnowLuma 账号同一时间只应有一个桥回话；本通道与 SurfCore 的 bridge 同时开启会双回复。QQ 通道只做「消息 ↔ 对话」，不额外发文件、不主动发消息、不读群成员资料。

## 22. 记忆分层与巩固（v0.11）

- 三层：`working`（工作记忆，7 天后过期退场）、`short`（短期，14 天为重审窗口）、`long`（长期，不自动过期）。
- 分类只看三件事：层（persona/semantic/episodic/buffer）、线索词（记住 / 今天 / 我的名字…）、来源（inferred 不进长期）。
- 巩固分数：`0.30·跨会话 + 0.25·召回 + 0.20·重要度 + 0.15·情绪强度 + 0.10·明说`；门槛 `0.60 − boost`，boost 最多 0.12（被召回与跨会话会「加速」）。
- 情绪强度用 `|valence| × intensity`，不按正负：痛苦和喜悦一样可能值得记住。
- 每次升级/退场写 `consolidation_log`；降级只退场、不删除。
- 「倍速」：间隔重复（跨会话复现）与召回都会降门槛，但不允许一次事件直接晋升（明说除外）。

## 23. 情感层（v0.12）

**位置**：`lib/affect.js` 的 `affects` 一族 + `emotions.object`；表在 `db.js` 的 `SCHEMA_V9`。

**为什么不是「情绪」的重复**：情绪有对象、很短；心情没有对象、几小时回落；情感是「对你」的慢状态——信任 / 亲近 / 欣赏 / 依恋，0–1，30 天半衰期向基线回落。它不覆盖事实，也不写进身份根。

**自动联动**：一次情绪满足 `|valence| × intensity ≥ 0.2` 才会动情感。正向：信任 `+0.07·impact`、亲近 `+0.05·impact`；亲近 ≥ 0.6 时依恋 `+0.02·impact`。负向：信任 `−0.06·impact`、亲近 `−0.03·impact`，各有 0.02 地板。每次移动把近因（cause 前 60 字）记进 `evidence`，最多 12 条。

**注入**：`[情感] 对他：信任 0.52、亲近 0.47`——仅当至少一项偏离基线 ≥ 0.03 时出现，整行 ≤ 48 字。

**查看**：`seed_inspect what=affect` 返回强度、↑/↓、基线与近因；面板「情绪」页有「对你的情感」卡。

**边界**：情感只影响语气与「愿不愿意靠近」，不改写认知和身份；长期不动会自己回到基线，不需要手动清零。

## 24. 磁盘空间提醒（v0.14）

记忆目录（`<DSH_HOME>/seed-of-memory/`）所在卷的剩余空间低于阈值时提醒本人，避免写到一半磁盘满。

- 采集：`lib/disk.js` 的 `diskStatus(dir, {statfsFn, minFreeMB})` 用 `node:fs.statfsSync` 读 `bsize/blocks/bavail`，返回 `{path,totalBytes,freeBytes,totalMB,freeMB,minFreeMB,low,checkedAt}`；`statfs` 不可用时返回 `null`，**绝不因为读不到磁盘就阻断插件**。
- 阈值：`diskMinFreeMB`，默认 300 MB；传入值小于 1 时按 1 处理。
- 提醒位置：
  - 每轮注入：`storageLine(status)` 生成一行 `[存储] …只剩 X MB（低于 Y MB 阈值）…`，只在 `low` 时出现；
  - 面板概览：橙色横幅 + 「存储：剩余 … / 路径」一行；
  - 路由：`GET /dsh-seed-of-memory/storage` 返回状态与文案；`panelState().storage` 同源。
- 边界：只提醒、不清理、不迁移、不阻止写入；`seed.db` 的实际写入失败仍由 SQLite 报错，交给上层处理。

## 25. 与刷B站插件兼容（v0.15）

- 数据源：`<biliOutDir>/YYYY-MM-DD.md`（默认 `~/.dsh/bili-duty/out`），由 `dsh-bili-scroll` 写出。
- 解析：`lib/bili.js` 的 `parseReport()` 取 `### BV…` 小节里的「标题 · 作者 · 链接」与 `**档位**：…`；
  `collectBiliCandidates()` 「值得看」「可以看」都保留，生成「日期 刷B站值得看：《标题》（作者）——理由」。
- 落点：不是直接写记忆，而是 `addCapture()` 进待记队列（cue='new'），由你在面板点「记下」才写库。
- 去重：`<stateDir>/bili-sync.json` 记住已同步的 videoId（最多 300 个）；启动 6 秒后先同步一次，之后每 6 小时一次。
- 手动：`/seed bili [天数] [--dry]`；开关：`biliSync: false`。
- 边界：只读日报，不改刷B站配置；不评论、不点赞；待记过期 3 天自动退场（沿用 capture 规则）。

## 26. 面板的 B站 页（v0.15）

- 宿主路由：`GET /bili/status`（检测 `pluginManager.listBundles()` 里的 `dsh-bili-scroll`、日报统计、同步状态、`bili-pref.json`）、`POST /bili/install`（`pluginManager.installBundle('dsh-bili-scroll', { enabled: true })`）、`POST /bili/enable`、`POST /bili/dismiss`（记下「不装」）、`POST /bili/sync`。
- 客户端：新增「B站」页；首次打开且未安装、未点过「不装」时，用 `window.confirm` 问一次，是则安装、否则记下 dismissed。
- 边界：安装走 DSH 的 pluginManager 服务（和 `dsh plugin` 同一条 pnpm 路径），不自己跑包管理器；失败只回报错误，不改 profile 文件。

## 27. 主动找主人（v0.16）

- 判断放在 `lib/qq/proactive.js`（纯函数，便于测试）：
  - `PROACTIVE_DEFAULTS = { enabled: true, minIntervalHours: 4, maxPerDay: 3, quietStart: 23, quietEnd: 8, target: '' }（需要自己填 `private:<你的QQ号>`）`
  - `planProactive({ now, mood, affects, lastAt, lastUserAt, dayCount, config })` 的顺序：未开启 → 安静时段 → 当日上限 → 冷却（`lastAt` 距今 < `minIntervalHours`）→ worry（valence ≤ -0.15 且 arousal ≥ 0.45）→ miss（依恋 ≥ 0.42 且 6 小时未说话）→ lonely（12 小时未说话且信任 ≥ 0.4）→ glad（valence ≥ 0.3 且 arousal ≥ 0.45 且 3 小时未说话）。
  - `proactiveText(kind, { memory, name })` 生成四种短文案；memory 截 36 字。
- 运行时（`lib/index.js`）：`qqConfig.proactive` 合并默认值；`<stateDir>/qq-proactive.json` 存 `{lastAt, day, count, lastUserAt, lastKind, lastReason}`；`setInterval` 每 10 分钟跑一次 `proactiveTick()`，只在国内白天、且满足条件时发一句；`startProactive()` 在插件启动时调用，dispose 时清理。
- 发送不走 Agent：`QqChannel.say(key, text, { voice })` 直接 `send_private_msg` / `send_group_msg`，可选合成语音条（沿用 `voiceOut` 判断），并写 `proactive` 日志。QQ 未连接或未启用时静默返回。
- 面板（`QqView`）：开关、冷却、每日上限、安静起止、是否语音、「现在说一句」（`POST /qq/proactive/once`，绕过时段与冷却做测试），并显示 `decision`（现在会不会开口、原因、距上次说话几小时）。
- 路由：`GET/POST /qq/proactive`（读/改配置）、`POST /qq/proactive/once`（强制发一句）。都走同源鉴权。
- 边界：不写记忆、不改心情与情感；主动消息只是一句话，不触发反思与捕获。`lastUserAt` 由 `QqChannel.lastInboundAt` 提供，进程重启后从状态文件兜底。

## 28. 群聊判断与按心情潜水（v0.17）

- 纯函数在 `lib/qq/group.js`：
  - `GROUP_DEFAULTS = { groupPolicy: 'smart', groupNames: ['阿鱼','Carys'], groupTopics: [...], groupMinGapSec: 120, groupMaxPerHour: 8, groupMaxPerDay: 60, groupQuietStart: 0, groupQuietEnd: 7, groupRandomChance: 0.06 }`。
  - `socialEnergy(mood)` = `clamp01(0.5 + 0.5·valence + 0.5·(arousal − 0.35))`。
  - `interestScore(text, topics)`：命中一个词 0.5，每多一个 +0.15，上限 0.95。
  - `decideGroupReply({ text, mentioned, repliedToMe, mood, config, now, lastSpokeAt, hourCount, dayCount, random })` 顺序：
    1. `groupPolicy === 'off'` → 不接；
    2. @我 / 回复我 → 接（跳过夜间、冷却、心情）；
    3. 当日上限 / 每小时上限 / 间隔 → 不接；
    4. 夜间（`groupQuietStart`~`groupQuietEnd`）→ 不接；
    5. 提到名字 → 85%；
    6. 低落（valence ≤ -0.3 且 arousal ≤ 0.45）→ 不接；
    7. 兴趣 → `interest × (0.4 + 0.6·energy)`；
    8. 其余 → 电量 ≥ 0.65 时 `groupRandomChance × energy`，否则潜水。
- `QqChannel`：`#admitGroup` 在**转写之后**判断，日志写 `join` / `lurk`；`groupPolicy: 'at'` 保持旧的「只回 @」。群内发言后 `#noteSpoken` 用 `bumpGroupStats` 记小时/天计数；发出的消息 id 进 `myMessageIds`（上限 300），用于识别「回复我」。
- 心情来源：构造时注入 `getMood: () => currentMood(db)`，每轮判断读实时心情，不另存。
- 面板（`QqView`）：群聊卡片（聪明模式 / 只在 @ 时回 / 群聊关闭、兴趣词、间隔/每小时/每天、夜间起止、当天各群发言数）。
- 配置写入 `qq.json`：`groupPolicy`、`groupTopics`、`groupNames`、`groupMinGapSec`、`groupMaxPerHour`、`groupMaxPerDay`、`groupQuietStart`、`groupQuietEnd`、`groupRandomChance`。
- 边界：判断只影响「接不接」，不改会话历史；潜水时消息不入 Agent，也不会被捕获成记忆。

## 29. 语音能力探测与降级（v0.18）

**目标**：没装 dsh-voice（或没配 ASR/TTS）的人也能正常用 Seed，不会因为「听得见 / 会说话」缺失而报错或沉默。

- 探测在 `lib/voice.js`：
  - `asrConfigStatus(config)`：`asrPython` 与 `asrScript` 都配了、且脚本文件存在，才算可用；否则返回原因（`没配置语音识别（asrPython / asrScript）`、`asrPython 没配置`、`asrScript 不存在：…`）。
  - `probeTts(url, { fetchImpl, timeoutMs = 900 })`：对 `<ttsUrl>/` 发 GET，**有 HTTP 响应（包括 404）就算可达**；网络错误或超时返回 `连不上 ttsUrl：…`。默认 900 ms，避免拖慢收消息。
  - `voiceCapability(config, options)` → `{ tts: {ok, reason, url}, asr: {ok, reason, script}, any, textOnly }`；`VOICE_HINT` 是面板里的一句说明。
  - `VoiceProbe`：60 秒 TTL 的记忆化包装（注入 `probe` 便于测试，`get(config, {force})`）。
- 收（`QqChannel.handleEvent`）：
  - 语音段先按原逻辑下载/解码；`caps.asr.ok` 才转写，否则标记 skip（日志 `voice-skip`），消息按「（语音）」占位继续走。
  - 若这条**只有语音**（`#hasVoice && !#hasTextLike`），同一会话 15 分钟内最多直接回一次 `VOICE_NOTICE`（绕过 Agent），避免每条都念一遍。
- 发：`#canSpeak(text)` = `voiceOut` 允许 + `looksSpeakable(text)` + TTS 真的可达；不可达时退回文字，`tts-skip` 日志 10 分钟最多一条。`say()` 的可选语音同理。
- 面板与路由：`GET /dsh-seed-of-memory/voice`（30 秒缓存，`?refresh=1` 强制重探）返回能力 + `pluginManager` 里 `dsh-voice` 的安装/启用状态 + `mode`（`full` / `voice-out` / `voice-in` / `text`）；「QQ」页语音卡片可「重新检测」。
- 边界：探测失败只降级，不抛错；不因为对方没装语音就拒绝收文字；TTS 探活不合成音频、不写盘。


