# TASK — htask 价值声明 + metrics 持续测量

## Value Statement（4 问）

- **谁受益**: 我自己——每个新任务开始前被迫思考价值；每周用 metrics 复盘交付瓶颈
- **解决什么**: ① 写任务前不验证价值 → 炫技任务混入；② TTV/等待时间不可见 → 决策靠记忆
- **省多少时间**: 复盘从手动翻 events.jsonl（~30min）→ `htask metrics` 1 秒出报告
- **改变什么行为**: 写 TASK.md 前先填价值声明（写不出就不开始）；每周一跑 metrics 复盘上周

## Goal

让 htask 从"加速交付"升级为"逼你选对问题 + 持续测量交付健康"。
Before: 任务想写就写，交付效率靠感觉。After: 每个任务强制价值声明，`htask metrics` 一键输出 TTV/等待/瓶颈。

## Context

- 灵感: 范冰《前线部署工程师》第 2 章 PSF（问题-方案契合）+ 附录 A 交付层指标（TTV 价值实现时间）
- 模板库: ~/Project/.templates/TASK.md（4 项目共用，本任务要改它）
- htask 命令分发: bin/htask.mjs 1756-1792 行（cmdPlan/cmdStart/.../cmdReport），新增 cmdMetrics
- 数据源: .htask/tasks/<id>.json 的 history 数组（每任务各阶段时间戳，by=auto/human 区分）+ implementDurationMs

## Current Behavior

- TASK.md 模板无价值验证环节——任何任务都能直接 htask start
- TTV/等待时间只在 events.jsonl 里，无汇总命令，复盘靠手工翻

## Expected Behavior

- `htask metrics` 文本输出: 每任务 TTV/实现耗时/等人 accept 耗时 + 汇总（平均 TTV、等待占比、瓶颈分布）
- `htask metrics --json`: 结构化输出（对齐现有 JSON 风格，id/result 包裹）
- 模板更新: TASK.md 模板新增 Value Statement 4 问区（Goal 之前）
- 容错: 无任务目录 / 缺 history 的任务不 crash，标注缺失

## Design

- 新增 `export async function cmdMetrics({ cwd, json })` + main 分发 case 'metrics' + help 文案
- 计算逻辑（纯函数 `computeMetrics(tasks)`，可单测）:
  - 每任务: created/verifying/accepted/merged 时间戳从 history 提取（to=状态 的 at）
  - TTV = merged - created；wait_human = accepted - verifying；impl = implementDurationMs
  - 汇总: 平均 TTV、总等待 vs 总实现、等待占比 = wait/(wait+impl)、瓶颈排序
- 输出: 文本表格（对齐 cmdList 风格）+ --json 全量
- 模板: TASK.md 模板在 ## Goal 前插入 Value Statement 区（4 问 + 注释"写不出就不要开始"）

## Files

- ~/Project/.templates/TASK.md: 加 Value Statement 区（注意: 此文件在项目模板库，不在仓库内）
- bin/htask.mjs: cmdMetrics + computeMetrics + 分发 + help
- test/htask.test.mjs: metrics 测试组（空目录 / 单任务 / 多任务汇总 / 缺 history 容错）
- TASK.md: 本任务文件（替换）

## Constraints

- 不引新依赖（Date 计算纯 JS）
- 输出兼容现有 JSON 风格
- 不动现有命令行为；metrics 只读不写
- 模板注释用 HTML 注释（<!-- -->），与原模板一致

## Acceptance Criteria

- `htask metrics` 在 hermes-task-runner 输出真实 7 任务汇总（等待占比约 97%）
- `htask metrics --json` 可解析，含 tasks[] + summary
- 单测 4+ 个（空目录/单任务/汇总/容错）
- 模板文件含 Value Statement 4 问
- 全部测试通过（现有 100 + 新增）

## Verification Commands

```bash
node --check bin/htask.mjs
node --test "test/*.test.mjs"
htask metrics
htask metrics --json | head -40
```

## Rollback Plan

- git revert <commit>（metrics 与模板分开提交，模板在独立 commit）
