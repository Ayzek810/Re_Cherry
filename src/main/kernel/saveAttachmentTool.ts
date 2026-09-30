/**
 * save_attachment 工作模式外置工具（v0.4.6）。
 *
 * V2 saveAttachment.ts 同构物：把本轮附件（FILE 附件，read_document 同一登记）的原始
 * 字节复制为工作区**新**文件，工作模式 fs 工具链从此可以加工它。边界与安全设计照抄：
 * 输出路径强制工作区相对（拒绝对路径/`..` 段/Windows 非法字符段）、父目录必须已存在、
 * 目标 wx 独占创建（no-clobber，EEXIST 具名报错）、复制失败清零回滚。
 *
 * 档位语义与 move_to_trash 一致：workspace-write / danger 自动，read-only 拒绝 + 升级提示。
 * 图片附件不在此工具面（已是上下文图像，走 describe_images/视觉直读）。
 */
import { open, stat, unlink } from 'node:fs/promises'
import path from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { loggerService } from '@logger'

import { knowledgeService } from '../services/knowledge/KnowledgeService'
import { ensureNotReadOnly, escalationSchemaFields, resolveCallPolicy } from './toolEscalation'

const logger = loggerService.withContext('SaveAttachmentTool')

export const name = 'tool-save-attachment'
// execute 里读到的每个 cordis Service 都必须在此声明（get 走 inject 声明制）。
export const inject = ['tools', 'sandboxPolicy', 'approval']

const DESCRIPTION =
  'Copy the original bytes of one file attached to this conversation into a new file in the session workspace. ' +
  'Pass the attachment name exactly as listed under "Attached documents" and a workspace-relative destination ' +
  'path whose parent directory already exists. Never overwrites an existing file.'

const WINDOWS_INVALID_FILENAME_CHARACTERS = '<>:"|?*'

/** V2 hasWindowsInvalidFilenameSegment 同语义：任一段含 Windows 非法字符或控制字符。 */
export function hasWindowsInvalidFilenameSegment(filePath: string): boolean {
  const pathWithoutDriveRoot = /^[A-Za-z]:[\\/]/.test(filePath) ? filePath.slice(2) : filePath
  return pathWithoutDriveRoot
    .split(/[\\/]+/)
    .some((segment) =>
      Array.from(segment).some(
        (character) => WINDOWS_INVALID_FILENAME_CHARACTERS.includes(character) || character.charCodeAt(0) <= 0x1f
      )
    )
}

/**
 * 输出路径校验（V2 saveAttachmentInputSchema 同语义，非 zod 形态）：强制工作区相对、
 * 禁 `..` 段、禁 Windows 非法字符段。返回规范化后的工作区相对路径（正斜杠分隔）。
 */
export function validateOutputPath(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new Error('save_attachment: output_path must be a string')
  }
  const candidate = raw.trim()
  if (candidate.length === 0 || candidate.length > 4096) {
    throw new Error('save_attachment: output_path must be 1..4096 characters')
  }
  if (/^(?:[/\\]|[A-Za-z]:)/.test(candidate)) {
    throw new Error(`save_attachment: output_path must be workspace-relative, got "${candidate}"`)
  }
  if (candidate.split(/[\\/]+/).some((segment) => segment === '..')) {
    throw new Error(`save_attachment: output_path must not traverse outside the workspace, got "${candidate}"`)
  }
  if (hasWindowsInvalidFilenameSegment(candidate)) {
    throw new Error(`save_attachment: output_path contains characters invalid in Windows filenames, got "${candidate}"`)
  }
  return candidate.split(path.sep).join('/')
}

/** wx 独占复制：目标已存在（EEXIST）具名报错；失败删除半成品（本工具刚创建的文件）。 */
export async function copyNoClobber(sourcePath: string, outputPath: string, signal?: AbortSignal): Promise<void> {
  let handle
  try {
    handle = await open(outputPath, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`save_attachment: destination already exists: ${outputPath}`)
    }
    throw error
  }
  try {
    // 整读复制（附件体积受准入预算约束）：单次 handle.writeFile，避免双流生命周期管理。
    const source = await open(sourcePath, 'r')
    try {
      const size = (await source.stat()).size
      const buffer = Buffer.alloc(size)
      let offset = 0
      while (offset < size) {
        const { bytesRead } = await source.read(buffer, offset, size - offset, offset)
        if (bytesRead === 0) break
        offset += bytesRead
      }
      await handle.writeFile(buffer.subarray(0, offset))
    } finally {
      await source.close()
    }
    await handle.close()
  } catch (error) {
    await handle.close().catch(() => undefined)
    await unlink(outputPath).catch(() => undefined)
    throw error
  }
  if (signal?.aborted) {
    await unlink(outputPath).catch(() => undefined)
    const abortError = new Error('The operation was aborted.')
    abortError.name = 'AbortError'
    throw abortError
  }
}

export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'save_attachment',
      description: DESCRIPTION,
      parameters: {
        document: {
          type: 'string',
          required: true,
          description: 'The attachment name, quoted exactly as listed under "Attached documents".'
        },
        output_path: {
          type: 'string',
          required: true,
          description:
            'New workspace-relative file path. Its parent directory must exist and the destination must not already exist.'
        },
        ...escalationSchemaFields(ctx.sandboxPolicy.defaultMode)
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            bytes: { type: 'number', required: true },
            text: { type: 'string', required: true }
          }
        },
        render: (_args, value) => [{ type: 'text', text: value.text }]
      },
      async execute(args, exec) {
        const documentName = String(args.document ?? '').trim()
        if (documentName.length === 0) {
          throw new Error('save_attachment: empty attachment name')
        }
        const outputPath = validateOutputPath(args.output_path)
        const topicId = exec.agent?.session?.id
        if (topicId === undefined) {
          throw new Error('save_attachment: no active conversation turn')
        }
        const turnDocuments = knowledgeService.getTurnDocuments(topicId) ?? []
        const document = turnDocuments.find((candidate) => candidate.name === documentName || candidate.path === documentName)
        if (document === undefined) {
          const available = turnDocuments.map((candidate) => `"${candidate.name}"`).join(', ') || '(none)'
          throw new Error(
            `save_attachment: no attached document named "${documentName}" (attached documents: ${available})`
          )
        }

        const policy = await resolveCallPolicy(ctx, exec, args, 'save_attachment', 'operation')
        ensureNotReadOnly(policy, 'operation')
        const workspacePath = policy.workspaceRoot

        const destination = path.resolve(workspacePath, outputPath)
        const parent = path.dirname(destination)
        // V2 语义：父目录必须已存在（auto-mkdir 会掩盖模型拼错的路径）。
        const parentStat = await stat(parent).catch(() => undefined)
        if (parentStat === undefined || !parentStat.isDirectory()) {
          throw new Error(`save_attachment: parent directory does not exist: ${path.dirname(outputPath)}`)
        }
        await copyNoClobber(document.path, destination, exec.signal)
        const bytes = (await stat(destination)).size
        logger.info(`save_attachment: "${document.name}" -> "${outputPath}" (${bytes} bytes)`)
        return {
          path: outputPath,
          bytes,
          text: `Saved attached file "${document.name}" to "${outputPath}" (${bytes} bytes).`
        }
      }
    })
  )
}
