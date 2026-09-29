// fork 缝（原创，v0.4.5-1）：npm registry 常量单点。
// 为什么单列一件：dsh 安装（BinaryManager）与市场通道（marketBaseline）都要用同一个镜像
// URL——两处各写一份字面量就是"会漂移的第二份清单"（一处改了另一处没改，表现是市场抓包
// 与版本解析走了两个源，社区版 #337 记录的正是这个坑）。备用源的用途见 marketBaseline。

/** 主镜像（墙内可用；安装与市场版本解析一律先钉此源）。 */
export const NPM_REGISTRY_MIRROR = 'https://registry.npmmirror.com'

/**
 * 备用源（社区版 `FALLBACK_NPM_REGISTRY` 对位）：主镜像缺该版本或不可达时，市场通道做
 * **一次性**回退。镜像对第三方包（非 `@deepseek-ai/*`）的同步会滞后，而 dshmarket 恰好
 * 是第三方包——"镜像还没有那个版本"是常态而非异常。
 */
export const NPM_REGISTRY_FALLBACK = 'https://registry.npmjs.org'
