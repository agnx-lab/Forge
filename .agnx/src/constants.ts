// 场景：Forge Sub App 常量（AppId / 命令 / 面板 / ensure 相对路径 / 端口）。
export const FORGE_APP_ID = "forge";
export const FORGE_PANEL_ID = "forge.main";
export const FORGE_OPEN_COMMAND_ID = "forge.open";

/** 短跑 sidecar：复用或拉起 Forge（Next 控制台 + FastAPI 引擎），对外统一 8106。 */
export const FORGE_ENSURE_TOOL_REL = ".agnx/tools/ensure-forge-web.mjs";

/** 对外入口端口（Next 控制台，同源反代 /api/forge → 引擎）。 */
export const DEFAULT_FORGE_PORT = 8106;

/** 引擎内部端口（仅绑 127.0.0.1，不对外）。 */
export const FORGE_API_PORT = 8000;
