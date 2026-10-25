# 部署

oh-my-sage 的 MCP Server 有三种部署方式，工具和功能完全相同，区别只在于进程跑在哪里。

| 方式 | 进程位置 | 特点 |
|------|----------|------|
| **stdio（默认）** | 由 AI 助手按需启动 | 最简单，零额外进程；客户端重启后需重新登录（配置自动取码后可自动完成） |
| **本机常驻** | 本机后台服务，仅监听 `127.0.0.1` | 登录一次网关，多个客户端共享，重开客户端无需再输登录码 |
| **私有服务器** | NAS / 家庭服务器上的 Docker | 同上，多台电脑共用一个网关登录；需设置访问 token |

后两种走 Streamable HTTP（`/mcp`）：进程常驻，请求不经过 stdio 路径，因此并发工具调用较多时也不会刷 `MaxListenersExceededWarning`（该告警来自 MCP SDK stdio 客户端为每个并发请求在流上挂 `drain` 监听器，属于日志噪音，不影响工具执行结果）。无论用哪种方式，客户端都不需要额外处理这个告警。

改完部署方式后，客户端配置见下文 [客户端配置](#客户端配置)。

---

## 方式一：stdio

由客户端按需拉起进程，无需部署脚本。客户端配置见 [主 README](../README.md#mcp-方式一行命令安装)。

---

## 方式二：本机常驻

注册为当前用户登录时自动启动的后台服务，只监听回环地址，默认端口 `3790`。前提是已构建：

```bash
npm run build:mcp
```

### macOS / Linux

```bash
bash deploy/install-local.sh -g http://192.168.0.5
```

| 参数 | 说明 |
|------|------|
| `-g, --gateway` | 网关地址；不填则首次调用 `mijia_auth` 时需传 `gateway_url` |
| `-p, --port` | 监听端口，默认 `3790` |
| `-t, --token` | Bearer token，回环地址可不设 |
| `-n, --name` | 服务名，默认 `oh-my-sage-mcp` |
| `-u, --uninstall` | 卸载服务 |

- macOS 注册为 launchd LaunchAgent（`com.oh-my-sage.<name>`），日志在 `~/Library/Logs/<name>.log`
- Linux 注册为 systemd `--user` 服务（`Restart=on-failure`）；希望未登录时也运行，执行 `loginctl enable-linger $USER`

### Windows

```powershell
pwsh deploy/install-local.ps1 -GatewayUrl http://192.168.0.5
```

| 参数 | 说明 |
|------|------|
| `-GatewayUrl` | 网关地址，默认取 `$env:GATEWAY_URL` |
| `-Port` | 监听端口，默认 `3790` |
| `-Token` | Bearer token，回环地址可不设 |
| `-TaskName` | 计划任务名，默认 `oh-my-sage-mcp` |
| `-Uninstall` | 卸载任务 |

注册为当前用户登录时启动的计划任务，无窗口运行，无需管理员权限。进程退出后一分钟内自动拉起。需要 **Node.js 20.6+**（配置通过 `node --env-file` 读取 `%LOCALAPPDATA%\oh-my-sage\<TaskName>.env`）。

两个脚本装完都会请求 `GET /healthz` 验证，并打印可直接粘贴的客户端配置。

---

## 方式三：私有服务器（Docker）

```bash
cp deploy/.env.example deploy/.env   # 填入 GATEWAY_URL、MCP_AUTH_TOKEN、MCP_ALLOWED_HOSTS
cd deploy && docker compose up -d --build
```

`deploy/.env` 需要设置：

| 变量 | 说明 |
|------|------|
| `GATEWAY_URL` | 米家网关局域网地址 |
| `MCP_AUTH_TOKEN` | 客户端携带的 Bearer token，`openssl rand -hex 32` 生成；**未设置会拒绝启动** |
| `MCP_ALLOWED_HOSTS` | 客户端访问服务器时用的主机名或 IP，逗号分隔；缺失会导致 Host 校验返回 403 |
| `MCP_PORT` | 宿主机映射端口，默认 `3790` |
| `MIJIA_*` | 可选；扫码登录态或自动取码凭据，见 [扫码登录与自动取码](#扫码登录与自动取码推荐) |

镜像为多阶段构建，运行阶段只装 MCP 实际引用的依赖（约 14 MB，不含 Next.js / antd 等 Web 端依赖）。`deploy/mcp-runtime-package.mjs` 扫描编译产物生成这份最小依赖清单。

网络要求：容器需能访问局域网内的米家网关（WebSocket）、公网 `miot-spec.org`（校验设备能力时拉取 MIOT Spec），以及自动取码用到的小米官方接口（见下文）。普通端口映射即可，无需 `network_mode: host`。

---

## 扫码登录与自动取码（推荐）

米家极客版的登录码是一次性的。推荐在 Web 登录页用米家 App 扫码登录小米账号：

1. 打开 Web 界面，点击“扫码登录小米账号”；
2. 用米家 App 扫描二维码；
3. 登录态保存到 `.sessionstore/mijia-auth.json`，随后自动换取 `serviceToken` 并取码连接网关。

之后打开页面会优先使用这份登录态自动取码，**不需要每次扫码**；只有登录态失效（或手动清除）时才需要重新扫码。

扫码成功后，服务端会：

1. 用保存的 `passToken` 向 `account.xiaomi.com` 换取 `serviceToken`；
2. 调用小米云 `miIO.get_central_link_passcode` 获取 6 位登录码；
3. 用该登录码连接网关。

取码目标是当前签发登录码的中枢/路由器设备。默认按 `GATEWAY_URL` 的主机名与云端设备列表的 `localip` 匹配；匹配不到时可在 `MIJIA_ROUTER_DID` 中直接指定设备 DID。

> 扫码登录与自动取码依赖小米账号接口，接口调整时可能失效；失败时仍可改用手动登录码。

### 登录态存储

| 项 | 说明 |
|------|------|
| `MIJIA_AUTH_FILE` | 登录态文件路径，默认当前工作目录下的 `.sessionstore/mijia-auth.json` |
| 文件内容 | `userId`、`passToken`、`cUserId`、`deviceId`，不保存 `serviceToken` / `ssecurity` |
| 权限 | 尽量以 `0600` 写入；Windows 由文件系统 ACL 控制 |
| 优先级 | 本机扫码登录态 > 环境变量 |

- MCP 与 Web 使用同一工作目录时会自动共用这份登录态，`mijia_auth` 可省略 `passcode`。
- 清除已保存登录态：调用 `DELETE /api/auth`，或直接删除该文件。
- 文件等同于账号登录态，不要提交到仓库或发给他人。
- Web 端需要是长期运行的 Node 进程（二维码长轮询最长约 5 分钟）；Serverless 平台可能在轮询期间终止函数。

### 手动配置（备用）

不使用 Web 扫码（例如 Docker 私有服务器）时，可以手动配置凭据：

| 变量 | 必填 | 说明 |
|------|------|------|
| `MIJIA_USER_ID` | 是 | 小米账号 userId |
| `MIJIA_PASS_TOKEN` | 是 | 浏览器登录 `account.xiaomi.com` 后的 passToken |
| `MIJIA_COOKIE` | 否 | 整段 Cookie，可替代上面两项；单项环境变量优先 |
| `MIJIA_C_USER_ID` | 否 | Cookie 中的 cUserId |
| `MIJIA_DEVICE_ID` | 否 | Cookie 中的 deviceId |
| `MIJIA_ROUTER_DID` | 否 | 签发登录码的设备 DID；留空时自动匹配 |
| `MIJIA_AUTH_FILE` | 否 | 扫码登录态文件路径，默认 `.sessionstore/mijia-auth.json` |

**获取凭据**：

1. 在浏览器登录 https://account.xiaomi.com 。
2. 打开开发者工具 → Application / 存储 → Cookies → `account.xiaomi.com`。
3. 复制 `userId`、`passToken`（建议连同 `cUserId`、`deviceId` 一起复制）。也可以在网络面板找一条发往 `account.xiaomi.com` 的请求，把完整 `Cookie` 请求头粘贴到 `MIJIA_COOKIE`。

> `passToken` 等同于账号登录态。只写入本机 `.env`、服务环境变量或私有部署配置，不要提交到仓库，也不要发到聊天或第三方服务。

### 各部署方式

**stdio**：如果 Web 与 MCP 都在同一个仓库目录运行，扫码后 MCP 会自动读取 `.sessionstore/mijia-auth.json`，无需把凭据写进 MCP 配置。需要手动配置时，加在客户端 MCP 配置的 `env` 里：

```json
{
  "mcpServers": {
    "oh-my-sage": {
      "command": "oh-my-sage-mcp",
      "env": {
        "GATEWAY_URL": "http://192.168.0.5",
        "MIJIA_USER_ID": "1234567890",
        "MIJIA_PASS_TOKEN": "<passToken>"
      }
    }
  }
}
```

**本机常驻**：服务工作目录默认是仓库根目录，会直接读取 Web 扫码生成的 `.sessionstore/mijia-auth.json`。如果 Web 与服务的目录不同，设置 `MIJIA_AUTH_FILE` 指向同一文件。手动配置环境变量后重启服务：

- macOS：编辑 `~/Library/LaunchAgents/com.oh-my-sage.oh-my-sage-mcp.plist` 的 `EnvironmentVariables`，然后重新加载：

  ```bash
  launchctl bootout gui/$(id -u)/com.oh-my-sage.oh-my-sage-mcp
  launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.oh-my-sage.oh-my-sage-mcp.plist"
  ```

- Linux：`systemctl --user edit oh-my-sage-mcp`，在 `[Service]` 下加 `Environment="MIJIA_PASS_TOKEN=..."`，再 `systemctl --user restart oh-my-sage-mcp`。
- Windows：编辑 `%LOCALAPPDATA%\oh-my-sage\oh-my-sage-mcp.env`（每行 `KEY=VALUE`），然后重启计划任务：

  ```powershell
  Stop-ScheduledTask -TaskName oh-my-sage-mcp
  Start-ScheduledTask -TaskName oh-my-sage-mcp
  ```

**Docker**：容器内没有 Web 登录页。推荐在 `deploy/.env` 中直接配置 `MIJIA_USER_ID` + `MIJIA_PASS_TOKEN`；也可以在宿主机用 Web 扫码生成 `.sessionstore/mijia-auth.json`，复制到 `deploy/` 后挂载并设置 `MIJIA_AUTH_FILE`：

```yaml
services:
  oh-my-sage-mcp:
    environment:
      MIJIA_AUTH_FILE: /data/mijia-auth.json
    volumes:
      - ./mijia-auth.json:/data/mijia-auth.json:ro
```

挂载时注意容器内 `node` 用户需要有读取权限；权限不方便处理时优先用环境变量。

### 网络与排障

扫码登录需要能访问 `account.xiaomi.com`、`ak.account.xiaomi.com`、`ak.lp.account.xiaomi.com`、`sts.api.mijia.tech`。自动取码还需要 `sts.api.io.mi.com`、`core.api.mijia.tech`、`api.io.mi.com`。如果容器或服务器只允许白名单出站，请放行这些域名。设置了 `MIJIA_ROUTER_DID` 时会跳过设备列表，`api.io.mi.com` 仅用于自动匹配设备。

- `获取二维码失败` / 二维码图片打不开：检查到 `account.xiaomi.com` 的网络、代理或防火墙。
- `二维码已过期`：点击“刷新二维码”；每张二维码约 5 分钟有效。
- `小米账号登录态无效或已过期` / `需要安全验证`：在 Web 登录页重新扫码；或更新 `MIJIA_PASS_TOKEN`，也可以临时改用手动登录码。
- `无法从云端设备列表确定签发登录码的设备`：确认 `GATEWAY_URL` 与网关的局域网 IP 一致，或设置 `MIJIA_ROUTER_DID`。
- `获取云端设备列表失败`：通常是 `xiaomiio` 服务登录态问题；确认凭据完整，或直接设置 `MIJIA_ROUTER_DID` 跳过设备列表。

---

## 客户端配置

### stdio（`mcpServers` 通用格式）

多数客户端（Claude Desktop、Cursor、Cline 等）使用 `mcpServers`：

```json
{
  "mcpServers": {
    "oh-my-sage": {
      "command": "oh-my-sage-mcp",
      "env": { "GATEWAY_URL": "http://192.168.0.5" }
    }
  }
}
```

部分客户端把 server 放在自己的键下，字段名也略有不同。以 OpenCode 为例，同样一个 stdio server 写成：

```json
{
  "mcp": {
    "oh-my-sage": {
      "type": "local",
      "command": ["oh-my-sage-mcp"],
      "environment": { "GATEWAY_URL": "http://192.168.0.5" }
    }
  }
}
```

区别只在配置文件位置、外层键名和数组/字符串写法，`command` 与 `GATEWAY_URL` 的取值不变。其他客户端按各自文档对应填写。

### HTTP（Streamable HTTP 客户端）

把地址换成实际部署地址，端口默认 `3790`：

```json
{
  "mcpServers": {
    "oh-my-sage": {
      "url": "http://127.0.0.1:3790/mcp",
      "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

若客户端的 HTTP 配置字段名不同（如 `serverUrl`、`transport` 等），按该客户端文档对应填写；需要鉴权时把 token 放进 `headers`，未设置 token 时去掉 `headers`。

部署在私有服务器时把地址换成服务器的主机名或 IP（并列入 `MCP_ALLOWED_HOSTS`）。

---

## 手动启动 HTTP 模式

不借助安装脚本也可以直接前台运行：

```bash
oh-my-sage-mcp --http            # 或 MCP_TRANSPORT=http oh-my-sage-mcp
```

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MCP_TRANSPORT` | `stdio` | 设为 `http` 等同于传 `--http` |
| `MCP_HTTP_HOST` | `127.0.0.1` | 监听地址；非回环地址必须配 `MCP_AUTH_TOKEN`，否则拒绝启动 |
| `MCP_HTTP_PORT` | `3790` | 监听端口 |
| `MCP_AUTH_TOKEN` | 无 | Bearer token |
| `MCP_ALLOWED_HOSTS` | 回环地址及非通配的监听地址 | 额外允许的 Host 主机名，逗号分隔（防 DNS rebinding；回环地址始终允许） |
| `MCP_SESSION_TTL_MINUTES` | `30` | 空闲会话回收时间；没有进行中请求且超过该时长才会回收 |

监听 `0.0.0.0` 但未设置 `MCP_ALLOWED_HOSTS` 时，只接受 Host 为回环地址的请求，启动日志会给出提示。

---

## 排障

**`GET /healthz`**

```bash
curl -s http://127.0.0.1:3790/healthz
# {"ok":true,"connected":false}
```

无需认证，`connected` 反映网关连接的实时状态。

**403 Host 不在允许列表中**

客户端用的主机名/IP 没进 `MCP_ALLOWED_HOSTS`。校验比较的是 Host 头里的主机名（不含端口），与端口映射无关。

**401 未授权**

缺少或错误的 `Authorization: Bearer <token>`；token 与服务端 `MCP_AUTH_TOKEN` 不一致。

**服务未启动**

安装脚本会打印日志位置。macOS：`~/Library/Logs/oh-my-sage-mcp.log`；Linux：`journalctl --user -u oh-my-sage-mcp`；Windows：查看计划任务「oh-my-sage-mcp」的运行结果。

**端口被占用**

换 `-p` / `-Port` / `MCP_PORT`，或先停掉占用 `3790` 的进程。

**登录码相关**

登录码是一次性的，认证一次（无论成败）即作废。HTTP 模式下网关只登录一次，已有会话登录过后，新客户端直接调用工具即可，无需再次 `mijia_auth`。配置了小米账号凭据时，`mijia_auth` 会自动获取新登录码；未配置或自动取码失败时，仍需手动获取。
