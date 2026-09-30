import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

import { denyReadOnly, ensureNotReadOnly, escalationSchemaFields, resolveCallPolicy } from '../toolEscalation'

/**
 * toolEscalation 机测（v0.4.6）：档位闸 + 升级问询流（dsh-tool-fs 同编舞）。
 * ctx 以最小假体注入（sandboxPolicy.resolve + approval.request；结构化直传，
 * 调用点按 Context 断言——与内核机测的假缝惯例一致）。
 */

function makeCtx(options: { mode?: string; outcome?: string } = {}) {
  const resolved = { mode: options.mode ?? 'read-only', workspaceRoot: 'C:\\ws' }
  const requests: Array<Record<string, unknown>> = []
  const ctx = {
    sandboxPolicy: {
      defaultMode: 'read-only',
      resolve: (request?: { session?: unknown; mode?: string }) => {
        if (request?.mode !== undefined) return { ...resolved, mode: request.mode }
        return { ...resolved }
      }
    },
    approval: {
      request: vi.fn(async (req: Record<string, unknown>) => {
        requests.push(req)
        return options.outcome ?? 'allowed-once'
      })
    }
  }
  return { ctx: ctx as unknown as Context, requests }
}

const EXEC = {
  callId: 'call-1',
  rootCallId: 'call-1',
  name: 'move_to_trash',
  arguments: {},
  token: Symbol('token'),
  // approveEscalation fail-closed：无 agent 的执行一律拒绝问询——假体带上最小 agent。
  agent: { session: { events: [] } },
  signal: new AbortController().signal
} as unknown as Parameters<typeof resolveCallPolicy>[1]

describe('resolveCallPolicy', () => {
  it('无升级参数：返回站态档位，不产生问询', async () => {
    const { ctx, requests } = makeCtx({ mode: 'workspace-write' })
    const policy = await resolveCallPolicy(ctx, EXEC, { path: 'a.txt' }, 'move_to_trash', 'operation')
    expect(policy.mode).toBe('workspace-write')
    expect(policy.workspaceRoot).toBe('C:\\ws')
    expect(requests).toHaveLength(0)
  })

  it('升级参数 + 批准：档位抬升为本调用放行', async () => {
    const { ctx, requests } = makeCtx({ mode: 'read-only', outcome: 'allowed-once' })
    const policy = await resolveCallPolicy(
      ctx,
      EXEC,
      { sandbox_permissions: 'workspace-write', justification: '用户已确认删除该产物' },
      'move_to_trash',
      'operation'
    )
    expect(policy.mode).toBe('workspace-write')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ toolName: 'move_to_trash', callId: 'call-1' })
  })

  it('升级参数 + 拒绝：fail-closed 抛错（不执行）', async () => {
    const { ctx } = makeCtx({ mode: 'read-only', outcome: 'rejected' })
    await expect(
      resolveCallPolicy(
        ctx,
        EXEC,
        { sandbox_permissions: 'workspace-write', justification: 'reason' },
        'move_to_trash',
        'operation'
      )
    ).rejects.toThrow()
  })

  it('升级参数缺 justification：配对校验失败', async () => {
    const { ctx, requests } = makeCtx({ mode: 'read-only' })
    await expect(
      resolveCallPolicy(ctx, EXEC, { sandbox_permissions: 'workspace-write' }, 'move_to_trash', 'operation')
    ).rejects.toThrow()
    expect(requests).toHaveLength(0)
  })

  it('非放宽请求（同档位）不问询直接失败', async () => {
    const { ctx, requests } = makeCtx({ mode: 'workspace-write' })
    await expect(
      resolveCallPolicy(
        ctx,
        EXEC,
        { sandbox_permissions: 'workspace-write', justification: 'same' },
        'move_to_trash',
        'operation'
      )
    ).rejects.toThrow()
    expect(requests).toHaveLength(0)
  })
})

describe('denyReadOnly / ensureNotReadOnly', () => {
  it('read-only 拒绝带沙箱标记 + 升级提示（denyReadOnly 构造错误面）', () => {
    const error = denyReadOnly('operation')
    expect(error.message).toContain('[sandbox: file access denied under read-only mode]')
    expect(error.message).toContain('sandbox_permissions')
    expect(error.code).toBe('FS_SANDBOX_DENIED')
  })

  it('ensureNotReadOnly：read-only 抛、workspace-write 放行', () => {
    expect(() => ensureNotReadOnly({ mode: 'read-only', workspaceRoot: 'C:\\ws' }, 'operation')).toThrow()
    expect(
      ensureNotReadOnly({ mode: 'danger-full-access', workspaceRoot: 'C:\\ws' }, 'operation').mode
    ).toBe('danger-full-access')
  })
})

describe('escalationSchemaFields', () => {
  it('枚举 = 站态档位的严格放宽集（fork 部署缺省 read-only）', () => {
    const fields = escalationSchemaFields('read-only')
    expect(fields.sandbox_permissions).toMatchObject({ type: 'string' })
    const spec = fields.sandbox_permissions as { enum: readonly string[] }
    expect(spec.enum).toEqual(['workspace-write', 'danger-full-access'])
    expect(fields.justification).toBeDefined()
  })
})
