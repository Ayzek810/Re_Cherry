/**
 * LocalPaddle 模型仓（v0.4.4 收编：合并原 services/localModel 的 localModelService
 * + ocrPaths + ocrInferenceService 三文件——「本地模型系统」的通用壳不存在了，
 * 这里就是文档处理通道 local-paddle 条目的模型盘与下载生命周期）。
 *
 * 状态机 not_downloaded | downloading | ready | error | unsupported；盘 = 真相源，
 * 重启无状态。.tmp + rename 原子落盘，minBytes 拒 LFS 指针/错误页；镜像逐文件
 * 回退（顺序见 modelAssets）。下载失败不清理模型目录：先前已完成的权重保留，
 * 就绪探测（三文件齐）天然挡住半成品。
 *
 * 存储：{userData}/Runtime/models/pp-ocrv6——故意放 Data/ 之外（BackupManager
 * 全量备份 Data，140MB 权重不该进备份包）。删除前先终止活着的 OCR 子进程
 * （Windows 打开句柄会让 unlink 失败——原 ocrInferenceService 的唯一存在理由，
 * 直接调 localOcr.terminateActiveOcrProcess，不再有中间层）。
 *
 * onnxruntime 二进制不下载：dev 下直接用 node_modules 的原生绑定；安装版依赖
 * electron-builder 收集 + asarUnpack（v0.4.4 起显式声明 + after-pack 断言）。
 */
import fs from 'node:fs'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'

import { loggerService } from '@logger'
import { app, net } from 'electron'
import { parse as parseYaml } from 'yaml'

import { terminateActiveOcrProcess } from './localOcr'
import { LOCAL_PADDLE_ASSETS, MODEL_SOURCE_ORDER, resolveModelFileUrl } from './modelAssets'

const logger = loggerService.withContext('LocalPaddleModelStore')

export interface LocalPaddleStatus {
  status: 'not_downloaded' | 'downloading' | 'ready' | 'error' | 'unsupported'
  percent?: number
  error?: string
}

export function paddleModelDir(): string {
  return path.join(app.getPath('userData'), 'Runtime', 'models', 'pp-ocrv6')
}

export async function ensurePaddleModelDir(): Promise<string> {
  const dir = paddleModelDir()
  await mkdir(dir, { recursive: true })
  return dir
}

export function paddleModelPaths(): { detection: string; recognition: string; charactersDictionary: string } {
  const dir = paddleModelDir()
  const { weights, dictionary } = LOCAL_PADDLE_ASSETS
  return {
    detection: path.join(dir, weights.detection.fileName),
    recognition: path.join(dir, weights.recognition.fileName),
    charactersDictionary: path.join(dir, dictionary.fileName)
  }
}

/** 检测/识别权重 + 字典三文件齐 = 就绪。 */
export function isPaddleModelReady(): boolean {
  const paths = paddleModelPaths()
  return existsSync(paths.detection) && existsSync(paths.recognition) && existsSync(paths.charactersDictionary)
}

/** onnxruntime-node 无 darwin-x64 原生绑定（V2 同判定）——该平台永久不支持。 */
export function isPaddlePlatformSupported(): boolean {
  return !(process.platform === 'darwin' && process.arch === 'x64')
}

/**
 * 从识别模型 inference.yml 的 PostProcess.character_dict 构建字典文本。
 * ppu-paddle-ocr 按行 split 不 trim、CTC 解码 index 0 = blank、尾项 = space 类——
 * 前导空行 + 字典项 + 尾换行逐字节复刻。
 */
export function dictTextFromInferenceYml(yml: string): string {
  const config = parseYaml(yml) as { PostProcess?: { character_dict?: unknown } } | null
  const characters = config?.PostProcess?.character_dict
  if (!Array.isArray(characters) || characters.length === 0) {
    throw new Error('inference.yml is missing PostProcess.character_dict')
  }
  return `\n${characters.map(String).join('\n')}\n`
}

class LocalPaddleModelStore {
  private downloading = false
  private percent = 0
  private error: string | undefined
  private controller: AbortController | undefined

  getStatus(): LocalPaddleStatus {
    if (!isPaddlePlatformSupported()) return { status: 'unsupported' }
    if (this.downloading) return { status: 'downloading', percent: this.percent }
    if (isPaddleModelReady()) return { status: 'ready', percent: 100 }
    if (this.error !== undefined) return { status: 'error', error: this.error }
    return { status: 'not_downloaded' }
  }

  /** 下载（幂等：已在下载中或已就绪时直接返回）。 */
  async download(): Promise<void> {
    if (!isPaddlePlatformSupported()) throw new Error('local OCR is not supported on this platform')
    if (this.downloading || isPaddleModelReady()) return
    this.downloading = true
    this.percent = 0
    this.error = undefined
    this.controller = new AbortController()
    try {
      await this.performDownload(this.controller.signal)
    } catch (error) {
      if (!this.controller.signal.aborted) {
        this.error = error instanceof Error ? error.message : String(error)
        logger.error('local OCR model download failed', error as Error)
      }
    } finally {
      this.downloading = false
      this.controller = undefined
    }
  }

