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

# Kích hoạt LightCode an toàn (22/11/2026): BE cấp vé Ed25519 ngắn hạn ràng chặt vào machine-id của riêng lần bật container này.
# Vé chỉ ghi vào /var/lib/aivin (0700, root-only) với quyền 0600 rồi xóa sạch khỏi biến môi trường trước khi chạy tiến trình nào khác.
if [ -n "${AIVIN_LIGHTCODE_MACHINE_ID:-}" ]; then
  printf '%s\n' "$AIVIN_LIGHTCODE_MACHINE_ID" > /etc/machine-id 2>/dev/null && chmod 444 /etc/machine-id 2>/dev/null || true
fi
if [ -n "${AIVIN_LIGHTCODE_LICENSE_KEY:-}" ]; then
  umask 077
  printf '%s\n' "$AIVIN_LIGHTCODE_LICENSE_KEY" > /var/lib/aivin/lightcode-license.key
  chmod 600 /var/lib/aivin/lightcode-license.key
  umask 022
  export LCAGENT_LICENSE_FILE=/var/lib/aivin/lightcode-license.key
fi
unset AIVIN_LIGHTCODE_LICENSE_KEY AIVIN_LIGHTCODE_MACHINE_ID

exec node /opt/aivin-cli/bin/cli.mjs remote start --multi-user "$@"
