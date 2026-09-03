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
 * 内存凭证提供者：密钥由渲染进程通过 IPC 推送，随应用会话存续。
 * 不落盘——密钥的持久化仍然归渲染进程的 settings store 管理，
 * 内核只在运行期持有解析所需的值。
 */
export class CherryCredentialProvider extends CredentialProvider {
  private readonly values = new Map<CredentialRef, string>()

  override async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(ref)
    return value === undefined || value.length === 0 ? undefined : { value, source: 'cherry' }
  }

  override async describe(ref: CredentialRef): Promise<CredentialInfo> {
    const value = this.values.get(ref)
    return {
      configured: value !== undefined && value.length > 0,
      source: value === undefined ? undefined : 'cherry',
      writable: true
    }
  }

  override async set(ref: CredentialRef, value: string): Promise<void> {
    if (value.length === 0) {
      throw new Error(`cherry-credentials: refusing to store an empty value for ${String(ref)}`)
    }
    this.values.set(ref, value)
    this.ctx.emit('credentials/reference-updated', ref)
  }

  override async unset(ref: CredentialRef): Promise<void> {
    if (this.values.delete(ref)) {
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
