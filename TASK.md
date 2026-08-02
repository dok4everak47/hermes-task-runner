# TASK — Dynamic Pipeline：按 plan.pipeline 动态驱动执行序列

## Value Statement

- **谁受益**: 你——任务按类型走对的流程（bug 修复不浪费 reviewer、架构任务有 architect 前置），少花 token 少等时间
- **解决什么**: plan.pipeline 只记录不执行，所有任务走同一固定流程（developer→reviewer→tester），小任务也被 review 拖慢
- **省多少时间**: 无 reviewer 的任务省一次 agent 调用（数分钟 + token）
- **改变什么行为**: 任务流程从"一刀切"变为"按 planner 分析结果定制"

## Goal

让 htask 按 plan.pipeline 真正驱动执行序列（对齐演进建议 #2 Dynamic Pipeline）。
Before: pipeline 只是 JSON 里的记录。After: pipeline 元素决定实际执行的 agent 阶段。

## Context

- 演进建议 Hermes_Task_Runner_演进建议.md #2:
  - Bug 修复: Developer → Test → Verify（无 reviewer）
  - 架构修改: Architect → Developer → Reviewer → Security Review → Verify
  - 文档任务: Writer → Proofread
- 现状: cmdStart（bin/htask.mjs L880+）固定流程（spawn developer 实现 → [可选 reviewer] → verify）；plan.pipeline 在 L946 打印、L1863 推荐，不驱动
- plan 结构: { complexity, risk[], pipeline[], suggestModel, suggestReview }
- pipeline 元素（planner 生成）: architect / developer / schema-check / security-reviewer / reviewer / tester / writer / proofread
- reviewer agent: ~/.config/opencode/agents/reviewer.md（htask --review 时用）

## Current Behavior

- 所有任务: spawn developer（实现）→ 验证（verify 命令）→ [--review 时跑 reviewer]
- plan.pipeline 不参与执行决策

## Expected Behavior

- cmdStart 按 plan.pipeline 决定执行序列（无 plan 的旧任务保持现状向后兼容）:
  - pipeline 含 `architect` → developer 前跑一次架构分析 prompt（普通 opencode run，不指定 agent 角色）
  - pipeline 含 `reviewer` → 现有 reviewer 流程（等价 --review）
  - pipeline 含 `security-reviewer` → verify 前跑安全检查 prompt
  - pipeline **不含** `reviewer` 且未显式 --review → 跳过 reviewer（省 token）——但 review 字段记为 skipped
  - `developer`/`tester` 元素不新增行为（developer=现有实现，tester=现有 verify）
- 执行顺序: architect → developer → [security-reviewer] → verify → [reviewer 若在 pipeline 尾部?] —— 按文档: 架构=Architect→Developer→Reviewer→Security→Verify；bug=Developer→Verify
- 具体顺序映射（pipeline 元素 → 执行位置）:
  - architect: 实现前（前置 prompt）
  - developer: 实现（现有）
  - reviewer: verify 后（现有 reviewer 逻辑）
  - security-reviewer: verify 前（安全检查 prompt）
  - schema-check: verify 前（只跑 plan 检查类 prompt, 不阻塞）
- 每个新阶段: spawn opencode run（复用 runAgent/适配器），输出追加到 .htask/logs/<task-id>.log，失败不中断主流程（记 warn），阶段结果写进 task JSON（`stages: [{name, exitCode, durationMs, output}]`）
- 跳过 reviewer 时 task.review = { status: "skipped", reason: "pipeline" }

## Design

- cmdStart 重构: 把"实现 → 验证 → 审查"改为 pipeline 驱动的阶段循环
  - `const stages = buildStages(plan)` → [{name:'architect', before:'implement'}, {name:'developer'}, ...]
  - 现有代码路径保留（无 plan 任务走旧逻辑）
- 新增 `function buildStages(plan)`: plan.pipeline → 有序阶段列表（含位置标记）
- 新增 `function runPipelineStage(cwd, backend, stage, prompt, logName)`: 复用 runAgent（architect/security-reviewer 用普通 prompt，不传 --agent；reviewer 用现有逻辑）
- task JSON 加 `stages` 数组（记录每阶段 exitCode/durationMs/output 摘要）
- htask status/list 展示 stages 摘要（可选，一行）

## Files

- bin/htask.mjs: buildStages + runPipelineStage + cmdStart 重构 + task.stages 字段
- test/htask.test.mjs: pipeline 测试（含 reviewer 跳过/architect 前置/无 plan 兼容）

## Constraints

- 无 plan 任务 / 旧任务行为完全不变（向后兼容）
- 新阶段失败不阻塞主流程（warn + 记录）
- reviewer 显式 --review 始终优先于 pipeline（用户显式要求时）
- 不引新依赖
- token 控制: 每新增阶段是独立 prompt，保持 prompt 简短（一两句指令）

## Acceptance Criteria

- pipeline 含 reviewer → 跑 reviewer；不含 → 跳过且 review=skipped
- pipeline 含 architect → 实现前有 architect 阶段记录
- 阶段结果写入 task.stages（name/exitCode/durationMs）
- 无 plan 任务流程不变
- 单测 ≥ 6（跳过/前置/顺序/兼容/失败不阻塞/显式 --review 优先）
- 全部测试通过（119 + 新增）+ 冒烟

## Verification Commands

```bash
node --check bin/htask.mjs
node --test "test/*.test.mjs"
# 冒烟: 构造 plan 不含 reviewer 的任务 → 验证跳过
```

## Rollback Plan

- git revert <commit>
