# Máy tính đám mây của tổ chức (Aivin cấp cho org, BE config/org_computer.json → image). Container chạy CLI ở chế độ nhiều người dùng:
# mỗi thành viên org một tài khoản Linux + thư mục nhà riêng (/home/<vùng>), thư mục chung /shared. Token thiết bị do BE đặt qua env lúc
# tạo container (AIVIN_DEVICE_TOKEN / AIVIN_DEVICE_ID / AIVIN_SERVER). Build từ gốc repo cli:
#   docker build -f deploy/org-computer/Dockerfile -t aivin/org-computer:latest .
FROM node:22-bookworm-slim

# Công cụ thường dùng cho việc của văn phòng / lập trình: AI cài thêm gói theo từng người (pip --user, npm trong dự án), không có sudo.
# util-linux: /usr/bin/prlimit — trần số tiến trình mỗi thành viên (multiUser.mjs withProcessCap); image slim thường có sẵn, ghi rõ để
# không mất khi đổi image gốc. du (coreutils) đo hạn mức đĩa. util-linux (losetup, nsenter) + mount + e2fsprogs (mkfs.ext4, resize2fs):
# service-manager dùng chính image này làm helper privileged chốc lát để dựng đĩa ext4 theo gói và remount /proc hidepid (28/10/2026).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git ripgrep jq less nano procps util-linux mount e2fsprogs coreutils unzip zip xz-utils file \
      python3 python3-pip python3-venv build-essential \
      libreoffice-core-nogui libreoffice-writer-nogui libreoffice-calc-nogui fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

# Nhóm chính của mọi tài khoản thành viên (khớp MEMBER_GID ở bin/lib/remote/multiUser.mjs). /shared: sticky — sửa chung được, chỉ chủ tệp
# xoá được. Bỏ tài khoản `node` của image gốc (không ai dùng, để lại /home/node đọc được).
# Không còn thư mục nào thành viên ghi được trên lớp ghi của container (ngoài đĩa /home, /shared có hạn mức): /var/tmp → /tmp (tmpfs có
# trần), /run/lock chỉ root — không thì ghi vào đó lách được hạn mức đĩa, đổ thẳng xuống ổ máy chủ.
RUN userdel -r node \
 && groupadd -g 10000 aivin \
 && mkdir -p /shared /var/lib/aivin \
 && chown root:aivin /shared && chmod 1775 /shared \
 && chmod 711 /home && chmod 700 /var/lib/aivin \
 && rm -rf /var/tmp && ln -s /tmp /var/tmp \
 && chmod 755 /run/lock

WORKDIR /opt/aivin-cli
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY bin ./bin
COPY README.md ./
COPY deploy/org-computer/entrypoint.sh ./entrypoint.sh
RUN sed -i 's/\r$//' ./entrypoint.sh && chmod 755 ./entrypoint.sh

ENV AIVIN_REMOTE_HOME=/var/lib/aivin \
    AIVIN_MULTI_USER=1 \
    SHELL=/bin/bash \
    NODE_ENV=production

# Chạy bằng root (tạo tài khoản thành viên, đổi sang tài khoản đó khi chạy lệnh); container bỏ hết capability trừ phần cần cho việc ấy
# (service-manager OrgComputerHelper.buildRunArgs) và chặn leo quyền. entrypoint.sh kiểm đĩa đúng của org + chờ /proc đã ẩn rồi mới
# exec `node bin/cli.mjs remote start --multi-user`.
ENTRYPOINT ["/opt/aivin-cli/entrypoint.sh"]
