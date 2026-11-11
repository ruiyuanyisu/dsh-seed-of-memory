# Seed of Memory（记忆之种）

[![npm version](https://img.shields.io/npm/v/dsh-seed-of-memory.svg)](https://www.npmjs.com/package/dsh-seed-of-memory)
[![license](https://img.shields.io/npm/l/dsh-seed-of-memory.svg)](./LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.2.0--rc.1-4f46e5)](https://github.com/deepseek-ai/dsh)

> 给 DSH 的一套本地记忆层：根、记忆、认知、情绪、人格、说话习惯。换会话、换模型、换宿主，它都还在。

Seed of Memory is a local-first memory plugin for **DeepSeek Harness (DSH)**. It keeps a durable identity root, layered memories, beliefs, emotions, a mood line, and a slowly-growing persona + speaking style — all in one SQLite file on your machine. No network calls, no external services.

---

## 为什么做它

大多数「记忆插件」会把一堆摘要塞进上下文，或者把人格写死成一张卡。这个项目反过来：

- **根（identity.md / us.md）** 是纯文本，每轮最先注入；插件卸了、模型换了，任何 agent 都能直接读。
- **记忆** 分四层（persona / semantic / episodic / buffer），有半衰期、有取代链、有「存疑」状态，不删历史。
- **认知** 是带证据与置信度的判断；冲突时挂起，不覆盖。
- **情绪** 由六维评估（相关、顺逆、确定、可控、归因、意外）推出来，写进 `emotions`，聚合为 `mood`，只影响语气与召回权重，**不改事实**。
- **人格** 从记忆与认知里长出来：理想 → 特质 → 行为，有每日上限、有反例、有衰减。
- **说话习惯** 单独一层，默认持续学习，不衰减；只影响怎么说，不影响说什么。

所有判断都能追：`seed_why` 能查到一条记忆/认知/情绪/习惯的来历。

## 需要什么

- DSH `>=0.2.0-rc.1 <0.3.0`
- Node `>=22.19`（插件用 `node:sqlite`，不依赖任何 npm 包）

## 安装

```bash
# 在 DSH profile 目录里（或直接让 DSH 的 plugin_manager 装）
plugin_manager install_bundle  dsh-seed-of-memory
```

手工安装（等价）：

```bash
cd ~/.dsh/profiles/<profile>
pnpm add dsh-seed-of-memory
```

装好后设置页会出现「记忆之种」，工具表里出现 `seed_*`，系统提示末尾开始出现：

```
[Seed of Memory · 根] …
[Seed of Memory] 记得：…
[心情] 此刻：…
[人格] 性格：…
[说话] …
```

## 数据放在哪

```
~/.dsh/seed-of-memory/
├── seed.db          # SQLite（WAL）：记忆、认知、情绪、心情、特质、习惯、档案索引
├── identity.md      # 我是谁（纯文本，可直接改）
├── us.md            # 我们之间（纯文本，可直接改）
├── sources.json     # 可选：外部档案目录（见下）
└── export-*/        # /seed export 导出的快照
```

全部在本地，不联网、不上传。`seed.db` **没有加密**，里面会有你的私人记录——分享或备份前请自己判断。

## 配置

插件 config（profile 的 `cordis.patch.yml` 里那一行）：

```yaml
- id: seed-of-memory
  name: dsh-seed-of-memory
  config:
    enabled: true
    budget: 600          # 每轮记忆卡预算（字符）
    coreBudget: 1200     # 根（identity + us）预算
    moodBiasWeight: 0.15 # 心情对召回的偏置权重
    learnHabits: true    # 说话习惯持续学习
    sources: []          # 外部档案源（也可写 sources.json）
```

外部档案（只读、按需检索、不进卡片）：

```json
// ~/.dsh/seed-of-memory/sources.json
[
  { "id": "notes", "label": "旧笔记", "root": "D:/notes",
    "include": ["长期.md", "日记/**"], "exclude": ["备份/**"] }
]
```

## 工具与命令

工具：`seed_remember` `seed_search` `seed_open` `seed_why` `seed_forget` \
`seed_self` `seed_anchor` `seed_believe` `seed_feel` `seed_mood` \
`seed_trait` `seed_aspire` `seed_persona` `seed_habit` `seed_style`

命令：`/seed status | search | remember | why | self | anchor | mood | feel` \
`| believe | persona | aspire | trait | habit | style | sources [rescan] | export`

## 设计原则

1. 根不动，情绪只影响语气，不改事实与 persona。
2. 所有增长都要证据；推断来的标 `inferred`，不进常驻。
3. 冲突不覆盖：旧记录退休（`superseded_by`），或新记录挂起（`pending`）。
4. 退休不删除，历史留在库里，可追溯。
5. 记忆卡有预算，超出就截断；没有稳定内容时宁可不显示。

详细规格见 [`SPEC.md`](./SPEC.md)。

## 兼容性

- 只使用 Node 内置模块（`node:sqlite`、`node:fs`、`node:crypto` 等），`dependencies` 为空。
- 客户端面板通过 `window.__ModuleLoader__` 注册 `settings.section`，不需要构建步骤。
- 不 spawn 子进程、不打开端口（面板走 DSH 自己的 webServer，带 `connection.requestRejection` 鉴权）。

## 开发

```bash
node --check lib/index.js
node --test test/*.test.mjs          # 需要带 node:sqlite 的 Node 22.19+
```

测试覆盖：存储/取代/挂起、身份根、情绪评分、档案索引、人格生长、说话习惯、插件注册。

## License

MIT
