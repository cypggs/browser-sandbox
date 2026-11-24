# Browser Sandbox

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

一套面向纯终端 Ubuntu Server 的**持久化、可视化、可由 AI 自动化控制且支持人类实时接管**的 Chromium Browser Sandbox 基础设施。

它不是简单启动一个无头浏览器，而是一个可长期运行的 **AI Browser Runtime**：AI Agent 与人类通过 **同一个实时运行中的有头 Chromium 实例**协同工作，支持持久化保存登录态（Cookies / LocalStorage / IndexedDB）、远程 noVNC 实时画面与键鼠接管、Playwright HTTP API、TypeScript SDK 以及原生 **MCP Server**（Streamable HTTP & Stdio）。

---

## 核心特性

- **真实有头 Chromium 运行环境**：`Xvfb (1920×1080)` + `Openbox` + 原生 Debian Chromium，支持多标签页、中文字体渲染、文件下载、网页截图与崩溃自动拉起。
- **单实例人机协同**：通过 `flock` 文件锁防止同 Profile 多开，AI（Playwright over CDP）与人类（noVNC）始终操作同一个 Chromium 实例，画面实时同步，人类可随时接管登录/验证。
- **登录状态长期持久化**：宿主机 bind mount 挂载固定 Chromium `User Data Dir`，重启 Chromium、重启或重建容器后 Cookies、LocalStorage、IndexedDB 与会话配置完整保留。
- **远程可视化与接管**：内置 `x11vnc` + `websockify` + `noVNC` + `autocutsel`（剪贴板同步），无需本地安装客户端，直接在 Chrome / Edge 中即可观看与操控。
- **AI 控制接口 + SDK + MCP**：
  - 完整 RESTful HTTP API（导航、点击、输入、键鼠、滚动、标签页、DOM/Accessibility Snapshot、iframe、弹窗策略、文件上传/下载、Console & 网络错误监控、失败自动截图）。
  - 内置 TypeScript HTTP/CDP SDK。
  - 原生 MCP Server，同时支持 Streamable HTTP（`/api/mcp`）与 Stdio（`dist/mcp-stdio.js`）。
- **纵深安全设计**：
  - `browser` 与 `agent` 容器均以非 root 用户（UID 1000）运行；Chromium 通过 `CAP_SYS_ADMIN` 启用完整沙箱，**不使用 `--no-sandbox`**。
  - CDP、noVNC、API 全部仅绑定宿主机 `127.0.0.1`，公网仅经由 Nginx HTTPS 反向代理暴露，**CDP 绝不暴露公网**。
  - noVNC 双重认证（HTTPS + Nginx HTTP Basic Auth + VNC 密码），API/MCP 使用常量时间比对的 Bearer Token。
  - 日志自动脱敏（剥离 Cookie / Authorization / Token / Password）。
  - 高风险操作保护（转账、支付、删除、发布、提交订单等动作默认返回 `409 CONFIRMATION_REQUIRED` 并附带截图，需人工确认后传 `confirmed: true`）。

---

## 架构总览

```text
Chrome / Edge (Windows / Mac)
        │  HTTPS + Basic Auth + WSS
        ▼
Host Nginx Reverse Proxy (:443)
   ├── / & /websockify ──► 127.0.0.1:6080  (browser 容器: noVNC + x11vnc + Xvfb + Openbox + Chromium)
   └── /api/           ──► 127.0.0.1:3800  (agent 容器: Playwright HTTP API + MCP Server)
                                  │
                                  └── Docker 内部桥接网络 sandbox-net (CDP) ──► browser 容器 Chromium 单实例
                                                                                      │
                                                                                      ▼
                                                                     ./data/{chrome-profile,downloads,screenshots}
```

---

## 目录结构

