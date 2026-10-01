/**
 * DXT（.dxt）MCP 扩展包安装服务（v0.4.7 自上游 CS_V1 src/main/services/DxtService.ts 移植）。
 *
 * .dxt 本质是 zip 包：manifest.json（dxt_version/name/version/server.mcp_config）+ 服务器
 * 运行文件。uploadDxt 解包 → 校验 manifest → 落位 `{mcpDir}/server-{name}` → 渲染层把它转成
 * stdio MCPServer 条目走既有添加流程（redux mcp 切片 → Dsh_SyncMcpServers 投影）；
 * MCPService 启动 stdio 服务器时经 getResolvedMcpConfig 做平台覆写 + 变量替换并设 cwd。
 *
 * fork 偏离（上游对账）：
 * - uuid → node:crypto randomUUID（fork services/mcp 同款）；
 * - 目录懒解析（app.getPath 读取不进构造期，且测试可注入 tempDir/mcpDir）；
 * - 上游 install 期残留的临时 .dxt 文件不清理（filePath.startsWith(this.tempDir) 永假：
 *   落盘在 getTempDir() 根而非 dxt_uploads 子目录）——改为处理完删除 tempDir 内的源文件；
 * - 清理按 dxtPath 而非 server.name 定位（上游 cleanupDxtServer(name) 拼目录名，display_name
 *   ≠ name 时永远失配、目录变孤儿）——cleanupDxtServerByPath 校验目标在 mcpDir 内再删。
 */
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import os from 'node:os'
import * as path from 'node:path'

import { loggerService } from '@logger'
import { getMcpDir, getTempDir, isPathInside } from '@main/utils/file'
import type { DxtManifest, DxtResolvedMcpConfig, DxtUploadResult } from '@shared/config/types'
import { redactSecretText } from '@shared/utils/redaction'
import StreamZip from 'node-stream-zip'

const logger = loggerService.withContext('DxtService')

/**
 * Ensure a target path is within the base directory to prevent path traversal attacks.
 * This is the correct approach: validate the final resolved path rather than sanitizing input.
 *
 * @param basePath - The base directory that the target must be within
 * @param targetPath - The target path to validate
 * @returns The resolved target path if valid
 * @throws Error if the target path escapes the base directory
 */
export function ensurePathWithin(basePath: string, targetPath: string): string {
  const resolvedBase = path.resolve(basePath)
  const resolvedTarget = path.resolve(path.normalize(targetPath))

  // Must be direct child of base directory, no subdirectories allowed
  if (path.dirname(resolvedTarget) !== resolvedBase) {
    throw new Error('Path traversal detected: target path must be direct child of base directory')
  }

  return resolvedTarget
}

/**
 * Validate and sanitize a command to prevent path traversal attacks.
 * Commands should be either:
 * 1. Simple command names (e.g., "node", "python", "npx") - looked up in PATH
 * 2. Absolute paths (e.g., "/usr/bin/node", "C:\\Program Files\\node\\node.exe")
 * 3. Relative paths starting with ./ or .\ (relative to extractDir)
 *
 * Rejects commands containing path traversal sequences (..)
 *
 * @param command - The command to validate
 * @returns The validated command
 * @throws Error if command contains path traversal or is invalid
 */
export function validateCommand(command: string): string {
  if (!command || typeof command !== 'string') {
    throw new Error('Invalid command: command must be a non-empty string')
  }

  const trimmed = command.trim()
  if (!trimmed) {
    throw new Error('Invalid command: command cannot be empty')
  }

  // Check for path traversal sequences
  // This catches: .., ../, ..\, /../, \..\, etc.
  if (/(?:^|[/\\])\.\.(?:[/\\]|$)/.test(trimmed) || trimmed === '..') {
    throw new Error(`Invalid command: path traversal detected in "${command}"`)
  }

  // Check for null bytes
  if (trimmed.includes('\0')) {
    throw new Error('Invalid command: null byte detected')
  }

  return trimmed
}

/**
 * Validate command arguments to prevent injection attacks.
 * Rejects arguments containing path traversal sequences.
 *
 * @param args - The arguments array to validate
 * @returns The validated arguments array
 * @throws Error if any argument contains path traversal
 */
