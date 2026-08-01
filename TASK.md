# TASK — htask 引入任务状态机（Task State Machine）

## Goal

给 htask 每个任务引入明确的**生命周期状态机**，让 htask 从"脚本集合"升级为 orchestrator：
- 任务有明确状态（CREATED → PLANNING → IMPLEMENTING → REVIEWING → VERIFYING → ACCEPTED → MERGED）
- Hermes/用户一眼知道：哪些卡住、哪些需要人工介入、哪些可自动继续
- 状态持久化 + 迁移历史可审计

Before: 任务靠文件和人脑推进，`state.json` 只有粗糙的 running/verifying/done。
After: 每个任务有完整状态机 + 迁移历史 + 卡住检测 + 人工确认闸门。

## Context

- 项目: ~/Project/hermes-task-runner（htask, 零依赖 node CLI, 当前 16 测试全绿）
- 现有状态: `.htask/state.json` 单文件, `status` 取值 running/implementing/verifying/done/failed（粗糙）
- 现有命令: `htask start`（解析 TASK.md → spawn opencode → 通知 → 验证 → REPORT.md）、`htask status`、`htask report`
- 相关代码: `bin/htask.mjs`（~440 行, 单文件 CLI）, 测试 `test/htask.test.mjs`
- 用户流程: ① 读代码 → ② TASK.md → ③ htask start → ④ 独立验收（REVIEW.md）→ ⑤ commit+push → ⑥ 简历

## Current Behavior

- `start` 内联顺序执行: 解析→实现→通知→验证→REPORT, 状态一次性写到 done/failed, 无中间状态记录
- 无迁移历史、无人工确认闸门、无多任务记录、无法检测卡住
- `status` 只显示当前单任务状态, `report` 只重新生成 REPORT.md

## Expected Behavior

### 状态机

```
CREATED → PLANNING → IMPLEMENTING → REVIEWING → VERIFYING → ACCEPTED → MERGED
   │         │           │             │            │           │
   │         │           │             │            └─(fail)→ FAILED
   │         │           │             └─(review 结果仅记录)→ VERIFYING
   │         │           └─(exit≠0)→ FAILED
   │         └─(解析失败)→ FAILED
   └─(任意非终态可)→ CANCELLED
```

| 迁移 | 触发者 | 条件 |
|---|---|---|
| CREATED → PLANNING | auto | `htask start` 解析 TASK.md 成功 |
| PLANNING → IMPLEMENTING | auto | spawn opencode 前 |
| IMPLEMENTING → REVIEWING | auto | opencode exit 0 且 `--review` 开启 |
| IMPLEMENTING → VERIFYING | auto | opencode exit 0 且无 `--review` |
| REVIEWING → VERIFYING | auto | reviewer 完成（无论 review 结果, 结果记录到 state.review） |
| VERIFYING → ACCEPTED | **human** | 验证全过 + `htask accept` |
| ACCEPTED → MERGED | **human** | `htask merge`（自动 git add/commit/push） |
| 任意 → FAILED | auto | 失败条件（见上） |
| 任意非终态 → CANCELLED | human | `htask cancel` |

**人工闸门设计**（这是 orchestrator 的关键）:
- VERIFYING 是全绿状态, 但**不自动** ACCEPTED——等人工 `htask accept`（对应工作流第④步"我独立验收"）
- ACCEPTED 不自动 MERGED——等人工 `htask merge`（对应第⑤步 commit+push）
- 验证有失败 → FAILED, 需 `htask retry` 或人工介入

### 数据结构 `.htask/tasks/<id>.json`（每任务一文件）

```json
{
  "id": "task-20260801-toolstats",
  "title": "Cortex 新增 toolStats 工具",
  "status": "VERIFYING",
  "agent": "opencode",
  "model": "deepseek/deepseek-v4-flash",
  "taskFile": "TASK.md",
  "review": "passed",
  "verification": { "typecheck": true, "test": true, "build": true },
  "history": [
    { "from": "CREATED", "to": "PLANNING", "at": "2026-08-01T12:00:00.000Z", "by": "auto" },
    { "from": "PLANNING", "to": "IMPLEMENTING", "at": "2026-08-01T12:00:01.000Z", "by": "auto" },
    { "from": "VERIFYING", "to": "ACCEPTED", "at": "2026-08-01T12:05:00.000Z", "by": "human" }
  ],
  "startedAt": "2026-08-01T12:00:00.000Z",
  "updatedAt": "2026-08-01T12:05:00.000Z",
  "endedAt": null,
  "implementExit": 0,
  "implementDurationMs": 120000,
  "verify": [ { "command": "npm run typecheck", "exitCode": 0, "durationMs": 900, "output": "..." } ]
}
```

兼容: 旧的 `.htask/state.json` 保留为**当前任务指针**（存 `{ currentId: "task-xxx" }`），`htask status` 无参时读它；旧格式 state.json（含 status 字段）首次读取时自动迁移到 tasks/ 并删除。

### 命令扩展

```
htask start [--model M] [--agent A] [--review] [--id <id>] [TASK.md]
  # 自动: CREATED→PLANNING→IMPLEMENTING→(REVIEWING)→VERIFYING
  # 结束时停在 VERIFYING (全绿) 或 FAILED; 打印 "下一步: htask accept"
htask status [--id <id> | --all]
  # 默认: 当前任务状态 + 迁移历史 + 下一步建议 ("等待人工: htask accept" / "可继续: htask merge")
  # --all: 表格列出所有任务: id / 标题 / 状态 / 停留时长 / 卡住标记
htask accept [--id <id>]
  # VERIFYING→ACCEPTED (验证全过才允许; 有失败 → 拒绝并提示 FAILED)
htask merge [--id <id>] [--no-push]
  # ACCEPTED→MERGED: 自动 git add -A + git commit -m "<title>" --no-verify + git push (--no-push 跳过 push)
htask cancel [--id <id>]
  # 任意非终态→CANCELLED
htask list
  # = status --all 别名
```

