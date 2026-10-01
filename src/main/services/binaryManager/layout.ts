// fork 缝（原创）：受管工具布局单点。
//
// 为什么要有这件：同一份"装到哪"的知识此前散在三处——`BinaryManager.managedBinaryPath`
// （安装器）、`resolveBinary.managedBinaryPath`（解析器；文件头注释写着"与 BinaryManager 的
// managedBinaryPath 保持一致"）、`PaperAgentService.toolDir/sourceTreeDir/venvPython`
// （Web UI 生命周期）。靠注释维持的"保持一致"已经漂移过一次：`resolveBinary` 至今不认识
// paper-agent——任何走它的通道都会把已安装的源码型工具判成"未安装"。三个消费者改为
// import 本件，布局只在一个地方定义。

import path from 'node:path'

import { isWin } from '@main/constant'
import { codeMateToolsRoot } from '@main/services/deepSeekHarness/paths'

import { BINARY_TOOL_PRESETS, type BinaryToolPreset } from './presets'

/** 安装后端映射出的布局类别（`registry`/`aqua` 等未支持的后端没有受管布局）。 */
export type ManagedToolKind = 'npm' | 'venv' | 'source'

/**
 * 预设 → 布局类别。未支持的后端返回 undefined（调用方各自决定"跳过"还是"报错"：
 * 安装器选择告警跳过，解析器选择回落到系统 PATH）。
 */
export function managedToolKind(preset: BinaryToolPreset): ManagedToolKind | undefined {
  switch (preset.install) {
    case 'npm':
      return 'npm'
    case 'pipx':
      return 'venv'
    case 'source':
      return 'source'
    default:
      return undefined
  }
}

const KIND_BY_EXECUTABLE: ReadonlyMap<string, ManagedToolKind> = new Map(
  BINARY_TOOL_PRESETS.flatMap((preset) => {
    const kind = managedToolKind(preset)
    return kind ? [[preset.executable, kind] as const] : []
  })
)

/** 按可执行名查布局类别（不在预设表里的返回 undefined）。 */
export function managedToolKindFor(executable: string): ManagedToolKind | undefined {
  return KIND_BY_EXECUTABLE.get(executable)
}

/** 受管工具目录（`tools/<name>`；name = executable）。 */
export function toolDir(name: string): string {
  return path.join(codeMateToolsRoot(), name)
}

/** 源码型工具的源码树落点（升级整树替换；用户态不在此，见 codeMateToolHome）。 */
export function sourceTreeDir(name: string): string {
  return path.join(toolDir(name), 'src')
}

/** 源码型工具的 venv 落点（跨升级保留，依赖变更由 pip 增量解析）。 */
export function sourceVenvDir(name: string): string {
  return path.join(toolDir(name), 'venv')
}

/** venv 型工具（pipx 等价物）的 venv 落在工具目录本身。 */
export function venvPython(name: string): string {
  return isWin ? path.join(toolDir(name), 'Scripts', `${name}.exe`) : path.join(toolDir(name), 'bin', name)
}

/** 源码型 venv 的解释器（受管"可执行物"，也是快照探针与存在性判据）。 */
export function sourceVenvPython(name: string): string {
  return isWin
    ? path.join(sourceVenvDir(name), 'Scripts', 'python.exe')
    : path.join(sourceVenvDir(name), 'bin', 'python3')
}

/**
 * 受管可执行物的落点（快照探针、启动解析、生命周期服务共用）。
 * 未知工具（不在预设表里）返回 undefined——**不要**在此为未知名字猜一个路径。
 */
export function managedBinaryPathFor(executable: string): string | undefined {
  switch (managedToolKindFor(executable)) {
    case 'npm':
      // npm 型：bin shim 在 node_modules/.bin（Windows 为 .cmd）。
      return path.join(toolDir(executable), 'node_modules', '.bin', isWin ? `${executable}.cmd` : executable)
    case 'venv':
      return venvPython(executable)
    case 'source':
      return sourceVenvPython(executable)
    default:
      return undefined
  }
}
