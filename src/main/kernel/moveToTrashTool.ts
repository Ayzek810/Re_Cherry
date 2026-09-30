/**
 * move_to_trash 工作模式外置工具（v0.4.6）。
 *
 * V2 moveToTrash.ts 同构物：把工作区内文件/目录移入系统回收站（electron
 * shell.trashItem）——工作模式 fs 族（read/write/edit/glob/grep/pwsh）此前没有删除口子，
 * rm 走 pwsh 不可恢复且无防护。安全设计照抄 V2：保护路径矩阵（工作区根/盘根/主目录/
 * 顶层用户目录/凭据目录/VCS 元数据/OS 目录/挂载卷根）、拒绝 symlink、TOCTOU 双检
 * （lstat dev/ino 身份前后一致 + realpath 未变）。
 *
 * 档位语义（fork 三档，与 fs 工具族一致）：workspace-write / danger-full-access 自动
 * （回收站可恢复，属工作区操作）；read-only 档拒绝并给升级提示，模型带
 * sandbox_permissions+justification 重发经审批放行（toolEscalation.ts，dsh-tool-fs 同流）。
 */
import type { BigIntStats } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { loggerService } from '@logger'
import { getDataPath } from '@main/utils'
import { app, shell } from 'electron'

import { ensureNotReadOnly, escalationSchemaFields, resolveCallPolicy } from './toolEscalation'

const logger = loggerService.withContext('MoveToTrashTool')

export const name = 'tool-move-to-trash'
// execute 里读到的每个 cordis Service 都必须在此声明（get 走 inject 声明制）。
export const inject = ['tools', 'sandboxPolicy', 'approval']

const DESCRIPTION =
  'Move one existing file or directory from the session workspace to the operating-system trash. Recoverable ' +
  'from the trash; never a permanent delete. State the exact path to the user before calling. Refuses the ' +
  'workspace root, protected system and user directories, and symbolic links. At the read-only permission ' +
  'tier the call is denied once and needs sandbox_permissions with a justification on the retry.'