### 卡住检测（`status --all` / `list`）

- 每个任务计算 `停留时长 = now - updatedAt`
- 状态停留超过阈值标记 `⚠️ 卡住`:
  - IMPLEMENTING > 30min（opencode 可能挂了）
  - REVIEWING > 15min
  - VERIFYING > 1h（等人工 accept 太久, 提醒）
  - ACCEPTED > 24h（等 merge）
- FAILED / MERGED / CANCELLED 是终态, 不标卡住

## Design

**`bin/htask.mjs` 重构**（保持单文件, 用模块化函数组织）:

```js
// 状态机核心
const STATES = ['CREATED','PLANNING','IMPLEMENTING','REVIEWING','VERIFYING','ACCEPTED','MERGED','FAILED','CANCELLED']
const TERMINAL = new Set(['MERGED','FAILED','CANCELLED'])

function newTaskId(title)      // task-YYYYMMDD-<slug>: 日期+标题前 12 字符(去非字母数字, 小写)
async function createTask(cwd, meta)        // 写 tasks/<id>.json, 状态 CREATED, 更新 state.json 指针
async function transition(cwd, id, to, by)  // 校验迁移合法(TRANSITIONS 表), 追加 history, 更新 status/updatedAt
async function readTask(cwd, id) / readAllTasks(cwd)
async function currentTask(cwd)             // 读 state.json 指针 → tasks/<id>.json
function staleInfo(task)                    // 返回卡住标记 {stale, reason} 或 null
function nextStep(task)                     // 根据状态返回建议: "等待人工: htask accept" 等

const TRANSITIONS = {  // from -> Set<to>
  'CREATED': ['PLANNING','CANCELLED'],
  'PLANNING': ['IMPLEMENTING','FAILED','CANCELLED'],
  'IMPLEMENTING': ['REVIEWING','VERIFYING','FAILED','CANCELLED'],
  'REVIEWING': ['VERIFYING','FAILED','CANCELLED'],
  'VERIFYING': ['ACCEPTED','FAILED','CANCELLED'],
  'ACCEPTED': ['MERGED','CANCELLED'],
}
```

**cmdStart 改造**:
1. `createTask` → CREATED
2. 解析 TASK.md → 成功 `transition PLANNING`，失败 → FAILED
3. `transition IMPLEMENTING` → spawn opencode（日志到 `.htask/logs/<id>.log`）→ exit≠0 → FAILED
4. `--review` → `transition REVIEWING` → spawn reviewer → 记录 review 结果 → `transition VERIFYING`；否则直接 `transition VERIFYING`
5. 验证 → 全绿: 停在 VERIFYING, 打印 `✅ 验证全过, 下一步: htask accept`；有失败: `transition FAILED`, 打印失败项
6. 生成 REPORT.md（含状态机信息: 当前状态 + 历史摘要）

**cmdAccept**: 读任务 → 必须 VERIFYING 且 verify 全过 → `transition ACCEPTED` → 提示 `下一步: htask merge`；否则拒绝（非 VERIFYING 或验证未全过）

**cmdMerge**: 读任务 → 必须 ACCEPTED → 在项目根执行 `git add -A && git commit -m "<title>" --no-verify`（commit 失败不改变状态, 打印错误）→ `transition MERGED`（成功）→ 非 --no-push 时 `git push`（失败只告警不改变状态, 已 MERGED）

**cmdCancel**: 非终态 → `transition CANCELLED`

**cmdStatus / cmdList**: 见 Expected Behavior; 输出含状态机图示（简化为当前状态高亮）与下一步建议

**向后兼容**: `state.json` 旧格式（含 status）首次读到时: 迁移到 tasks/<legacy-id>.json（id 用 task-<日期>-legacy）, 删旧文件, 写指针。`cmdReport` 用 currentTask。

## Files

- 修改: `bin/htask.mjs`（状态机核心 + 命令扩展）
- 修改: `test/htask.test.mjs`（新增状态机测试）
- 修改: `README.md`（状态机说明 + 新命令用法）

## Constraints

- 零 npm 依赖、单文件 CLI 不变
- 状态机迁移必须**校验合法迁移**（非法迁移抛错, 不静默）
- 人工闸门是硬约束: VERIFYING 不能自动变 ACCEPTED, ACCEPTED 不能自动变 MERGED（测试断言这一点）
- 旧 state.json 兼容迁移不能丢数据（history 至少保留一条初始记录）
- `htask accept/merge/cancel` 不带 --id 时操作当前任务, 无当前任务时报错退出码 1
- 中文输出风格与现有代码一致

## Acceptance Criteria

1. `node --check bin/htask.mjs` 通过
2. 测试全绿（新增: 迁移合法性校验、非法迁移拒绝、人工闸门（verify 全绿但 status 仍 VERIFYING 直到 accept）、accept/merge/cancel 流程、旧 state.json 兼容迁移、卡住检测、nextStep 建议）
3. 端到端（假 opencode）: start 结束停在 VERIFYING → accept → VERIFYING→ACCEPTED → merge → MERGED, 全程 history 正确
4. `htask list` 显示多任务表格 + 卡住标记
5. 验证失败路径: 假 opencode 或验证命令失败 → FAILED

## Verification Commands

```bash
node --check bin/htask.mjs
node --test "test/*.test.mjs"
```

## Rollback Plan

- `git revert` 该 commit（htask 独立仓库, 不影响其他项目）
- 状态机数据在 .htask/tasks/ 下, 删除目录即回到无状态模式（代码仍兼容）
