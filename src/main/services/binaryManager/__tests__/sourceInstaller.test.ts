/**
 * 源码型安装器的依赖解析契约 + 源码获取契约。
 *
 * 为什么这两条契约值得单测：
 * ① 依赖解析：安装器**不做** `pip install -e .`（上游无 [build-system] 且 flat-layout 多顶层
 *    目录，打包发现会失败），而是只装 pyproject 的 dependencies 数组。于是"解析不出依赖"必须
 *    被显式识别——否则会装出一个空 venv，把失败推迟到启动时的 ImportError（用户读不懂）。
 *    解析为空 ⇒ 调用方 fail-closed 抛错，绝不猜依赖。
 * ② 源码获取（）：官方 codeload 之外允许用户配置镜像前缀，而镜像取回的内容必须能被证伪
 *    ——顶层目录名带我们钉的 SHA，对不上即拒绝（否则第三方代理可以把别的提交塞进构建链）。
 */
import { describe, expect, it } from 'vitest'

import {
  parseGithubMirrorPrefixes,
  parsePyprojectDependencies,
  selectSourceTreeEntry,
  sourceArchiveUrls
} from '../sourceInstaller'

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

const SHA = 'a'.repeat(40)
const OFFICIAL = `https://codeload.github.com/Tswoen/Paper-Agent/zip/${SHA}`
const ACCELERATED = `https://ghfast.top/https://github.com/Tswoen/Paper-Agent/archive/${SHA}.zip`

describe('源码归档来源（加速前缀 + 官方回退）', () => {
  it('defaults to the built-in acceleration prefix with the official host as fallback', () => {
    // 用户裁决（2026-09-29）：加速前缀 https://ghfast.top/https://github.com；
    // 回退 = 官方 codeload（加速服务抖动/下线时安装不至于失败）。
    expect(sourceArchiveUrls('Tswoen/Paper-Agent', SHA, {})).toEqual([ACCELERATED, OFFICIAL])
  })

  it('composes a ghproxy-style prefix onto the full github archive URL', () => {
    const urls = sourceArchiveUrls('Tswoen/Paper-Agent', SHA, {
      RC_GITHUB_MIRROR: 'https://ghproxy.net/, https://ghfast.top'
    })
    expect(urls).toEqual([
      `https://ghproxy.net/https://github.com/Tswoen/Paper-Agent/archive/${SHA}.zip`,
      `https://ghfast.top/https://github.com/Tswoen/Paper-Agent/archive/${SHA}.zip`,
      OFFICIAL
    ])
  })

  it('lets RC_GITHUB_MIRROR=none turn acceleration off entirely', () => {
    expect(sourceArchiveUrls('Tswoen/Paper-Agent', SHA, { RC_GITHUB_MIRROR: 'none' })).toEqual([OFFICIAL])
    expect(sourceArchiveUrls('Tswoen/Paper-Agent', SHA, { RC_GITHUB_MIRROR: 'OFF' })).toEqual([OFFICIAL])
  })

  it('normalizes prefixes: trims, drops trailing slashes, dedupes, ignores non-http entries', () => {
    expect(parseGithubMirrorPrefixes(' https://a.test/ , https://a.test , file:///tmp ,  ,ftp://x')).toEqual([
      'https://a.test'
    ])
    expect(parseGithubMirrorPrefixes(undefined)).toEqual([])
  })
})

describe('归档顶层目录校验（镜像取回的内容必须能被证伪）', () => {
  it('accepts exactly <Repo>-<sha>', () => {
    expect(selectSourceTreeEntry([`Paper-Agent-${SHA}`], 'Paper-Agent', SHA)).toBe(`Paper-Agent-${SHA}`)
  })

  it('rejects a different commit (a proxy served something else)', () => {
    expect(() => selectSourceTreeEntry([`Paper-Agent-${'b'.repeat(40)}`], 'Paper-Agent', SHA)).toThrow(
      /Unexpected source archive content/
    )
  })

  it('rejects an unexpected number of top-level entries', () => {
    expect(() => selectSourceTreeEntry([`Paper-Agent-${SHA}`, 'extra'], 'Paper-Agent', SHA)).toThrow(
      /Unexpected source archive layout/
    )
    expect(() => selectSourceTreeEntry([], 'Paper-Agent', SHA)).toThrow(/Unexpected source archive layout/)
  })

  it('falls back to a prefix match when no SHA is pinned', () => {
    expect(selectSourceTreeEntry(['Paper-Agent-main'], 'Paper-Agent')).toBe('Paper-Agent-main')
    expect(() => selectSourceTreeEntry(['Other-main'], 'Paper-Agent')).toThrow(/Unexpected source archive content/)
  })
})
