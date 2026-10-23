## 上游嵌入

- 上游：nihalashetty/Forge @ `25074df`（2026-10-06），许可证 **MIT**
- 上游原生平台：桌面 ✅（浏览器访问，无独立桌面壳）| 网页 ✅（Next.js 14 控制台 + FastAPI 引擎）| 移动 ❌（依据：`apps/web` 仅 Next.js web 目标，无移动构建）
- 工作方式：**原样嵌入（首选）** — 上游 Next 控制台自带同源反代，对外只需一个 origin
- 上游改动清单：**无**（`.agnx/` 为新增胶水；未改任何上游文件。运行期生成的 `apps/api/uv.lock` 已删除，保持上游干净）
- 挂载：`guest.auth=none` / 策略 `auto`（direct-iframe）
- 启动：`ensureTool=.agnx/tools/ensure-forge-web.mjs`，端口 **8106**，上游命令：
  - 引擎：`apps/api/.venv/bin/python -m uvicorn forge.main:app --host 127.0.0.1 --port 8000`
  - 控制台：`apps/web/node_modules/.bin/next start -p 8106 -H 127.0.0.1`
- 面板与 Tab：`forge.main`（走 ensureTool），命令 `forge.open`
- 数据落盘：`$AGNX_HOME/apps/data/forge/`（`FORGE_DATA_DIR` / `FORGE_DATABASE_URL` / `FORGE_CHECKPOINT_DB` / `FORGE_CHROMA_PATH` 全部指向它）

### 为什么这个项目好嵌

上游 `apps/web/lib/api.ts` 第 4 行写死 `const BASE = "/api/forge"`，而 `next.config.mjs` 把
`/api/forge/:path*` **反代**到 `FORGE_API_URL`（默认 `127.0.0.1:8000`）。所以：

- 对外只需要暴露 **Next 的 8106 一个 origin**，引擎 8000 只绑 `127.0.0.1`，不对外；
- iframe 内所有请求都是同源的，**没有跨源 cookie、没有 CORS 预检、没有 SSE 跨域中断**；
- 面板 `guest.auth=none` 即可，登录态走上游自己的 JWT（存 localStorage），与 Agnx 无关。

### 依赖安装的两个坑（重要）

1. **不能用 `uv sync`**。上游只提供 `pyproject.toml`、**不提供 `uv.lock`**；`uv sync` 会把
   所有平台的全部可选组一起解析，于是在本机（macOS 13 x86_64）卡在
   `onnxruntime==1.31.0`——它只有 macOS **14_0 arm64** 的 wheel。`uv sync` 报错退出，环境装不起来。
   正确做法是按本机平台解析：

   ```bash
   cd apps/api
   uv venv --python 3.12
   uv pip install --python .venv/bin/python -e ".[vectors,providers,mcp]"
   ```

2. **`[all]` 在本机装不全**。`all = vectors + providers + knowledge + mcp`，而
   `knowledge → fastembed → onnxruntime` 在 x86_64 macOS 上没有 wheel。因此这里**故意省略 `knowledge` 组**。
   影响面：仅「本地 fastembed 向量嵌入 / BM25 混合检索」这一个能力不可用，
   画布、多智能体、RAG 的 Chroma 向量库、MCP、发布链路全部正常。
   若换到 Apple Silicon / Linux，补 `--extra knowledge` 即可。

3. 前端要**先 build 再 start**：`pnpm install && pnpm --filter web build`。生产模式下 `next start`
   不会做按需编译，缺 `.next` 会直接失败。

### 验收实测（2026-10-19）

```text
$ node .agnx/tools/ensure-forge-web.mjs --port 8106 --work-dir /tmp/forge-probe2
[ensure-forge-web] {"phase":"spawn.api","port":8000,"dataDir":"/tmp/forge-probe2"}
[ensure-forge-web] {"phase":"spawn.frontend","port":8106}
{"ok":true,"reused":false,"port":8106,"pid":72342,"origin":"http://127.0.0.1:8106",
 "api":"http://127.0.0.1:8000","dataDir":"/tmp/forge-probe2","warnings":[]}
（冷启动 4.8s；复跑同一命令返回 "reused":true）

$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8106/                 → 200
  <title>Forge - AI Agent Platform</title>
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8106/api/forge/openapi.json → 200（同源反代生效）
$ curl -o /dev/null -w '%{http_code}' -X POST .../api/forge/v1/auth/login -d '{}'  → 422（路由在，缺参校验）
```