```text
browser-sandbox/
├── docker-compose.yml                  # 服务编排（browser + agent + sandbox-net）
├── Dockerfile                          # Browser 镜像（Chromium + Xvfb + Openbox + x11vnc + noVNC）
├── .env.example                        # 环境变量模板
├── LICENSE                             # MIT License
├── README.md
├── config/
│   ├── browser.json                    # Chromium 分辨率、路径与启动参数
│   ├── openbox/rc.xml                  # Openbox 自动最大化窗口配置
│   └── nginx/browser-sandbox.conf.example  # Nginx HTTPS 反向代理配置模板
├── browser/
│   ├── entrypoint.sh                   # Xvfb/Openbox/x11vnc/noVNC/CDP 桥接与优雅退出
│   ├── start-browser.sh                # flock 单实例锁 + Chromium 崩溃自恢复守护
│   └── healthcheck.sh                  # 容器健康检查
├── agent/
│   ├── Dockerfile                      # AI 控制层镜像（Node.js 22 + TypeScript + Playwright）
│   ├── package.json
│   ├── tsconfig.json
│   ├── examples/sdk-demo.mjs           # HTTP SDK 快速调用示例
│   └── src/
│       ├── browser.ts                  # 单实例 CDP 连接与事件/日志监听
│       ├── controller.ts               # 完整浏览器操作与高风险确认拦截
│       ├── screenshot.ts               # 页面/元素截图与失败自动截图
│       ├── security.ts                 # Bearer 认证、日志脱敏、路径防穿越、高风险检测
│       ├── mcp.ts                      # MCP Server 工具注册
│       ├── mcp-stdio.ts                # MCP Stdio 入口
│       ├── sdk.ts                      # TypeScript HTTP & CDP SDK
│       └── server.ts                   # Express HTTP API + Streamable HTTP MCP
├── data/                               # 持久化目录（请设置 chmod 700）
│   ├── chrome-profile/                 # Chromium User Data Directory
│   ├── downloads/                      # 下载目录
│   └── screenshots/                    # 截图与失败自动截图
└── logs/                               # 容器运行日志
```

---

## 快速部署

### 1. 克隆项目并初始化目录权限

```bash
git clone https://github.com/cypggs/browser-sandbox.git /opt/browser-sandbox
cd /opt/browser-sandbox

mkdir -p data/chrome-profile data/downloads data/screenshots logs/browser logs/agent
chmod 700 data data/chrome-profile data/downloads data/screenshots
```

### 2. 生成密钥配置（`.env`）

```bash
cp .env.example .env
# 生成强随机密码与 API Token（VNC 标准密码有效长度 8 位，建议外层叠加 Nginx Basic Auth）
sed -i "s|CHANGE_ME_VNC_PASS|$(openssl rand -base64 12 | tr -dc 'A-Za-z0-9' | head -c 8)|" .env
sed -i "s|CHANGE_ME_STRONG_RANDOM_API_TOKEN|$(openssl rand -hex 32)|" .env
chmod 600 .env
```

### 3. 构建并启动服务

```bash
docker compose up -d --build
docker compose ps
```

等待 `browser-sandbox-browser` 与 `browser-sandbox-agent` 状态均变为 `healthy`。

### 4. 配置 Nginx + HTTPS（推荐）

1. 生成 noVNC HTTP Basic Auth 密码文件：
   ```bash
   HASH=$(openssl passwd -6 'YOUR_STRONG_BASIC_PASSWORD')
   printf 'sandbox:%s\n' "$HASH" | sudo tee /etc/nginx/htpasswd-browser-sandbox >/dev/null
   sudo chmod 640 /etc/nginx/htpasswd-browser-sandbox
   sudo chown root:www-data /etc/nginx/htpasswd-browser-sandbox
   ```
2. 复制 [config/nginx/browser-sandbox.conf.example](config/nginx/browser-sandbox.conf.example) 为 `/etc/nginx/sites-available/browser-sandbox`，将 `browser.example.com` 替换为你的域名并启用站点：
   ```bash
   sudo cp config/nginx/browser-sandbox.conf.example /etc/nginx/sites-available/browser-sandbox
   sudo sed -i 's/browser.example.com/your-domain.com/g' /etc/nginx/sites-available/browser-sandbox
   sudo ln -sf /etc/nginx/sites-available/browser-sandbox /etc/nginx/sites-enabled/browser-sandbox
   sudo nginx -t && sudo systemctl reload nginx
   ```
3. 使用 Certbot 自动签发 Let's Encrypt HTTPS 证书：
   ```bash
   sudo certbot --nginx -d your-domain.com --redirect
   ```

