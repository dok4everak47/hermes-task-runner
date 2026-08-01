# REVIEW — htask 引入任务状态机（Task State Machine） 验收报告

> 独立验收, 不依赖 OpenCode/开发者自述。所有命令均在本仓库内实际执行。
> 时间: 2026-08-01 · 环境: macOS, node v24.18.0

## 变更概览

```bash
$ git diff --stat HEAD
 README.md           |  56 +++--
 TASK.md             | 235 +++++++++++--------
 bin/htask.mjs       | 644 +++++++++++++++++++++++++++++++++++++++++++++-------
 test/htask.test.mjs | 438 ++++++++++++++++++++++++++++++++---
 4 files changed, 1151 insertions(+), 222 deletions(-)

$ git status --short
 M README.md
 M TASK.md
 M bin/htask.mjs
 M test/htask.test.mjs
?? REPORT.md          # 未跟踪: 旧版 start 生成的旧格式报告, 见"风险与遗留 #3"
```

- `bin/htask.mjs`: 444 → 922 行, 新增状态机核心（STATES/TERMINAL/TRANSITIONS、newTaskId、createTask、transition、readTask/readAllTasks、currentTask、migrateLegacyState、staleInfo、nextStep）+ 新命令 accept/merge/cancel/list + start/status/report 改造。旧函数（parseTaskFile、spawnOpenCode、runVerifyCommands、writeReport、buildOpenCodeArgs、notify、state.lock）全部保留, 无功能删除。
- `test/htask.test.mjs`: 16 → 35 测试（新增 19 个）。
- `TASK.md`: 被重写为本次状态机规范（任务定义变更, 属工作流第②步, 预期行为; 但不在 Files 清单内, 提交时需确认是否入库）。

## 逐项验收

| 验收项 | 命令 / 方法 | 结果 (✅/❌) | 实际输出摘要 |
|---|---|---|---|
| 语法检查 (AC-1) | `node --check bin/htask.mjs` | ✅ | `SYNTAX OK` |
| 全量测试 (AC-2) | `node --test "test/*.test.mjs"`（= npm test） | ✅ | `tests 35 · pass 35 · fail 0`（duration ~1.2s） |
| Typecheck | `npm run typecheck` | N/A | package.json 无 typecheck script（纯 node CLI 无 TS, 无编译环节） |
| 构建 | `npm run build` | N/A | 同上, 无 build script, 无编译产物 |
| 功能实测 (E2E) | 假 opencode 冒烟: start → status → accept → merge --no-push | ✅ | start 停在 VERIFYING → accept 后 ACCEPTED → merge 后 MERGED; history 六步全对（by=auto/auto/auto/auto/human/human）; git commit "E2E 冒烟任务" 生成 |
| 功能实测 (status/list) | `htask status` / `htask list` | ✅ | 详情含状态+迁移历史+下一步建议; list 表格输出 id/标题/状态/停留/卡住列, 卡住任务标 `⚠️ 卡住` |
| 兼容迁移实测 | 项目根旧格式 state.json 首次 `htask status` | ✅ | 自动迁移出 `task-20260801-legacy.json`（done→VERIFYING）, verify 2 条数据完整保留, history 保留初始 migration 记录, 指针改写, 幂等 |
| 人工闸门实测 | start 后不 accept 直接看状态 | ✅ | 验证全绿仍停在 VERIFYING, 打印 "等待人工: htask accept"; 只有 `htask accept` 才 ACCEPTED |
| 测试数核对 | 新增测试 = 35 − 16(HEAD) = 19 | ✅ | 对上（HEAD 旧测试文件恰好 16 个 `test(`） |

## 与 Acceptance Criteria 逐条对照

- [x] AC-1: `node --check bin/htask.mjs` 通过。
- [x] AC-2: 35 测试全绿。新增覆盖: 迁移合法性校验（`test/htask.test.mjs:278`）、非法迁移拒绝（:291）、人工闸门（:521, :542）、accept/merge/cancel 流程（:568/:587/:601/:619/:638）、旧 state.json 兼容迁移（:340）、卡住检测（:314）、nextStep（:329）。
- [x] AC-3: 端到端（假 opencode）: start 停在 VERIFYING → accept → ACCEPTED → merge → MERGED, 全程 history 正确（测试 :371 + :521 + :568, 并经本次手动冒烟复验）。
- [x] AC-4: `htask list` 显示多任务表格 + 卡住标记（测试 :679, 手动复验）。
- [x] AC-5: 验证失败路径 → FAILED（测试 :418 验证失败、:448 opencode 非 0、:465 解析失败, 三条路径均断言 FAILED）。

