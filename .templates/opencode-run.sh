#!/bin/bash
# opencode-run.sh — 后台跑 OpenCode 任务, 结束时弹 macOS 通知
# 用法: opencode-run.sh "任务描述" [--dir <路径>] [opencode 参数...]
# 例:   opencode-run.sh "实现 TASK.md" --dir ~/Project/foo --pure -m deepseek/deepseek-v4-flash
#
# 通知链: OpenCode 完成 → osascript 弹窗 + 终端摘要
# 失败也通知 (标题带 ❌), 不会静默失败
# ⚠️ --dir 必传: 脚本不会自动 cd, 默认在调用方工作目录运行

set -u

DESC="${1:-OpenCode 任务}"
shift

WORKDIR=""
if [ "${1:-}" = "--dir" ]; then
  WORKDIR="$2"
  shift 2
  if [ -n "$WORKDIR" ]; then cd "$WORKDIR" || { echo "❌ 无法进入目录: $WORKDIR"; exit 1; }; fi
fi

export PATH="/opt/homebrew/bin:/Users/dok4ever/.nvm/versions/node/v24.18.0/bin:$PATH"

echo "▶️  启动 OpenCode: $DESC"
echo "    目录: $(pwd)"
echo "    参数: $*"
echo ""

START=$(date +%s)

opencode run "$@" 2>&1 | tail -80
RC=${PIPESTATUS[0]}

DURATION=$(( $(date +%s) - START ))

if [ "$RC" -eq 0 ]; then
  osascript -e "display notification \"$DESC\" with title \"✅ OpenCode 完成\" subtitle \"耗时 ${DURATION}s\"" >/dev/null 2>&1
  echo ""
  echo "✅ OpenCode 完成 (${DURATION}s): $DESC"
else
  osascript -e "display notification \"$DESC (exit $RC)\" with title \"❌ OpenCode 失败\" subtitle \"耗时 ${DURATION}s\"" >/dev/null 2>&1
  echo ""
  echo "❌ OpenCode 失败 (exit=$RC, ${DURATION}s): $DESC"
fi

exit $RC
