/**
 * 自定义工具的沙箱档位闸（v0.4.6，move_to_trash / save_attachment 共用）。
 *
 * 复用 dsh-tool-fs 确立的升级编舞（词汇表在 @deepseek-ai/dsh-sandbox 公开导出）：
 * 站态档位由 ctx.sandboxPolicy.resolve({session}) 解析（会话 cwd 即工作区边界）；
 * read-only 档下未带升级参数的副作用按 FS_SANDBOX_DENIED 拒绝并附同轮升级提示，
 * 模型带 `sandbox_permissions`+`justification` 重发后经 ctx.approval 问询拿本调用放行。
 * workspace-write / danger-full-access 档自动放行（三档语义见 @shared/config/workMode）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import {
  approveEscalation,
  ESCALATION_TARGETS,
  escalationHintMarker,
  sandboxDenialMarker,
  validateEscalationArgs,
  WIDER_MODES
} from '@deepseek-ai/dsh-sandbox'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'

/** 与 dsh-tool-fs write/edit 的 schema 完全同形（词表随 dsh-sandbox 演进）。 */
export function escalationSchemaFields(defaultMode: SandboxMode): ParameterSchemaSpec {
  const modes = WIDER_MODES[defaultMode] ?? ESCALATION_TARGETS
  return {
    sandbox_permissions: {
      type: 'string',
      enum: [...modes],
      description:
        'The wider sandbox mode this file operation needs. Only valid as a one-shot retry of an operation the ' +
        'sandbox just denied; requires justification and user approval.'
    },
    justification: {
      type: 'string',
      description:
        'Required with sandbox_permissions: one sentence for the user explaining why this exact file operation needs the wider access.'
    }
  }
}

interface EscalationArgs {
  sandbox_permissions?: unknown
  justification?: unknown
}

/** 从 defineTool 解析参数里取升级字段（schema 经展开合入，TS 推断看不到字面量键）。 */
function readEscalationArgs(args: unknown): {
  sandboxPermissions: string | undefined
  justification: string | undefined
} {
  const source = (typeof args === 'object' && args !== null ? args : {}) as EscalationArgs
  return {
    sandboxPermissions: source.sandbox_permissions === undefined ? undefined : String(source.sandbox_permissions),
    justification: source.justification === undefined ? undefined : String(source.justification)
  }
}

/**
 * 解析本次调用的档位：带升级参数则走问询（严格放宽 + fail-closed），
 * 否则直接返回站态档位。read-only 档未升级的副作用由调用方经 denyReadOnly 处理。
 */
export async function resolveCallPolicy(
  ctx: Context,
  exec: ToolRunContext,
  args: unknown,
  toolName: string,
  subject: string
): Promise<SandboxExecutionPolicy> {
  const { sandboxPermissions, justification } = readEscalationArgs(args)
  validateEscalationArgs(sandboxPermissions, justification)
  const session = exec.agent?.session
  const policy = ctx.sandboxPolicy.resolve(session === undefined ? {} : { session })
  if (sandboxPermissions === undefined || justification === undefined) {
    return policy
  }
  const approvedMode = await approveEscalation(
    {
      requestedMode: sandboxPermissions,
      justification,
      effectiveMode: policy.mode,
      subject
    },
    {
      approver: ctx.approval ?? undefined,
      agent: exec.agent,
      callId: exec.callId,
      toolName,
      signal: exec.signal
    }
  )
  return { ...policy, mode: approvedMode }
}

/**
 * read-only 档下未升级的副作用统一拒绝面：与 dsh-tool-fs 的 FS_SANDBOX_DENIED
 * 文本同源（[sandbox: …] 标记 + 同轮升级提示），模型据提示带参重发。
 */
export function denyReadOnly(subject: string): FsError {
  return new FsError(`${sandboxDenialMarker('read-only')}\n${escalationHintMarker(subject)}`, 'FS_SANDBOX_DENIED')
}

/** 站态/升级档位收敛后的副作闸门：read-only 即拒绝，返回实际放行档位。 */
export function ensureNotReadOnly(policy: SandboxExecutionPolicy, subject: string): SandboxExecutionPolicy {
  if (policy.mode === 'read-only') {
    throw denyReadOnly(subject)
  }
  return policy
}