/** 大小写/分隔符归一（Windows 大小写不敏感、分隔符两形态），V2 normalizeComparable 同语义。 */
function normalizeComparable(filePath: string, platform: NodeJS.Platform): string {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const normalized = pathApi.resolve(filePath)
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isSameOrWithin(targetPath: string, rootPath: string, platform: NodeJS.Platform): boolean {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const target = normalizeComparable(targetPath, platform)
  const root = normalizeComparable(rootPath, platform)
  if (target === root) return true
  const relative = pathApi.relative(root, target)
  return relative !== '' && !relative.startsWith('..') && !pathApi.isAbsolute(relative)
}

function isDirectChild(targetPath: string, rootPath: string, depth: number, platform: NodeJS.Platform): boolean {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const relative = pathApi.relative(normalizeComparable(rootPath, platform), normalizeComparable(targetPath, platform))
  if (!relative || relative.startsWith('..') || pathApi.isAbsolute(relative)) return false
  return relative.split(pathApi.sep).filter(Boolean).length === depth
}

export interface TrashProtectionContext {
  platform?: NodeJS.Platform
  homeDirectory?: string
  downloadsDirectory?: string
  protectedDirectories?: readonly string[]
  environment?: Readonly<Record<string, string | undefined>>
}

/** 保护路径判定（V2 getProtectedTrashTargetReason 同语义；返回拒因，undefined = 放行）。 */
export function getProtectedTrashTargetReason(
  targetPath: string,
  workspacePath: string,
  context: TrashProtectionContext = {}
): string | undefined {
  const platform = context.platform ?? process.platform
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const target = normalizeComparable(targetPath, platform)
  const workspace = normalizeComparable(workspacePath, platform)

  if (target === workspace) return 'the session workspace root'

  const filesystemRoot = normalizeComparable(pathApi.parse(target).root, platform)
  if (target === filesystemRoot) return 'a filesystem, drive, or volume root'

  const home = context.homeDirectory ? normalizeComparable(context.homeDirectory, platform) : undefined
  if (home && target === home) return 'the user profile or home directory'

  const topLevelUserDirectories = home
    ? ['Desktop', 'Documents', 'Downloads', 'Music', 'Movies', 'Pictures', 'Videos', 'Backups'].map((directory) =>
        pathApi.join(home, directory)
      )
    : []
  if (context.downloadsDirectory) topLevelUserDirectories.push(context.downloadsDirectory)
  if (topLevelUserDirectories.some((directory) => target === normalizeComparable(directory, platform))) {
    return 'a top-level user data directory'
  }

  const sensitiveUserDirectories = home
    ? [
        '.ssh',
        '.gnupg',
        '.aws',
        '.azure',
        '.kube',
        '.docker',
        ...(platform === 'win32' ? ['AppData'] : ['.config', '.local/share']),
        ...(platform === 'darwin' ? ['Library'] : [])
      ].map((directory) => pathApi.join(home, directory))
    : []
  if (
    [...sensitiveUserDirectories, ...(context.protectedDirectories ?? [])].some((directory) =>
      isSameOrWithin(target, directory, platform)
    )
  ) {
    return 'a credential, configuration, or application-data directory'
  }

  const relativeTargetSegments = pathApi.relative(workspace, target).split(pathApi.sep)
  if (relativeTargetSegments.some((segment) => ['.git', '.hg', '.svn'].includes(segment))) {
    return 'version-control metadata'
  }

  if (platform === 'win32') {
    const environment = context.environment ?? process.env
    const conventionalRoots = [
      pathApi.join(filesystemRoot, 'Windows'),
      pathApi.join(filesystemRoot, 'Program Files'),
      pathApi.join(filesystemRoot, 'Program Files (x86)'),
      pathApi.join(filesystemRoot, 'ProgramData')
    ]
    const environmentRoots = [
      environment.SystemRoot,
      environment.WINDIR,
      environment.ProgramFiles,
      environment['ProgramFiles(x86)'],
      environment.ProgramData
    ].filter((directory): directory is string => Boolean(directory))

    if ([...conventionalRoots, ...environmentRoots].some((directory) => isSameOrWithin(target, directory, platform))) {
      return 'an operating-system or installed-program directory'
    }
  } else {
    const systemDirectories = [
      '/Applications',
      '/System',
      '/Library',
      '/usr',
      '/bin',
      '/sbin',
      '/etc',
      '/opt',
      '/boot',
      '/dev',
      '/proc',
      '/sys',
      '/root',
      '/var/lib',
      '/var/db',
      '/private/etc',
      '/private/var/db'
    ]
    if (systemDirectories.some((directory) => isSameOrWithin(target, directory, platform))) {
      return 'an operating-system directory'
    }

    const isMountedVolumeRoot =
      (platform === 'darwin' && isDirectChild(target, '/Volumes', 1, platform)) ||
      (platform === 'linux' &&
        (isDirectChild(target, '/mnt', 1, platform) ||
          isDirectChild(target, '/media', 2, platform) ||
          isDirectChild(target, '/run/media', 2, platform)))
    if (isMountedVolumeRoot) return 'a mounted volume root'
  }

  if (home && isSameOrWithin(home, workspace, platform)) {
    return 'a workspace rooted at or above the user profile or home directory'
  }

  return undefined
}

function sameFileIdentity(left: { dev: bigint; ino: bigint }, right: { dev: bigint; ino: bigint }): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/** 防护 + TOCTOU 校验后的回收站投递（V2 moveWorkspaceItemToTrash 同构；electron shell 缝由调用方注入）。 */
export async function moveItemToTrash(
  workspacePath: string,
  targetInput: string,
  trash: (target: string) => Promise<void>,
  context: TrashProtectionContext = {}
): Promise<{ path: string; type: 'file' | 'directory' }> {
  const platform = context.platform ?? process.platform
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const lexicalTargetPath = pathApi.resolve(
    pathApi.isAbsolute(targetInput) ? targetInput : pathApi.resolve(workspacePath, targetInput)
  )

  const protectedReason = getProtectedTrashTargetReason(lexicalTargetPath, workspacePath, context)
  if (protectedReason) {
    throw new Error(`Refusing to move protected path to trash (${protectedReason}): ${targetInput}`)
  }
  if (!isSameOrWithin(lexicalTargetPath, workspacePath, platform)) {
    throw new Error(`Refusing to move a path outside the session workspace: ${targetInput}`)
  }

  let initialStat: BigIntStats
  try {
    initialStat = await lstat(lexicalTargetPath, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Path not found: ${targetInput}`)
    }
    throw error
  }
  if (initialStat.isSymbolicLink()) {
    throw new Error(`Refusing to move a symbolic link to trash: ${targetInput}`)
  }
  if (!initialStat.isFile() && !initialStat.isDirectory()) {
    throw new Error(`Path is not a regular file or directory: ${targetInput}`)
  }

  const currentRealPath = await realpath(lexicalTargetPath)
  if (normalizeComparable(currentRealPath, platform) !== normalizeComparable(lexicalTargetPath, platform)) {
    throw new Error(`Path changed while preparing to move it to trash: ${targetInput}`)
  }
  const finalStat = await lstat(lexicalTargetPath, { bigint: true })
  if (!sameFileIdentity(initialStat, finalStat)) {
    throw new Error(`Path changed while preparing to move it to trash: ${targetInput}`)
  }

  await trash(lexicalTargetPath)
  return {
    path: pathApi.relative(pathApi.resolve(workspacePath), lexicalTargetPath),
    type: initialStat.isDirectory() ? 'directory' : 'file'
  }
}

export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'move_to_trash',
      description: DESCRIPTION,
      parameters: {
        path: {
          type: 'string',
          required: true,
          description:
            'Existing file or directory inside the session workspace. Relative paths resolve against the workspace root.'
        },
        ...escalationSchemaFields(ctx.sandboxPolicy.defaultMode)
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            type: { type: 'string', required: true },
            destination: { type: 'string', required: true },
            text: { type: 'string', required: true }
          }
        },
        render: (_args, value) => [{ type: 'text', text: value.text }]
      },
      async execute(args, exec) {
        const targetInput = String(args.path ?? '').trim()
        if (targetInput.length === 0) {
          throw new Error('move_to_trash: empty path')
        }
        const policy = await resolveCallPolicy(ctx, exec, args, 'move_to_trash', 'operation')
        ensureNotReadOnly(policy, 'operation')
        const workspacePath = policy.workspaceRoot
        const context: TrashProtectionContext = {
          homeDirectory: app.getPath('home'),
          downloadsDirectory: app.getPath('downloads'),
          protectedDirectories: [app.getPath('userData'), getDataPath()]
        }
        const result = await moveItemToTrash(workspacePath, targetInput, (target) => shell.trashItem(target), context)
        logger.info(`move_to_trash: "${result.path}" (${result.type}) from "${workspacePath}"`)
        return {
          path: result.path,
          type: result.type,
          destination: 'trash',
          text: `Moved "${result.path}" (${result.type}) to the operating-system trash.`
        }
      }
    })
  )
}
