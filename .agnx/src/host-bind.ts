// 场景：Forge Host 绑定单例 — 面板共用。
import type { WorkspaceAppHostApi } from "@agnx-lab/app-sdk";

let boundHost: WorkspaceAppHostApi | null = null;

export function bindForgeHost(host: WorkspaceAppHostApi): void {
  boundHost = host;
}

export function getBoundHost(): WorkspaceAppHostApi | null {
  return boundHost;
}

export function requireBoundHost(): WorkspaceAppHostApi {
  if (!boundHost) {
    throw new Error("Forge Host 尚未绑定");
  }
  return boundHost;
}
