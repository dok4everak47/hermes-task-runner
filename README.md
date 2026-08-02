# hermes-task-runner (htask)

把「TASK.md → OpenCode 实现 → 完成通知 → 验证 → REPORT」整条链自动化成一条命令,
并给每个任务引入生命周期状态机, 升级为 orchestrator。

## 安装

```bash
npm link          # 或手动软链
ln -s "$(pwd)/bin/htask.mjs" /opt/homebrew/bin/htask
```

依赖: macOS, node ≥ 24, opencode (`/opt/homebrew/bin/opencode`), osascript。

## 状态机

```
CREATED → PLANNING → IMPLEMENTING → REVIEWING → VERIFYING → ACCEPTED → MERGED
   │         │           │             │            │           │
   │         │           │             │            └─(fail)→ FAILED
   │         │           │             └─(review 结果仅记录)→ VERIFYING
   │         │           └─(exit≠0)→ FAILED
   │         └─(解析失败)→ FAILED
   └─(任意非终态可)→ CANCELLED
```

关键设计: **人工闸门**。验证全绿后任务停在 `VERIFYING` (不自动 accept),
需人工 `htask accept` → `ACCEPTED`; 再人工 `htask merge` → `MERGED` (自动 git commit+push)。
`FAILED / MERGED / CANCELLED` 是终态。

### 分诊状态 `state` (Hermes 决策信号, 由 status/verify/stale 派生)

| state | 含义 |
|---|---|
| `RUNNING` | PLANNING / IMPLEMENTING / REVIEWING, 等 opencode/reviewer |
| `WAITING_HUMAN` | CREATED (等 start)、VERIFYING 全绿 (等 accept)、ACCEPTED (等 merge) |
| `BLOCKED` | FAILED / CANCELLED、或 VERIFYING 验证有失败 |
| `DONE` | MERGED |
| `STALE` | 任意非终态且卡住检测触发 (覆盖上述) |

`state` 是纯函数 `deriveState(task)`, 出现在 `--json` 输出里, Hermes 可据此决定介入。

### `htask advance` — 自动推进可自动的迁移

验证全绿时一次命令走完能走的路: `VERIFYING → ACCEPTED → MERGED` (自动 git commit+push,
`--no-push` 跳过 push)。验证有失败 → 拒绝 (退出码 1, 状态不变); 其他状态 (RUNNING/BLOCKED/CREATED)
幂等跳过 (退出码 0); 已 MERGED 重复执行无副作用。自动 accept 与人工 accept 校验完全一致 (verify 全过)。

内置报告保护: `merge` / `advance` 提交时自动把 `REPORT.md` / `REVIEW.md` 从暂存区排除
(`git add -A` 后 reset), 不依赖项目 `.gitignore` 配置; 报告文件保留在工作区, 只不进 commit。

每个任务一个文件 `.htask/tasks/<id>.json`, 含 status / history (迁移历史) / verify 结果 / plan 等;
`.htask/state.json` 只是当前任务指针 `{ currentId }`。旧格式 state.json (含 status)
首次读取时自动迁移到 `tasks/task-<日期>-legacy.json`。

## Task Planner (`htask plan`)

`htask plan [TASK.md] [--json]` 用纯规则 (零依赖, 不用 LLM) 分析任务并输出建议:

- `complexity`: high (含 架构|重构|迁移|安全|认证|oauth|数据库|schema 或 >3000 字) / medium (含 功能|接口|api|测试|工具 或 1000-3000 字) / low。
- `risk`: security / database / api / dependency 关键字命中集合。
- `pipeline`: 按复杂度生成, risk 含 security → 插入 `security-reviewer`, 含 database → 插入 `schema-check`。
- `suggestReview`: complexity != low 或 risk 非空 → 建议 review。
- `estimated`: 预计改动文件数 / 分钟数。

`htask start` 启动时自动调 Planner, 把结果写入 `state.plan`, 打印一行
`📋 计划: complexity=…, risk=[…], pipeline=[…]`; 且 `suggestReview` 为 true 时默认开 review
(`--no-review` 关闭)。`htask plan --json` 输出纯 JSON。

## Event System (`htask events`)

状态迁移与关键动作发事件, 追加到 `.htask/events.jsonl` (JSON Lines):

```
task.created      {taskId, title}
task.started      {taskId, status: "IMPLEMENTING"}
task.review_failed {taskId}
task.verifying    {taskId}
task.waiting_human {taskId, reason: "accept" | "merge"}
task.completed    {taskId, status: "MERGED" | "FAILED" | "CANCELLED"}
```

订阅钩子: 若 `.htask/hooks/on-<type>` 存在且可执行, 事件发生时 spawn 执行
(参数 = 事件 JSON, cwd = 项目根), 失败仅 warn 不阻断。

`htask events [--tail N]` 查看最近 N 条事件 (默认 10, JSON Lines 输出)。

## Artifact Bundle (`.htask/artifacts/<taskId>/`)

