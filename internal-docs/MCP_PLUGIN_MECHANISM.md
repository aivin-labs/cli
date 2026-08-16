# Cơ chế MCP → Plugin: CLI, backend, và cách chúng khớp với nhau

> Tài liệu nội bộ — KHÔNG nằm trong `docs/` nên không bị đóng gói khi `npm publish` (xem
> `package.json`'s `files: ["bin/**/*", "docs/**/*", "README.md"]`). File này tham chiếu trực tiếp
> tới code/đường dẫn của repo backend (`aivin-service`/BE), không phải thứ nên lộ ra ngoài cùng gói
> CLI công khai.
>
> Đối tượng đọc: engineer làm việc trên CLI hoặc BE cần hiểu toàn bộ luồng MCP → plugin, không phải
> người dùng cuối (người dùng cuối đọc [`docs/CLI.md`](../docs/CLI.md)).

## 1. Tổng quan — MCP proxy plugin là gì

Một "MCP proxy plugin" là 1 plugin **không có code** (`proxy_config.type === 'mcp'`) — không
`src/main.ts`, không container riêng. Khi được gọi, host (backend) tự kết nối thẳng tới 1 MCP
server bên ngoài (qua `stdio` — spawn 1 process, hoặc `sse` — HTTP tới URL) và forward lời gọi
tới đúng tool/resource/prompt đã khai trong manifest.

CLI có 2 cách tạo loại plugin này:

| Lệnh | Cách hoạt động | Khi nào dùng |
|---|---|---|
| `aivin mcp create <name>` | Khai tay 1 tool/resource/prompt, build manifest **hoàn toàn ở phía CLI**, không gọi BE cho tới bước deploy | Biết chính xác 1 tool cụ thể cần bọc |
| `aivin mcp <url>` | Scan **toàn bộ** 1 MCP server (repo GitHub/npm/Smithery hoặc URL sống), BE tự sinh N manifest tương ứng N tool/resource/prompt tìm được | Muốn bọc nguyên cả server, không biết trước có bao nhiêu tool |

Code CLI: [`bin/lib/mcpProxy.mjs`](../bin/lib/mcpProxy.mjs) (toàn bộ 2 lệnh trên nằm ở đây).

## 2. Schema — `McpProxyConfig`

Định nghĩa gốc phía BE: `src/plugins/dto/proxy/McpProxyConfig.ts`. CLI's `buildMcpManifest()`
build đúng field-for-field theo interface này.

```ts
interface McpProxyConfig extends BaseProxyConfig {
    type: 'mcp';
    mcp_transport?: 'stdio' | 'sse';
    mcp_server_id?: string;          // id nhóm — nhiều tool cùng 1 server chia sẻ giá trị này
    mcp_command?: string;            // stdio: lệnh spawn (vd "npx")
    mcp_args?: string[];             // stdio: tham số cho lệnh trên
    mcp_url?: string;                // sse: URL server sống
    mcp_auth_env_key?: string;       // sse: tên key trong env đã resolve, dùng làm Bearer header
    mcp_kind?: 'tool' | 'resource' | 'prompt';
    mcp_tool_name?: string;          // kind=tool
    mcp_resource_uri?: string;       // kind=resource
    mcp_resource_mime_type?: string; // kind=resource
    mcp_prompt_name?: string;        // kind=prompt
    mcp_env?: Record<string, string>; // ⚠ XEM MỤC 6 — field chết, đừng dùng
    auth_type?: string;              // vd 'bearer'
    auth_secret_key?: string;        // reference tới Redis (KHÔNG phải giá trị thật)
}
```

Ngoài `proxy_config`, manifest còn 3 field **cấp cao nhất** (không nằm trong `proxy_config`) liên
quan trực tiếp tới auth/multi-tenant — xem Mục 5:

- `initable?: string[]` — danh sách tên biến bắt buộc phải cấu hình trước khi plugin chạy được.
- `initial?: Record<string, { source, connection_id?, scopes?, ... }>` — schema chi tiết cho từng
  biến trong `initable`.
- `connection_id?: string` — connector gắn với plugin, **chỉ dùng cho hiển thị/readiness**, không
  phải nơi BE lấy giá trị thật lúc chạy (xem Mục 5.3 — đây là chỗ CLI từng làm sai).

## 3. Luồng `aivin mcp create <name>` (khai tay)

Hàm: `createMcpProxyPlugin()` trong `mcpProxy.mjs`.

```
1. Validate tên (chỉ chữ thường/số/gạch ngang)
2. Suy luận transport/kind từ flag đã truyền (--command → stdio, --url → sse, v.v.)
3. Nếu chạy trong terminal thật (TTY): hỏi tương tác PHẦN CÒN THIẾU
   (không hỏi lại phần đã truyền qua flag)
4. Khai auth (chỉ hỏi nếu chưa có --auth-secret-key):
     a. Không cần auth
     b. 1 token dùng chung cho cả org (→ proxy_config.auth_secret_key)
     c. Khai từng biến môi trường riêng (vòng lặp: tên biến → nguồn)
        - "workspace tự điền sau" → chỉ thêm vào initable
        - "gắn 1 connector" → initable + initial[tên].connection_id
5. Validate (validatePluginConfig + validateMcpProxyConfig)
6. Ghi manifest.json vào thư mục mới (KHÔNG gọi BE ở bước này)
7. In hướng dẫn: cd → aivin login → aivin test (KHÔNG auto-verify proxy trừ --verify-proxy)
   → aivin deploy
```

Điểm quan trọng: **toàn bộ manifest được build tại CLI, offline** — không có bước nào gọi BE để
"phân tích thông minh" tên biến môi trường (khác hẳn luồng `mcp <url>` ở Mục 4). Nghĩa là nếu dev
khai `--initable`-kiểu biến qua vòng lặp tương tác, CLI không tự biết `GITHUB_TOKEN` nên map vào
connector `github` — dev phải tự chọn connector đúng bằng tay.

## 4. Luồng `aivin mcp <url>` (scan tự động)

Hàm: `scanAndPublishMcp()`.

```
1. Cảnh báo trust ("chỉ scan MCP server bạn tin tưởng")
2. POST /plugins/scan-mcp {url}   [timeout 60s]
   - URL sống → handshake thật qua giao thức MCP (initialize, tools/list, ...)
   - Repo/npm chưa chạy → rất có thể BE phải tải + chạy thử (vd `npx -y <package>`) để lấy
     schema thật, tương tự cách MCP Inspector hoạt động — "cài đặt" xảy ra ở BƯỚC NÀY,
     TRƯỚC khi có manifest nào tồn tại
3. FYI check trùng lặp — search text theo chính URL đó (không đảm bảo, chỉ để tham khảo)
4. Checkbox chọn tool/resource/prompt (mặc định CHECK HẾT)
5. POST /plugins/build-mcp-manifests {scanned}   [timeout 30s]
   - BE dùng AI/heuristic đọc README để tự suy luận initable/initial cho từng biến môi
     trường phát hiện được (xem McpAwesomeListHelper — resolveConnectionId/resolveParamType/
     resolveFieldSource, và McpProvisioningService.mcpToolsToManifests) — ĐÂY LÀ CHỖ luồng
     `mcp <url>` có auth thông minh hơn `mcp create`
6. (optional) Sửa tên/mô tả từng manifest
7. (optional) Gắn 1 connector cho TẤT CẢ manifest cùng lúc (1 prompt, áp dụng hàng loạt)
8. XÁC NHẬN — "Deploy N plugin(s)? Không thể undo qua CLI" (default: No, skip nếu không phải TTY)
9. POST /plugins/deploy {manifest: [...]}   [timeout 60s] — org-scoped, ĐIỂM KHÔNG THỂ QUAY LẠI
10. (chỉ khi --publish) với MỖI manifest:
      - Nếu proxy_config.auth_secret_key tồn tại → CHẶN, không submit (xem Mục 6.2)
      - Ngược lại: POST /plugins/store/submit {pluginId}   [timeout 30s]
11. In hướng dẫn test (`plugin trigger --id <id> -a "..."`) + hỏi test ngay tại chỗ
```

## 5. Runtime — điều gì xảy ra khi plugin proxy được `trigger`

`aivin plugin trigger` → `POST /plugins/execute` → BE's `PluginProxyService.callMcpServer()`
(`src/plugins/service/PluginProxyService.ts`).

### 5.1. Merge credential theo 3 tầng (hàm `resolveMcpEnv`)

```
Tầng 1 — Admin-level (buildBaseMcpEnv):
  Nếu proxy_config.auth_secret_key tồn tại → PluginSecretStore.loadSecret(key)
  (đọc từ Redis, đã mã hoá — manifest chỉ giữ REFERENCE, không giữ giá trị thật)
  → dùng chung cho MỌI user trong org sở hữu plugin này

Tầng 2 — Workspace-level (applyWorkspaceInitableEnv):
  Với mỗi tên trong manifest.initable:
    đọc ctx.workspace.plugins[].arguments (giá trị workspace ĐANG GỌI tự cấu hình)
    → GHI ĐÈ giá trị tầng 1 nếu có

Tầng 3 — OAuth auto-fill (applyOAuthAutoFillEnv):
  Với mỗi field trong manifest.initial có connection_id:
    NẾU field đó CHƯA được set ở tầng 1/2 → CredentialBrokerService.resolveForWorkspace(
      workspace đang gọi, connection_id, client, scopes)
    → chỉ điền vào chỗ còn trống, không đè giá trị tầng 1/2 đã có
```

Quan trọng: cả tầng 2 và tầng 3 đều resolve theo **workspace/org đang gọi**
(`ctx.context.workspace`), KHÔNG phải theo document plugin — nên dù nhiều org cùng gọi chung 1
plugin (trường hợp publish/marketplace), 2 tầng này vẫn tách đúng theo từng tenant. Đã verify trực
tiếp trong `resolveWorkspacePluginArgs()` và `applyOAuthAutoFillEnv()`.

**Tầng 1 thì KHÔNG** — `auth_secret_key` nằm ngay trên manifest document dùng chung, không có cơ
chế nào tách theo org gọi. Xem Mục 6.2.

### 5.2. Áp dụng theo transport

- `sse`: kết quả env được convert thành HTTP header (`buildRemoteAuthHeaders`, dùng
  `mcp_auth_env_key` để biết lấy key nào làm Bearer token).
- `stdio`: kết quả env được đưa thẳng vào `env` của subprocess khi spawn MCP server.

### 5.3. `connection_id` cấp cao nhất — chỉ là badge, KHÔNG phải nơi resolve

`applyOAuthAutoFillEnv` chỉ đọc `manifest.initial[field].connection_id` — **không bao giờ** đọc
`manifest.connection_id` (cấp cao nhất) để lấy credential. Field cấp cao nhất chỉ dùng cho:

- Badge "requires logging in to a connector" (CLI: `formatPluginDetail` trong `pluginTrigger.mjs`).
- 1 nhánh fallback trong `PluginReadinessHelper.checkPluginReadiness` để check "còn thiếu cấu hình
  không" trước khi cho phép trigger.

→ CLI's `--connector <id>` flag (thêm ở phiên trước) chỉ set field này — **không tự động tiêm gì
vào MCP server đang chạy**. Đã sửa lại: CLI giờ set `connection_id` cấp cao **suy ra từ** field nào
trong `initial` thực sự dùng connector (không set độc lập), để badge luôn khớp với auth thật.

## 6. 2 vấn đề đã phát hiện khi đối chiếu CLI với BE thật

### 6.1. `mcp_env: Record<string,string>` — field chết

Khai trong DTO, bị **redact khỏi mọi response trả client** (`PluginSecretStore.sanitizeForClient`)
— ngụ ý được thiết kế để giữ thứ nhạy cảm — nhưng **không có bất kỳ chỗ nào trong
`PluginProxyService` đọc `config.mcp_env`** để inject vào subprocess. Đừng dùng field này. Cơ chế
thật đang chạy production là `initable`/`initial` (Mục 5.1). Cần trao đổi với team BE: hoàn thiện
tiếp hay xoá hẳn (khuyến nghị: xoá — nếu hoàn thiện theo đúng tên field, tức lưu giá trị trực tiếp,
sẽ phá vỡ nguyên tắc "manifest không bao giờ giữ giá trị secret thật" mà mọi cơ chế khác đang theo).

### 6.2. `auth_secret_key` + `--publish` = rò rỉ credential chéo org

`auth_secret_key` được thiết kế "dùng chung cho tất cả user" — nhưng comment gốc chỉ nói tới user
**trong org sở hữu**, không tính tới việc publish. Grep toàn bộ `PluginStoreService.ts`: **không có
bước nào strip/reissue `auth_secret_key` khi plugin được publish lên marketplace**. Nếu org khác
gọi được plugin đã publish (cùng document), request của họ sẽ vô tình resolve đúng secret của org
publish gốc — tốn quota/tiền của org gốc, hoặc lộ credential.

**Đã chặn ở CLI** (`scanAndPublishMcp`, nhánh `--publish`): manifest nào còn
`proxy_config.auth_secret_key` sẽ **không được submit**, in rõ lý do + gợi ý chuyển sang
connector-bound env var (Mục 5.1 tầng 3 — đã xác nhận an toàn multi-tenant). Cũng cảnh báo ngay lúc
`mcp create` chọn "1 token dùng chung", trước khi kịp publish.

**Giới hạn của gate này**: chỉ chặn được đường publish mà CLI kiểm soát (`mcp <url> --publish`).
Nếu có đường publish khác (FE web app) cho plugin tạo bằng `mcp create` + `aivin deploy` riêng, CLI
không với tới được — **cần BE tự gate ở tầng `/plugins/store/submit`** mới an toàn triệt để, CLI chỉ
là lớp phòng vệ bổ sung.

## 7. Danh sách các gate an toàn hiện có trong CLI (tham chiếu nhanh)

| Gate | File | Mục đích |
|---|---|---|
| Timeout mọi call scan/build/deploy/submit | `mcpProxy.mjs` (`MCP_*_TIMEOUT_MS`) | Tránh treo vô hạn khi BE/server ngoài không phản hồi |
| Cảnh báo trust trước khi scan | `mcpProxy.mjs` | Scan = kết nối/chạy thử code ngoài, không phải hành động vô hại |
| Check trùng lặp CHÍNH XÁC theo `mcp_server_id` (`scanned.repo_id`) | `mcpProxy.mjs` | Tránh convert lại cùng 1 server — không còn là text search mơ hồ, dùng đúng id BE dùng để nhóm manifest |
| Confirm bắt buộc trước deploy | `mcpProxy.mjs` | Deploy org-wide, checkbox mặc định check hết |
| `aivin plugin delete [id] [--group <groupId>]` | `pluginTrigger.mjs` | Đường lùi — xoá 1 plugin hoặc cả lô theo `group_id` (endpoint BE vốn đã có sẵn, comment gốc ghi rõ "để CLI dùng group_id... rollback cả lô" nhưng chưa được nối) |
| Chặn publish nếu còn `auth_secret_key` | `mcpProxy.mjs` | Mục 6.2 |
| Cảnh báo sớm khi chọn "1 token dùng chung" | `mcpProxy.mjs` (`createMcpProxyPlugin`) | Báo trước, không đợi tới lúc bị chặn ở publish |
| `--verify-proxy` opt-in + tự skip entry `request_hil` | `deploy.mjs` | Auto-test proxy = gọi thật ra ngoài; vẫn tôn trọng cờ destructive do chính MCP server tự khai (annotations) dù đã bật flag |
| Gợi ý tên connector từ tên biến môi trường | `mcpProxy.mjs` (`guessConnectorQueryFromEnvVarName`) | Điền sẵn ô search (có thể sửa/xoá), không tự quyết định — không port logic phân loại thật của BE để tránh lệch dần |

## 8. Giới hạn còn tồn đọng (chưa có gate/tính năng)

- `--verify-proxy` với entry KHÔNG bị flag `request_hil` vẫn gửi `arguments: {}` mù — nếu MCP server
  không tự khai `destructiveHint` (annotation optional theo spec, server có thể khai thiếu), CLI
  không có cách nào khác để biết tool có an toàn gọi lặp lại hay không. Người dùng vẫn phải tự đánh
  giá trước khi bật flag cho 1 server không tin tưởng.
- Gợi ý tên connector (`guessConnectorQueryFromEnvVarName`) chỉ là heuristic strip-suffix đơn giản,
  không phải bản port đầy đủ logic phân loại của `McpAwesomeListHelper` phía BE — có thể đoán sai
  với tên biến khác thường, nhưng vô hại vì chỉ là gợi ý điền sẵn ô search.
- Gate chặn publish (Mục 6.2) chỉ chặn được đường CLI kiểm soát — nếu FE có đường publish riêng cho
  plugin `mcp create` + `aivin deploy`, CLI không với tới được.

## 9. Tham chiếu chéo

- Tài liệu lệnh công khai (English, phần này SẼ đóng gói theo npm publish): [`docs/CLI.md`](../docs/CLI.md) — mục `aivin mcp <url>`, `aivin mcp create`, `aivin test`.
- Code CLI: `bin/lib/mcpProxy.mjs`, `bin/lib/deploy.mjs`, `bin/lib/pluginTrigger.mjs`.
- Code BE liên quan (đường dẫn tương đối tới repo `be`):
  `src/plugins/dto/proxy/McpProxyConfig.ts`,
  `src/plugins/service/PluginProxyService.ts`,
  `src/plugins/service/McpProvisioningService.ts`,
  `src/plugins/helper/McpAwesomeListHelper.ts`,
  `src/plugins/helper/PluginSecretStore.ts`,
  `src/plugins/helper/PluginReadinessHelper.ts`.
