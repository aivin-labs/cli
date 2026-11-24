#!/bin/bash
# Khởi động máy tính tổ chức (28/10/2026). Hai chốt trước khi chạy CLI — CLI chạy lệnh của thành viên, nên chốt hỏng thì không chạy:
#  1. Đĩa ext4 (AIVIN_DISK_OWNER, service-manager OrgComputerDiskHelper): /home phải đúng là đĩa của org này. Mount nhầm đĩa org khác
#     (số loop cũ sau khi máy chủ khởi động lại) → thoát, không cho ai đọc.
#  2. Ẩn tiến trình (AIVIN_PROC_HIDE, OrgComputerProcHideHelper): service remount /proc hidepid từ ngoài ngay sau `docker run` — chờ tới khi
#     xong (hoặc service báo không làm được qua dấu /run/aivin/proc-hide-skip) để không tiến trình thành viên nào chạy trước lúc ẩn.
#     off = không chờ; auto = quá hạn thì vẫn chạy (ghi cảnh báo); required = quá hạn thì thoát.
set -u

log() { echo "[org-computer] $*" >&2; }

if [ -n "${AIVIN_DISK_OWNER:-}" ]; then
  owner="$(cat /home/.aivin-disk-owner 2>/dev/null || true)"
  if [ "$owner" != "$AIVIN_DISK_OWNER" ]; then
    log "Đĩa /home không phải của máy này (cần '${AIVIN_DISK_OWNER}', thấy '${owner:-<trống>}') — dừng."
    exit 78
  fi
  log "Đĩa: ext4 chặn cứng $(df -h --output=size /home 2>/dev/null | tail -1 | tr -d ' ') (cơ chế ${AIVIN_DISK_MODE:-?})"
else
  log "Đĩa: ${AIVIN_DISK_MODE:-soft} (không có đĩa ext4 riêng — CLI tự đo và chặn ghi khi đầy)"
fi

proc_hidden() { grep -Eq ' /proc .* - proc .*hidepid=' /proc/self/mountinfo; }

mode="${AIVIN_PROC_HIDE:-off}"
if [ "$mode" != "off" ]; then
  wait_s="${AIVIN_PROC_HIDE_WAIT_S:-20}"
  case "$wait_s" in ''|*[!0-9]*) wait_s=20 ;; esac
  deadline=$((SECONDS + wait_s))
  until proc_hidden || [ -e /run/aivin/proc-hide-skip ] || [ "$SECONDS" -ge "$deadline" ]; do sleep 0.1; done
  if proc_hidden; then
    log "Tiến trình: đã ẩn giữa các tài khoản (/proc hidepid)"
  elif [ "$mode" = "required" ]; then
    log "Tiến trình: chưa ẩn được sau ${wait_s} s (proc_hide.mode=required) — dừng."
    exit 79
  else
    log "CẢNH BÁO tiến trình: KHÔNG ẩn được — thành viên thấy tên tiến trình của nhau"
  fi
fi

# Kích hoạt LightCode an toàn (24/11/2026): BE cấp vé Ed25519 ngắn hạn ràng chặt vào machine-id của riêng lần bật container này.
# Vé ghi vào /var/lib/aivin-lc (0700, chủ aivin-lc, chế độ 0600) — daemon LightCode đọc được, thành viên không.
# CLI (root) ghi được nhờ DAC_OVERRIDE; sau đó xoá sạch khỏi biến môi trường trước khi exec bất kỳ tiến trình nào khác.
if [ -n "${AIVIN_LIGHTCODE_MACHINE_ID:-}" ]; then
  printf '%s\n' "$AIVIN_LIGHTCODE_MACHINE_ID" > /etc/machine-id 2>/dev/null && chmod 444 /etc/machine-id 2>/dev/null || true
fi
if [ -n "${AIVIN_LIGHTCODE_LICENSE_KEY:-}" ]; then
  umask 077
  printf '%s\n' "$AIVIN_LIGHTCODE_LICENSE_KEY" > /var/lib/aivin-lc/lightcode-license.key
  chown aivin-lc:aivin-lc /var/lib/aivin-lc/lightcode-license.key
  chmod 600 /var/lib/aivin-lc/lightcode-license.key
  umask 022
  export LCAGENT_LICENSE_FILE=/var/lib/aivin-lc/lightcode-license.key
fi
unset AIVIN_LIGHTCODE_LICENSE_KEY AIVIN_LIGHTCODE_MACHINE_ID

# Khởi động LightCode headless (nếu bundle đã được cài vào image) dưới tài khoản daemon aivin-lc, loopback.
# connector.json nằm ở /var/lib/aivin-lc/.lightcode/connector.json — CLI đọc qua LIGHTCODE_HEADLESS_CONNECTOR_FILE.
# MẶC ĐỊNH TẮT: daemon aivin-lc không đọc được home 0700 của thành viên (LightCode chưa có runAs) → chỉ chạy khi AIVIN_LIGHTCODE_ORG_JOBS=1.
# Tắt: không khởi động daemon, CLI không quảng bá LightCode → org dùng đường Claude Code / Codex như cũ.
if [ "${AIVIN_LIGHTCODE_ORG_JOBS:-0}" != "1" ]; then
  log "LightCode: tắt (AIVIN_LIGHTCODE_ORG_JOBS != 1) — bỏ qua daemon"
