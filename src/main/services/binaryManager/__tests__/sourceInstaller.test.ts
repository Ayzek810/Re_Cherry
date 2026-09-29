/**
 * v0.4.5 源码型安装器的依赖解析契约。
 *
 * 为什么这条契约值得单测：安装器**不做** `pip install -e .`（上游无 [build-system] 且
 * flat-layout 多顶层目录，打包发现会失败），而是只装 pyproject 的 dependencies 数组。
 * 于是"解析不出依赖"必须被显式识别——否则会装出一个空 venv，把失败推迟到启动时的
 * ImportError（用户读不懂）。解析为空 ⇒ 调用方 fail-closed 抛错，绝不猜依赖。
 */
import { describe, expect, it } from 'vitest'

import { parsePyprojectDependencies } from '../sourceInstaller'

// 上游 Tswoen/Paper-Agent 的 pyproject.toml 形状（每行一条带引号规格）。
const UPSTREAM_PYPROJECT = `[project]
name = "papers-agents"
version = "0.1.0"
description = "Add your description here"
readme = "README.md"
requires-python = ">=3.12"
dependencies = [
    "anthropic>=0.111.0",
    "chromadb>=1.5.9",
    "fastapi>=0.116.0",
    "httpx>=0.28.0",
    "langgraph>=1.2.6",
    "openai>=2.43.0",
    "pypdf>=5.0.0",
    "uvicorn>=0.35.0",
]
`

describe('parsePyprojectDependencies', () => {
  it('extracts every dependency spec from the upstream layout', () => {
    expect(parsePyprojectDependencies(UPSTREAM_PYPROJECT)).toEqual([
      'anthropic>=0.111.0',
      'chromadb>=1.5.9',
      'fastapi>=0.116.0',
      'httpx>=0.28.0',
      'langgraph>=1.2.6',
      'openai>=2.43.0',
      'pypdf>=5.0.0',
      'uvicorn>=0.35.0'
    ])
  })

  it('drops inline comments, trailing commas and quotes', () => {
    const text = `[project]
dependencies = [
    "fastapi>=0.116.0",  # web 框架
    'uvicorn>=0.35.0',
]`
    expect(parsePyprojectDependencies(text)).toEqual(['fastapi>=0.116.0', 'uvicorn>=0.35.0'])
  })

  it('returns nothing when the dependencies table is absent (caller fails closed)', () => {
    expect(parsePyprojectDependencies('[project]\nname = "x"\n')).toEqual([])
  })

  it('returns nothing for an empty dependencies array', () => {
    expect(parsePyprojectDependencies('[project]\ndependencies = []\n')).toEqual([])
  })

  it('ignores unquoted entries instead of guessing a spec', () => {
    const text = `[project]
dependencies = [
    fastapi>=0.116.0,
    "uvicorn>=0.35.0",
]`
    expect(parsePyprojectDependencies(text)).toEqual(['uvicorn>=0.35.0'])
  })

  it('does not read a same-named key from another table', () => {
    const text = `[project]
name = "x"

[tool.other]
dependencies = [
    "not-a-runtime-dep>=1.0.0",
]
`
    // 表作用域：`[project]` 里没有 dependencies ⇒ 解析为空（调用方 fail-closed）。出现在
    // 别的表里的同名键不属于运行时依赖契约，宁可报错也不装错东西。
    expect(parsePyprojectDependencies(text)).toEqual([])
  })

  it('stops at the next table header', () => {
    const text = `[project]
dependencies = [
    "fastapi>=0.116.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0.0",
]
`
    expect(parsePyprojectDependencies(text)).toEqual(['fastapi>=0.116.0'])
  })
})
