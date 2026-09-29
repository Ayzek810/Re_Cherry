/**
 * v0.4.5-1 安装进度阶段位置的契约（进度条"分段"的算术基础）。
 *
 * 这一件守的是"不许编进度"：阶段位置只能来自本次安装真会走的步骤序列——不在序列里就返回
 * undefined（调用方降级为只报步骤名），绝不猜一个位置。真机判据是"进度条要动，但不能假"。
 */
import { describe, expect, it } from 'vitest'

import {
  buildInstallProgressPayload,
  createStageTracker,
  INSTALL_PROGRESS_STEPS,
  stagePosition
} from '../installProgress'

describe('INSTALL_PROGRESS_STEPS', () => {
  it('holds every step name once (the vocabulary is the single source of step names)', () => {
    expect(new Set(INSTALL_PROGRESS_STEPS).size).toBe(INSTALL_PROGRESS_STEPS.length)
  })
})

describe('stagePosition', () => {
  it('numbers the stages of one install from 1', () => {
    const hermes = ['runtime', 'extract', 'venv', 'pip'] as const
    expect(stagePosition(hermes, 'runtime')).toEqual({ index: 1, total: 4 })
    expect(stagePosition(hermes, 'pip')).toEqual({ index: 4, total: 4 })
  })

  it('follows the pipeline it is given, not a fixed order', () => {
    // paper-agent 的阶段序列是按需组的（venv 只有要建时才在序列里），所以同一步骤在不同
    // 序列里的位置可以不同——位置描述的是"这次装到哪一步"，不是一张全局表。
    const withoutVenv = ['runtime', 'extract', 'source', 'unpack', 'deps', 'front', 'build', 'deploy'] as const
    const withVenv = ['runtime', 'extract', 'source', 'unpack', 'venv', 'deps', 'front', 'build', 'deploy'] as const
    expect(stagePosition(withoutVenv, 'deps')).toEqual({ index: 5, total: 8 })
    expect(stagePosition(withVenv, 'deps')).toEqual({ index: 6, total: 9 })
  })

  it('returns undefined for a step outside the pipeline instead of inventing a position', () => {
    expect(stagePosition(['runtime', 'extract', 'venv', 'pip'], 'ppt')).toBeUndefined()
    expect(stagePosition([], 'runtime')).toBeUndefined()
  })
})

describe('buildInstallProgressPayload', () => {
  it('carries every field the sender provided', () => {
    expect(
      buildInstallProgressPayload('dsh', 'extract', {
        detail: '43% · 12.3/30.5 MB',
        fraction: 0.43,
        stage: { index: 2, total: 6 }
      })
    ).toEqual({
      tool: 'dsh',
      step: 'extract',
      detail: '43% · 12.3/30.5 MB',
      fraction: 0.43,
      stage: { index: 2, total: 6 }
    })
  })

  it('keeps stage even when the stage carries no measurable fraction (the segmented bar is the point)', () => {
    // 回归护栏：stage 曾在主进程里被对象展开悄悄丢掉（spread 绕过多余属性检查），
    // 于是"分段进度条"这一整条链路在渲染层永远收不到数据。
    expect(buildInstallProgressPayload('hermes', 'pip', { stage: { index: 4, total: 4 } })).toEqual({
      tool: 'hermes',
      step: 'pip',
      stage: { index: 4, total: 4 }
    })
  })

  it('omits absent fields instead of sending undefined', () => {
    const payload = buildInstallProgressPayload('paper-agent', 'front')
    expect(payload).toEqual({ tool: 'paper-agent', step: 'front' })
    expect(Object.keys(payload)).toEqual(['tool', 'step'])
  })

  it('refuses a fraction the renderer cannot turn into a width', () => {
    expect(buildInstallProgressPayload('dsh', 'runtime', { fraction: Number.NaN }).fraction).toBeUndefined()
    expect(
      buildInstallProgressPayload('dsh', 'runtime', { fraction: Number.POSITIVE_INFINITY }).fraction
    ).toBeUndefined()
    // 0 是合法比例（"这一段刚开始"），不能被当成缺省丢掉。
    expect(buildInstallProgressPayload('dsh', 'runtime', { fraction: 0 }).fraction).toBe(0)
  })

  it('drops an empty detail string', () => {
    expect(buildInstallProgressPayload('dsh', 'runtime', { detail: '' }).detail).toBeUndefined()
  })
})

describe('createStageTracker', () => {
  const paperAgent = ['runtime', 'extract', 'source', 'unpack', 'venv', 'deps', 'front', 'build', 'deploy'] as const

  it('advances through the pipeline as the install enters each step', () => {
    const enter = createStageTracker(paperAgent)
    expect(enter('runtime').stage).toEqual({ index: 1, total: 9 })
    expect(enter('extract').stage).toEqual({ index: 2, total: 9 })
    expect(enter('source').stage).toEqual({ index: 3, total: 9 })
    expect(enter('unpack').stage).toEqual({ index: 4, total: 9 })
  })

  it('never lets the bar move backwards when a step is entered twice', () => {
    // 真机形态：paper-agent 先下载+解压 CPython（runtime → extract），再下载+解压受管 node
    // （又一轮 runtime → extract）。第二次的步骤名指向已走过的段——条停在最远处（记 held）。
    const enter = createStageTracker(paperAgent)
    enter('runtime')
    enter('extract')
    const second = enter('runtime')
    expect(second.held).toBe(true)
    expect(second.stage).toEqual({ index: 2, total: 9 })
    const secondExtract = enter('extract')
    expect(secondExtract.held).toBe(false)
    expect(secondExtract.stage).toEqual({ index: 2, total: 9 })
    // 真正的下一步仍然能前进。
    expect(enter('source').stage).toEqual({ index: 3, total: 9 })
  })

  it('reports a step outside the pipeline as no position at all', () => {
    const enter = createStageTracker(['runtime', 'extract', 'venv', 'pip'])
    expect(enter('ppt')).toEqual({ held: false })
    // 越界的一步不改变已到达的位置：下一步照旧前进。
    expect(enter('pip').stage).toEqual({ index: 4, total: 4 })
  })
})
