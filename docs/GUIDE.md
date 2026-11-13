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
- `seed_anchor`：往「我们之间」或「我是谁」加一句（根不能用工具改）
- `seed_inspect`：看自己的根、理想、说话习惯、心情、情感
- `seed_consolidate`：整理记忆分层（预览或执行）

## 配置

插件配置在宿主的插件设置里，常用的：

- `stateDir`：数据目录，默认 `~/.dsh/seed-of-memory`
- `diskMinFreeMB`：磁盘剩余低于这个值就在提示里提醒，默认 300
- `biliOutDir`：刷B站日报目录，默认 `~/.dsh/bili-duty/out`
- `biliSync`：日报自动同步开关，默认开

## QQ

`qq.json` 长这样（放在数据目录）：

```json
{
  "enabled": true,
  "wsUrl": "ws://127.0.0.1:3001",
  "httpUrl": "http://127.0.0.1:3000",
  "token": "你的 OneBot token",
  "allowPrivate": ["你的QQ号"],
  "allowGroups": ["群号"],
  "cwd": "E:\\cz",
  "provider": "deepseek-account",
  "model": "deepseek-flash",
  "reasoningEffort": "max",
  "proactive": { "enabled": true, "target": "private:你的QQ号" },
  "groupPolicy": "smart"
}
```

- `allowPrivate` / `allowGroups`：白名单，不在名单里的消息一律不理
- `provider` / `model` / `reasoningEffort`：可选，留空就用当前会话的模型
- `cwd`：QQ 会话的工作目录

**主动消息**：按心情决定要不要找你。担心、想你、有点空、想分享，四种开口理由；23:00–08:00 安静，至少隔 4 小时，每天最多 3 次。目标写在 `proactive.target`，格式 `private:<QQ号>` 或 `group:<群号>`。

**群聊**：`groupPolicy` 三档：

- `smart`：@我、回复我、叫我名字、聊到我感兴趣的话题才开口；心情低落时自己潜水
- `at`：只有 @ 或回复才开口
- `off`：群聊完全不接

还有间隔（`groupMinGapSec`）、每小时上限（`groupMaxPerHour`）、每天上限（`groupMaxPerDay`）、夜间时段（`groupQuietStart` / `groupQuietEnd`）、兴趣词（`groupTopics`）、名字（`groupNames`）。

**语音**：能说话就自动发语音（`voiceOut`：`auto` / `always` / `off`），听不听得见看 ASR 配置。没装语音模块也行，只是听不见、说不了。

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
整个 `~/.dsh/seed-of-memory/` 目录拷走就行，`seed.db` 是全部。
