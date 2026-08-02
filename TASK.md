# TASK — README 补充可观测性文档

## Value Statement

- **谁受益**: 用 htask 的人（含未来的你）——新能力（progress.json/细粒度事件/通知）没文档等于不存在
- **解决什么**: README 还停留在旧功能列表，progress.json/事件/通知节点无说明
- **省多少时间**: 未来查"怎么看任务进度"不用翻代码
- **改变什么行为**: 新能力可被发现、被使用

## Goal

README.md 补充可观测性章节，覆盖 progress.json / verify 粒度事件 / 通知节点。
Before: README 无 progress/事件说明。After: 读者知道怎么实时查任务状态。

## Context

- 可观测性功能已实现（commit 7ae9b7b）:
  - .htask/progress.json: {taskId,status,stage,progress,currentAction,startedAt,updatedAt}
  - stage 映射: PLANNING→planning / IMPLEMENTING→coding / REVIEWING→reviewing / VERIFYING→testing / MERGED→finished / FAILED→failed / idle(无任务)
  - progress: CREATED 5 / PLANNING 15 / IMPLEMENTING 40 / REVIEWING 60 / VERIFYING 80 / ACCEPTED 90 / MERGED 100 / FAILED 0
  - events.jsonl 新增: test_started / test_passed / test_failed（detail 含命令）
  - 通知节点: 🔨开始 / 🧪测试中 / ✅完成 / ❌失败（HTASK_NOTIFY=0 全关）
- README.md 在仓库根，现有结构: 功能列表 + 用法 + 状态机说明

## Current Behavior

- README 无 progress.json / 细粒度事件 / 通知节点说明

## Expected Behavior

- README 新增「可观测性」章节:
  - progress.json 路径 + 字段说明 + stage/progress 映射表
  - 事件类型列表（含 verify 粒度）
  - 通知节点 + HTASK_NOTIFY 开关
  - 消费示例: `cat .htask/progress.json` / `tail .htask/events.jsonl`
- 不破坏现有章节结构（追加或插入合适位置）

## Design

- 在 README 状态机说明之后追加「## 可观测性」章节
- 用表格列 stage 映射和事件类型
- 保持 README 简洁风格（不堆细节）

## Files

- README.md（追加章节）

## Constraints

- 只改 README.md，不动代码
- 中文文档（README 现有风格）

## Acceptance Criteria

- README 含可观测性章节 + progress.json 字段 + stage 映射表 + 事件列表
- 无代码改动

## Verification Commands

```bash
grep -c "可观测性\|progress.json" README.md
```

## Rollback Plan

- git revert <commit>（README 单文件）
