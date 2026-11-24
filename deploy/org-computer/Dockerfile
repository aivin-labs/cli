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
      ca-certificates curl wget git gh ripgrep jq less nano procps util-linux mount e2fsprogs coreutils unzip zip xz-utils file \
      python3 python3-pip python3-venv build-essential \
      libreoffice-core-nogui libreoffice-writer-nogui libreoffice-calc-nogui fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

# Nhóm chính của mọi tài khoản thành viên (khớp MEMBER_GID ở bin/lib/remote/multiUser.mjs). /shared: sticky — sửa chung được, chỉ chủ tệp
# xoá được. Bỏ tài khoản `node` của image gốc (không ai dùng, để lại /home/node đọc được).
# Không còn thư mục nào thành viên ghi được trên lớp ghi của container (ngoài đĩa /home, /shared có hạn mức): /var/tmp → /tmp (tmpfs có
# trần), /run/lock chỉ root — không thì ghi vào đó lách được hạn mức đĩa, đổ thẳng xuống ổ máy chủ.
# Tài khoản daemon LightCode (uid 9999, không phải thành viên, không có shell thật): LightCode headless chạy dưới tài khoản này, loopback,
# cổng ngẫu nhiên — không mở ra ngoài. /var/lib/aivin-lc: thư mục làm việc + vé bản quyền (0700, chủ aivin-lc) — thành viên không đọc được.
RUN userdel -r node \
 && groupadd -g 10000 aivin \
 && groupadd -r -g 9999 aivin-lc \
 && useradd -r -u 9999 -g 9999 -M -d /var/lib/aivin-lc -s /sbin/nologin aivin-lc \
 && mkdir -p /shared /var/lib/aivin /var/lib/aivin-lc \
 && chown root:aivin /shared && chmod 1775 /shared \
 && chmod 711 /home && chmod 700 /var/lib/aivin \
 && chown aivin-lc:aivin-lc /var/lib/aivin-lc && chmod 700 /var/lib/aivin-lc \
 && rm -rf /var/tmp && ln -s /tmp /var/tmp \
 && chmod 755 /run/lock

# Agent làm "mô hình trên máy" cho từng thành viên (17/11/2026, bin/lib/remote/localLlmMembers.mjs): cài chung một bản (root, /usr/local),
# mỗi thành viên đăng nhập tài khoản Claude / ChatGPT CỦA CHÍNH HỌ từ Aivin — tệp đăng nhập nằm trong /home/<vùng>, không ai dùng chung
# tài khoản / hạn mức của ai. Ghim bản đã đo đăng nhập không màn hình (claude auth login, codex login --device-auth); nâng bản = build lại
# image. Thành viên không ghi được /usr/local → tắt tự cập nhật. /var/lib/aivin-llm: thư mục làm việc rỗng của agent (root, 0755).
ARG CLAUDE_CODE_VERSION=2.1.326
ARG CODEX_VERSION=0.169.0
ARG GEMINI_CLI_VERSION=0.70.0
# OpenCode: LightCode chạy job có ai_gateway (nhánh hạn mức mặc định) bằng OpenCode — thiếu binary thì worker thoát mã 127 và lặp. LightCode test với 1.19.
# Cấu hình / dữ liệu / cache / state của opencode nằm dưới $HOME (~/.config, ~/.local/share, ~/.cache, ~/.local/state) = /home/<vùng> (0700 theo thành viên), không ghi /usr/local.
ARG OPENCODE_VERSION=1.19.6
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" "@google/gemini-cli@${GEMINI_CLI_VERSION}" "opencode-ai@${OPENCODE_VERSION}" \
 && npm cache clean --force \
 && mkdir -p /var/lib/aivin-llm && chmod 755 /var/lib/aivin-llm \
 && claude --version && codex --version && gemini --version && opencode --version
ENV DISABLE_AUTOUPDATER=1

# LightCode headless: bundle đóng gói bằng deploy/org-computer/lightcode/pack-lightcode.mjs TRƯỚC KHI build (mặc định ghi tarball + pin thẳng vào deploy/org-computer/lightcode/, không phải dist/), ghim bản bằng ARG (sha256 kiểm
# lúc build). Chạy ngầm dưới tài khoản daemon `aivin-lc` (uid 9999), loopback, không mở cổng ra ngoài. Native deps (@lydell/node-pty) cần npm.
ARG LIGHTCODE_VERSION
ARG LIGHTCODE_SHA256
COPY deploy/org-computer/lightcode/ /opt/lightcode-dist/
RUN set -e; \
    if [ -z "${LIGHTCODE_VERSION:-}" ]; then echo "Bỏ qua LightCode (LIGHTCODE_VERSION chưa đặt)"; \
    else \
      TARBALL="/opt/lightcode-dist/lightcode-server-${LIGHTCODE_VERSION}.tar.gz"; \
      if [ ! -f "$TARBALL" ]; then echo "LIGHTCODE_VERSION=${LIGHTCODE_VERSION} nhưng không thấy $TARBALL — chạy pack-lightcode.mjs trước" >&2; exit 1; fi; \
      ACTUAL="$(sha256sum "$TARBALL" | awk '{print $1}')"; \
      if [ "$ACTUAL" != "${LIGHTCODE_SHA256}" ]; then echo "sha256 không khớp: kỳ vọng ${LIGHTCODE_SHA256}, thực tế $ACTUAL" >&2; exit 1; fi; \
      mkdir -p /opt/lightcode && tar -xzf "$TARBALL" -C /opt/lightcode; \
      cd /opt/lightcode && npm install --omit=dev --ignore-scripts && npm cache clean --force; \
      chown -R aivin-lc:aivin-lc /opt/lightcode; \
    fi

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
