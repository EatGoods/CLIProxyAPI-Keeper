# CLIProxyAPI-Keeper

基于 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 的社区增强版本，将 [CPA Usage Keeper](https://github.com/Willxup/cpa-usage-keeper) 直接集成到 CPA 进程和管理后台中。

它保留 CLIProxyAPI 的代理、OAuth、多账号和模型路由能力，同时增加 SQLite 用量持久化、费用统计、凭证限额查看、API Key 独立用量视图、AI 提供商配置入口和备注管理。Keeper 与 CPA 共用端口、生命周期和管理密钥，不需要单独部署或再次登录。

> 本项目是社区派生版本，不是 CLIProxyAPI 或 CPA Usage Keeper 的官方发行版。

## 功能

- 支持 OpenAI、Codex、Claude、Gemini、Grok 等 CLIProxyAPI 已有协议和认证方式
- 在 `management.html#/usage` 中直接查看请求量、Token、费用、缓存、成功率和延迟
- 用 SQLite 持久保存用量，重启后数据不会丢失
- 按模型、API Key、Auth File 和 AI Provider 分析用量
- 查看 Auth File 与 AI Provider 的健康状态和上游限额
- 为单个 CPA API Key 提供独立的只读用量页面
- 在 AI 提供商列表中快速打开配置，并保存管理备注
- Keeper 直接接收 CPA 内部用量事件，不依赖第二个服务或轮询进程

## Docker Compose 部署（推荐）

### 1. 获取项目

```bash
git clone https://github.com/EatGoods/CLIProxyAPI-Keeper.git
cd CLIProxyAPI-Keeper
cp config.example.yaml config.yaml
mkdir -p auths logs plugins usage-keeper
```

### 2. 修改配置

至少修改 `config.yaml` 中的管理密钥、客户端 API Key，并启用 Keeper：

```yaml
host: ""
port: 8317

remote-management:
  allow-remote: true
  secret-key: "change-this-management-key"

api-keys:
  - "change-this-client-api-key"

usage-keeper:
  enabled: true
  base-path: "/usage"
  data-dir: "./usage-keeper"
```

`secret-key` 用于登录管理后台；`api-keys` 用于调用 `/v1/*` API。请为两者设置不同的强随机值。

Docker 端口映射下，宿主机请求通常也会被容器识别为远程请求，因此示例启用了 `allow-remote`。请同时使用 HTTPS、强管理密钥和防火墙访问控制；不需要远程管理时，应只把 `8317` 映射到宿主机回环地址。

### 3. 构建并启动

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f cli-proxy-api
```

默认访问地址：

- API：`http://127.0.0.1:8317/v1`
- 管理后台：`http://127.0.0.1:8317/management.html`
- 用量统计：登录管理后台后进入“用量统计”，地址为 `management.html#/usage`

停止服务：

```bash
docker compose down
```

`docker compose down` 不会删除挂载在宿主机上的配置、认证文件和用量数据库。不要执行 `docker compose down -v`，除非确定要删除相关数据卷。

## Docker 数据目录

Compose 默认挂载以下路径：

| 宿主机路径 | 容器路径 | 用途 |
| --- | --- | --- |
| `./config.yaml` | `/CLIProxyAPI/config.yaml` | CPA 配置 |
| `./auths` | `/root/.cli-proxy-api` | OAuth 和认证文件 |
| `./logs` | `/CLIProxyAPI/logs` | 运行日志 |
| `./plugins` | `/CLIProxyAPI/plugins` | CPA 插件 |
| `./usage-keeper` | `/CLIProxyAPI/usage-keeper` | Keeper SQLite 数据与备份 |

生产部署时必须持久化 `config.yaml`、`auths` 和 `usage-keeper`。

## OAuth 登录

容器启动后，可以在管理后台添加账号，也可以使用命令行认证：

```bash
docker compose exec cli-proxy-api ./CLIProxyAPI -codex-login -no-browser
docker compose exec cli-proxy-api ./CLIProxyAPI -claude-login -no-browser
docker compose exec cli-proxy-api ./CLIProxyAPI -antigravity-login -no-browser
docker compose exec cli-proxy-api ./CLIProxyAPI -kimi-login -no-browser
docker compose exec cli-proxy-api ./CLIProxyAPI -xai-login -no-browser
```

按终端提示在浏览器中完成认证。Compose 已暴露项目使用的 OAuth 回调端口；服务器位于代理网络后时，可在 `config.yaml` 中设置 `proxy-url`。

## 本地编译运行

依赖：

- Go 1.26+
- Node.js 24+
- npm
- 支持 CGO 的 C 编译工具链（Keeper 使用 SQLite）

先构建 Keeper 前端，再编译统一的 CPA 可执行文件：

```bash
npm --prefix keeper/web ci
npm --prefix keeper/web run build
CGO_ENABLED=1 go build -o CLIProxyAPI ./cmd/server
cp config.example.yaml config.yaml
./CLIProxyAPI --config ./config.yaml
```

修改 `config.yaml` 后需要重启进程。首次打开管理后台时，CPA 会按配置获取管理面板资源。

## 调用示例

```bash
curl http://127.0.0.1:8317/v1/models \
  -H "Authorization: Bearer change-this-client-api-key"
```

客户端只需要将 OpenAI 兼容接口地址指向 `http://127.0.0.1:8317/v1`，并使用 `config.yaml` 中配置的 API Key。

## 更新项目

更新本仓库并重新构建：

```bash
git pull --ff-only
docker compose up -d --build
```

维护者同步 CLIProxyAPI 上游时，应保留两个远端：

```bash
git remote add upstream https://github.com/router-for-me/CLIProxyAPI.git
git fetch upstream --tags
git merge upstream/main
```

合并冲突时不要直接覆盖 `keeper/`、`internal/usagekeeper/`、管理后台注入逻辑和供应商备注逻辑；完成后运行测试并重新构建。

## 验证

```bash
go test ./...
npm --prefix keeper/web run test
npm --prefix keeper/web run typecheck
npm --prefix keeper/web run build
```

## 安全建议

- 不要提交 `config.yaml`、`.env`、`auths/`、`usage-keeper/` 或日志目录
- 不要公开管理密钥、客户端 API Key、OAuth Token 或代理地址
- 公网部署应使用 HTTPS，并限制管理接口的来源地址
- 定期备份 `config.yaml`、`auths/` 和 `usage-keeper/`
- 更新前先查看变更并完成测试，不要用上游文件直接覆盖本仓库

## 上游与许可

- [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
- [Willxup/cpa-usage-keeper](https://github.com/Willxup/cpa-usage-keeper)

项目沿用上游的 MIT License，详见 [LICENSE](LICENSE)；Keeper 子项目许可见 [keeper/LICENSE](keeper/LICENSE)。