完成后即可通过 `https://your-domain.com/` 访问 noVNC，通过 `https://your-domain.com/api` 调用 AI 控制接口。

---

## 日常运维命令

> 日常运维**切勿使用 `docker compose down -v`**。

```bash
docker compose up -d       # 启动
docker compose down        # 停止（保留持久化数据）
docker compose restart     # 重启
docker compose ps          # 查看状态
docker compose logs -f     # 实时查看日志
```

### Profile 备份与恢复

```bash
# 备份（先停止 browser 容器以保证 SQLite 一致性）
docker compose stop browser
tar -czf chrome-profile-backup-$(date +%F).tar.gz -C data chrome-profile
chmod 600 chrome-profile-backup-*.tar.gz
docker compose start browser

# 恢复
docker compose stop browser
rm -rf data/chrome-profile/*
tar -xzf chrome-profile-backup-YYYY-MM-DD.tar.gz -C data
chmod 700 data/chrome-profile
docker compose start browser
```

---

## AI 控制 HTTP API

除 `/health` 外，所有接口均需携带请求头：`Authorization: Bearer <API_TOKEN>`（或 `X-API-Key: <API_TOKEN>`）。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 服务与 CDP 连接状态 |
| `GET` | `/browser/status` | 浏览器版本、活动标签页与诊断统计 |
| `GET` | `/browser/tabs` | 列出所有打开的标签页 |
| `POST` | `/browser/tabs` | 新建标签页（`{ "url": "..." }`） |
| `POST` | `/browser/tabs/switch` | 切换并置顶标签页（`{ "index": 0 }`） |
| `DELETE` | `/browser/tabs/:index` | 关闭指定标签页 |
| `POST` | `/browser/navigate` | 跳转/前进/后退/刷新（`url`, `action`: `goto`/`back`/`forward`/`reload`） |
| `POST` | `/browser/click` | 点击元素或坐标（`selector` 或 `x`/`y`，支持 `frame`；高风险按钮需 `confirmed: true`） |
| `POST` | `/browser/type` | 输入文本（`selector`, `text`, `clear`, `pressEnter`, `delay`） |
| `POST` | `/browser/keyboard` | 键盘事件（`action`: `press`/`type`/`down`/`up`, `key`, `text`） |
| `POST` | `/browser/mouse` | 鼠标事件（`action`: `move`/`click`/`dblclick`/`down`/`up`/`wheel`） |
| `POST` | `/browser/scroll` | 滚动页面（`deltaX`/`deltaY`、`selector` 或 `position`: `top`/`bottom`） |
| `POST` | `/browser/screenshot` | 页面/元素截图（`fullPage`, `selector`, `format`, `name`, `returnBase64`） |
| `GET` | `/browser/page` | 获取标题、URL、正文、Accessibility Snapshot、DOM（支持 `accessibility`, `html`, `frame`） |
| `POST` | `/browser/evaluate` | 在页面或 iframe 中执行 JavaScript |
| `POST` | `/browser/wait` | 等待元素状态、页面加载状态或毫秒延迟 |
| `POST` | `/browser/upload` | 向文件输入框上传 `/data/downloads` 中的文件 |
| `GET` | `/browser/downloads` | 列出下载目录文件及下载事件 |
| `GET` | `/browser/logs` | 获取脱敏后的 Console、PageError、网络错误与弹窗记录 |
| `POST` | `/browser/dialog` | 配置弹窗处理策略（`mode`: `manual` / `accept` / `dismiss`, `promptText`） |
| `POST` | `/browser/action` | 统一单步或多步动作编排入口 |
| `POST` | `/mcp` | Streamable HTTP MCP Server 入口 |

---

## MCP Server 接入

支持任何兼容 MCP 的 AI Agent 客户端通过 **Streamable HTTP** 远程接入：

```json
{
  "mcpServers": {
    "browser-sandbox": {
      "url": "https://your-domain.com/api/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_TOKEN"
      }
    }
  }
}
```

亦可通过本机 **Stdio** 模式运行：

```bash
CDP_URL=http://127.0.0.1:9222 node agent/dist/mcp-stdio.js
```

---

## License

本项目基于 [MIT License](LICENSE) 开源。
