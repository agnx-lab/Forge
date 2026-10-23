#!/usr/bin/env node
/**
 * 场景：短跑 sidecar — 确保 Forge（FastAPI 引擎 + Next 控制台）已在 127.0.0.1:<port> 上。
 *       端口已健康则复用；--force-restart 则停旧再起。
 * 用法：node .agnx/tools/ensure-forge-web.mjs [--port <n>] [--work-dir <dataRoot>] [--force-restart] [--supervised]
 * stdout：最后一行单行 JSON { ok, port, origin, reused, pid, api?, warnings? }；失败 { ok:false, error } 且 exitCode=1
 *
 * 上游启动方式（不改造上游，只传端口 / 环境变量 / 数据目录）：
 *   engine : apps/api → <api>/.venv/bin/python -m uvicorn forge.main:app --host 127.0.0.1 --port 8000
 *   web    : apps/web → node_modules/.bin/next start -p <port> -H 127.0.0.1
 *            next.config.mjs 把 /api/forge/* 反代到 FORGE_API_URL（默认 127.0.0.1:8000），
 *            所以对外只需一个 origin，iframe 内同源、无跨源 cookie / CORS 问题。
 * 数据落盘：--work-dir 指定的目录（FORGE_DATA_DIR / DB / checkpoint / chroma 全指过去）。
 */
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** clone 根 = Forge 仓根 */
const repoRoot = path.resolve(__dirname, "../..");
// --- Agnx SDK sidecar 骨架（宿主注入绝对路径；拿不到则回退本文件自写实现）---
const sdk = process.env.AGNX_APP_SDK_SIDECAR
  ? await import(process.env.AGNX_APP_SDK_SIDECAR)
  : null;

const defaultPort = 8106;
const apiPort = 8000;



async function pathExists(p) {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function httpStatus(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", () => resolve(0));
    req.on("timeout", () => {
      req.destroy();
      resolve(0);
    });
  });
}

/** 端口有监听即视为活着。 */
function tcpListening(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (v) => {
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}



async function readJson(p) {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return null;
  }
}

async function waitFor(predicate, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * 后台拉起子进程，日志落文件而不是 stdout 管道：
 * 管道常驻会让调用方的 `| tail` / readFile(STDIN) 永远等不到 EOF，ensure 进程看似挂死。
 */

// --- SDK 骨架：优先用宿主注入的实现；拿不到时回退本文件内的等价实现（不 exit）---
// 硬报错会让「宿主还没升级 SDK」或「离线手工调试」直接起不来，且静默失败更糟；
// 这里保留最小自写实现，行为与 SDK 一致（端口守卫 / 探活 / 脱离 spawn / 日志）。
function fallbackCreateLogger(tag) {
  return (phase, fields) =>
    console.error(`[${tag}] ${phase}${fields ? " " + JSON.stringify(fields) : ""}`);
}
function fallbackParseArgs(argv, opts = {}) {
  const out = {
    port: opts.defaultPort,
    workDir: opts.defaultWorkDir ?? process.cwd(),
    supervised: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--work-dir") out.workDir = argv[++i];
    else if (a === "--supervised") out.supervised = true;
  }
  return out;
}
function fallbackIsPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
function fallbackSpawnDetached(command, args, { logFile, env = {} } = {}) {
  const fd = openSync(logFile, "a");
  const child = spawn(command, args, {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, ...env },
  });
  child.unref();
  return child.pid;
}
async function fallbackStopPid(pid, timeoutMs = 5000) {
  const n = Number(pid);
  if (!fallbackIsPidAlive(n)) return true;
  try {
    process.kill(n, "SIGTERM");
  } catch {
    return true;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!fallbackIsPidAlive(n)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    process.kill(n, "SIGKILL");
  } catch {
    /* 已退出 */
  }
  return !fallbackIsPidAlive(n);
}

const sdkImpl = sdk?.parseEnsureArgs
  ? sdk
  : {
      parseEnsureArgs: fallbackParseArgs,
      isPidAlive: fallbackIsPidAlive,
      stopPid: fallbackStopPid,
      spawnDetached: fallbackSpawnDetached,
      createEnsureLogger: fallbackCreateLogger,
    };
if (!sdk?.parseEnsureArgs) {
  console.error(
    "[ensure-forge-web] AGNX_APP_SDK_SIDECAR 未注入，使用本文件内回退实现（建议通过宿主启动）",
  );
}

const { parseEnsureArgs, isPidAlive, stopPid, spawnDetached, createEnsureLogger } = sdkImpl;
const trace = createEnsureLogger("ensure-forge-web");

/**
 * parseEnsureArgs 用 call-site 的缺省值；forge 的数据目录同时是上游 HOME。
 */
