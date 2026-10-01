import { DEFAULT_SIDEBAR_ICONS } from '@renderer/config/sidebar'
import { describe, expect, it } from 'vitest'

import migrate from '../migrate'

describe('store migrations', () => {
  describe('migration 207: StepFun Anthropic-compatible host backfill', () => {
    it('backfills anthropicApiHost for existing StepFun providers', async () => {
      const state = {
        llm: {
          providers: [
            {
              id: 'stepfun',
              apiHost: 'https://api.stepfun.com'
            }
          ]
        },
        _persist: { version: 206, rehydrated: false }
      }

      const migrated: any = await migrate(state as any, 207)

      expect(migrated.llm.providers[0].anthropicApiHost).toBe('https://api.stepfun.com')
    })

    it('preserves existing StepFun anthropicApiHost customizations', async () => {
      const state = {
        llm: {
          providers: [
            {
              id: 'stepfun',
              apiHost: 'https://api.stepfun.com',
              anthropicApiHost: 'https://custom.example.com'
            }
          ]
        },
        _persist: { version: 206, rehydrated: false }
      }

      const migrated: any = await migrate(state as any, 207)

      expect(migrated.llm.providers[0].anthropicApiHost).toBe('https://custom.example.com')
    })
  })

  describe('migration 218: LocalPaddle default provider backfill', () => {
    it('appends missing default providers to the persisted array (local-paddle becomes visible)', async () => {
      const state = {
        preprocess: {
          providers: [
            { id: 'doc2x', name: 'Doc2X', apiKey: 'k' },
            { id: 'paddleocr', name: 'PaddleOCR', apiKey: '', apiHost: '' }
          ],
          defaultProvider: 'mineru'
        },
        _persist: { version: 217, rehydrated: false }
      }

      const migrated: any = await migrate(state as any, 218)
      const ids = migrated.preprocess.providers.map((p: { id: string }) => p.id)

      expect(ids).toContain('local-paddle')
      expect(ids).toContain('doc2x')
      expect(ids).toContain('paddleocr')
    })

    it('preserves user-modified provider entries while backfilling only missing ids', async () => {
      const state = {
        preprocess: {
          providers: [
            { id: 'doc2x', name: 'Doc2X', apiKey: 'user-key', apiHost: 'https://user.example.com' },
            { id: 'local-paddle', name: 'LocalPaddle' }
          ],
          defaultProvider: 'doc2x'
        },
        _persist: { version: 217, rehydrated: false }
      }

      const migrated: any = await migrate(state as any, 218)
      const doc2x = migrated.preprocess.providers.find((p: { id: string }) => p.id === 'doc2x')

      expect(doc2x.apiKey).toBe('user-key')
      expect(doc2x.apiHost).toBe('https://user.example.com')
      expect(migrated.preprocess.providers.filter((p: { id: string }) => p.id === 'local-paddle')).toHaveLength(1)
    })

    it('does not touch defaultProvider (user choice survives upgrade)', async () => {
      const state = {
        preprocess: {
          providers: [{ id: 'doc2x', name: 'Doc2X', apiKey: 'k' }],
          defaultProvider: 'doc2x'
        },
        _persist: { version: 217, rehydrated: false }
      }

      const migrated: any = await migrate(state as any, 218)

      expect(migrated.preprocess.defaultProvider).toBe('doc2x')
    })

    it('tolerates a missing or malformed preprocess slice', async () => {
      const noSlice: any = await migrate({ _persist: { version: 217, rehydrated: false } } as any, 218)
      const badSlice: any = await migrate(
        { preprocess: { providers: 'not-an-array' }, _persist: { version: 217, rehydrated: false } } as any,
        218
      )

      expect(noSlice.preprocess).toBeUndefined()
      expect(badSlice.preprocess.providers).toBe('not-an-array')
    })
  })

  describe('migration 223: codeCliConfigs backfill (v0.3.4-1 真机 TypeError 修复)', () => {
    it('backfills missing codeCliConfigs on persisted settings (old shape → {})', async () => {
      const state = {
        settings: { sidebarIcons: { visible: ['assistants'] } },
        _persist: { version: 222, rehydrated: false }
      }

      const migrated: any = await migrate(state as any, 223)

      expect(migrated.settings.codeCliConfigs).toEqual({})
    })

    it('preserves existing codeCliConfigs (user data survives upgrade)', async () => {
      const existing = { 'deepseek-harness': { providers: {}, current: null } }
      const state = {
        settings: { codeCliConfigs: existing },
        _persist: { version: 222, rehydrated: false }
      }

      const migrated: any = await migrate(state as any, 223)

      expect(migrated.settings.codeCliConfigs).toBe(existing)
    })

    it('tolerates a missing settings slice', async () => {
      const noSettings: any = await migrate({ _persist: { version: 222, rehydrated: false } } as any, 223)

      expect(noSettings.settings).toBeUndefined()
    })
  })

  describe('migration 225: VisionModel default provider backfill (v0.4.4 视觉模型文档处理)', () => {
    it('appends the missing vision-model entry to the persisted array', async () => {
      const state = {
        preprocess: {
          providers: [
            { id: 'doc2x', name: 'Doc2X', apiKey: 'k' },
            { id: 'local-paddle', name: 'LocalPaddle' }
          ],
          defaultProvider: 'mineru'
        },
        _persist: { version: 224, rehydrated: false }
      }

      const migrated: any = await migrate(state as any, 225)
      const ids = migrated.preprocess.providers.map((p: { id: string }) => p.id)

      expect(ids).toContain('vision-model')
      expect(ids).toContain('doc2x')
      expect(ids).toContain('local-paddle')
    })

    it('preserves user-modified entries (apiKey/visionModel survive) and does not duplicate', async () => {
      const state = {
        preprocess: {
          providers: [
            { id: 'doc2x', name: 'Doc2X', apiKey: 'user-key' },
            {
              id: 'vision-model',
              name: 'VisionModel',
              visionModel: { id: 'qwen-vl', name: 'Qwen-VL', provider: 'silicon' }
            }
          ],
          defaultProvider: 'doc2x'
        },
        _persist: { version: 224, rehydrated: false }
      }

      const migrated: any = await migrate(state as any, 225)
      const vision = migrated.preprocess.providers.filter((p: { id: string }) => p.id === 'vision-model')

      expect(vision).toHaveLength(1)
      expect(vision[0].visionModel).toEqual({ id: 'qwen-vl', name: 'Qwen-VL', provider: 'silicon' })
      expect(migrated.preprocess.providers.find((p: { id: string }) => p.id === 'doc2x').apiKey).toBe('user-key')
      expect(migrated.preprocess.defaultProvider).toBe('doc2x')
    })

    it('tolerates a missing or malformed preprocess slice', async () => {
      const noSlice: any = await migrate({ _persist: { version: 224, rehydrated: false } } as any, 225)
      const badSlice: any = await migrate(
        { preprocess: { providers: 'not-an-array' }, _persist: { version: 224, rehydrated: false } } as any,
        225
      )

      expect(noSlice.preprocess).toBeUndefined()
      expect(badSlice.preprocess.providers).toBe('not-an-array')
    })
  })

  describe('migration 227: defaultObsidianVault backfill (v0.4.7 Obsidian 集成移植)', () => {
    it('backfills missing defaultObsidianVault on persisted settings (old shape → null)', async () => {
      const state = {
        settings: { exportMenuOptions: { obsidian: true } },
        _persist: { version: 226, rehydrated: false }
      }

      const migrated: any = await migrate(state as any, 227)

      expect(migrated.settings.defaultObsidianVault).toBeNull()
    })

    it('preserves an existing defaultObsidianVault (user selection survives upgrade)', async () => {
      const state = {
        settings: { defaultObsidianVault: 'MyVault' },
        _persist: { version: 226, rehydrated: false }
      }

      const migrated: any = await migrate(state as any, 227)

      expect(migrated.settings.defaultObsidianVault).toBe('MyVault')
    })

    it('tolerates a missing settings slice', async () => {
      const noSettings: any = await migrate({ _persist: { version: 226, rehydrated: false } } as any, 227)

      expect(noSettings.settings).toBeUndefined()
    })
  })

  describe('migration 228: memory slice removal (v0.4.7 全局记忆废弃)', () => {
    it('removes the stale memory slice from persisted state', async () => {
      const state = {
        memory: { memoryConfig: { llmModel: { id: 'm', provider: 'p' } }, globalMemoryEnabled: true },
        settings: { enableQuickPanelTriggers: false },
        _persist: { version: 227, rehydrated: false }
      }

      const migrated: any = await migrate(state as any, 228)

      expect(migrated.memory).toBeUndefined()
      expect(migrated.settings.enableQuickPanelTriggers).toBe(false)
    })

    it('tolerates state without a memory slice', async () => {
      const migrated: any = await migrate(
        { settings: { enableQuickPanelTriggers: false }, _persist: { version: 227, rehydrated: false } } as any,
        228
      )

      expect(migrated.memory).toBeUndefined()
      expect(migrated.settings.enableQuickPanelTriggers).toBe(false)
    })
  })

  describe('migration 229: sidebar icon reconciliation + pinnedTabs backfill (r2-11 / r2-50)', () => {
    /**
     * 老账号升级路径的忠实复现：'209'（旧白名单）砍到 3 项 → '217' 补 knowledge →
     * '220' 补 translate/paintings → '222' 补 code。'notes' 只能由 '141' 补，而 '141' 排在
     * '209' 之前，这批账号永远补不回来——这正是 '229' 要修的形态。
     */
    const legacyVisibleAfter209to222 = ['assistants', 'minapp', 'files', 'knowledge', 'translate', 'paintings', 'code']

    it("restores the default sidebar icons an upgraded account lost ('notes')", async () => {
      const state = {
        settings: {
          sidebarIcons: {
            visible: [...legacyVisibleAfter209to222],
            disabled: ['memory']
          }
        },
        _persist: { version: 228, rehydrated: false }
      }

      const migrated: any = await migrate(state as any, 229)
      const visible: string[] = migrated.settings.sidebarIcons.visible

      expect(visible).toContain('notes')
      expect(new Set(visible).size).toBe(visible.length)
      // 新装默认表的每一项都在（升级路径收敛到与全新安装同一形态）
      expect(DEFAULT_SIDEBAR_ICONS.every((icon) => visible.includes(icon))).toBe(true)
    })

    it('keeps icons the user hid hidden, and does not duplicate existing ones', async () => {
      const state = {
        settings: {
          sidebarIcons: {
            visible: ['assistants', 'minapp', 'files', 'knowledge', 'translate', 'paintings', 'code'],
            disabled: ['notes']
          }
        },
        _persist: { version: 228, rehydrated: false }
      }

      const migrated: any = await migrate(state as any, 229)

      expect(migrated.settings.sidebarIcons.disabled).toEqual(['notes'])
      expect(migrated.settings.sidebarIcons.visible).not.toContain('notes')
    })

    it('backfills missing pinnedTabs on persisted settings (old shape → [])', async () => {
      const state = {
        settings: { sidebarIcons: { visible: [...legacyVisibleAfter209to222], disabled: [] } },
        _persist: { version: 228, rehydrated: false }
      }

      const migrated: any = await migrate(state as any, 229)

      expect(migrated.settings.pinnedTabs).toEqual([])
    })

    it('preserves an existing pinnedTabs (user pin set survives upgrade)', async () => {
      const pinned = [{ id: 'home', path: '/' }]
      const state = {
        settings: { pinnedTabs: pinned },
        _persist: { version: 228, rehydrated: false }
      }

      const migrated: any = await migrate(state as any, 229)

      expect(migrated.settings.pinnedTabs).toBe(pinned)
    })

    it('tolerates a missing or malformed settings slice', async () => {
      const noSettings: any = await migrate({ _persist: { version: 228, rehydrated: false } } as any, 229)
      const badIcons: any = await migrate(
        { settings: { sidebarIcons: 'not-an-object' }, _persist: { version: 228, rehydrated: false } } as any,
        229
      )

      expect(noSettings.settings).toBeUndefined()
      expect(badIcons.settings.sidebarIcons).toBe('not-an-object')
    })
  })
})
