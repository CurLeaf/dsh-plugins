#!/usr/bin/env bash
# =============================================================================
# dsh-update.sh — 把「更新 DeepSeek Harness」一次跑完：
#
#   检查最新版本 → 停 dsh-web 服务 → npm 全局安装新版本 → 回读版本校验
#   → 起服务 → 健康探测；中途任何一步失败都自动回滚到旧版本并如实记账。
#
# 设计要点（照官方桌面端 updater 的教训来）：
#   * 不在服务进程里换包：本脚本必须由 systemd 瞬态单元（或终端）拉起，处在
#     dsh-web 的 cgroup 之外，否则 `systemctl stop` 会把自己一起杀掉，更新到
#     一半就断在半新半旧的状态。
#   * 先停服务再换包：正在运行的进程持有旧代码，换包后它会「内存里旧、磁盘上新」，
#     这种混合态是怪问题的温床。
#   * 换完必须回读版本：npm 返回 0 不等于装上了，用新二进制自报版本做二次确认。
#   * 起服务后做健康探测：systemd 说 active 不代表 HTTP 已就绪。
#   * 失败回滚：旧版本号在动手前就记下来了，回滚不需要网络以外的信息。
#   * 一切过程写进状态文件：浏览器半边轮询它，这样按钮能显示进度、错误和日志。
#
# 用法：
#   dsh-update.sh --check                # 只检查，输出一行 JSON 到 stdout（给按钮用）
#   dsh-update.sh --dry-run              # 打印将要做什么，不动服务、不装包
#   dsh-update.sh                        # 完整更新（等价 --tag next --service dsh-web）
#   dsh-update.sh --tag 0.2.2-rc.3       # 固定版本
#   dsh-update.sh --with-plugins         # 顺带在 profile 里 pnpm update（插件层）
#   dsh-update.sh --service ''           # 不碰服务（只换包，重启自己想办法）
# =============================================================================
set -Eeuo pipefail

PROGRAM="dsh-update"

# ---- 默认参数 --------------------------------------------------------------
MODE="update"
SERVICE="${DSH_UPDATE_SERVICE:-dsh-web}"
TAG="${DSH_UPDATE_TAG:-next}"
PORT="${DSH_UPDATE_PORT:-3080}"
PROFILE_DIR="${DSH_UPDATE_PROFILE:-}"
WITH_PLUGINS=0
DRY_RUN=0
ROLLBACK_ENABLED=1

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
STATE_DIR="$DSH_HOME_DIR/state"
LOG_DIR="$DSH_HOME_DIR/logs"
STATUS_FILE="$STATE_DIR/update-status.json"
LOG_FILE="$LOG_DIR/dsh-update.log"
LOCK_FILE="$STATE_DIR/update.lock"
LOG_TAIL_LINES=40

# ---- 进程内状态 ------------------------------------------------------------
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
FINISHED_AT=""
PHASE="init"
MESSAGE=""
FROM=""
TO=""
CHANGED="false"
ERROR=""
ROLLED_BACK="false"

usage() {
  sed -n '3,40p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

need_value() {
  [ $# -ge 2 ] && [ -n "$2" ] || { echo "$PROGRAM: $1 需要一个值" >&2; exit 2; }
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE="check"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --with-plugins) WITH_PLUGINS=1; shift ;;
    --no-rollback) ROLLBACK_ENABLED=0; shift ;;
    --service) need_value "$@"; SERVICE="$2"; shift 2 ;;
    --service=*) SERVICE="${1#*=}"; shift ;;
    --tag) need_value "$@"; TAG="$2"; shift 2 ;;
    --tag=*) TAG="${1#*=}"; shift ;;
    --port) need_value "$@"; PORT="$2"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    --profile) need_value "$@"; PROFILE_DIR="$2"; shift 2 ;;
    --profile=*) PROFILE_DIR="${1#*=}"; shift ;;
    --status-file) need_value "$@"; STATUS_FILE="$2"; shift 2 ;;
    --log-file) need_value "$@"; LOG_FILE="$2"; shift 2 ;;
    --home) need_value "$@"; DSH_HOME_DIR="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "$PROGRAM: 未知参数 $1（--help 看用法）" >&2; exit 2 ;;
  esac
done

mkdir -p "$STATE_DIR" "$LOG_DIR"

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
warn() { log "!! $*"; }

# ---- 工具 ------------------------------------------------------------------
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

json_bool() { if [ "$1" = "1" ] || [ "$1" = "true" ]; then printf 'true'; else printf 'false'; fi; }

