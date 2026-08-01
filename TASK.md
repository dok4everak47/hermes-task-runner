# TASK — htask JSON 输出 + advance 自动推进（Hermes 编排集成）

## Goal

让 Hermes（外部编排者）能**程序化读取** htask 任务状态并**自动推进**任务，实现"读状态 → 分诊 → 介入"的 orchestrator 闭环。

Before: htask 输出是给人看的文本，Hermes 无法可靠解析；自动推进只能靠人肉敲 accept/merge。
After: `htask list --json` / `htask status --json` 输出机器可读状态；`htask advance` 自动推进可自动的迁移（验证全绿 → ACCEPTED → MERGED）；Hermes 可据此自动介入。

## Context

- 项目: ~/Project/hermes-task-runner（htask, 零依赖 node CLI, 当前 35 测试全绿）
- 现有状态机: CREATED → PLANNING → IMPLEMENTING → REVIEWING → VERIFYING → ACCEPTED → MERGED，人工闸门在 VERIFYING→ACCEPTED（accept）与 ACCEPTED→MERGED（merge）
- 现有命令: start/status/report/accept/merge/cancel/list
- 状态文件: `.htask/tasks/<id>.json`（含 status/history/verify 等）, `.htask/state.json` 存 currentId 指针
- 用户工作流第④⑤步: Hermes 独立验收 → commit+push（对应 accept → merge）

## Current Behavior

- `htask status` / `htask list` 只输出人类可读文本（中文表格），无 `--json`
- 自动推进需人工: 先 accept 再 merge 两条命令
- Hermes 介入需要解析文本（脆弱）或自己读 JSON 文件（可行但散落各处）

## Expected Behavior

### 1. `--json` 输出（status / list）

`htask status --json`（无参=当前任务）:
```json
{
  "id": "task-20260801-toolstats",
  "title": "...",
  "status": "VERIFYING",
  "state": "WAITING_HUMAN",
  "taskFile": "TASK.md",
  "model": "deepseek/deepseek-v4-flash",
  "agent": null,
  "review": null,
  "verification": { "typecheck": true, "test": true, "build": true },
  "verify": [{ "command": "npm run typecheck", "exitCode": 0 }],
  "historyCount": 5,
  "startedAt": "...", "updatedAt": "...", "endedAt": null,
  "stale": null,
  "nextStep": "等待人工: htask accept"
}
```

`htask list --json`:
```json
{
  "tasks": [
    { "id": "...", "title": "...", "status": "VERIFYING", "state": "WAITING_HUMAN", "updatedAt": "...", "stale": null, "nextStep": "..." }
  ],
  "summary": { "total": 1, "byStatus": { "VERIFYING": 1 } }
}
```

**关键新增字段 `state`（分诊状态，给 Hermes 的决策信号）**:
- `RUNNING` — IMPLEMENTING/REVIEWING（opencode/reviewer 在跑, 等它）
- `WAITING_HUMAN` — VERIFYING 全绿（等 accept）或 ACCEPTED（等 merge）
- `BLOCKED` — FAILED（需修复）或 CANCELLED
- `DONE` — MERGED
- `STALE` — 任意非终态且卡住检测触发（staleInfo 非空）

`state` 派生规则（纯函数, 不依赖额外 IO）:
- MERGED → DONE
- FAILED/CANCELLED → BLOCKED
- VERIFYING: verify 全过 → WAITING_HUMAN（提示 accept）; verify 有失败 → BLOCKED
- ACCEPTED → WAITING_HUMAN（提示 merge）
- IMPLEMENTING/REVIEWING/PLANNING → RUNNING
- CREATED → WAITING_HUMAN（提示 start）
- 任何非终态且 stale → STALE（覆盖上述）

### 2. `htask advance [--id <id>] [--no-push]`

自动推进**可自动的迁移**, 一次命令走完能走的路:

- VERIFYING 且验证全过 → ACCEPTED（= 自动 accept）→ 继续尝试 MERGED（= 自动 merge, 含 git add/commit/push; --no-push 跳过 push）
- VERIFYING 且有验证失败 → 拒绝（保持, 提示 FAILED 需修复）退出码 1
- ACCEPTED → MERGED（= 自动 merge）
- 其他状态（RUNNING/BLOCKED/DONE/CREATED）→ 不动, 打印当前 state 和原因, 退出码 0（幂等, 不报错）
- 每次迁移打印 `✅ <id>: VERIFYING → ACCEPTED` 等一行
- 最终打印: `✅ <id> → MERGED, 全链路自动完成` 或 `⏸ <id> 停在 <状态>: <原因>`（如 "等待 opencode 完成"）

