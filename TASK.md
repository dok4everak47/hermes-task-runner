# TASK — htask v0.2 阶段一: Task Planner + Event System + Artifact Bundle

## Goal

htask 从"固定流程执行器"升级为"自适应编排器"的第一步。三个 P0 能力：

1. **Task Planner** — 任务开始前分析复杂度/风险/推荐 pipeline（动态流程的决策层）
2. **Event System** — 状态变化事件化（task.created/started/review_failed/completed/waiting_human），为通知/恢复/指标打地基
3. **Artifact Bundle** — 每个任务独立产物目录（TASK.md/PLAN.md/REVIEW.md/REPORT.md/metrics.json/timeline.json），可复盘可审计

Before: 固定流程 Developer→Review→Verify; 状态只写 .htask/tasks/<id>.json 单文件; 任务产物散落项目根。
After: `htask plan TASK.md` 输出分析建议; 状态迁移发事件(可订阅); 每任务产物归入 .htask/artifacts/<id>/。

## Context

- 项目: ~/Project/hermes-task-runner（htask, 零依赖 node CLI, 当前 50 测试全绿, bin/htask.mjs 1125 行）
- 现有: 状态机(STATES/TRANSITIONS/transition)、命令(start/status/accept/merge/advance/cancel/list/report)、JSON 输出、MERGE_EXCLUDE 保护
- 状态文件: .htask/tasks/<id>.json + .htask/state.json(currentId 指针)
- 演进蓝图: 见 Hermes_Task_Runner_演进建议.md（本 TASK 是阶段一: 特性 1/4/5, Dynamic Pipeline 并入 Planner）

## Current Behavior

- `htask start` 直接跑固定流程: 解析→IMPLEMENTING→(REVIEWING)→VERIFYING, 无前置分析
- 状态迁移只有文件写入, 无事件通知（外部无法实时感知）
- 任务产物: REPORT.md 写项目根, REVIEW.md 写项目根, 日志在 .htask/logs/, 状态在 .htask/tasks/ — 分散

## Expected Behavior

### 1. Task Planner（`htask plan` 命令）

`htask plan TASK.md` 分析任务并输出建议:

```json
{
  "complexity": "high",           // low | medium | high
  "risk": ["security", "database"],
  "pipeline": ["architect", "developer", "security-reviewer", "tester"],
  "estimated": { "files": 6, "minutes": 40 },
  "suggestModel": "deepseek/deepseek-v4-flash",
  "suggestReview": true
}
```

规则引擎实现（零依赖, 纯规则, 不用 LLM——保持可测可离线）:
- **complexity 判定**: 按 TASK.md 关键字与长度
  - high: 含 "架构|重构|迁移|安全|认证|oauth|数据库|schema" 或 >3000 字
  - medium: 含 "功能|接口|api|测试|工具" 或 1000-3000 字
  - low: 其他
- **risk**: 命中关键字集合——security(安全/认证/oauth/注入/权限), database(数据库/schema/迁移/migration), api(接口/api/路由), dependency(依赖/引入/require)
- **pipeline 生成**（按 complexity/risk）:
  - high → ["architect", "developer", "security-reviewer", "tester"]
  - medium → ["developer", "reviewer", "tester"]
  - low → ["developer", "tester"]
  - risk 含 security → 插入 "security-reviewer"; 含 database → 插入 "schema-check"
- **suggestReview**: complexity != low 或 risk 非空 → true
- `htask plan --json` 输出纯 JSON; 无参数则分析当前 TASK.md

`htask start` 集成: 启动时自动调 Planner, 把 `plan` 结果写入任务状态（state.plan 字段）, 并据此:
- suggestReview && 未显式 --no-review → 默认开 review
- 打印一行: `📋 计划: complexity=high, risk=[security], pipeline=[architect,developer,...]`

### 2. Event System

**事件定义**（状态迁移 + 关键动作时发）:

```
task.created      {taskId, title}
task.started      {taskId, status: "IMPLEMENTING"}
task.review_failed {taskId}
task.verifying    {taskId}
task.waiting_human {taskId, reason: "accept" | "merge"}
task.completed    {taskId, status: "MERGED" | "FAILED" | "CANCELLED"}
```

