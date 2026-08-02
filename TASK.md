# TASK — Token 记录：捕获 OpenCode 真实 token 消耗进 metrics

## Value Statement

- **谁受益**: 你——终于知道每个任务花了多少 token/钱（你一直关心成本）
- **解决什么**: metrics.json 有 tokens 字段但永远 null；"哪种任务适合哪个模型/哪个 Prompt 最贵"无法分析
- **省多少时间**: token 消耗自动记录，不用猜；长期数据支撑模型选型
- **改变什么行为**: 从"不知道花多少"变为"每任务 token 可审计"

## Goal

让 htask 捕获每次 OpenCode 执行的 token 消耗，写入 task.tokens + metrics.json + metrics 输出。
Before: tokens 字段空置。After: 每任务 token/成本可见，长期可分析。

## Context

- 演进建议 #9 Metrics System（结合 TokenTracker）: task/tokens/duration/iterations/success 记录 + 长期分析（模型选型/Prompt 效果/Token 优化）
- metrics.json 已有 tokens 字段（L269: `tokens: task.tokens ?? null`）——缺捕获端
- opencode 能力（已实测）:
  - `opencode stats` 文本表格（Sessions/Messages + Total Cost/Input/Output/Cache Read/Write），**无 --json**
  - `opencode session list` / `opencode export <sessionID>`（session 数据 JSON，含 usage?）
  - `opencode run --print-logs`（stderr 详细日志，可能含 token）
  - opencode 数据目录: ~/.local/share/opencode/（session 存储）
- 已知限制: stats 是全局累计（所有会话），并发 opencode 会话（如 herdr pane 里另一个）会污染差量

## Current Behavior

- task.tokens 永远 null；metrics 输出无 token 列

## Expected Behavior

- 每次 OpenCode 实现完成后，task.tokens 写入 { input, output, cacheRead, cacheWrite, total, cost? }（能拿到多少拿多少，拿不到对应字段 null）
- metrics.json（artifacts）+ htask metrics 输出新增 token 列（每任务 + 汇总）
- 优先方案（准确）: 按本次 run 的 session 拿 usage——spawn 时记录 opencode session（如 `opencode run --session <id>` 或 spawn 后查最新 session export）；若 session export 无 usage 字段，fallback 到 stats 差量（标注并发限制）
- 拿不到 token 的任务: tokens 保持 null，metrics 标注"—"（不 crash）
- 向后兼容: 旧任务无 tokens 不影响 metrics 汇总（缺失跳过）

## Design

- spawn 方案（二选一，实现者按实测选择，README 里写清理由）:
  - 方案 A（推荐先试）: spawn 前 `opencode session list --json?` 快照最新 session id；run 完成后 export 该 id 解析 usage（若无 --json，解析文本/JSON）
  - 方案 B: run 前后各跑一次 `opencode stats`（解析文本表 Input/Output/Cache Read/Cache Write 行），差值写入；并发会话时数据可能偏大（注释说明）
- 新增 `function captureTokens(cwd, before, after)`: 差量/解析逻辑（纯函数可单测，输入 stats 文本）
- spawnOpenCode/runAgent 完成后调用: `task.tokens = await captureTokenUsage(...)`，写 task JSON
- metrics: computeMetrics 读 task.tokens，输出加 token 列（总 input/output/cost，若都有）
- `htask status` 展示 tokens（一行）

## Files

- bin/htask.mjs: captureTokenUsage + spawn 集成 + metrics token 列
- test/htask.test.mjs: token 解析/差量/缺失容错测试

## Constraints

- 不引新依赖（child_process 已有）
- token 拿不到绝不 crash（null + 标注）
- metrics 输出对齐现有文本/JSON 格式
- 旧任务（无 tokens）metrics 正常（缺失跳过）
- stats 解析基于当前表格格式（若 opencode 改版导致解析失败 → warn + null，不硬失败）

## Acceptance Criteria

- 真实任务跑完 task.tokens 非 null（input/output 至少一项有值）或明确标注不可得（warn 说明原因）
- metrics 输出含 token 列（有数据的任务显示，无数据显示 —）
- 单测 ≥ 5（stats 文本解析/差量/缺失容错/格式变化 warn）
- 全部测试通过（128 + 新增）

## Verification Commands

```bash
node --check bin/htask.mjs
node --test "test/*.test.mjs"
# 冒烟: 跑一个最小 opencode run, 验证 task.tokens 被写入
```

## Rollback Plan

- git revert <commit>
