# TASK — htask merge 内置报告文件保护

## Goal

让 `htask advance` / `htask merge` 的 git commit **自动排除报告文件**（REPORT.md / REVIEW.md），不依赖项目 `.gitignore` 配置——任何项目用它都不会把运行产物污染进仓库。

Before: `git add -A` 会把 REPORT.md/REVIEW.md 一起提交（cron 自动推进时实测踩坑，靠 revert 清理）。
After: merge 前自动 `git reset` 掉报告文件，commit 只含代码 + TASK.md。

## Context

- 项目: ~/Project/hermes-task-runner（htask, 零依赖 node CLI, 当前 47 测试全绿）
- 触发背景: cron job 自动 advance 时，`git add -A` 提交了测试任务的 REPORT.md/TASK.md 进仓库（commit bccf15e），已 revert + 加 .gitignore 补救——但 .gitignore 是项目级配置，新项目可能忘加
- 现有代码: `bin/htask.mjs` 的 `cmdMerge` / `cmdAdvance` 共用 git add/commit 逻辑

## Current Behavior

- `cmdMerge` 执行 `git add -A` → 全部文件进暂存区 → commit
- 若项目没在 .gitignore 排除 REPORT.md/REVIEW.md，它们会被提交

## Expected Behavior

- 新增内置保护清单: `['REPORT.md', 'REVIEW.md']`（相对项目根）
- merge/advance 流程: `git add -A` → `git reset -- <保护清单>`（仅当文件存在时）→ commit
- 报告文件仍保留在工作区（可读），只是不进 commit
- 行为与 .gitignore 配置无关（双保险，即使项目配了 ignore 也不冲突）

## Design

**`bin/htask.mjs`**:

```js
// 内置保护: merge/advance 提交时排除的运行产物
const MERGE_EXCLUDE = ['REPORT.md', 'REVIEW.md']

// 在 git add 后、commit 前插入:
function unstageExcluded(cwd) {
  for (const f of MERGE_EXCLUDE) {
    const r = spawnSync('git', ['reset', '--', f], { cwd, encoding: 'utf8' })
    // git reset 不存在的文件也会 exit 0 (no-op), 无需检查存在性
    if (r.status !== 0) getLogger?.warn?.(`git reset ${f} 失败: ${r.stderr}`) // 或 console.warn
  }
}
```

- `cmdMerge` 在 `git add -A` 成功后调用 `unstageExcluded(cwd)`，再 commit
- `cmdAdvance` 复用 cmdMerge 的 merge 逻辑（已抽取的 `doMerge`），自动获得保护
- console.warn 风格与现有代码一致（中文）

## Files

- 修改: `bin/htask.mjs`（MERGE_EXCLUDE + unstageExcluded + doMerge 内调用）
- 修改: `test/htask.test.mjs`（新增测试）

## Constraints

- 零 npm 依赖, 单文件 CLI
- 不改变 commit 成功/失败的状态机行为（保护文件 reset 失败只 warn, 不阻断）
- 报告文件在工作区必须保留（不删除）
- 现有 47 测试不回归

## Acceptance Criteria

1. 测试全绿（新增: merge 时 REPORT.md 不进 commit 但保留在工作区、REVIEW.md 同理、无报告文件时 merge 正常）
2. 端到端: 临时项目有 REPORT.md + 代码改动 → advance → commit 不含 REPORT.md, 工作区仍有该文件
3. README 提一句内置保护

## Verification Commands

```bash
node --check bin/htask.mjs
node --test "test/*.test.mjs"
```

## Rollback Plan

- `git revert` 该 commit（htask 独立仓库）
- 保护清单是纯增量逻辑, 不影响无报告文件的项目
