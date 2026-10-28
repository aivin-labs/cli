# Máy tính đám mây của tổ chức (Aivin cấp cho org, BE config/org_computer.json → image). Container chạy CLI ở chế độ nhiều người dùng:
# mỗi thành viên org một tài khoản Linux + thư mục nhà riêng (/home/<vùng>), thư mục chung /shared. Token thiết bị do BE đặt qua env lúc
# tạo container (AIVIN_DEVICE_TOKEN / AIVIN_DEVICE_ID / AIVIN_SERVER). Build từ gốc repo cli:
#   docker build -f deploy/org-computer/Dockerfile -t aivin/org-computer:latest .
FROM node:22-bookworm-slim

# Công cụ thường dùng cho việc của văn phòng / lập trình: AI cài thêm gói theo từng người (pip --user, npm trong dự án), không có sudo.
# util-linux: /usr/bin/prlimit — trần số tiến trình mỗi thành viên (multiUser.mjs withProcessCap); image slim thường có sẵn, ghi rõ để
# không mất khi đổi image gốc. du (coreutils) đo hạn mức đĩa.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git ripgrep jq less nano procps util-linux coreutils unzip zip xz-utils file \
      python3 python3-pip python3-venv build-essential \
      libreoffice-core-nogui libreoffice-writer-nogui libreoffice-calc-nogui fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

# Nhóm chính của mọi tài khoản thành viên (khớp MEMBER_GID ở bin/lib/remote/multiUser.mjs). /shared: sticky — sửa chung được, chỉ chủ tệp
# xoá được. Bỏ tài khoản `node` của image gốc (không ai dùng, để lại /home/node đọc được).
RUN userdel -r node \
 && groupadd -g 10000 aivin \
 && mkdir -p /shared /var/lib/aivin \
 && chown root:aivin /shared && chmod 1775 /shared \
 && chmod 711 /home && chmod 700 /var/lib/aivin

WORKDIR /opt/aivin-cli
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY bin ./bin
COPY README.md ./

ENV AIVIN_REMOTE_HOME=/var/lib/aivin \
    AIVIN_MULTI_USER=1 \
    SHELL=/bin/bash \
    NODE_ENV=production

# Chạy bằng root (tạo tài khoản thành viên, đổi sang tài khoản đó khi chạy lệnh); container bỏ hết capability trừ phần cần cho việc ấy
# (service-manager OrgComputerHelper.buildRunArgs) và chặn leo quyền.
ENTRYPOINT ["node", "/opt/aivin-cli/bin/cli.mjs", "remote", "start", "--multi-user"]