export function validateArgs(args: string[]): string[] {
  if (!Array.isArray(args)) {
    throw new Error('Invalid args: must be an array')
  }

  return args.map((arg, index) => {
    if (typeof arg !== 'string') {
      throw new Error(`Invalid args: argument at index ${index} must be a string`)
    }

    // Check for null bytes
    if (arg.includes('\0')) {
      throw new Error(`Invalid args: null byte detected in argument at index ${index}`)
    }

    // Check for path traversal in arguments that look like paths
    // Only validate if the arg contains path separators (indicating it's meant to be a path)
    if ((arg.includes('/') || arg.includes('\\')) && /(?:^|[/\\])\.\.(?:[/\\]|$)/.test(arg)) {
      throw new Error(`Invalid args: path traversal detected in argument at index ${index}`)
    }

    return arg
  })
}

export function performVariableSubstitution(
  value: string,
  extractDir: string,
  userConfig?: Record<string, any>
): string {
  let result = value

  // Replace ${__dirname} with the extraction directory
  result = result.replace(/\$\{__dirname\}/g, extractDir)

  // Replace ${HOME} with user's home directory
  result = result.replace(/\$\{HOME\}/g, os.homedir())

  // Replace ${DESKTOP} with user's desktop directory
  const desktopDir = path.join(os.homedir(), 'Desktop')
  result = result.replace(/\$\{DESKTOP\}/g, desktopDir)

  // Replace ${DOCUMENTS} with user's documents directory
  const documentsDir = path.join(os.homedir(), 'Documents')
  result = result.replace(/\$\{DOCUMENTS\}/g, documentsDir)

  // Replace ${DOWNLOADS} with user's downloads directory
  const downloadsDir = path.join(os.homedir(), 'Downloads')
  result = result.replace(/\$\{DOWNLOADS\}/g, downloadsDir)

  // Replace ${pathSeparator} or ${/} with the platform-specific path separator
  result = result.replace(/\$\{pathSeparator\}/g, path.sep)
  result = result.replace(/\$\{\/\}/g, path.sep)

  // Replace ${user_config.KEY} with user-configured values
  if (userConfig) {
    result = result.replace(/\$\{user_config\.([^}]+)\}/g, (match, key) => {
      return userConfig[key] || match // Keep original if not found
    })
  }

  return result
}

export function applyPlatformOverrides(
  mcpConfig: DxtManifest['server']['mcp_config'],
  extractDir: string,
  userConfig?: Record<string, any>
): DxtResolvedMcpConfig {
  const platform = process.platform
  const resolvedConfig = { ...mcpConfig }

  // Apply platform-specific overrides
  if (mcpConfig.platform_overrides && mcpConfig.platform_overrides[platform]) {
    const override = mcpConfig.platform_overrides[platform]

    // Override command if specified
    if (override.command) {
      resolvedConfig.command = override.command
    }

    // Override args if specified
    if (override.args) {
      resolvedConfig.args = override.args
    }

    // Merge environment variables
    if (override.env) {
      resolvedConfig.env = { ...resolvedConfig.env, ...override.env }
    }
  }

  // Apply variable substitution to all string values
  if (resolvedConfig.command) {
    resolvedConfig.command = performVariableSubstitution(resolvedConfig.command, extractDir, userConfig)
    // Validate command after substitution to prevent path traversal attacks
    resolvedConfig.command = validateCommand(resolvedConfig.command)
  }

  if (resolvedConfig.args) {
    resolvedConfig.args = resolvedConfig.args.map((arg) => performVariableSubstitution(arg, extractDir, userConfig))
    // Validate args after substitution to prevent path traversal attacks
    resolvedConfig.args = validateArgs(resolvedConfig.args)
  }

  if (resolvedConfig.env) {
    for (const [key, value] of Object.entries(resolvedConfig.env)) {
      resolvedConfig.env[key] = performVariableSubstitution(value, extractDir, userConfig)
    }
  }

  return resolvedConfig as DxtResolvedMcpConfig
}

export interface DxtServiceOptions {
  /** 测试注入：解包临时根目录（默认 `{getTempDir()}/dxt_uploads`）。 */
  tempDir?: string
  /** 测试注入：扩展落位根目录（默认 getMcpDir()）。 */
  mcpDir?: string
}

class DxtService {
  private readonly injectedTempDir?: string
  private readonly injectedMcpDir?: string

  constructor(options?: DxtServiceOptions) {
    this.injectedTempDir = options?.tempDir
    this.injectedMcpDir = options?.mcpDir
  }

  /** 解包临时根目录（懒解析 + 确保存在；目录建不出来如实抛给调用方）。 */
  private getTempUploadsDir(): string {
    const dir = this.injectedTempDir ?? path.join(getTempDir(), 'dxt_uploads')
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    return dir
  }

  /** 扩展落位根目录（懒解析 + 确保存在）。 */
  private getMcpRootDir(): string {
    const dir = this.injectedMcpDir ?? getMcpDir()
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    return dir
  }