elif [ -f /opt/lightcode/index.js ]; then
  log "LightCode: đang khởi động daemon headless..."
  export LIGHTCODE_HEADLESS_CONNECTOR_FILE=/var/lib/aivin-lc/.lightcode/connector.json
  mkdir -p /var/lib/aivin-lc/.lightcode
  chown aivin-lc:aivin-lc /var/lib/aivin-lc/.lightcode
  # Thư mục dữ liệu của daemon: không đặt thì bundle tính theo vị trí tệp (/opt/lightcode/../../../data = /data) → EACCES mkdir /data rồi chết.
  # Đặt trong /var/lib/aivin-lc (chủ aivin-lc, 0700 — thành viên không đọc được).
  LC_DATA_DIR=/var/lib/aivin-lc/data
  mkdir -p "$LC_DATA_DIR"
  chown aivin-lc:aivin-lc "$LC_DATA_DIR"
  chmod 700 "$LC_DATA_DIR"
  # Dải uid/gid thành viên mà LightCode chấp nhận cho `run_as` (khớp multiUser.mjs: nhóm chung gid 10000, uid thành viên từ 10001).
  # Ngoài dải (root, daemon 9999, tài khoản hệ thống) bị từ chối. LCAGENT_MANAGED_RUNTIME=1 bật nhận `run_as` theo từng job; thiếu
  # CAP_SETUID/SETGID thì job THẤT BẠI, không bao giờ rơi về tài khoản daemon.
  # Host cổng AI mà LightCode chấp nhận cho `ai_gateway.base_url` (LCAGENT_AI_GATEWAY_HOSTS; mặc định chỉ loopback/host.docker.internal →
  # trên production job bị 403 ai_gateway_host_not_allowed). = mặc định + hostname của AIVIN_SERVER + danh sách phụ AIVIN_AI_GATEWAY_HOSTS
  # (dấu phẩy). Chỉ nhận hostname/IPv4 hợp lệ (chữ-số, dấu chấm, gạch ngang); giá trị lạ (khoảng trắng, wildcard, đường dẫn, cổng) bị bỏ.
  LC_GATEWAY_HOSTS="host.docker.internal,localhost,127.0.0.1,::1"
  lc_server_host="$(printf '%s' "${AIVIN_SERVER:-}" | sed -E 's|^[A-Za-z][A-Za-z0-9+.-]*://||; s|[/?#].*$||; s|^[^@]*@||; s|:[0-9]+$||')"
  lc_extra_hosts="$(printf '%s' "${AIVIN_AI_GATEWAY_HOSTS:-}" | tr ',' '
')"
  while IFS= read -r lc_host; do
    lc_host="$(printf '%s' "$lc_host" | tr 'A-Z' 'a-z' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
    if printf '%s' "$lc_host" | grep -Eq '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$'; then
      case ",$LC_GATEWAY_HOSTS," in *",$lc_host,"*) ;; *) LC_GATEWAY_HOSTS="$LC_GATEWAY_HOSTS,$lc_host" ;; esac
    elif [ -n "$lc_host" ]; then
      log "LightCode: bỏ host cổng AI không hợp lệ"
    fi
  done <<EOF_HOSTS
$lc_server_host
$lc_extra_hosts
EOF_HOSTS
  LC_ENV="HOME=/var/lib/aivin-lc LIGHTCODE_HEADLESS=1 LCAGENT_DATA_DIR=$LC_DATA_DIR LCAGENT_MANAGED_RUNTIME=1 LCAGENT_RUNAS_UID_MIN=${LCAGENT_RUNAS_UID_MIN:-10000} LCAGENT_RUNAS_UID_MAX=${LCAGENT_RUNAS_UID_MAX:-65533} LCAGENT_AI_GATEWAY_HOSTS=$LC_GATEWAY_HOSTS"
  LC_CMD="env $LC_ENV ${LCAGENT_LICENSE_FILE:+LCAGENT_LICENSE_FILE=$LCAGENT_LICENSE_FILE} node /opt/lightcode/index.js --headless --loopback"
  if command -v setpriv >/dev/null 2>&1; then
    # Daemon không phải root; chỉ giữ 3 capability (đổi uid/gid sang thành viên cho từng job, dừng cây tiến trình của họ) qua ambient caps.
    setpriv --reuid=aivin-lc --regid=aivin-lc --clear-groups \
      --inh-caps=+setuid,+setgid,+kill --ambient-caps=+setuid,+setgid,+kill \
      sh -c "$LC_CMD" &
  else
    log "CẢNH BÁO LightCode: thiếu setpriv — daemon không đổi được sang tài khoản thành viên, job LightCode sẽ thất bại (không chạy dưới daemon)"
    su -s /bin/sh -c "$LC_CMD" aivin-lc &
  fi
  LC_PID=$!
  # Chờ tối đa 30 s để connector.json xuất hiện
  lc_wait=0
  until [ -f /var/lib/aivin-lc/.lightcode/connector.json ] || [ "$lc_wait" -ge 30 ]; do
    sleep 1; lc_wait=$((lc_wait + 1))
  done
  if [ -f /var/lib/aivin-lc/.lightcode/connector.json ]; then
    log "LightCode: daemon sẵn sàng (pid=$LC_PID)"
  else
    log "CẢNH BÁO LightCode: daemon chưa mở connector sau ${lc_wait} s — tiếp tục không có LightCode"
  fi
else
  log "LightCode: không có bundle trong image — bỏ qua"
fi

exec node /opt/aivin-cli/bin/cli.mjs remote start --multi-user "$@"