# 原子写状态文件：浏览器半边随时可能在读。
write_status() {
  local ok="false"
  [ "$PHASE" = "done" ] && ok="true"
  local tmp="$STATUS_FILE.tmp.$$"
  printf '{"ok":%s,"phase":"%s","message":"%s","service":"%s","tag":"%s","from":"%s","to":"%s","changed":%s,"error":"%s","rolledBack":%s,"dryRun":%s,"startedAt":"%s","updatedAt":"%s","finishedAt":"%s","pid":%s,"port":%s,"logFile":"%s"}\n' \
    "$ok" \
    "$(json_escape "$PHASE")" \
    "$(json_escape "$MESSAGE")" \
    "$(json_escape "$SERVICE")" \
    "$(json_escape "$TAG")" \
    "$(json_escape "$FROM")" \
    "$(json_escape "$TO")" \
    "$CHANGED" \
    "$(json_escape "$ERROR")" \
    "$ROLLED_BACK" \
    "$(json_bool "$DRY_RUN")" \
    "$STARTED_AT" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$FINISHED_AT" \
    "$$" \
    "${PORT:-0}" \
    "$(json_escape "$LOG_FILE")" >"$tmp"
  mv -f "$tmp" "$STATUS_FILE"
}

set_phase() {
  PHASE="$1"
  MESSAGE="$2"
  log "[$PHASE] $MESSAGE"
  write_status
}

# ---- 定位 node / 全局前缀 --------------------------------------------------
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  ERROR="找不到 node（PATH=$PATH）"
  PHASE="failed"; FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; write_status
  echo "$PROGRAM: $ERROR" >&2
  exit 1
fi

PREFIX="${npm_config_prefix:-}"
if [ -z "$PREFIX" ]; then
  PREFIX="$(cd "$(dirname "$NODE_BIN")/.." && pwd)"
fi
DSH_PKG="$PREFIX/lib/node_modules/@deepseek-ai/dsh/package.json"
DSH_BIN_JS="$PREFIX/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
NODE_DIR="$(dirname "$NODE_BIN")"

current_version() {
  [ -f "$DSH_PKG" ] || return 1
  "$NODE_BIN" -p "require('$DSH_PKG').version" 2>/dev/null
}

resolve_target_version() {
  if [[ "$TAG" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
    printf '%s' "$TAG"
    return 0
  fi
  local out="" i
  for i in 1 2 3; do
    out="$(timeout 60 npm view "@deepseek-ai/dsh@$TAG" version 2>/dev/null | tail -n 1 | tr -d '[:space:]' || true)"
    [ -n "$out" ] && { printf '%s' "$out"; return 0; }
    [ "$i" -lt 3 ] && sleep 2
  done
  return 1
}

# ---- 版本比较（semver，含 rc 序号） ----------------------------------------
# 只比「严格更新」。返回 0 = 更新，1 = 不更新，2 = 无法比较。
semver_gt() {
  "$NODE_BIN" -e '
const P = (v) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v).trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? m[4].split(".") : []]
}
const a = P(process.argv[1])
const b = P(process.argv[2])
if (!a || !b) process.exit(2)
const cmp = (x, y) => {
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  const A = x[3], B = y[3]
  if (A.length === 0 && B.length === 0) return 0
  if (A.length === 0) return 1
  if (B.length === 0) return -1
  for (let i = 0; i < Math.max(A.length, B.length); i += 1) {
    const p = A[i], q = B[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    const pn = typeof p === "number", qn = typeof q === "number"
    if (pn && qn) return p < q ? -1 : 1
    if (pn) return -1
    if (qn) return 1
    return p < q ? -1 : 1
  }
  return 0
}
process.exit(cmp(a, b) > 0 ? 0 : 1)
' "$1" "$2"
}

# ---- --check：只回答「有没有新版本」 --------------------------------------
if [ "$MODE" = "check" ]; then
  FROM="$(current_version || true)"
  if ! TO="$(resolve_target_version)"; then
    printf '{"current":"%s","latest":"","tag":"%s","updateAvailable":false,"error":"无法从 npm 取得 %s 版本"}\n' \
      "$FROM" "$(json_escape "$TAG")" "$(json_escape "$TAG")"
    exit 1
  fi
  available="false"
  cmp=0
  semver_gt "$TO" "$FROM" >/dev/null 2>&1 || cmp=$?
  if [ "$cmp" -eq 0 ]; then
    available="true"
  elif [ "$cmp" -eq 2 ]; then
    printf '{"current":"%s","latest":"%s","tag":"%s","updateAvailable":false,"error":"版本号无法比较"}\n' \
      "$(json_escape "$FROM")" "$(json_escape "$TO")" "$(json_escape "$TAG")"
    exit 1
  fi
  printf '{"current":"%s","latest":"%s","tag":"%s","updateAvailable":%s,"service":"%s","dshPackage":"%s"}\n' \
    "$(json_escape "$FROM")" "$(json_escape "$TO")" "$(json_escape "$TAG")" "$available" \
    "$(json_escape "$SERVICE")" "$(json_escape "$DSH_PKG")"
  exit 0
