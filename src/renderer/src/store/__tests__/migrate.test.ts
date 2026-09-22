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
})
