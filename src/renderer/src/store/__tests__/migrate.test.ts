import { allMinApps } from '@renderer/config/minapps'
import { SYSTEM_PROVIDERS, SYSTEM_PROVIDERS_CONFIG } from '@renderer/config/providers'
import { DEFAULT_SIDEBAR_ICONS } from '@renderer/config/sidebar'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

  describe('migration 223: codeCliConfigs backfill (真机 TypeError 修复)', () => {
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

  describe('migration 225: VisionModel default provider backfill (视觉模型文档处理)', () => {
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

  describe('migration 227: defaultObsidianVault backfill (Obsidian 集成移植)', () => {
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

  describe('migration 228: memory slice removal (全局记忆废弃)', () => {
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

  describe('migration 229: sidebar icon reconciliation + pinnedTabs backfill', () => {
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

  describe(': addMiniApp 不把 config/minapps 的模块对象推进持久化状态', () => {
    // 分支 '68' 是最小的 addMiniApp 载体（`addMiniApp(state, 'notebooklm')`），
    // 且 'notebooklm' 仍在 config/minapps 的默认表里（'143' 的 'longcat' 已被裁掉，是 no-op）。
    const MINI_APP_ID = 'notebooklm'
    const baseState = () => ({
      minapps: { enabled: [], disabled: [], pinned: [] },
      llm: { providers: [] },
      _persist: { version: 67, rehydrated: false }
    })

    it('push 的是副本（值相等、引用不同）', async () => {
      const configured = allMinApps.find((app) => app.id === MINI_APP_ID)
      expect(configured).toBeDefined()

      const migrated: any = await migrate(baseState() as any, 68)
      const pushed = migrated.minapps.enabled.find((app: { id: string }) => app.id === MINI_APP_ID)

      expect(pushed).toBeDefined()
      expect(pushed).not.toBe(configured)
      expect(pushed).toEqual(configured)
      // 模块表没有被 push 时的任何写入污染
      expect(allMinApps.find((app) => app.id === MINI_APP_ID)).toEqual(configured)
    })

    it('已存在的 app 不会被重复添加（幂等）', async () => {
      const state = baseState()
      state.minapps.enabled = [allMinApps.find((app) => app.id === MINI_APP_ID) as never]

      const migrated: any = await migrate(state as any, 68)

      expect(migrated.minapps.enabled.filter((app: { id: string }) => app.id === MINI_APP_ID)).toHaveLength(1)
    })
  })

  describe(': 迁移分支抛错时留下 logger.error 面包屑（失败不再伪装成「无事可做」）', () => {
    const restores: Array<() => void> = []
    afterEach(() => {
      while (restores.length > 0) restores.pop()?.()
    })

    it("分支 '210' 抛错时写出 'migrate 210 error'（此前完全静默）", async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      restores.push(() => errorSpy.mockRestore())

      // 缺 llm 切片 → 分支 '210' 的 `state.llm.quickAssistantModel` 抛 TypeError，进 catch。
      const state = { _persist: { version: 209, rehydrated: false } }
      const migrated: any = await migrate(state as any, 210)

      const logged = errorSpy.mock.calls
        .flat()
        .map((arg) => String(arg))
        .join(' ')
      expect(logged).toContain('migrate 210 error')
      // 语义未变：仍然是「记日志 + 返回未修改的 state」
      expect(migrated).toBe(state)
    })

    it("分支 '211' 抛错时同样留痕（缺 settings 切片）", async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      restores.push(() => errorSpy.mockRestore())

      const state = { _persist: { version: 210, rehydrated: false } }
      await migrate(state as any, 211)

      const logged = errorSpy.mock.calls
        .flat()
        .map((arg) => String(arg))
        .join(' ')
      expect(logged).toContain('migrate 211 error')
    })
  })

  describe(': 迁移链不就地改写模块级默认 provider 表', () => {
    it('整链跑完（0 → 229）后 SYSTEM_PROVIDERS_CONFIG 分毫不动', async () => {
      // 快照：浅拷贝即可——迁移的写入都是**顶层字段赋值**（type / anthropicApiHost），
      // 嵌套对象（models）只做整表替换，`toEqual` 会连嵌套一起比对。
      const snapshot = Object.fromEntries(
        Object.entries(SYSTEM_PROVIDERS_CONFIG).map(([key, provider]) => [key, { ...(provider as object) }])
      )
      const grokTypeBefore = (SYSTEM_PROVIDERS_CONFIG.grok as { type: string }).type

      const state = {
        llm: { providers: [], settings: {} },
        settings: {},
        _persist: { version: 0, rehydrated: false }
      }

      // 整链：'174'/'176'/'200' 等分支会在同一趟里就地改写 provider 顶层字段。
      await migrate(state as any, 229)

      expect(
        Object.fromEntries(
          Object.entries(SYSTEM_PROVIDERS_CONFIG).map(([key, provider]) => [key, { ...(provider as object) }])
        )
      ).toEqual(snapshot)
      // 具名断言（可读性）：migrate '200' 会把 grok 的 type 改成 'openai-response'——那只该改 state 里的副本
      expect((SYSTEM_PROVIDERS_CONFIG.grok as { type: string }).type).toBe(grokTypeBefore)
    })

    it("分支 '38' 推入的 grok 走到 '98' 时仍是 state 自己的副本（就地写 type 不污染模块表）", async () => {
      const grokModule = SYSTEM_PROVIDERS_CONFIG.grok as { type: string }
      const grokInModuleArray = SYSTEM_PROVIDERS.find((provider) => provider.id === 'grok') as { type: string }
      // 前置：默认表里 grok 是 openai，而 '98' 会把所有 type='openai' 的 provider 改成 openai-compatible
      expect(grokModule.type).toBe('openai')
      expect(grokInModuleArray.type).toBe('openai')

      let state: any = {
        llm: { providers: [], settings: {} },
        minapps: { enabled: [], disabled: [], pinned: [] },
        _persist: { version: 37, rehydrated: false }
      }
      state = await migrate(state, 38) // addProvider('grok') → provider 进入 state
      expect(state.llm.providers.map((provider: { id: string }) => provider.id)).toContain('grok')

      state._persist.version = 97
      state = await migrate(state, 98) // 就地写 `provider.type = 'openai-compatible'`

      const inState = state.llm.providers.find((provider: { id: string }) => provider.id === 'grok')
      expect(inState.type).toBe('openai-compatible') // state 里的那行确实被改写
      // 两张模块表都分毫不动：config/providers.ts 的 SYSTEM_PROVIDERS 是迁移的取材表
      //（`addProvider`/`fixMissingProvider` 都从它取），它自己的对象也不能进 state。
      expect(grokInModuleArray.type).toBe('openai')
      expect(grokModule.type).toBe('openai')
    })

    it('addProvider 推入 state 的 provider 不是模块对象（改它不污染模块表）', async () => {
      const state = {
        llm: { providers: [], settings: {} },
        settings: {},
        _persist: { version: 0, rehydrated: false }
      }

      const migrated: any = await migrate(state as any, 229)
      const inState = migrated.llm.providers.find((provider: { id: string }) => provider.id === 'grok')

      expect(inState).toBeDefined()
      expect(inState).not.toBe(SYSTEM_PROVIDERS_CONFIG.grok)
      expect(inState.models).not.toBe((SYSTEM_PROVIDERS_CONFIG.grok as { models: unknown[] }).models)

      // 就地改 state 里的副本，模块表不受影响
      const grokModuleBefore = { ...(SYSTEM_PROVIDERS_CONFIG.grok as object) }
      inState.type = 'mutated-by-test'
      expect({ ...(SYSTEM_PROVIDERS_CONFIG.grok as object) }).toEqual(grokModuleBefore)
    })
  })
})