function parseArgs(argv) {
  return parseEnsureArgs(argv, {
    defaultWorkDir: process.env.AGNX_APP_DATA_ROOT || path.join(repoRoot, ".agnx-runtime"),
    defaultPort,
  });
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  const warnings = [];
  await mkdir(cfg.workDir, { recursive: true });
  const statePath = path.join(cfg.workDir, "forge-web.json");

  const webRoot = path.join(repoRoot, "apps", "web");
  const apiRoot = path.join(repoRoot, "apps", "api");
  const venvPython = path.join(apiRoot, ".venv", "bin", "python");
  const nextBin = path.join(webRoot, "node_modules", ".bin", "next");

  if (!(await pathExists(nextBin))) {
    console.log(
      JSON.stringify({
        ok: false,
        error: `未找到 Next 可执行文件：${nextBin}。请先在仓根执行 pnpm install 与 pnpm --filter web build`,
      }),
    );
    process.exitCode = 1;
    return;
  }
  if (!(await pathExists(venvPython))) {
    console.log(
      JSON.stringify({
        ok: false,
        error: `未找到 Forge 引擎虚拟环境：${venvPython}。请先在 apps/api 执行 uv venv --python 3.12 && uv pip install -e ".[vectors,providers,mcp]"`,
      }),
    );
    process.exitCode = 1;
    return;
  }

  const existing = await readJson(statePath);
  const frontAlive = await tcpListening("127.0.0.1", cfg.port);
  const apiAlive = (await httpStatus(`http://127.0.0.1:${apiPort}/openapi.json`)) === 200;

  if (!cfg.forceRestart && frontAlive && apiAlive) {
    trace("reuse", { port: cfg.port, apiPort });
    console.log(
      JSON.stringify({
        ok: true,
        reused: true,
        port: cfg.port,
        pid: existing?.pid ?? null,
        origin: `http://127.0.0.1:${cfg.port}`,
        api: `http://127.0.0.1:${apiPort}`,
        warnings,
      }),
    );
    return;
  }

  // 收拾旧实例
  if (existing && isPidAlive(existing.pid)) {
    stopPid(existing.pid);
  }
  if (existing && isPidAlive(existing.apiPid)) {
    stopPid(existing.apiPid);
  }
  if (cfg.forceRestart) {
    await new Promise((r) => setTimeout(r, 800));
  }

  const dataDir = cfg.workDir;
  const dbFile = path.join(dataDir, "forge.db");
  const baseEnv = {
    ...process.env,
    FORGE_DATA_DIR: dataDir,
    FORGE_DATABASE_URL: `sqlite+aiosqlite:///${dbFile}`,
    FORGE_CHECKPOINT_DB: path.join(dataDir, "checkpoints.sqlite"),
    FORGE_CHROMA_PATH: path.join(dataDir, "chroma"),
    FORGE_CORS_ORIGINS: JSON.stringify([
      `http://127.0.0.1:${cfg.port}`,
      `http://localhost:${cfg.port}`,
    ]),
  };

  // 1) FastAPI 引擎
  let apiPid = existing?.apiPid ?? null;
  if (!apiAlive || cfg.forceRestart) {
    if (await tcpListening("127.0.0.1", apiPort)) {
      warnings.push(`127.0.0.1:${apiPort} 已被其它进程占用，引擎可能无法启动`);
    }
    trace("spawn.api", { port: apiPort, dataDir });
    const api = spawnDetached(
      venvPython,
      ["-m", "uvicorn", "forge.main:app", "--host", "127.0.0.1", "--port", String(apiPort)],
      { cwd: apiRoot, env: baseEnv, logFile: path.join(dataDir, "forge-api.log") },
    );
    apiPid = api.child.pid ?? null;
    const ready = await waitFor(
      async () => (await httpStatus(`http://127.0.0.1:${apiPort}/openapi.json`)) === 200,
      180_000,
    );
    if (!ready) {
      stopPid(apiPid);
      const out = api.readLog().trim();
      console.log(
        JSON.stringify({
          ok: false,
          error: out
            ? `Forge 引擎启动超时：${out.slice(-400)}`
            : "Forge 引擎启动超时（uvicorn 未在 180s 内就绪）",
        }),
      );
      process.exitCode = 1;
      return;
    }
  }

  // 2) Next 控制台
  let frontPid = existing?.pid ?? null;
  if (!frontAlive || cfg.forceRestart) {
    trace("spawn.frontend", { port: cfg.port });
    const front = spawnDetached(
      nextBin,
      ["start", "-p", String(cfg.port), "-H", "127.0.0.1"],
      {
        cwd: webRoot,
        env: { ...baseEnv, FORGE_API_URL: `http://127.0.0.1:${apiPort}` },
        logFile: path.join(dataDir, "forge-web.log"),
      },
    );
    frontPid = front.child.pid ?? null;
    const ready = await waitFor(async () => (await tcpListening("127.0.0.1", cfg.port)), 120_000);
    if (!ready) {
      stopPid(frontPid);
      const out = front.readLog().trim();
      console.log(
        JSON.stringify({
          ok: false,
          error: out
            ? `Forge 控制台启动超时：${out.slice(-400)}`
            : "Forge 控制台启动超时（next start 未就绪）；请先执行 pnpm --filter web build",
        }),
      );
      process.exitCode = 1;
      return;
    }
  }

  await writeFile(
    statePath,
    JSON.stringify({ port: cfg.port, pid: frontPid, apiPid, dataDir, updatedAt: Date.now() }, null, 2),
    "utf8",
  );

  console.log(
    JSON.stringify({
      ok: true,
      reused: false,
      port: cfg.port,
      pid: frontPid,
      origin: `http://127.0.0.1:${cfg.port}`,
      api: `http://127.0.0.1:${apiPort}`,
      dataDir,
      warnings,
    }),
  );
}

main().catch((error) => {
  console.log(
    JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
});
