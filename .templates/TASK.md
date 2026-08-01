# TASK — <任务名>

<!-- 模板用法: cp .templates/TASK.md TASK.md, 填空后交给 OpenCode 实现 -->

## Goal

<!-- 一句话目标, 用户价值表述 (Before/After), 不堆数字 -->

## Context

<!-- 背景: 为什么做、灵感来源、相关代码位置 (贴文件路径) -->

## Current Behavior

<!-- 现状: 现有代码怎么工作的, 缺什么。贴具体文件 + 行号/函数名 -->

## Expected Behavior

<!-- 期望: 完成后外部可见的变化, 谁能用、怎么用 -->

## Design

<!-- 方案: 新文件 / 重构点 / 接口签名。关键设计决定写清楚, 别让实现者猜 -->

## Files

<!-- 涉及文件清单: 新增 / 修改 (路径) -->

## Constraints

<!-- 约束: 向后兼容、不动构建产物、不引新依赖、代码风格、语言约定 -->

## Acceptance Criteria

<!-- 验收标准: 可验证的具体标准 (测试数变化、新工具出现、行为改变) -->

## Verification Commands

```bash
# 验收时依次执行, 结果贴回
npm run typecheck
npm test
npm run build
```

## Rollback Plan

<!-- 回滚: git revert <commit> / 删除新增文件 / 恢复点 -->

---
<!-- 实现完成后, 结果写入下方 (由验收人填写) -->

## Result

<!-- typecheck / test / build 实际输出, MCP 手工验证记录, 与 Acceptance Criteria 逐条对照 -->
