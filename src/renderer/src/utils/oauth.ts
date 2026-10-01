import { loggerService } from '@logger'
import { PPIO_APP_SECRET, PPIO_CLIENT_ID, SILICON_CLIENT_ID, TOKENFLUX_HOST } from '@renderer/config/constant'
import i18n, { getLanguageCode } from '@renderer/i18n'

const logger = loggerService.withContext('Utils:oauth')

/**
 * 允许向本窗口 postMessage OAuth 结果的来源白名单（audit2 r2-95）。
 *
 * 只登记本文件里 `window.open` 出去、且约定用 postMessage 回传密钥的授权页来源，
 * 全部由同一批授权 URL 推导而来：
 * - `oauthWithSiliconFlow` → `https://account.siliconflow.cn/oauth?...`
 * - `oauthWithAihubmix`    → `https://console.aihubmix.com/token?...`
 * - `oauthWith302AI`       → `https://dash.302.ai/sso/login?...`
 *
 * 不校验 origin 时，任何窗口/iframe 只要 postMessage 出 `{secretKey}` 形状就能写入
 * 用户的 API Key。不在白名单内的消息一律丢弃并记 warn。
 * （PPIO / TokenFlux 不走 message 通道：前者用 `window.api.protocol`，后者只打开页面。）
 */
const OAUTH_MESSAGE_ORIGINS = ['https://account.siliconflow.cn', 'https://console.aihubmix.com', 'https://dash.302.ai']

/**
 * 注册一次性 OAuth message 监听。
 * - 监听器句柄被保存，回调里 removeEventListener 用同一实例（原实现在 add 之前
 *   对刚创建的函数 remove，永远匹配不上，重复点击会叠加监听）。
 * - 不在 `OAUTH_MESSAGE_ORIGINS` 的消息直接丢弃。
 * - `event.data` 可能为 undefined，取用前先判空。
 * @param handler 收到合法来源消息后的处理逻辑；返回 true 表示已处理完，监听器随即注销。
 * @returns 注销函数（调用方可提前清理）
 */
const listenForOauthMessage = (handler: (data: any) => boolean | Promise<boolean>): (() => void) => {
  let settled = false
  const messageHandler = (event: MessageEvent) => {
    if (settled) return
    if (!OAUTH_MESSAGE_ORIGINS.includes(event.origin)) {
      logger.warn(`[oauth] ignored message from untrusted origin: ${event.origin}`)
      return
    }
    const data = event.data
    if (data === undefined || data === null) {
      return
    }
    void Promise.resolve()
      .then(() => handler(data))
      .then((handled) => {
        if (handled && !settled) {
          settled = true
          window.removeEventListener('message', messageHandler)
        }
      })
      .catch((error) => {
        // handler 内的失败必须可见（家规 §9：绝不静默失败）。
        logger.warn('[oauth] message handler failed', error as Error)
      })
  }

  window.addEventListener('message', messageHandler)
  return () => {
    settled = true
    window.removeEventListener('message', messageHandler)
  }
}

export const oauthWithSiliconFlow = async (setKey) => {
  const authUrl = `https://account.siliconflow.cn/oauth?client_id=${SILICON_CLIENT_ID}`

  const popup = window.open(
    authUrl,
    'oauth',
    'width=720,height=720,toolbar=no,location=no,status=no,menubar=no,scrollbars=yes,resizable=yes,alwaysOnTop=yes,alwaysRaised=yes'
  )

  listenForOauthMessage((data) => {
    if (Array.isArray(data) && data.length > 0 && data[0]?.['secretKey'] !== undefined) {
      setKey(data[0]['secretKey'])
      popup?.close()
      return true
    }
    return false
  })
}

