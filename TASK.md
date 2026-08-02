# TASK — htask worktree 并行任务隔离

## Goal

让每个任务有独立的 git worktree 工作区，互不干扰，支持多任务并行开发。
Before: 所有任务在同一工作区串行，切换任务要 stash/清工作区。
After: htask worktree create/list/remove 一键管理独立任务工作区，完成后合回主干。

## Context

- 来源: Hermes_Task_Runner_演进建议.md #8 Git Worktree 并行任务（main + task/auth + task/api 结构）
- 依赖 git worktree 原生能力: `git worktree add <path> -b <branch>`，每个 worktree 独立 checkout + index
- 命令分发位置: bin/htask.mjs 1756-1792 行（cmdPlan/cmdStart/.../cmdReport），新增 worktree 命令组
- 已有 child_process 调用模式可参考 spawnOpenCode / runVerifyCommands

## Current Behavior

- htask 无 worktree 相关命令（htask --help 列表无 worktree）
- 所有任务在当前工作目录串行实现，同一时间只有一个任务在跑

## Expected Behavior

- `htask worktree create <slug>`: git worktree add .worktrees/<slug> -b task/<slug>，输出 worktree 路径
- `htask worktree list`: 摘要列出 worktree（path / branch / status）
- `htask worktree remove <slug>`: 校验后 git worktree remove 清理；脏 worktree 明确报错提示 --force
- 错误处理: slug 已存在 / 分支已存在 / worktree 不存在 → 明确报错，不破坏现有状态
- 兼容: 不动现有命令行为；.worktrees/ 加入 .gitignore

## Design

- 新命令组 worktree，子命令 create / list / remove，入口与现有命令并列
- 实现用 child_process execFile('git', [...])，stderr 捕获后转友好错误
- slug 校验: /^[a-z][a-z0-9-]{0,31}$/（对齐 agent 命名规则，拒绝非法输入）
- create: `git worktree add .worktrees/<slug> -b task/<slug>`（相对仓库根，仓库内建 .worktrees/ 目录）
- remove: `git worktree remove .worktrees/<slug>`，脏 worktree 时 git 报错 → 提示可用 --force
- 输出对齐现有 JSON 风格（--json 时 id/type/result 包裹；非 json 简洁文本）

## Files

- bin/htask.mjs: 新增 cmdWorktree（含 create/list/remove 分发）+ main 分发 case 'worktree' + help 文案
- test/htask.test.mjs: 新增 worktree 测试组（用临时 git 仓库 fixture，参考 makeTempDir 模式）
- .gitignore: 追加 .worktrees/

## Constraints

- 不引新依赖（child_process 已是内置）
- 命令输出兼容现有 JSON 风格
- worktree 路径固定 .worktrees/<slug>（仓库内，可 gitignore，跨机器一致）
- 不动现有状态机 / 流程命令（start/accept/merge/advance 等）行为

## Acceptance Criteria

- htask worktree create/list/remove 三个子命令可用
- create 后 git worktree list 可见 task/<slug> 分支
- 单测覆盖: create 成功 / 重复 slug 报错 / remove 成功 / remove 脏 worktree 报错提示
- 全部测试通过（现有 90 + 新增 5+）

## Verification Commands

```bash
node --check bin/htask.mjs
node --test "test/*.test.mjs"
# 冒烟: 临时仓库里 create → list → remove 一圈
cd "$(mktemp -d)" && git init -q . && htask worktree create demo && htask worktree list && htask worktree remove demo
```