- 构建胶水：`node .agnx/scripts/build.mjs` → `.agnx/dist/index.js`（含 `"forge"` / `forge.main` / `forge.open` / `ensure-forge-web`）
- manifest / config：`python3 -m json.tool` 通过

### 已知限制

1. **首次登录**：上游默认 `you@forge.local` / `forge-admin`（`.env` 里的 `FORGE_BOOTSTRAP_*`），
   开发环境会打印 `INSECURE CONFIG` 警告，属正常。
2. **引擎端口 8000 是全仓约定**：`next.config.mjs` 的反代目标在 build 期就冻结进 routes manifest，
   运行期改 `FORGE_API_URL` 只影响 dev。所以 ensure-tool 固定引擎 8000（仅回环），
   若 8000 已被占用会在 `warnings` 里明确报出。**注意本机 8000 若被其它子应用占用会互相踩，需先确认。**
3. **`.env` 是上游要求的**（`config.py` 从仓根 `.env` 读），已从 `.env.example` 拷贝，未提交任何真实密钥。
4. **模型 key**：画布可以搭、可以保存，但真要跑 agent 需在 `.env` 配 provider key（或界面上配）。
5. **上游禁止 iframe 嵌入，本接入用 `guest-webview` 绕过（已可用）**

   **上游行为**：控制台根路径被 `apps/web/middleware.ts:38` 强制
   `Content-Security-Policy: frame-ancestors 'none'` + `X-Frame-Options: DENY`，
   注释原文：_"the authenticated operator dashboard - is never framable"_（防点击劫持）。

   **解法**：manifest 设 `guest.preferStrategy = "guest-webview"`。Electron 的 `<webview>`
   跑在独立 WebContents（`partition=persist:agnx-guest-surface-forge`），不受宿主页 frame-ancestors 约束。

   验收（2026-10-19）：webview **1174×882**，Forge 登录页完整渲染；
   **连续 3 次切走再切回均保持 1174×882**。

   **易踩的坑**：
   - 首次挂载若在 Tab 未激活时，容器测得 0×0，webview 停在 0×0 → 必须**先激活 Tab 再挂载**。
   - 改 `preferStrategy` 后已挂载的面板不自动重建 → 需 `location.reload()` 或关掉 Tab 重开。
   - `X-Frame-Options: DENY` 对 webview 无效（它不是 iframe），这是能工作的关键。

   **图标**：上游 `apps/web/components/icons.tsx:101` 的 `logo` 描边形状已复制为
   `assets/forge-icon-light.svg` / `forge-icon-dark.svg`，manifest 用 `icon` / `iconDark` 指过去。

## 嵌页宿主能力缺口

| 上游能力 | 信号位置 | 嵌后风险 | 处置 | 主路径 | 备注 |
| --- | --- | --- | --- | --- | --- |
| SSE 运行流（节点逐个点亮） | `/api/forge/v1/.../runs` stream | 反代缓冲导致流不刷新 | A：Next 同源反代已透传 | Guest Surface | 同源，风险低；若发现缓冲再收紧 `X-Accel-Buffering` |
| 登录态 JWT | localStorage（`lib/api.ts`） | iframe 内 localStorage 按 origin 隔离；与 Agnx 域不同源属预期 | E：不介入 | Guest Surface | 8106 固定 origin，重启不丢 |
| MCP 客户端需直连引擎 | `components/screens/deploy.tsx:150` 注释 | UI 里展示的 MCP 地址指向引擎而非 8106 | E：不介入（外部 MCP 客户端本就不在 iframe 内） | 上游原样 | 文档已说明「MCP clients must reach the API DIRECTLY」 |
| 文件下载 / 导出 | `/api/forge` | 第三方上下文下载可能受限 | A：同源代理 | Guest Surface | — |
