# TASK — Hermes Task Runner (htask)

## Goal

把「TASK.md → OpenCode 实现 → 完成通知 → 验证 → REPORT」整条链自动化成一条命令。

Before: 人肉跑完流程（写 TASK.md、手动开 OpenCode、等、手动测试、手写报告）。
After: `htask start TASK.md` 一条命令自动完成全链路，产出 TASK.md + REPORT.md（+ 可选 REVIEW.md）闭环。

## Context

- 背景: 用户工作流已固化 —— 写 TASK.md → OpenCode 后台实现（`opencode run --pure -m deepseek/deepseek-v4-flash`）→ 独立验收（typecheck/test/build）→ 报告。目前每步都靠人（或靠 Hermes agent 手动串联）。本工具把 ③④⑤ 自动化。
- 灵感: TASK.md 模板已有固定字段（Goal / Design / Acceptance Criteria / Verification Commands 等），Verification Commands 是 ```bash 代码块 —— 机器可解析，这是自动化的前提。
- 相关资产:
  - 模板: `~/Project/.templates/TASK.md`（含 Verification Commands 格式）
  - 通知模式: `~/Project/.templates/opencode-run.sh`（osascript 弹窗，已验证可用）
  - Reviewer agent: `~/.config/opencode/agents/reviewer.md`（只读，输出 REVIEW.md）
  - 环境: macOS, node v24.18.0 (`~/.nvm/versions/node/v24.18.0/bin`), opencode (`/opt/homebrew/bin/opencode`), osascript 可用

## Current Behavior

- 每一步手动: 写 TASK.md → 手动跑 `opencode-run "..."`（后台）→ 等通知 → 手动跑 typecheck/test/build → 手动汇总结果。
- 没有状态追踪（任务跑到哪一步了）、没有自动验证、没有自动报告。

## Expected Behavior

`htask start TASK.md`（在项目根目录执行）:

1. **解析** TASK.md: 提取标题（第一行 `# TASK — xxx`）、`## Verification Commands` 下的 bash 代码块命令列表（忽略注释行/空行）。
2. **启动实现**: spawn `opencode run --pure -m deepseek/deepseek-v4-flash "按 TASK.md 实现，完成后总结"`，cwd = 项目根，stdout/stderr 追加到 `.htask/implement.log`。后台运行。
3. **完成通知**: OpenCode 进程退出后 osascript 弹窗（✅ 成功 / ❌ 失败 + 耗时）。
4. **自动验证**: 逐条执行 TASK.md Verification Commands 里的命令（cwd = 项目根，超时 600s/条），记录 exit code、耗时、输出摘要（截断 2000 字符）。
5. **生成 REPORT.md**: 项目根生成，含状态、验证结果表、输出摘要。
6. （可选 `--review`）: 验证通过后自动跑 reviewer agent（`opencode run --pure --agent reviewer ...`）生成 REVIEW.md。

`htask status`: 显示当前任务状态（.htask/state.json: idle/running/implementing/verifying/done/failed + 时间戳）。

`htask report`: 只根据已有 .htask 状态重新生成 REPORT.md（不重跑实现）。

## Design

**位置**: `~/Project/hermes-task-runner/`（独立目录, 含 package.json + bin/htask.mjs + test/）
**安装**: `npm link` 或手动软链 `/opt/homebrew/bin/htask -> .../bin/htask.mjs`
**零 npm 依赖**: 只用 node 内置模块（node:test, node:child_process, node:fs/promises, node:path, node:os）。

**bin/htask.mjs** 结构（单文件 CLI, shebang `#!/usr/bin/env node`）:

