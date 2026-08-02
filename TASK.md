# TASK — htask 可观测性：progress.json + 细粒度事件 + 通知节点

## Value Statement

- **谁受益**: 你（随时知道 OpenCode 在干嘛/卡没卡）+ 未来的菜单栏/手机端（读 progress.json 即可）
- **解决什么**: htask 只知道任务级状态（IMPLEMENTING），不知道 OpenCode 内部阶段（coding/testing）；事件只有任务级，无 verify 粒度
- **省多少时间**: 不用 poll 日志判断"是否在跑测试"；菜单栏/手机端免开发直接消费
- **改变什么行为**: 从"翻日志猜状态"变为"读 progress.json 即知 stage"

## Goal

让 htask 输出实时进度文件 + 细粒度事件 + 补通知节点，供外部（菜单栏/手机端）消费。
Before: 执行过程黑盒，只有任务级状态。After: .htask/progress.json 实时反映 stage/progress，events.jsonl 含 verify 粒度事件。

## Context

- 本任务替代原"OpenCode 可观测性改造方案"的重复部分（.supervisor 方案已否决——与 Agent Supervisor 冲突，改为扩展 htask）
- 相关代码: bin/htask.mjs
  - transition L343（状态迁移，写 history + emitEvent）
  - emitEvent L287（events.jsonl 追加）
  - runVerifyCommands L730 附近（verify 命令循环，已有 exitCode/durationMs 收集）
  - notify L160（osascript，HTASK_NOTIFY=0 开关，成功<10s 噪音过滤）
  - cmdStart L880+（spawn 前可加"开始"通知）
- stage 映射（派生自状态机）: PLANNING→planning / IMPLEMENTING→coding / REVIEWING→reviewing / VERIFYING→testing / ACCEPTED→merging / MERGED→finished / FAILED→failed / CANCELLED→cancelled
- progress 百分比（阶段粗粒度）: CREATED 5 / PLANNING 15 / IMPLEMENTING 40 / REVIEWING 60 / VERIFYING 80 / ACCEPTED 90 / MERGED 100 / FAILED 0

## Current Behavior

- htask 无 progress.json；事件只有 task.* 级别；通知只有完成/失败

## Expected Behavior

- `.htask/progress.json`（幂等更新，与用户方案字段对齐）:
  ```json
  { "taskId": "...", "status": "VERIFYING", "stage": "testing", "progress": 80,
    "currentAction": "运行验证: node --test ...", "startedAt": "...", "updatedAt": "..." }
  ```
  每次 transition / verify 命令开始 / 完成时更新；无任务时写 `{ "taskId": null, "status": "idle", "stage": "idle", "progress": 0 }`
- events.jsonl 新增 verify 粒度事件（emitEvent 扩展）:
  - `test_started`（detail: 命令）→ `test_passed` 或 `test_failed`（detail: 命令 + exitCode）
- 通知补节点: cmdStart spawn 前 🔨 开始执行；verify 开始时 🧪 正在运行测试（受 HTASK_NOTIFY=0 和噪音过滤约束——开始/测试通知即时弹，不受 <10s 过滤）
- 现有行为不变: TASK.md/REVIEW.md/状态机/events 格式向后兼容（新增事件类型不破坏旧消费者）

## Design

- 新增 `function writeProgress(cwd, task, { status, stage, progress, currentAction })`: 写 .htask/progress.json（JSON.stringify + '\n'）
- 新增 `function stageFor(status)`: 状态→stage 映射表
- 新增 `function progressFor(status)`: 状态→百分比映射表
- transition 内（或调用处）统一在写 history 后调 writeProgress——最小侵入: 在 emitEvent 之后加 writeProgress(cwd, task)（读最新任务算 stage/progress）
- runVerifyCommands 循环: 每个命令前 emitEvent('test_started') + writeProgress(currentAction=`运行验证: ${cmd}`)；命令后 emitEvent('test_passed'|'test_failed', detail=cmd+exitCode)
- cmdStart: spawn 前 notify('🔨 OpenCode 开始执行任务', task.title)（若 exitCode 过滤不适用开始通知——直接弹）；verify 前 notify('🧪 正在运行测试', ...)
- 通知顺序: 开始(前) → 测试(verify 前) → 完成/失败(已有)
- 所有新输出 JSON 与现有格式一致（events.jsonl 每行一个 JSON 对象）

## Files

- bin/htask.mjs: writeProgress + stageFor/progressFor + transition 集成 + verify 事件 + notify 节点
- test/htask.test.mjs: progress/事件/通知相关测试

## Constraints

- 不引新依赖
- events.jsonl 旧行格式不变（新事件类型追加）
- progress.json 只写不读（消费方是外部工具）
- 不改变状态机/流程语义
- 通知受 HTASK_NOTIFY=0 控制

## Acceptance Criteria

- htask start 后 progress.json 出现，stage=coding（IMPLEMENTING）
- verify 阶段 events.jsonl 有 test_started/test_passed（或 test_failed）且 detail 含命令
- MERGED 后 progress.json stage=finished progress=100；FAILED → stage=failed progress=0
- 无任务时 progress.json 为 idle
- 通知: start 弹出🔨（HTASK_NOTIFY 未禁用时）
- 全部测试通过（107 + 新增）+ 手动冒烟

## Verification Commands

```bash
node --check bin/htask.mjs
node --test "test/*.test.mjs"
# 冒烟: 临时任务跑一圈, 观察 progress.json 变化
```

## Rollback Plan

- git revert <commit>
