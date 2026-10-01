/**
 * 装机冒烟（v1 部署测试）：通过主进程预留的 CDP 门（RC_REMOTE_DEBUG_PORT）连上已构建应用，
 * 验证「窗口创建 → #root 挂载 → 应用外壳渲染 → 新 IPC 可达」。
 *
 * 用法：node smoke-cdp.cjs <port> [appPath]
 * 前置：以 RC_REMOTE_DEBUG_PORT=<port> 启动应用（见 tools/smoke-launch.ps1）。
 */
const port = Number(process.argv[2] || 9222)
const deadline = Date.now() + 120_000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findPageTarget() {
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
      if (page) return page
    } catch {
      /* 应用还没起来 */
    }
    if (Date.now() > deadline) throw new Error('未能在 120s 内连上 CDP 端口 —— 应用可能没起来')
    await sleep(1000)
  }
}

function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {
        /* noop */
      }
      reject(new Error('CDP evaluate 超时（30s）'))
    }, 30_000)
    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true }
        })
      )
    })
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString())
      if (msg.id !== 1) return
      clearTimeout(timer)
      ws.close()
      if (msg.result?.exceptionDetails) {
        reject(
          new Error(msg.result.exceptionDetails.text + ' ' + (msg.result.exceptionDetails.exception?.description ?? ''))
        )
        return
      }
      resolve(msg.result?.result?.value)
    })
    ws.addEventListener('error', (err) => {
      clearTimeout(timer)
      reject(new Error('CDP WebSocket 错误: ' + (err.message ?? String(err))))
    })
  })
}

const SNAPSHOT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(3000); // 等应用外壳与内核启动完成
  const root = document.querySelector('#root');
  const text = document.body ? document.body.innerText : '';
  const out = {
    url: location.href,
    readyState: document.readyState,
    rootMounted: !!root && (root.childElementCount ?? 0) > 0,
    bodyTextLength: text.length,
    hasSidebar: !!document.querySelector('[class*="sidebar" i]') || !!document.querySelector('aside'),
    hasMainContent: !!document.querySelector('main') || !!document.querySelector('[class*="main" i]'),
    apiBridge: typeof window.api === 'object' && window.api !== null,
    mcpCheckCommand: !!(window.api && window.api.mcp && typeof window.api.mcp.checkCommand === 'function'),
    i18nLanguage: (document.documentElement.getAttribute('lang') || '').slice(0, 10),
    errors: []
  };
  // 新 IPC 真调用：探测 node/npx 在系统 PATH 中的解析结果（v1 新增通道）
  if (out.mcpCheckCommand) {
    try {
      const [nodePath, npxPath] = await Promise.all([
        window.api.mcp.checkCommand('node'),
        window.api.mcp.checkCommand('npx')
      ]);
      out.probe = { node: nodePath, npx: npxPath };
    } catch (error) {
      out.errors.push('checkCommand failed: ' + String(error));
    }
  }
  // 渲染层是否有未捕获错误（白屏排查）
  if (text.includes('Something went wrong') || text.includes('出错了')) out.errors.push('错误边界文案出现在页面上');
  return JSON.stringify(out);
})()`

;(async () => {
  const target = await findPageTarget()
  console.log('CDP target:', target.url)
  const raw = await evaluate(target.webSocketDebuggerUrl, SNAPSHOT)
  const snap = JSON.parse(raw)
  console.log(JSON.stringify(snap, null, 2))
  const failures = []
  if (!snap.rootMounted) failures.push('#root 未挂载（渲染层没起来）')
  if (!snap.apiBridge) failures.push('window.api 桥缺失')
  if (!snap.mcpCheckCommand) failures.push('新 IPC Mcp_CheckCommand 未暴露到 window.api.mcp')
  if (snap.errors.length > 0) failures.push('运行时错误: ' + snap.errors.join('; '))
  if (failures.length > 0) {
    console.error('SMOKE FAILED:\n - ' + failures.join('\n - '))
    process.exit(1)
  }
  console.log('SMOKE OK: 窗口挂载、外壳渲染、新 IPC 可达')
})().catch((error) => {
  console.error('SMOKE ERROR:', error.message)
  process.exit(1)
})