export const oauthWithAihubmix = async (setKey) => {
  const authUrl = ` https://console.aihubmix.com/token?client_id=cherry_studio_oauth&lang=${getLanguageCode()}&aff=SJyh`

  const popup = window.open(
    authUrl,
    'oauth',
    'width=720,height=720,toolbar=no,location=no,status=no,menubar=no,scrollbars=yes,resizable=yes,alwaysOnTop=yes,alwaysRaised=yes'
  )

  listenForOauthMessage(async (data) => {
    if (!data || data.key !== 'cherry_studio_oauth_callback') {
      return false
    }
    const { iv, encryptedData } = data.data ?? {}

    try {
      const secret = import.meta.env.RENDERER_VITE_AIHUBMIX_SECRET || ''
      const decryptedData: any = await window.api.aes.decrypt(encryptedData, iv, secret)
      const { api_keys } = JSON.parse(decryptedData)
      if (api_keys && api_keys.length > 0) {
        setKey(api_keys[0].value)
        popup?.close()
        return true
      }
      return false
    } catch (error) {
      logger.error('[oauthWithAihubmix] error', error as Error)
      popup?.close()
      window.toast.error(i18n.t('settings.provider.oauth.error'))
      return true
    }
  })
}

export const oauthWithPPIO = async (setKey) => {
  const redirectUri = 'cherrystudio://'
  const authUrl = `https://ppio.com/oauth/authorize?invited_by=JYT9GD&client_id=${PPIO_CLIENT_ID}&scope=api%20openid&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}`

  window.open(
    authUrl,
    'oauth',
    'width=720,height=720,toolbar=no,location=no,status=no,menubar=no,scrollbars=yes,resizable=yes,alwaysOnTop=yes,alwaysRaised=yes'
  )

  if (!setKey) {
    logger.debug('[PPIO OAuth] No setKey callback provided, returning early')
    return
  }

  logger.debug('[PPIO OAuth] Setting up protocol listener')

  return new Promise<string>((resolve, reject) => {
    const removeListener = window.api.protocol.onReceiveData(async (data) => {
      try {
        const url = new URL(data.url)
        const params = new URLSearchParams(url.search)
        const code = params.get('code')

        if (!code) {
          reject(new Error('No authorization code received'))
          return
        }

        if (!PPIO_APP_SECRET) {
          reject(
            new Error('PPIO_APP_SECRET not configured. Please set RENDERER_VITE_PPIO_APP_SECRET environment variable.')
          )
          return
        }
        const formData = new URLSearchParams({
          client_id: PPIO_CLIENT_ID,
          client_secret: PPIO_APP_SECRET,
          code: code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri
        })
        const tokenResponse = await fetch('https://ppio.com/oauth/token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: formData.toString()
        })

        if (!tokenResponse.ok) {
          const errorText = await tokenResponse.text()
          logger.error(`[PPIO OAuth] Token exchange failed: ${tokenResponse.status} ${errorText}`)
          throw new Error(`Failed to exchange code for token: ${tokenResponse.status} ${errorText}`)
        }

        const tokenData = await tokenResponse.json()
        const accessToken = tokenData.access_token

        if (accessToken) {
          setKey(accessToken)
          resolve(accessToken)
        } else {
          reject(new Error('No access token received'))
        }
      } catch (error) {
        logger.error('[PPIO OAuth] Error processing callback:', error as Error)
        reject(error)
      } finally {
        removeListener()
      }
    })
  })
}

export const oauthWithTokenFlux = async () => {
  const callbackUrl = `${TOKENFLUX_HOST}/auth/callback?redirect_to=/dashboard/api-keys`
  const resp = await fetch(`${TOKENFLUX_HOST}/api/auth/auth-url?type=login&callback=${callbackUrl}`, {})
  if (!resp.ok) {
    window.toast.error(i18n.t('settings.provider.oauth.error'))
    return
  }
  const data = await resp.json()
  const authUrl = data.data.url
  window.open(
    authUrl,
    'oauth',
    'width=720,height=720,toolbar=no,location=no,status=no,menubar=no,scrollbars=yes,resizable=yes,alwaysOnTop=yes,alwaysRaised=yes'
  )
}
export const oauthWith302AI = async (setKey) => {
  const authUrl = 'https://dash.302.ai/sso/login?app=cherry-ai.com&name=Cherry%20Studio'

  const popup = window.open(
    authUrl,
    'oauth',
    'width=720,height=720,toolbar=no,location=no,status=no,menubar=no,scrollbars=yes,resizable=yes,alwaysOnTop=yes,alwaysRaised=yes'
  )

  listenForOauthMessage((data) => {
    if (data && data.data && data.data.apikey !== undefined) {
      setKey(data.data.apikey)
      popup?.close()
      return true
    }
    return false
  })
}

