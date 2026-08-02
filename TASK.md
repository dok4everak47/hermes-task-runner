# TASK — htask v0.2 阶段二: Agent Adapter + Failure Recovery + Human Approval Policy

## Goal

htask 编排能力第二层。三个 P1 特性：

1. **Agent Adapter Layer** — 抽象 Agent 执行接口（`agent.run({task, context, model})`），支持 OpenCode/Codex/Claude 多后端，未来可按任务自动选模型
2. **Failure Recovery** — FAILED 任务自动分析失败原因、生成修复建议、支持自动重试（不盲试）
3. **Human Approval Policy** — YAML 规则化人工审批（按风险类型: db/依赖/架构/删除 等决定是否必须人工确认）

Before: 绑定 opencode; FAILED 只能人工介入; 审批只按状态机硬编码（VERIFYING→ACCEPTED 全都要 accept）。
After: 可切换 agent 后端; FAILED 自动诊断+可重试; 低风险任务 advance 自动过闸、高风险必须人工。

## Context

- 项目: ~/Project/hermes-task-runner（htask, 零依赖 node CLI, 当前 68 测试全绿, bin/htask.mjs 1402 行）
- 已有: 状态机、10 命令(start/status/accept/merge/advance/cancel/list/report/plan/events)、JSON 输出、Artifact Bundle、Event System、Planner
- 演进蓝图: Hermes_Task_Runner_演进建议.md 特性 3(Adapter)/6(Recovery)/7(Approval Policy)
- 环境: opencode 在 /opt/homebrew/bin; Codex/Claude 未装（适配器需优雅降级提示）; 默认模型 deepseek/deepseek-v4-flash

## Current Behavior

- `spawnOpenCode` 硬编码 `opencode` 命令（HTASK_OPENCODE_CMD 可覆盖但无结构化适配层）
- FAILED 终态后: 无自动分析, 只能人工看 REPORT.md + 手动重新 start
- `advance` 对所有任务一视同仁: VERIFYING 全过 → 自动 ACCEPTED（不管风险高低）

## Expected Behavior

### 1. Agent Adapter Layer

**`.htask/agent.<name>.json` 适配器定义**（可扩展, 零依赖）:

```json
{
  "name": "opencode",
  "display": "OpenCode",
  "available": true,
  "runCmd": ["opencode", "run", "--pure"],
  "modelFlag": "-m",
  "agentFlag": "--agent",
  "env": { "SHELL": "/bin/bash" }
}
```

**配置方式**: 环境变量 `HTASK_AGENT=opencode` 选择默认后端; `htask start --agent-backend codex` 单任务覆盖; 内置适配器表（opencode 可用, codex/claude 标记 available:false 并在选用时报清晰错误）。

**`spawnOpenCode` 重构为 `runAgent(cwd, backend, args, prompt, logName)`**:
- 查适配器表 → 无则报 `❌ agent 后端 'codex' 未安装 (可用: opencode)` 退出码 1
- 用适配器的 runCmd + modelFlag/agentFlag 组装参数
- 保留 HTASK_OPENCODE_CMD / HTASK_OPENCODE_ARGS_PREFIX 兼容（若设置则直接走原路径）

**`htask agents` 命令**: 列出可用/不可用后端及模型。

**`htask start --agent-backend <name>`**: 覆盖后端; 任务状态记录 `agentBackend` 字段。

### 2. Failure Recovery

**`htask retry [--id <id>] [--fix]`**:

- 无 `--fix`: 读取 FAILED 任务的 REPORT.md + .htask/implement.log 尾部 + verify 结果, 输出诊断:
  ```
  🔍 失败诊断: task-xxx (FAILED)
  - 实现: exit 1 (120s)
  - 验证: 3 条中 1 条失败 → npm test (exit 1)
  - 日志尾部: <最后 15 行>
  - 建议: 实现阶段失败 → 检查 TASK.md 是否明确; 验证失败 → 修复代码或调整验证命令
  ```
- 有 `--fix`: 用当前 agent 重新跑实现（新 session, 提示词包含失败上下文: 上次 exit code + 失败命令输出摘要 + "修复后重新实现, 不要重复已完成的部分"）, 任务状态从 FAILED → PLANNING → IMPLEMENTING 重新流转; 验证通过 → VERIFYING
- `retry --fix` 前打印确认: `⚠️ 将重新运行 agent 修复, 确认? (y/N)` — 交互式确认或 `--yes` 跳过
- 不改变历史: 原 FAILED 任务保留（history 追加一条 `FAILED → PLANNING (retry)`）, 不新建任务

**事件**: retry 时发 `task.retrying {taskId}` 事件。

### 3. Human Approval Policy

**`.htask/approval.yaml`**（可选配置, 不存在时用默认）:

```yaml
# 风险类型 → 是否需要人工确认。默认全部需要(保守)。
rules:
  high_risk: true        # 默认 true — 高风险任务必须人工 accept
  low_risk: false        # 低风险任务 advance 可自动过闸
# 判定: 复用 Planner 的 risk 输出。risk 非空 → high_risk; 空 → low_risk
```

**行为**:
- `advance` 时: 读 approval 配置 + 任务的 plan.risk
  - 任务无 risk（low）且配置 low_risk:false → **自动过闸**: VERIFYING → ACCEPTED → MERGED 全程无需人工
  - 任务有 risk（high）或配置 high_risk:true → 停在 VERIFYING 等 accept（现有行为）
- `accept` 行为不变（人工显式确认始终有效）
- 无 approval.yaml 时默认: 全部需人工（保守, 向后兼容现有行为）

**`htask policy` 命令**: 显示当前审批策略 + 解释（读配置或默认）。

**plan 输出扩展**: `plan` 增加 `approval: "auto" | "human"` 字段（按 risk + 策略判定）。

## Files

- 修改: `bin/htask.mjs`（runAgent 重构 + cmdRetry + cmdAgents + cmdPolicy + approval 逻辑 + plan 扩展）
- 修改: `test/htask.test.mjs`（新增测试）
- 修改: `README.md`（agent 后端/retry/policy 用法 + .htask/approval.yaml 示例）
- 新增（测试用）: 内置适配器表常量

## Constraints

- 零 npm 依赖、单文件 CLI
- 适配器抽象必须向后兼容: 不设 HTASK_AGENT 时行为与现在完全一致（默认 opencode）
- retry 不破坏历史: 原任务 id/历史保留, 只追加迁移
- approval.yaml 解析失败 → warn + 走默认（全部人工, 保守）
- 未安装的后端（codex/claude）报清晰错误, 不尝试执行
- 现有 68 测试不回归

## Acceptance Criteria

1. `node --check` + 全量测试绿（新增: 适配器解析/未知后端报错/默认 opencode、retry 诊断输出/retry --fix 状态流转/事件、approval 配置解析/自动过闸/保守默认/plan.approval 字段）
2. `htask agents` 列出 opencode 可用 + codex/claude 不可用
3. `htask plan --json` 对无 risk 任务输出 approval:"auto"（配 low_risk:false 时）
4. 端到端: 低风险任务（无 risk）advance 一次自动 MERGED（无人工闸门）; 高风险任务 advance 停在 VERIFYING
5. `htask retry` 对 FAILED 任务输出诊断; `retry --fix --yes` 重新流转并（假 agent）验证通过 → VERIFYING
6. README 更新

## Verification Commands

```bash
node --check bin/htask.mjs
node --test "test/*.test.mjs"
```

## Rollback Plan

- `git revert` 该 commit
- 新增配置（approval.yaml）删除即回退默认保守行为; retry/agents/policy 是增量命令