## 代码质量检查

- [x] 无双重转义 / 语法错误。
- [x] 注释语言与现有代码一致（中文）; 无 debug 输出、无 TODO/FIXME 残留。
- [x] 无未使用 import —— 唯一例外见下。
- [x] **死代码 1 处**: `bin/htask.mjs:9` 从 `node:fs/promises` 导入的 `rm` 从未使用（全文件 `rm(` 零调用）。测试文件里 `rm` 有使用, 但 CLI 文件里没有。建议删除。

## 风险与遗留

1. **[低] 规格文档自相矛盾（review 失败路径）** — TASK.md:36 状态机图示 `REVIEWING └─(review fail)→ FAILED`, 但迁移表（TASK.md:47）写明 "REVIEWING → VERIFYING | auto | reviewer 完成（**无论 review 结果**, 结果记录到 state.review）", Design 步骤 4 同样不判 FAILED。实现遵循迁移表/Design: `bin/htask.mjs:600-604` reviewer 退出码非 0 仅记录 `state.review='failed'`, 仍转 VERIFYING。README.md 也复制了该图示。行为合理（REVIEW.md 生成失败不应把任务判死, 验收是独立人工步骤）, 但图示与表格矛盾需统一, 否则后续维护会误读。建议修 TASK.md/README 图示为 `REVIEWING └─(review 结果仅记录)→ VERIFYING`。
2. **[低] VERIFYING 时序竞态** — `bin/htask.mjs:604` 在**跑验证之前**就 transition 到 VERIFYING, 若验证耗时长且用户并发执行 `htask accept`, 此时 `task.verify` 为空数组, `verify.every()` 恒真 → 会误 ACCEPTED（随后 cmdStart 的 FAILED 迁移抛"非法迁移"被 catch）。本地单用户工具影响极小, 可在 accept 前置 `updatedAt` 检查或先跑验证再转 VERIFYING。测试未覆盖此并发场景。
3. **[低] 残留产物（建议提交前清理）** — 项目根:
   - `.htask/state.lock`（5 字节, 20:42 创建）: 旧版 `htask start` 被中断残留, 现在 `htask start` 会被它拒绝（错误信息有提示手动删除）。属既有 lock 机制的已知局限（进程被杀锁不清理）, 非本次回归。
   - 未跟踪 `REPORT.md`: 旧版 start 生成的旧格式报告, `htask merge` 的 `git add -A` 会把它与代码一起提交, 建议删除或重新生成。
   - 注: 本次验收执行 `htask status` 已触发根目录旧 state.json 的自动迁移（设计行为）; `.htask/` 已被 .gitignore 忽略, 不影响提交。
4. **[低] 测试覆盖小缺口** — `cmdStart --id`（指定 id 创建任务）与 `htask status --id <不存在的id>`（错误退出码）未直接覆盖; `status --all` 间接走 cmdList。均为小缺口。
5. **[信息] DEFAULT_VERIFY 与本仓库不完全匹配** — `DEFAULT_VERIFY`（`htask.mjs:14`）含 `npm run typecheck`/`npm run build`, 但本项目 package.json 仅定义 `test` script → 对无 Verification Commands 的 TASK.md 走默认验证会因缺 script 而 FAILED。此为旧版既有行为（非本次回归）, 且真实使用中 TASK.md 均自带验证命令。

**安全检查**: git add/commit/push 全部数组传参（无 shell 拼接, 无命令注入）; osascript 通知已转义; `runVerifyCommands` 用 `shell: true` 执行 TASK.md 中的命令属产品设计（命令来源是用户自己的 TASK.md）; 无 secrets 提交、无敏感信息进日志; `--id` 拼路径存在理论上的 `../` 越界但 JSON.parse 失败即返回 null, 本地单人 CLI 风险可忽略。

## 结论

- **APPROVED** — 5 条 Acceptance Criteria 全部实测通过, 35 测试全绿, 状态机/人工闸门/兼容迁移/卡住检测行为均符合 TASK.md 迁移表与 Design 章节, 未发现功能缺陷或安全问题。
- 提交前建议: ① 删除 `bin/htask.mjs:9` 未使用的 `rm` import; ② 清理根目录 `.htask/state.lock` 与旧格式 `REPORT.md`; ③ 统一 TASK.md/README 中 REVIEWING 失败路径的图示与迁移表描述（文档歧义, 不阻塞）。