fi

# ---- 从这里开始会动真格：先接管日志与锁 ------------------------------------
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  PHASE="failed"; ERROR="另一个更新进程正在运行（锁 $LOCK_FILE）"
  FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  MESSAGE="更新被拒绝：已有更新在进行"
  write_status
  echo "$PROGRAM: $ERROR" >&2
  exit 3
fi

# stdout/stderr 同时进日志文件和调用方的终端（journal 里也能看到）。
exec > >(tee -a "$LOG_FILE") 2>&1

log "================================================================"
log "$PROGRAM 开始：tag=$TAG service=${SERVICE:-<none>} port=$PORT dry-run=$DRY_RUN plugins=$WITH_PLUGINS"
log "node=$NODE_BIN prefix=$PREFIX"

FROM="$(current_version || true)"
if [ -z "$FROM" ]; then
  PHASE="failed"; ERROR="读不到当前安装版本（$DSH_PKG）"
  MESSAGE="当前安装不在 $PREFIX 下，拒绝更新"
  FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  write_status
  exit 1
fi
log "当前版本：$FROM"

set_phase checking "正在查询 @deepseek-ai/dsh@$TAG 的最新版本"
if ! TO="$(resolve_target_version)"; then
  PHASE="failed"; ERROR="npm view @deepseek-ai/dsh@$TAG 没有返回版本"
  MESSAGE="查不到目标版本，可能是网络或 npm 源问题"
  FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  write_status
  exit 1
fi
log "目标版本：$TO"

if [ "$FROM" = "$TO" ]; then
  CHANGED="false"
  PHASE="done"; MESSAGE="已是最新（$FROM）"
  FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  write_status
  log "已经是最新版本，不动服务"
  exit 0
fi

# 只有在目标**严格更新**时才动手：npm 的 dist-tag 会指回旧版本（`latest` 就长期
# 停在 rc.1），把它当更新会把用户降级。
cmp=0
semver_gt "$TO" "$FROM" >/dev/null 2>&1 || cmp=$?
if [ "$cmp" -ne 0 ]; then
  if [ "$cmp" -eq 2 ]; then
    PHASE="failed"; ERROR="版本号无法比较：current=$FROM target=$TO"
    MESSAGE="版本号解析失败，拒绝更新"
    FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    write_status
    exit 1
  fi
  CHANGED="false"
  PHASE="done"; MESSAGE="目标版本 $TO 不高于当前 $FROM，拒绝降级"
  FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  write_status
  log "目标版本不比当前新，什么都不做"
  exit 0
fi

CHANGED="true"

if [ "$DRY_RUN" = "1" ]; then
  PHASE="done"; MESSAGE="dry-run：将从 $FROM 更新到 $TO（未执行）"
  FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  write_status
  log "dry-run 结束"
  exit 0
fi

# ---- 服务开关 --------------------------------------------------------------
has_systemd() { [ -n "$SERVICE" ] && command -v systemctl >/dev/null 2>&1; }

stop_service() {
  has_systemd || { log "未配置 systemd 服务，跳过'停服务'"; return 0; }
  log "systemctl --user stop $SERVICE"
  systemctl --user stop "$SERVICE" 2>/dev/null || true
  local i
  for i in $(seq 1 60); do
    systemctl --user is-active --quiet "$SERVICE" || { log "服务已停止"; return 0; }
    sleep 0.5
  done
  warn "服务在 30s 内没有停下来"
  return 1
}

wait_http() {
  local deadline=$((SECONDS + ${1:-90})) code
  while [ $SECONDS -lt $deadline ]; do
    code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://127.0.0.1:$PORT/" 2>/dev/null || true)"
    if [ -n "$code" ] && [ "$code" != "000" ]; then
      log "HTTP 就绪：127.0.0.1:$PORT 返回 $code"
      return 0
    fi
    sleep 1
  done
  return 1
}

