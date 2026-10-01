/**
 * W4-4：快照里的"进行中操作"必须原样透传到解释结果。
 *
 * 背景：安装跑在主进程，而"正在安装 + 进度"此前只活在渲染层组件的局部 state 里——切走
 * `/code` 页面即销毁，回来时主进程还在装、渲染层却已认为空闲（按钮变回"可安装"、进度行不渲染）。
 * 主进程现在把它同步进快照，这里是这条数据接缝的回归门：一旦某个重构把 `operation` 丢掉
 * （V2 移植时丢过一次，见本文件头注），页面重挂载后的"正在安装"就会重新消失。
 *
 * 行为面（安装 → 切页 → 回页 仍显示进度）由真机验收承担；本文件只钉数据接缝。
 */
import type { InstallProgressPayload } from '@shared/types/installProgress'
import { describe, expect, it } from 'vitest'

import type { BinaryToolSnapshot } from '../binarySnapshot'
import { interpretBinarySnapshot } from '../binarySnapshot'

const progress: InstallProgressPayload = {
  tool: 'dsh',
  step: 'pip',
  detail: '12.3 MB / 40.0 MB',
  fraction: 0.31,
  stage: { index: 3, total: 6 }
}

const snapshot = (operation?: BinaryToolSnapshot['operation']): BinaryToolSnapshot => ({
  name: 'dsh',
  application: 'applied',
  availability: { source: 'managed', path: 'C:/x/dsh', version: '1.0.0' },
  ...(operation === undefined ? {} : { operation })
})

describe('interpretBinarySnapshot × 进行中操作（W4-4）', () => {
  it('带操作：operation 原样透传（含最后一次进度载荷）', () => {
    const view = interpretBinarySnapshot(snapshot({ kind: 'install', at: 1000, progress }), { latest: '1.0.0' })

    expect(view.operation?.kind).toBe('install')
    expect(view.operation?.at).toBe(1000)
    expect(view.operation?.progress?.step).toBe('pip')
    expect(view.operation?.progress?.fraction).toBe(0.31)
    expect(view.operation?.progress?.stage).toEqual({ index: 3, total: 6 })
  })

  it('无操作：字段缺省（不是 null/undefined 混用的假值）', () => {
    const view = interpretBinarySnapshot(snapshot(), { latest: '1.0.0' })

    expect('operation' in view).toBe(false)
  })

  it('卸载进行中同样透传（kind=remove）', () => {
    const view = interpretBinarySnapshot(snapshot({ kind: 'remove', at: 2000 }), {})

    expect(view.operation?.kind).toBe('remove')
    expect(view.operation?.progress).toBeUndefined()
  })
})
