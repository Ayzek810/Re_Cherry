import { loggerService } from '@logger'
import type { Model, Provider } from '@renderer/types'
import type { ApiKeyWithStatus, ModelCheckOptions, ModelWithStatus } from '@renderer/types/healthCheck'
import { HealthStatus } from '@renderer/types/healthCheck'
import { safeToString, serializeHealthCheckError } from '@renderer/utils/error'
import { aggregateApiKeyResults } from '@renderer/utils/healthCheck'

import { checkModel } from './ApiService'

const logger = loggerService.withContext('HealthCheckService')

/**
 * 用多个 API 密钥检查单个模型的连通性
 *
 * `isConcurrent=false` 时密钥也**逐个串行**发（此前 `apiKeys.map` 无条件全并发，
 * 关掉开关仍会一次打出「模型数 × key 数」个请求——正是该开关要避免的限流场景）。
 * 无论走哪条路，返回值都按 `apiKeys` 下标对齐。
 */
export async function checkModelWithMultipleKeys(
  provider: Provider,
  model: Model,
  apiKeys: string[],
  timeout?: number,
  isConcurrent = true
): Promise<ApiKeyWithStatus[]> {
  const checkWithKey = async (key: string): Promise<ApiKeyWithStatus> => {
    const startTime = Date.now()
    // 如果 checkModel 抛出错误，让这个 promise 失败
    await checkModel({ ...provider, apiKey: key }, model, timeout)
    const latency = Date.now() - startTime

    return {
      key,
      status: HealthStatus.SUCCESS,
      latency
    }
  }

  const settled: PromiseSettledResult<ApiKeyWithStatus>[] = []
  if (isConcurrent) {
    settled.push(...(await Promise.allSettled(apiKeys.map((key) => checkWithKey(key)))))
  } else {
    // 串行：一个 key 结算后才发下一个（下标顺序与 apiKeys 一致，下面的 index 对齐仍然成立）
    for (const key of apiKeys) {
      try {
        settled.push({ status: 'fulfilled', value: await checkWithKey(key) })
      } catch (reason) {
        settled.push({ status: 'rejected', reason })
      }
    }
  }

  return settled.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value
    } else {
      const serializedError = serializeHealthCheckError(result.reason)

      return {
        key: apiKeys[index], // 对应失败的 promise 的 key
        status: HealthStatus.FAILED,
        error: serializedError
      }
    }
  })
}

/**
 * 检查多个模型的连通性
 *
 * 修改前 try/catch 包住整个 `Promise.all`（fail-fast），任一模型抛出
 * 未捕获异常就整批跳出，catch 只写日志，然后返回**当时尚未填充的** `results`（并发下只有
 * 少数几项，串行下常常是空数组）。调用方拿这个数组去汇总，于是「一次整体失败」被渲染成
 * 「0/N 通过」的成功态。现在错误按**单个模型**兜住，返回与 `models` 等长的定长数组，
 * 每个失败项带 `HealthStatus.FAILED` 与错误文本，调用方能如实表达失败。
 *
 * 返回值语义（三者必须可分）：`FAILED` + 空 `keyResults` = 该模型检查本身抛错；
 * `FAILED` + 有 `keyResults` = 真的测过且密钥不可用；`SUCCESS` = 至少一个密钥通过。
 *
 * @returns 与 `models` 下标对齐的定长结果数组；本函数不 reject。
 */
export async function checkModelsHealth(
  options: ModelCheckOptions,
  onModelChecked?: (result: ModelWithStatus, index: number) => void
): Promise<ModelWithStatus[]> {
  const { provider, models, apiKeys, isConcurrent, timeout } = options
  const results: ModelWithStatus[] = new Array(models.length)

  const runModelCheck = async (model: Model, index: number): Promise<ModelWithStatus> => {
    let result: ModelWithStatus
    try {
      const keyResults = await checkModelWithMultipleKeys(provider, model, apiKeys, timeout, isConcurrent)
      const analysis = aggregateApiKeyResults(keyResults)

      result = {
        model,
        keyResults,
        status: analysis.status,
        error: analysis.error,
        latency: analysis.latency
      }
    } catch (error) {
      // 单个模型的意外失败不牵连同批的其它模型，但必须留下可见的失败结论。
      const messageText = error instanceof Error ? `${error.name}: ${error.message}` : safeToString(error)
      logger.error(`[HealthCheckService] Model health check threw: ${messageText}`, error as Error)
      result = {
        model,
        keyResults: [],
        status: HealthStatus.FAILED,
        error: messageText
      }
    }

    results[index] = result
    onModelChecked?.(result, index)
    return result
  }

  if (isConcurrent) {
    // 并发：先构造全部请求再一起等（`models.map` 的既有语义）
    await Promise.all(models.map((model, index) => runModelCheck(model, index)))
  } else {
    // 非并发必须是**串行**。此前是 `models.map(async …)` 先构造全部 promise（map 阶段就
    // 把请求全发出去了），再按序 await——只是等待有序，请求早就并发打出去了，开关形同虚设。
    // 现在改成循环里逐个 await：下一个模型要等上一个结算。
    for (let index = 0; index < models.length; index++) {
      await runModelCheck(models[index], index)
    }
  }

  return results
}