start_service() {
  has_systemd || { log "未配置 systemd 服务，跳过'起服务'"; return 0; }
  log "systemctl --user start $SERVICE"
  systemctl --user start "$SERVICE" || return 1
  local i
  for i in $(seq 1 60); do
    systemctl --user is-active --quiet "$SERVICE" && return 0
    sleep 0.5
  done
  return 1
}

# npm 11+ 才认识 --allow-scripts（原生依赖必须在安装时放行脚本，否则 node-pty /
# koffi 之类会静默变成「装上了但没编」。老 npm 没有这个开关，就不传。
NPM_MAJOR="$(npm --version 2>/dev/null | cut -d. -f1 || echo 0)"
ALLOW_SCRIPTS=()
if [ "${NPM_MAJOR:-0}" -ge 11 ] 2>/dev/null; then
  ALLOW_SCRIPTS=(--allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs)
fi

# ---- 装包：先暂存，再原子切换（把停机窗口压到秒级） ------------------------
PKG_DIR="$PREFIX/lib/node_modules/@deepseek-ai/dsh"
STAGING_ROOT="$DSH_HOME_DIR/staging/dsh-update"
STAGE_DIR=""
BACKUP=""

install_version() {
  local version="$1"
  log "npm i -g @deepseek-ai/dsh@$version --prefix $PREFIX"
  timeout 1800 npm install -g "@deepseek-ai/dsh@$version" \
    --prefix "$PREFIX" \
    --no-audit --no-fund --loglevel=warn \
    ${ALLOW_SCRIPTS[@]+"${ALLOW_SCRIPTS[@]}"}
}

verify_binary() {
  local version="$1" got
  [ -f "$DSH_BIN_JS" ] || { warn "安装后找不到 $DSH_BIN_JS"; return 1; }
  got="$("$NODE_BIN" "$DSH_BIN_JS" --version 2>/dev/null | tail -n 1 | tr -d '[:space:]' || true)"
  log "二进制自报版本：${got:-<空>}"
  [ "$got" = "$version" ]
}

# 预装到暂存前缀：这一步服务照常运行，下载/解包/编译都在这里耗掉。
stage_install() {
  local version="$1" staged_pkg got
  STAGE_DIR="$STAGING_ROOT/$version-$(date +%s)-$$"
  rm -rf "$STAGE_DIR"
  mkdir -p "$STAGE_DIR"
  log "预装到暂存区（服务照常运行）：$STAGE_DIR"
  if ! timeout 1800 npm install -g "@deepseek-ai/dsh@$version" \
    --prefix "$STAGE_DIR" \
    --no-audit --no-fund --loglevel=warn \
    ${ALLOW_SCRIPTS[@]+"${ALLOW_SCRIPTS[@]}"}; then
    warn "暂存安装失败"
    return 1
  fi
  staged_pkg="$STAGE_DIR/lib/node_modules/@deepseek-ai/dsh"
  [ -f "$staged_pkg/lib/bin.js" ] || { warn "暂存区里没有 bin.js：$staged_pkg"; return 1; }
  got="$("$NODE_BIN" "$staged_pkg/lib/bin.js" --version 2>/dev/null | tail -n 1 | tr -d '[:space:]' || true)"
  log "暂存区自报版本：${got:-<空>}"
  [ "$got" = "$version" ] || { warn "暂存区版本与目标不一致"; return 1; }
  return 0
}

# 原子切换：旧目录挪成备份，暂存的目录 mv 进来（同一文件系统上是秒级 rename）。
swap_in() {
  local staged_pkg="$STAGE_DIR/lib/node_modules/@deepseek-ai/dsh" parent
  [ -d "$staged_pkg" ] || { warn "暂存目录不见了：$staged_pkg"; return 1; }
  parent="$(dirname "$PKG_DIR")"
  mkdir -p "$parent"
  BACKUP="$PKG_DIR.bak-$(date +%s)"
  if [ -e "$PKG_DIR" ]; then
    mv "$PKG_DIR" "$BACKUP" || { warn "旧版本挪到备份失败"; return 1; }
    log "旧版本已备份到 $BACKUP"
  fi
  if ! mv "$staged_pkg" "$PKG_DIR"; then
    warn "暂存目录切换失败，正在还原旧版本"
    [ -n "$BACKUP" ] && [ -d "$BACKUP" ] && mv "$BACKUP" "$PKG_DIR"
    return 1
  fi
  # npm 的全局 bin 链接相对路径不变；万一丢了就补一条。
  if [ ! -e "$PREFIX/bin/dsh" ]; then
    mkdir -p "$PREFIX/bin"
    ln -sfn "../lib/node_modules/@deepseek-ai/dsh/lib/bin.js" "$PREFIX/bin/dsh" || warn "补 bin 链接失败"
  fi
  return 0
}

