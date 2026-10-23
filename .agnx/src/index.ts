// 场景：Forge Sub App 入口 — 薄壳 + ensure + iframe。
import type { WorkspaceAppHostApi, WorkspaceAppModule } from "@agnx-lab/app-sdk";
import {
  FORGE_APP_ID,
  FORGE_ENSURE_TOOL_REL,
  FORGE_OPEN_COMMAND_ID,
  FORGE_PANEL_ID,
} from "./constants";
import { bindForgeHost, ForgePanel } from "./panel";

export const appId = FORGE_APP_ID;

function openTab(
  host: WorkspaceAppHostApi,
  context?: {
    serverId?: string;
    workspaceId?: string;
    currentPathname?: string | null;
  },
): void {
  host.openMiniAppTab({
    appId: FORGE_APP_ID,
    panelId: FORGE_PANEL_ID,
    serverId: context?.serverId,
    workspaceId: context?.workspaceId,
    currentPathname: context?.currentPathname,
  });
}

export function activate(host: WorkspaceAppHostApi): void {
  bindForgeHost(host);

  host.registerMiniApp({
    id: FORGE_PANEL_ID,
    appId: FORGE_APP_ID,
    title: "Forge",
    component: ForgePanel,
    iframeShortcutCapture: true,
    isolation: {
      mode: "iframe",
      sidecarTools: [FORGE_ENSURE_TOOL_REL],
      note: "Tab iframe 加载 Next 控制台（同源反代 /api/forge 到 FastAPI 引擎）；两端由 ensure sidecar 一并拉起",
    },
  });

  host.registerCommand({
    id: FORGE_OPEN_COMMAND_ID,
    appId: FORGE_APP_ID,
    title: "Forge",
    keywords: ["forge", "agent", "工作流", "workflow", "langgraph", "rag", "mcp", "n8n", "ai"],
    sidebarAction: {
      defaultVisible: true,
      label: "Forge",
      order: 61,
    },
    run: (context) => {
      openTab(host, context);
    },
  });
}

const moduleExport: WorkspaceAppModule = {
  appId: FORGE_APP_ID,
  activate,
};

export default moduleExport;

export { FORGE_APP_ID, FORGE_OPEN_COMMAND_ID, FORGE_PANEL_ID } from "./constants";
export { ForgePanel } from "./panel";
