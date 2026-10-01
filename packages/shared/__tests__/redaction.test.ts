import { describe, expect, it } from 'vitest'

import { REDACTED, redactSecretText } from '../utils/redaction'

/**
 * k2-26 的行为证据：`redactSecretText` 的真实调用点喂的是自由文本（子进程诊断输出、
 * provider 错误体、IPC handler 的入参摘要），而 provider 常把 `sk-…` 原文回显在
 * `{"error":{"message":"Incorrect API key provided: sk-…"}}` 这样的**值**里——
 * 没有 `key: value` 对可供旧的键名正则锚定。旧实现原样放行（实测），
 * 却给调用方一个"已清洗"的假信号，比不调用更危险。
 */
describe('redactSecretText 值形状兜底（k2-26）', () => {
  it('脱敏 JSON 错误体里回显的 OpenAI 风格密钥', () => {
    const body = '{"error":{"message":"Incorrect API key provided: sk-abcdef123456"}}'
    const out = redactSecretText(body)
    expect(out).not.toContain('sk-abcdef123456')
    expect(out).toContain(REDACTED)
  })

  it('脱敏裸文本里的各厂商前缀密钥（GitHub / Slack / Google / HF）', () => {
    const text = [
      'auth failed for ghp_abcdefghijklmnopqrstuvwxyz0123',
      'slack token xoxb-1234567890-abcdefghij rejected',
      'google key AIzaSyA1234567890abcdefghijklmnopqrs is invalid',
      'hf_abcdefghijklmnopqrstuvwxyz not accepted'
    ].join('\n')
    const out = redactSecretText(text)
    for (const secret of [
      'ghp_abcdefghijklmnopqrstuvwxyz0123',
      'xoxb-1234567890-abcdefghij',
      'AIzaSyA1234567890abcdefghijklmnopqrs',
      'hf_abcdefghijklmnopqrstuvwxyz'
    ]) {
      expect(out).not.toContain(secret)
    }
  })

  it('键名配对路径不被兜底替换破坏（既有契约保持）', () => {
    const out = redactSecretText('apiKey: sk-abcdef123456')
    expect(out).toBe(`apiKey: "${REDACTED}"`)
  })

  it('不吞掉普通散文与版本号（兜底只认厂商前缀形状）', () => {
    const text = 'the sk-learn guide and build v1.0.1-rc.2 are unrelated to secrets'
    expect(redactSecretText(text)).toBe(text)
  })
})