**幂等性**: 对已 MERGED 任务重复 advance → 无操作, 退出码 0, 不重复 commit。

### 3. 安全性

- `advance` 只在验证全过时自动 accept（与人工 accept 同一校验: verify 全过）
- merge 的 git commit 失败不改状态（沿用现有行为）, advance 打印错误并停在 ACCEPTED
- `--no-push` 供 CI/Hermes 预演
- 无状态时（无当前任务）报错退出码 1

## Design

**`bin/htask.mjs` 增加**:

```js
// state 派生
export function deriveState(task) {
  // 按 Expected Behavior 的规则表返回 'RUNNING'|'WAITING_HUMAN'|'BLOCKED'|'DONE'|'STALE'
}

// JSON 序列化（供 --json）
function taskToJson(task) {
  return {
    id: task.id, title: task.title, status: task.status,
    state: deriveState(task), taskFile: task.taskFile,
    model: task.model, agent: task.agent ?? null, review: task.review ?? null,
    verification: task.verification ?? {},   // 由 task.verify 派生 {cmd: bool}
    verify: (task.verify ?? []).map(r => ({ command: r.command, exitCode: r.exitCode })),
    historyCount: (task.history ?? []).length,
    startedAt: task.startedAt, updatedAt: task.updatedAt, endedAt: task.endedAt ?? null,
    stale: staleInfo(task),          // null 或 {reason}
    nextStep: nextStep(task),
  }
}

// list --json 聚合
function listToJson(tasks) { /* tasks[] + summary {total, byStatus} */ }
```

**cmdStatus/cmdList 改造**: 接受 `json` 参数（来自 `--json` flag）→ console.log(JSON.stringify(..., null, 2))

**cmdAdvance 新增**:
```js
export async function cmdAdvance({ cwd, id, noPush }) {
  // 读任务 → 按状态分支:
  //   VERIFYING(全过) → transition ACCEPTED → 继续 merge 逻辑(复用)
  //   VERIFYING(有失败) → 拒绝 exit 1
  //   ACCEPTED → merge 逻辑
  //   RUNNING/BLOCKED/DONE/CREATED → 幂等跳过, 打印原因, exit 0
}
```
- 建议把 merge 的 git 逻辑抽成 `async function doMerge(cwd, task, {noPush})` 供 cmdMerge 和 cmdAdvance 复用
- `main()` 的 `--json` flag 解析: `htask status --json` / `htask list --json` / `htask advance --json`（advance 也支持 --json 输出最终状态）

**CLI 帮助更新**: 三个命令都注明 `--json`。

## Files

- 修改: `bin/htask.mjs`（deriveState/taskToJson/listToJson + cmdStatus/cmdList --json + cmdAdvance + doMerge 抽取）
- 修改: `test/htask.test.mjs`（新增测试）
- 修改: `README.md`（--json + advance 用法, 状态机图补充 state 派生说明）

## Constraints

- 零 npm 依赖, 单文件 CLI
- `--json` 输出必须 `JSON.parse` 可解析（唯一 stdout 内容; 日志/提示走 stderr 或省略）
- `deriveState` 是纯函数（可单测, 不 IO）
- advance 幂等: 重复执行不产生副作用（不重复 commit/push）
- advance 自动 accept 的校验与人工 accept 完全一致（verify 全过）
- 现有 35 测试不回归

## Acceptance Criteria

1. `node --check` + 全量测试绿（新增: deriveState 各状态映射、taskToJson 字段、list --json summary、advance 全链路（VERIFYING→ACCEPTED→MERGED）、advance 幂等（重复无副作用）、advance 在验证失败时拒绝、advance 在 RUNNING 时跳过）
2. `htask list --json` 输出可 JSON.parse, 含 state/summary
3. `htask status --json` 含 state/nextStep/stale
4. 端到端（假 opencode）: start → 停在 VERIFYING → `htask advance --no-push` → MERGED, 且重复 advance 无副作用
5. README 更新

## Verification Commands

```bash
node --check bin/htask.mjs
node --test "test/*.test.mjs"
```

## Rollback Plan

- `git revert`（htask 独立仓库）
- advance 是纯增量命令, 不影响现有 start/accept/merge 流程
