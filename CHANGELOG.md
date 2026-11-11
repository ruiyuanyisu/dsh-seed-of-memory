# Changelog

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