  cancel(): void {
    this.controller?.abort()
  }

  /** 删除模型（推理子进程先释放——Windows 打开句柄会让 unlink 失败）。 */
  async remove(): Promise<void> {
    this.cancel()
    try {
      await terminateActiveOcrProcess()
    } catch (error: unknown) {
      logger.warn('terminate active OCR process failed before model removal', error as Error)
    }
    await fs.promises.rm(paddleModelDir(), { recursive: true, force: true })
    this.error = undefined
    logger.info('local OCR model removed')
  }

  private async performDownload(signal: AbortSignal): Promise<void> {
    const { weights } = LOCAL_PADDLE_ASSETS
    const paths = paddleModelPaths()
    // 字典是小的抓取+解析步，权重 1；总权重 133（onnxruntime 二进制不下载，fork dev-first）。
    const totalWeight = Object.values(weights).reduce((sum, file) => sum + file.weight, 0) + 1
    let doneWeight = 0
    await ensurePaddleModelDir()
    for (const key of Object.keys(weights) as Array<keyof typeof weights>) {
      const file = weights[key]
      await this.downloadFile(file, paths[key], signal, (fraction) => {
        this.percent = Math.round((100 * (doneWeight + file.weight * fraction)) / totalWeight)
      })
      doneWeight += file.weight
    }
    await this.downloadDictionary(paths.charactersDictionary, signal)
    this.percent = 100
    logger.info('local OCR model download completed')
  }

  /** 逐镜像尝试（fork 固定顺序 ModelScope → HuggingFace），首个有效文件胜出。 */
  private async downloadFile(
    file: { repo: string; remoteFile: string; fileName: string; minBytes: number },
    dest: string,
    signal: AbortSignal,
    onProgress: (fraction: number) => void
  ): Promise<void> {
    let lastError: unknown
    for (const id of MODEL_SOURCE_ORDER) {
      try {
        await this.fetchToFile(
          resolveModelFileUrl(id, file.repo, file.remoteFile),
          dest,
          file.minBytes,
          signal,
          onProgress
        )
        return
      } catch (error) {
        if (signal.aborted) throw error
        lastError = error
        logger.warn(`mirror failed for ${file.fileName}, trying next`, error as Error)
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`failed to download ${file.fileName}`)
  }

  /** 抓识别模型的 inference.yml（镜像回退），解析出字典落盘。 */
  private async downloadDictionary(dest: string, signal: AbortSignal): Promise<void> {
    const { repo, sourceFile, minBytes } = LOCAL_PADDLE_ASSETS.dictionary
    let lastError: unknown
    for (const id of MODEL_SOURCE_ORDER) {
      try {
        const response = await net.fetch(resolveModelFileUrl(id, repo, sourceFile), { signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const yml = await response.text()
        // LFS 指针/截断/错误页可能仍是合法（但极小）YAML——先按字节数拒，同权重下载。
        const bytes = Buffer.byteLength(yml, 'utf8')
        if (bytes < minBytes) throw new Error(`dictionary source too small (${bytes} bytes)`)
        const dictText = dictTextFromInferenceYml(yml)
        const tmp = `${dest}.tmp`
        await fs.promises.writeFile(tmp, dictText)
        await fs.promises.rename(tmp, dest)
        return
      } catch (error) {
        if (signal.aborted) throw error
        lastError = error
        logger.warn('dictionary mirror failed, trying next', error as Error)
      }
    }
    throw lastError instanceof Error ? lastError : new Error('failed to download OCR dictionary')
  }

  private async fetchToFile(
    url: string,
    dest: string,
    minBytes: number,
    signal: AbortSignal,
    onProgress: (fraction: number) => void
  ): Promise<void> {
    const response = await net.fetch(url, { signal })
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${url}`)

    const total = Number(response.headers.get('content-length')) || 0
    const tmp = `${dest}.tmp`
    let received = 0
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length
        if (total > 0) onProgress(received / total)
        callback(null, chunk)
      }
    })

    try {
      // net.fetch 的 body 是 DOM ReadableStream；Readable.fromWeb 要 node:stream/web 形态
      //（同一运行时对象，类型分叉）——照 V2。
      const webStream = response.body as unknown as NodeWebReadableStream<Uint8Array>
      await pipeline(Readable.fromWeb(webStream), counter, fs.createWriteStream(tmp), { signal })
    } catch (error) {
      await fs.promises.rm(tmp, { force: true })
      throw error
    }

    if (received < minBytes) {
      await fs.promises.rm(tmp, { force: true })
      throw new Error(`download from ${url} too small (${received} bytes)`)
    }
    await fs.promises.rename(tmp, dest)
    onProgress(1)
  }
}

export const localPaddleModelStore = new LocalPaddleModelStore()