**实现**:
- `src/.../events.ts` 或 bin 内 `emitEvent(cwd, event)`:
  - 追加到 `.htask/events.jsonl`（JSON Lines, 每行一个事件 {ts, type, ...payload}）
  - 调用可选的订阅钩子: 若 `.htask/hooks/on-<type>` 存在且可执行, spawn 执行（参数=事件 JSON, cwd=项目根）
  - 钩子执行失败仅 warn 不阻断
- 在 `transition()` 内自动发事件（task.created 在 createTask, completed 在进 TERMINAL 态）
- `htask events [--tail N]` 命令: 查看最近 N 条事件（默认 10, JSON Lines 输出）

**与通知集成**: cron/skill 层后续可用事件文件驱动; 本阶段只做事件产生 + 钩子机制 + 查看命令。

### 3. Artifact Bundle

**每任务独立产物目录** `.htask/artifacts/<taskId>/`:

```
.htask/artifacts/<taskId>/
  TASK.md          # 任务定义副本 (start 时复制)
  PLAN.md          # 若有 plan 输出 (JSON)
  REVIEW.md        # reviewer 输出 (--review 时)
  REPORT.md        # 验证报告
  diff.patch       # merge 时 git diff 快照 (git diff HEAD~1..HEAD 或工作区)
  metrics.json     # {durationMs, tokens?, iterations, model, agent}
  timeline.json    # 状态迁移时间线 [{from,to,at,by}]
```

**改动**:
- `createTask`: 建 artifacts/<id>/ 目录, 复制 TASK.md
- `writeReport`: 同时写项目根 REPORT.md（兼容现有）和 artifacts/<id>/REPORT.md
- `cmdStart` 的 REVIEWING 阶段: reviewer 输出的 REVIEW.md 复制到 artifacts/<id>/（若生成）
- `doMerge`: commit 前生成 diff.patch（git diff 工作区 vs HEAD 或上次 commit）
- `transition`: 更新 artifacts/<id>/timeline.json（与 tasks/<id>.json 的 history 同步, 冗余一份供复盘）
- `cmdStatus --json` / `list --json`: 增加 `artifactDir` 字段
- metrics.json 在 MERGED/FAILED 时写入（durationMs 从 startedAt 算, model/agent 从任务字段）

**兼容**: 保留现有 .htask/tasks/<id>.json 为唯一状态源; artifacts/ 是衍生产物, 可随时删（下次状态变更重建）。

## Files

- 修改: `bin/htask.mjs`（Planner 规则 + emitEvent + artifact 逻辑 + plan/events 命令）
- 修改: `test/htask.test.mjs`（新增测试）
- 修改: `README.md`（plan/events/artifacts 用法）
- 新增: `.htask/hooks/` 目录示例说明（README）

## Constraints

- 零 npm 依赖、单文件 CLI 不变（Planner 用纯规则, 不调 LLM）
- Event 钩子 spawn 失败只 warn; events.jsonl 追加写（appendFileSync）
- Artifact 目录与状态文件解耦: 删 artifacts/ 不破坏任务状态; 状态变更自动重建缺失产物
- 向后兼容: 现有命令/JSON 输出字段不破坏（只增字段）
- 现有 50 测试不回归
- 中文输出风格一致

## Acceptance Criteria

1. `node --check` + 全量测试绿（新增: Planner 复杂度/风险/pipeline 规则各分支、plan --json 输出、events 文件追加+钩子触发+events 命令、artifact 目录创建+REPORT/diff/metrics/timeline 生成、start 集成 plan 字段）
2. `htask plan TASK.md` 对高复杂度任务输出含 security-reviewer 的 pipeline
3. 跑一次 start（假 opencode）→ .htask/events.jsonl 有 task.created/started/verifying/waiting_human 事件; .htask/artifacts/<id>/ 有 TASK.md/REPORT.md/metrics.json/timeline.json
4. `htask events --tail 3` 正常输出
5. README 更新

## Verification Commands

```bash
node --check bin/htask.mjs
node --test "test/*.test.mjs"
```

## Rollback Plan

- `git revert` 该 commit（htask 独立仓库）
- artifacts/ 与 events.jsonl 是新增数据, 删除即回退; 状态机核心未动