每任务独立产物目录, 可复盘可审计 (衍生产物, 删掉不影响任务状态, 下次状态变更自动重建):

```
TASK.md          # 任务定义副本 (start 时复制)
PLAN.md          # Planner 分析结果 (JSON)
REVIEW.md        # reviewer 输出 (--review 时)
REPORT.md        # 验证报告 (与项目根 REPORT.md 同步)
diff.patch       # merge 时 git diff 快照 (排除内置保护文件)
metrics.json     # {durationMs, tokens, iterations, model, agent} (终态/报告时写)
timeline.json    # 状态迁移时间线 (与 tasks/<id>.json 的 history 同步)
```

`htask status --json` / `htask list --json` 增加 `artifactDir` 字段。

## 用法

```bash
htask plan [TASK.md] [--json]     # 分析复杂度/风险/推荐 pipeline
htask start [--model <provider/model>] [--agent <agent>] [--review] [--no-review] [--id <id>] [TASK.md]
htask status [--id <id> | --all] [--json]
htask list [--json]                 # = status --all 别名
htask accept [--id <id>]
htask merge [--id <id>] [--no-push]
htask advance [--id <id>] [--no-push] [--json]
htask cancel [--id <id>]
htask events [--tail N]           # 查看最近事件 (默认 10)
htask report
htask --help
```

`--json` 输出可 `JSON.parse` (唯一 stdout; 进度/日志走 stderr), 供 Hermes 程序化读取:

- `htask status --json`: 单个任务对象, 含 `state` / `nextStep` / `stale` / `verify` / `historyCount`。
- `htask list --json`: `{ tasks: [...], summary: { total, byStatus } }`。
- `htask advance --json`: 输出最终状态 `{ id, status, state, action, message }`。

`htask start` 流程 (状态流转):

1. 创建任务 → `CREATED`; 复制 TASK.md 到 `artifacts/<id>/`, 自动调 Planner 写 `state.plan` 并生成 `PLAN.md`, 打印 `📋 计划: …`。
2. 解析 TASK.md (标题 + `## Verification Commands` 下的 bash 命令) → 成功 `PLANNING`, 失败 `FAILED`。
3. `IMPLEMENTING`: spawn `opencode run --pure -m deepseek/deepseek-v4-flash "按 TASK.md 实现，完成后总结"`, 日志到 `.htask/logs/<id>.log`, exit≠0 → `FAILED`。
4. 退出后 osascript 弹窗通知 (✅/❌ + 耗时)。
5. review (显式 `--review` 或 Planner `suggestReview` 且未 `--no-review`): `REVIEWING` → 跑 reviewer agent → 记录结果到 state.review, REVIEW.md 复制到 `artifacts/<id>/` → `VERIFYING`。
6. 逐条执行验证命令 (超时 600s/条), 记录 exit code / 耗时 / 输出摘要 (截断 2000 字符)。
7. 全绿 → 停在 `VERIFYING`, 打印 "下一步: htask accept"; 有失败 → `FAILED`。
8. 生成 REPORT.md (项目根 + `artifacts/<id>/`) 与 metrics.json。

整个过程中状态迁移发事件到 `.htask/events.jsonl` (created/started/verifying/waiting_human/completed 等)。

`htask status` 显示当前任务状态 + 迁移历史 + 下一步建议 (如 `等待人工: htask accept`)。
`htask list` 表格列出所有任务 (id / 标题 / 状态 / 停留时长 / 卡住标记)。
卡住检测: IMPLEMENTING > 30min、REVIEWING > 15min、VERIFYING > 1h、ACCEPTED > 24h → `⚠️ 卡住`。
`htask accept/merge/advance/cancel` 不带 `--id` 时操作当前任务。
`htask advance` 供 CI/Hermes 自动推进: 验证全绿 → accept → merge 一步走完, 幂等可重跑。

`.htask/state.lock` 防止并发 start (存在即拒绝)。

## 环境变量 (测试注入, 不真调 API)

| 变量 | 默认 | 说明 |
|---|---|---|
| `HTASK_OPENCODE_CMD` | `opencode` | opencode 命令, 测试时换成假脚本 |
| `HTASK_OPENCODE_ARGS_PREFIX` | `run --pure -m deepseek/deepseek-v4-flash` | opencode 参数前缀 |

## 与工作流/模板的关系

- 输入 TASK.md 格式见 `.templates/TASK.md` (固定字段 + Verification Commands bash 代码块)。
- 通知模式复用 `.templates/opencode-run.sh` 的 osascript 弹窗。
- `--review` 生成的 REVIEW.md 基于 `.templates/REVIEW.md` (reviewer agent 只读)。
- htask 只读 TASK.md, 只写 `.htask/` 和 REPORT.md/REVIEW.md, 不改项目源码。

## 测试

```bash
node --check bin/htask.mjs
node --test test/
```

零 npm 依赖, 零构建, node 24 直接跑。
