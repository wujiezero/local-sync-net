# Local Sync Net (ClipMesh)

局域网实时剪贴板。同一房间里用浏览器打开页面即可同步文本、图片和附件，无需安装客户端。

适合家里、办公室、实验室多台设备互传片段：代码、配置、Markdown 笔记、截图、小文件。

## 功能

- 多终端打开同一页面，WebSocket 实时广播
- 文本 / 图片 / 附件在同一个发送框里发出，附件可附带说明
- 自动识别 Markdown、JSON、YAML，语法高亮，一键复制原文
- 消息带序号和完整时间戳，支持回复、二次编辑
- 标签在独立配置页增删改，时间线只选用，并支持按标签、时间区间筛选
- 归档房间代替清空：历史可回看、可重命名
- 归档可导出为 zip（时间线 Markdown、JSON、附件），也可把 zip 再导入
- 删除归档需 6 位验证码二次确认
- 数据写入 Docker volume，容器重启不丢

## 快速开始

```bash
git clone git@gitee.com:wujiezero/local-sync-net.git
cd local-sync-net
docker compose up -d --build
```

浏览器访问：

- 本机：http://127.0.0.1:8789
- 局域网其它设备：`http://<宿主机IP>:8789`

容器内监听 `8787`，默认映射到宿主机 `8789`。若要改端口，编辑 `docker-compose.yml` 的 `ports` 和 `PUBLIC_PORT`。

默认房间名为 `lan`。可用 `?room=office` 或页面左侧输入框切换房间。

## 页面

| 路径 | 说明 |
| --- | --- |
| `/` | 时间线：发送、回复、编辑、筛选 |
| `/settings` | 房间标签增删改 |
| `/#archives` | 查看 / 删除归档 |

## 配置

`docker-compose.yml` 环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 容器内端口 |
| `PUBLIC_PORT` | `8789` | 对外提示用的局域网端口 |
| `MAX_FILE_MB` | `32` | 单文件上限 |
| `MAX_CLIPS` | `200` | 每个房间活跃时间线保留条数 |
| `MAX_ARCHIVES` | `50` | 每个房间归档数量上限 |
| `MAX_IMPORT_MB` | `256` | 导入 zip 上限 |

数据卷：`clipmesh-data` → `/data`（消息、附件、归档、标签目录）。

## 本地开发（不走 Docker）

需要 Node.js 20+。

```bash
npm install
node server.js
```

默认监听 `http://0.0.0.0:8787`。

## 安全说明

这是局域网工具，默认没有账号体系。请不要把端口暴露到公网。删除归档会下发一次性 6 位验证码，两分钟内有效。

## 技术栈

- Node.js + Express + `ws`
- 原生前端（无构建步骤）
- Docker Compose
- marked / highlight.js / DOMPurify（本地 vendor，可离线使用）

## 开源协议

[MIT](./LICENSE)