  private async moveDirectory(source: string, destination: string): Promise<void> {
    try {
      // Try rename first (works if on same filesystem)
      fs.renameSync(source, destination)
    } catch (error) {
      // If rename fails (cross-filesystem), use copy + remove
      logger.debug('Cross-filesystem move detected, using copy + remove')

      // Ensure parent directory exists
      const parentDir = path.dirname(destination)
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true })
      }

      // Recursively copy directory
      await this.copyDirectory(source, destination)

      // Remove source directory
      fs.rmSync(source, { recursive: true, force: true })
    }
  }

  private async copyDirectory(source: string, destination: string): Promise<void> {
    // Create destination directory
    fs.mkdirSync(destination, { recursive: true })

    // Read source directory
    const entries = fs.readdirSync(source, { withFileTypes: true })

    // Copy each entry
    for (const entry of entries) {
      const sourcePath = path.join(source, entry.name)
      const destPath = path.join(destination, entry.name)

      if (entry.isDirectory()) {
        await this.copyDirectory(sourcePath, destPath)
      } else {
        fs.copyFileSync(sourcePath, destPath)
      }
    }
  }

  /**
   * 解包并注册一个 .dxt 扩展包。校验失败的每一条都以具名 Error 抛出（不静默、
   * 不返回空结果）；成功返回 manifest 与最终落位目录。
   */
  public async uploadDxt(filePath: string): Promise<DxtUploadResult> {
    const tempExtractDir = path.join(this.getTempUploadsDir(), `dxt_${randomUUID()}`)

    try {
      // Validate file exists
      if (!fs.existsSync(filePath)) {
        throw new Error('DXT file not found')
      }

      // Extract the DXT file (which is a ZIP archive) to a temporary directory
      logger.debug(`Extracting DXT file: ${filePath}`)

      fs.mkdirSync(tempExtractDir, { recursive: true })
      const zip = new StreamZip.async({ file: filePath })
      try {
        await zip.extract(null, tempExtractDir)
      } finally {
        await zip.close()
      }

      // Read and validate the manifest.json
      const manifestPath = path.join(tempExtractDir, 'manifest.json')
      if (!fs.existsSync(manifestPath)) {
        throw new Error('manifest.json not found in DXT file')
      }

      const manifestContent = fs.readFileSync(manifestPath, 'utf-8')
      const manifest = JSON.parse(manifestContent) as DxtManifest

      // Validate required fields in manifest
      if (!manifest.dxt_version) {
        throw new Error('Invalid manifest: missing dxt_version')
      }
      if (!manifest.name) {
        throw new Error('Invalid manifest: missing name')
      }
      if (!manifest.version) {
        throw new Error('Invalid manifest: missing version')
      }
      if (!manifest.server) {
        throw new Error('Invalid manifest: missing server configuration')
      }
      if (!manifest.server.mcp_config) {
        throw new Error('Invalid manifest: missing server.mcp_config')
      }
      if (!manifest.server.mcp_config.command) {
        throw new Error('Invalid manifest: missing server.mcp_config.command')
      }
      if (!Array.isArray(manifest.server.mcp_config.args)) {
        throw new Error('Invalid manifest: server.mcp_config.args must be an array')
      }

      // Use server name as the final extract directory for automatic version management
      const serverDirName = `server-${manifest.name}`
      const mcpRoot = this.getMcpRootDir()
      const finalExtractDir = ensurePathWithin(mcpRoot, path.join(mcpRoot, serverDirName))

      // Clean up any existing version of this server
      if (fs.existsSync(finalExtractDir)) {
        logger.debug(`Removing existing server directory: ${finalExtractDir}`)
        fs.rmSync(finalExtractDir, { recursive: true, force: true })
      }

      // Move the temporary directory to the final location
      // Use recursive copy + remove instead of rename to handle cross-filesystem moves
      await this.moveDirectory(tempExtractDir, finalExtractDir)
      logger.debug(`DXT server extracted to: ${finalExtractDir}`)

      // Clean up the uploaded temp file (fork: 落盘在 tempDir 根，处理完即删——上游此处
      // 的 startsWith(dxt_uploads) 判断永假，源文件滞留临时目录）
      const tempRoot = getTempDir()
      if (path.resolve(filePath).startsWith(path.resolve(tempRoot) + path.sep)) {
        try {
          fs.unlinkSync(filePath)
        } catch (error) {
          logger.warn(`Failed to remove uploaded temp DXT file: ${filePath}`, error as Error)
        }
      }

      // Return success with manifest and extraction path
      return {
        success: true,
        data: {
          manifest,
          extractDir: finalExtractDir
        }
      }
    } catch (error) {
      // Clean up on error
      if (fs.existsSync(tempExtractDir)) {
        fs.rmSync(tempExtractDir, { recursive: true, force: true })
      }

      const errorMessage = error instanceof Error ? error.message : 'Failed to process DXT file'
      logger.error('DXT upload error:', error instanceof Error ? error : new Error(String(error)))

      return {
        success: false,
        // 失败出口同样脱敏（v1 二轮审查 m2-05）：错误文本可能回显含 key 的 args。
        error: redactSecretText(errorMessage)
      }
    }
  }

  /**
   * Get resolved MCP configuration for a DXT server with platform overrides and variable
   * substitution. 解析失败返回 null（调用方如实降级到安装期值并记 warn——上游同语义）。
   */
  public getResolvedMcpConfig(dxtPath: string, userConfig?: Record<string, any>): DxtResolvedMcpConfig | null {
    try {
      // Read the manifest from the DXT server directory
      const manifestPath = path.join(dxtPath, 'manifest.json')
      if (!fs.existsSync(manifestPath)) {
        logger.error(`Manifest not found: ${manifestPath}`)
        return null
      }

      const manifestContent = fs.readFileSync(manifestPath, 'utf-8')
      const manifest = JSON.parse(manifestContent) as DxtManifest

      if (!manifest.server?.mcp_config) {
        logger.error('No mcp_config found in manifest')
        return null
      }

      // Apply platform overrides and variable substitution
      const resolvedConfig = applyPlatformOverrides(manifest.server.mcp_config, dxtPath, userConfig)

      // args 是 `${user_config.KEY}` 插值的载体（该功能的设计用法），必然含 provider key——
      // 与 codeCli/hermes/dsh/paper-agent 四处同纪律，落盘日志必须脱敏（v1 二轮审查 m2-05）。
      logger.debug('Resolved MCP config:', {
        command: resolvedConfig.command,
        args: resolvedConfig.args?.map((arg) => redactSecretText(arg)),
        env: resolvedConfig.env ? Object.keys(resolvedConfig.env) : undefined
      })

      return resolvedConfig
    } catch (error) {
      logger.error('Failed to resolve MCP config:', error instanceof Error ? error : new Error(String(error)))
      return null
    }
  }

  /**
   * 删除一个 DXT 服务器的解包目录（removeServer 时调用）。
   *
   * 清理用途的校验是「必须是 mcpDir 的**后代**」，不是「直系子目录」——`ensurePathWithin`
   * 的直系约束是为**落位**设计的（`uploadDxt` 自己拼 `server-${name}`）。此前清理复用同一
   * 判据（v1 二轮审查 m2-13），于是任何二级子目录形状的 `dxtPath`（旧版本落位形态、用户
   * 在 mcpDir 下手工分组）都会抛错并被吞成 `false`：配置已从注册表消失、解包目录（含可
   * 执行物）永久留在磁盘上，界面上再也看不到它。
   *
   * 返回 `true` = 目录已删除；`false` = 目录不存在或删除失败（调用方按 `logger.warn` 记录
   * 并给出信号，不得静默当作「清理成功」）。
   */
  public cleanupDxtServerByPath(dxtPath: string): boolean {
    try {
      const mcpRoot = this.getMcpRootDir()
      const serverDir = path.resolve(path.normalize(dxtPath))

      // 误用防墙：目标必须在 mcpDir 之内（isPathInside 正确处理 `/root/a` 与 `/root/ab`）。
      if (!isPathInside(serverDir, mcpRoot)) {
        logger.warn(`Refusing to clean up a path outside the MCP root: ${serverDir}`)
        return false
      }

      if (fs.existsSync(serverDir)) {
        logger.debug(`Removing DXT server directory: ${serverDir}`)
        fs.rmSync(serverDir, { recursive: true, force: true })
        return true
      }

      logger.warn(`Server directory not found: ${serverDir}`)
      return false
    } catch (error) {
      logger.error('Failed to cleanup DXT server:', error instanceof Error ? error : new Error(String(error)))
      return false
    }
  }

  /**
   * 解包目录是否**仍然存在于** mcpDir 内。供调用方区分「本就不在」（无需信号）与
   * 「仍在但清理失败」（必须给出可见失败信号）。
   */
  public dxtServerDirExists(dxtPath: string): boolean {
    try {
      const serverDir = path.resolve(path.normalize(dxtPath))
      return isPathInside(serverDir, this.getMcpRootDir()) && fs.existsSync(serverDir)
    } catch {
      return false
    }
  }
}

export default DxtService