```js
// 命令分发: start | status | report | --help
// 关键函数:
parseTaskFile(md)          // -> { title, verifyCommands: string[] }
  // 正则提取 ```bash ... ``` 块在 "## Verification Commands" 之后
  // 每行 trim, 跳过空行和 # 注释行

spawnOpenCode(cwd, extraArgs)  // spawn opencode run --pure -m <model> ...
  // 日志追加到 .htask/implement.log
  // 返回 Promise<{exitCode, durationMs}>  — 进程退出时 resolve

runVerifyCommands(cwd, cmds)   // 逐条执行, 超时 600s
  // -> [{command, exitCode, durationMs, output(截断2000)}]
  // 用 spawnSync 或 promisify(exec) with timeout; cwd=项目根

writeReport(cwd, ctx)          // 生成 REPORT.md
  // 格式见下

notify(title, subtitle)        // osascript display notification (静默失败)
```

**REPORT.md 格式**:

```markdown
# REPORT — <任务标题>

- 状态: ✅ 通过 / ❌ 失败
- 开始: <ISO> · 结束: <ISO> · 耗时: <Xs>
- 实现: OpenCode exit <code> (<duration>) · 日志: .htask/implement.log

## 验证结果

| # | 命令 | exit | 耗时 | 结果 |
|---|------|------|------|------|
| 1 | npm run typecheck | 0 | 8.2s | ✅ |
| 2 | npm test | 0 | 45.1s | ✅ |

## 输出摘要

### 1. npm run typecheck
```text
<输出前 2000 字符>
```
```

**状态文件** `.htask/state.json`:
```json
{ "status": "verifying", "startedAt": "...", "taskFile": "TASK.md",
  "implementExit": 0, "implementDurationMs": 123, "verify": [...] }
```
- status 流转: running → implementing → verifying → done | failed
- 用 `.htask/state.lock` 防止并发 start（存在即拒绝: "已有任务在运行"）

**模型/agent 可覆盖**: `htask start --model <provider/model> --agent <name> TASK.md`，默认 `deepseek/deepseek-v4-flash` / 默认无 agent。

**测试注入**: 环境变量 `HTASK_OPENCODE_CMD`（默认 `opencode`）和 `HTASK_OPENCODE_ARGS_PREFIX`（默认 `run --pure -m deepseek/deepseek-v4-flash`）——测试时用 `echo`/假脚本模拟 opencode，不真调 API 不花配额。

## Files

- `~/Project/hermes-task-runner/package.json`（name: hermes-task-runner, bin: {htask: "./bin/htask.mjs"}, type: module）
- `~/Project/hermes-task-runner/bin/htask.mjs`（CLI 全部逻辑）
- `~/Project/hermes-task-runner/test/htask.test.mjs`（node:test 测试）
- `~/Project/hermes-task-runner/README.md`（用法 + 与模板/工作流的关系）

## Constraints

- 零 npm 依赖、零构建（node 24 直接跑 .mjs）
- 不修改 dist/、不碰项目源码逻辑——htask 只读 TASK.md、只写 .htask/ 和 REPORT.md/REVIEW.md
- 注释/输出用中文（与用户习惯一致），代码标识符用英文
- osascript 通知失败必须静默（不阻塞主流程）
- 命令解析要容错: 找不到 Verification Commands 时告警并用默认验证（typecheck+test+build 提示）, 不 crash
- 用 `node:test`（node 内置, 无依赖）; 测试必须不真调 opencode

## Acceptance Criteria

1. `node --test test/` 全绿（测试覆盖: parseTaskFile 提取命令、忽略注释、verify 执行记录 exit code、REPORT.md 生成、状态流转、并发锁）
2. 在临时测试项目端到端: `htask start` 用假 opencode（HTASK_OPENCODE_CMD=假脚本）跑通 → 生成 REPORT.md 且内容含验证结果表
3. `htask status` 显示正确状态
4. 有 Verification Commands 的 TASK.md 能正确提取并执行; 无命令时告警不 crash
5. `node --check bin/htask.mjs` 语法通过

## Verification Commands

```bash
cd ~/Project/hermes-task-runner && node --check bin/htask.mjs && node --test test/
```

## Rollback Plan

- `rm -rf ~/Project/hermes-task-runner` + 移除 `/opt/homebrew/bin/htask` 软链
- 不影响任何现有项目（独立目录）
