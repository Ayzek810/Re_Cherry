import './assets/styles/index.css'
import './assets/styles/tailwind.css'
import '@ant-design/v5-patch-for-react-19'

import { WebTracer } from '@mcp-trace/trace-web'
import { createRoot } from 'react-dom/client'

import App from './App'

// 窗口卸载前冲刷 web 侧在途 span。批处理器不冲刷的话，这些 span 会随窗口关闭丢掉。
// pagehide 不可 await，故 fire-and-forget（适配器内部已保证 flush/shutdown 不抛）。
window.addEventListener('pagehide', () => {
  void WebTracer.forceFlush()
})

const root = createRoot(document.getElementById('root') as HTMLElement)
root.render(<App />)
