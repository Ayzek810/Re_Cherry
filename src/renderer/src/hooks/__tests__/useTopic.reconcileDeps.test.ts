/**
 * the reconciliation effect keeps a narrowed dependency, not the whole assistant object.
 * The line is part of the reconciliation umbrella contract (same gate style as
 * services/__tests__/topicAuthorityGate.test.ts), so it is pinned at the source level and the
 * behavioural outcome stays covered by useTopic.authority.test.ts.
 */
import { readFileSync } from 'node:fs'
import { sep } from 'node:path'

import { describe, expect, it } from 'vitest'

const repoRoot = process.cwd()
const readUseTopicSource = (): string => readFileSync(repoRoot + sep + 'src/renderer/src/hooks/useTopic.ts', 'utf8')

/** Dependencies of the effect whose first statement awaits kernelRootTopics(). */
function reconcileEffectDependencies(): string {
  const source = readUseTopicSource()
  const anchor = source.indexOf('await kernelRootTopics()')
  expect(anchor).toBeGreaterThan(-1)
  const deps = source.slice(anchor).match(/\n\s*\}, \[([^\]]*)\]\)/)
  expect(deps).not.toBeNull()
  return deps![1]
}

describe('useActiveTopic reconciliation effect dependencies', () => {
  it('depends on assistant?.topics, not the whole assistant object', () => {
    const deps = reconcileEffectDependencies()
    expect(deps).toContain('assistant?.topics')
    expect(deps.split(',').map((part) => part.trim())).not.toContain('assistant')
  })

  it('still reads assistant?.topics and assistantId (inputs unchanged)', () => {
    expect(readUseTopicSource()).toContain('const rows = assistant?.topics')
    expect(reconcileEffectDependencies()).toContain('assistantId')
  })
})