export const oauthWithAiOnly = async (setKey) => {
  const authUrl = `https://maas.aiionly.com/login?inviteCode=1755481173663DrZBBOC0&cherryCode=01`

  const popup = window.open(
    authUrl,
    'login',
    'width=720,height=720,toolbar=no,location=no,status=no,menubar=no,scrollbars=yes,resizable=yes,alwaysOnTop=yes,alwaysRaised=yes'
  )

  listenForOauthMessage((data) => {
    if (Array.isArray(data) && data.length > 0 && data[0]?.['secretKey'] !== undefined) {
      setKey(data[0]['secretKey'])
      popup?.close()
      return true
    }
    return false
  })
}

export const providerCharge = async (provider: string) => {
  const chargeUrlMap = {
    silicon: {
      url: 'https://cloud.siliconflow.cn/expensebill',
      width: 900,
      height: 700
    },
    aihubmix: {
      url: `https://console.aihubmix.com/topup?client_id=cherry_studio_oauth&lang=${getLanguageCode()}&aff=SJyh`,
      width: 720,
      height: 900
    },
    tokenflux: {
      url: `https://tokenflux.ai/dashboard/billing`,
      width: 900,
      height: 700
    },
    ppio: {
      url: 'https://ppio.com/user/register?invited_by=JYT9GD&utm_source=github_cherry-studio&redirect=/billing',
      width: 900,
      height: 700
    },
    '302ai': {
      url: 'https://dash.302.ai/charge',
      width: 900,
      height: 700
    },
    aionly: {
      url: `https://maas.aiionly.com/recharge`,
      width: 900,
      height: 700
    }
  }

  const { url, width, height } = chargeUrlMap[provider] ?? {}

  if (!url) {
    // 未登记 provider 不是「URL 为空」而是「没有这个入口」：给可见失败而不是 TypeError。
    logger.warn(`[providerCharge] no charge url registered for provider "${provider}"`)
    window.toast.error(i18n.t('settings.provider.oauth.error'))
    return
  }

  window.open(
    url,
    'oauth',
    `width=${width},height=${height},toolbar=no,location=no,status=no,menubar=no,scrollbars=yes,resizable=yes,alwaysOnTop=yes,alwaysRaised=yes`
  )
}

export const providerBills = async (provider: string) => {
  const billsUrlMap = {
    silicon: {
      url: 'https://cloud.siliconflow.cn/bills',
      width: 900,
      height: 700
    },
    aihubmix: {
      url: `https://console.aihubmix.com/statistics?client_id=cherry_studio_oauth&lang=${getLanguageCode()}&aff=SJyh`,
      width: 900,
      height: 700
    },
    tokenflux: {
      url: `https://tokenflux.ai/dashboard/billing`,
      width: 900,
      height: 700
    },
    ppio: {
      url: 'https://ppio.com/user/register?invited_by=JYT9GD&utm_source=github_cherry-studio&redirect=/billing/billing-details',
      width: 900,
      height: 700
    },
    '302ai': {
      url: 'https://dash.302.ai/charge',
      width: 900,
      height: 700
    },
    aionly: {
      url: `https://maas.aiionly.com/billManagement`,
      width: 900,
      height: 700
    }
  }

  const { url, width, height } = billsUrlMap[provider] ?? {}

  if (!url) {
    // 同上：bills 表缺项曾经直接抛 TypeError（解构 undefined）。
    logger.warn(`[providerBills] no bills url registered for provider "${provider}"`)
    window.toast.error(i18n.t('settings.provider.oauth.error'))
    return
  }

  window.open(
    url,
    'oauth',
    `width=${width},height=${height},toolbar=no,location=no,status=no,menubar=no,scrollbars=yes,resizable=yes,alwaysOnTop=yes,alwaysRaised=yes`
  )
}