swap_back() {
  [ -n "${BACKUP:-}" ] && [ -d "${BACKUP:-}" ] || return 1
  case "$PKG_DIR" in
    */node_modules/@deepseek-ai/dsh) ;;
    *) warn "PKG_DIR 形状不对，拒绝删除：$PKG_DIR"; return 1 ;;
  esac
  rm -rf "$PKG_DIR"
  mv "$BACKUP" "$PKG_DIR"
  BACKUP=""
  return 0
}

cleanup_old() {
  # 一份安装约 1.2G：暂存区用完就删，备份只留最近一份（回滚只需要最近的好版本）。
  if [ -n "${STAGE_DIR:-}" ] && [ -d "${STAGE_DIR:-}" ]; then
    rm -rf "$STAGE_DIR"
    STAGE_DIR=""
  fi
  [ -d "$STAGING_ROOT" ] && ls -1dt "$STAGING_ROOT"/* 2>/dev/null | tail -n +2 | while read -r dir; do rm -rf "$dir"; done
  ls -1dt "$PKG_DIR".bak-* 2>/dev/null | tail -n +2 | while read -r dir; do rm -rf "$dir"; done
}

rollback() {
  [ "$ROLLBACK_ENABLED" = "1" ] || { warn "已禁用回滚"; return 0; }
  ROLLED_BACK="true"
  set_phase rolling-back "更新失败，正在回滚到 $FROM"
  if swap_back; then
    log "已把备份切回 $PKG_DIR（不需要联网）"
  elif [ -n "$FROM" ]; then
    warn "没有可用备份，退回 npm 重装 $FROM"
    install_version "$FROM" || { warn "回滚安装失败！请手动执行：npm i -g @deepseek-ai/dsh@$FROM"; return 1; }
  else
    return 1
  fi
  verify_binary "$FROM" || warn "回滚后版本校验仍不一致"
  if has_systemd; then
    start_service || warn "回滚后服务启动失败"
    wait_http 60 || warn "回滚后 HTTP 探测失败"
  fi
  return 0
}

fail_update() {
  local step="$1" detail="$2"
  ERROR="$step: $detail"
  warn "失败：$ERROR"
  if [ "$ROLLBACK_ENABLED" = "1" ] && [ -n "$FROM" ] && [ "$(current_version || true)" != "$FROM" ]; then
    rollback || true
  elif has_systemd; then
    warn "尝试把服务拉回来（保持现有安装）"
    start_service || warn "服务启动失败，请手动 systemctl --user start $SERVICE"
  fi
  PHASE="failed"
  MESSAGE="更新失败：$step"
  FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  write_status
  exit 1
}

# ---- 主流程 ----------------------------------------------------------------
set_phase preparing "正在把 @deepseek-ai/dsh@$TO 预装到暂存区（服务照常运行）"
stage_install "$TO" || fail_update "stage" "预装到暂存区失败（服务未受影响）"

# 预装好了才停服务：停机窗口只剩下面的 rename + 启动。
set_phase stopping "正在停止 ${SERVICE:-服务}"
stop_service || fail_update "stop" "服务没有在超时内停止"

set_phase installing "正在原子切换到 $TO"
swap_in || fail_update "swap" "切换新版本目录失败"

set_phase verifying "正在校验新版本"
if ! verify_binary "$TO"; then
  fail_update "verify" "新安装自报版本与 $TO 不一致"
fi

if [ "$WITH_PLUGINS" = "1" ] && [ -n "$PROFILE_DIR" ] && [ -d "$PROFILE_DIR" ]; then
  set_phase updating-plugins "正在更新 profile 插件（$PROFILE_DIR）"
  if ! (cd "$PROFILE_DIR" && timeout 900 pnpm update --config.confirmModulesPurge=false); then
    warn "插件更新失败，但内核已经装好，继续启动"
  fi
fi

set_phase starting "正在启动 ${SERVICE:-服务}"
if ! start_service; then
  fail_update "start" "systemctl start 失败或服务没有变 active"
fi

set_phase health-check "正在等待 HTTP 就绪"
if ! wait_http 90; then
  fail_update "health" "服务起来了但 HTTP 在 90s 内没有响应"
fi

cleanup_old
FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
set_phase done "更新完成：$FROM → $TO"
log "完成：$FROM → $TO"
exit 0
