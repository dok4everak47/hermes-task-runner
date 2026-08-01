# REVIEW — <任务名> 验收报告

<!-- 工作流第 ④ 步: 我独立验收, 不信 OpenCode 自述。模板: cp .templates/REVIEW.md REVIEW.md -->

## 变更概览

```bash
# 贴实际输出
git diff --stat
git status --short
```

## 逐项验收

| 验收项 | 命令 / 方法 | 结果 (✅/❌) | 实际输出摘要 |
|---|---|---|---|
| Typecheck | `npm run typecheck` | | |
| 全量测试 | `npm test` | | pass/fail 计数 |
| 构建 | `npm run build` | | |
| MCP 工具注册 | tools/list 实测 | | 新工具是否出现 |
| 功能实测 | 调用新工具/新函数 | | 返回值是否符合预期 |
| 测试数核对 | 新增测试 = 报告数 - 原数 | | 对上/对不上 |

## 与 Acceptance Criteria 逐条对照

- [ ] AC-1: ...
- [ ] AC-2: ...

## 代码质量检查

- [ ] 无双重转义 / 语法错误（LaTeX/模板类项目）
- [ ] 无未使用 import、无 dead code
- [ ] 注释语言与现有代码一致

## 风险与遗留

- <!-- 未覆盖的边界、已知限制、后续 TODO -->

## 结论

<!-- 通过 / 需返工, 一句话 -->
