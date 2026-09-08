import {
  type CredentialInfo,
  CredentialProvider,
  type CredentialRecord,
  type CredentialRecordEntry,
  type CredentialRecordInfo,
  type CredentialRef,
  type ResolvedCredential
} from '@deepseek-ai/dsh-credentials'

/**
 * 将逗号拼接的多 key 字符串切分为去空后的数组（与渲染进程 splitApiKeyString 同语义：
 * 支持 \, 转义字面逗号）。单 key 或无 key 时分别返回单元素/空数组。
 */
function splitApiKeys(value: string): string[] {
  return value
    .split(/(?<!\\),/)
    .map((key) => key.trim())
    .map((key) => key.replace(/\\,/g, ','))
    .filter((key) => key.length > 0)
}

/**
 * 内存凭证提供者：密钥由渲染进程通过 IPC 推送，随应用会话存续。
 * 不落盘——密钥的持久化仍然归渲染进程的 settings store 管理，
 * 内核只在运行期持有解析所需的值。
 *
 * 支持多 key 轮换：渲染进程按 CS 约定以逗号拼接多把密钥推送
 * （provider.apiKey = "k1,k2,k3"），这里切分后逐请求轮换返回单把，
 * 使 chat 主路径真正使用单把 key（修复"逗号整串被当一把 key 发送"的断链）。
 * 单 key 场景行为不变。指针仅存于进程内（与会话同生命周期），不做持久化。
 */
export class CherryCredentialProvider extends CredentialProvider {
  private readonly values = new Map<CredentialRef, string[]>()
  private readonly lastUsedIndex = new Map<CredentialRef, number>()

  override async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const keys = this.values.get(ref)
    if (keys === undefined || keys.length === 0) {
      return undefined
    }
    const nextIndex = ((this.lastUsedIndex.get(ref) ?? -1) + 1) % keys.length
    this.lastUsedIndex.set(ref, nextIndex)
    return { value: keys[nextIndex], source: 'cherry' }
  }

  override async describe(ref: CredentialRef): Promise<CredentialInfo> {
    const keys = this.values.get(ref)
    const configured = keys !== undefined && keys.some((key) => key.length > 0)
    return {
      configured,
      source: configured ? 'cherry' : undefined,
      writable: true
    }
  }

  override async set(ref: CredentialRef, value: string): Promise<void> {
    const keys = splitApiKeys(value)
    if (keys.length === 0) {
      throw new Error(`cherry-credentials: refusing to store an empty value for ${String(ref)}`)
    }
    this.values.set(ref, keys)
    this.lastUsedIndex.set(ref, -1)
    this.ctx.emit('credentials/reference-updated', ref)
  }

  override async unset(ref: CredentialRef): Promise<void> {
    if (this.values.delete(ref) || this.lastUsedIndex.delete(ref)) {
      this.ctx.emit('credentials/reference-updated', ref)
    }
  }

  override async readRecord(): Promise<CredentialRecord | undefined> {
    return undefined
  }

  override async describeRecord(): Promise<CredentialRecordInfo> {
    return { configured: false, writable: true }
  }

  override async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return []
  }

  override async modifyRecord(): Promise<CredentialRecord | undefined> {
    return undefined
  }

  override async deleteRecord(): Promise<void> {}
}
