// fork 移植自 cherry-studio v2 src/renderer/pages/code/cliConfig/builders.ts（2026-09-24，v0.3.4-1 批次4a）。
// fork 缝：builder 面按 hermes 依赖闭包裁剪——buildClaude/Codex/OpenCode/Gemini/Qwen/Kimi/Pi
// 及其私有 helper（openCodeProviderRequestOptions/openCodeModelLimit/buildOpenCodeModelOptions/
// resolveCodexProviderDisplayName/hasRestorableCodexChatgptAuth）与 managedKeys/permissionModes/
// sanitize/values 的 import 面整块删除；buildHermesEnvConfig 逐字保留（hermesAdapter 唯一消费）。

export function buildHermesEnvConfig(envMap: Map<string, string>, apiKey: string): Map<string, string> {
  const next = new Map(envMap)
  next.delete('CHERRY_HERMES_API_KEY')
  if (apiKey) next.set('CHERRY_HERMES_API_KEY', apiKey)
  return next
}
