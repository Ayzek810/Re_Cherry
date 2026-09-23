// 本文件为主进程远程 URL 字面量安全守卫，拒绝非 http(s) 协议、内嵌凭据以及本地/私有地址字面量。

import * as ipaddr from 'ipaddr.js'

const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.'])
const BLOCKED_IPV4_RANGES = new Set([
  'broadcast',
  'carrierGradeNat',
  'linkLocal',
  'loopback',
  'multicast',
  'private',
  'reserved',
  'unspecified'
])
const BLOCKED_IPV6_RANGES = new Set([
  '6to4',
  'benchmarking',
  'discard',
  'linkLocal',
  'loopback',
  'multicast',
  'reserved',
  'rfc6145',
  'teredo',
  'uniqueLocal',
  'unspecified'
])
const BLOCKED_IPV6_CIDR_RANGES: ReadonlyArray<readonly [ipaddr.IPv6, number]> = [
  [ipaddr.IPv6.parse('64:ff9b:1::'), 48],
  [ipaddr.IPv6.parse('100:0:0:1::'), 64],
  [ipaddr.IPv6.parse('3fff::'), 20],
  [ipaddr.IPv6.parse('5f00::'), 16]
]
const PUBLIC_IPV6_RANGE: readonly [ipaddr.IPv6, number] = [ipaddr.IPv6.parse('2000::'), 3]
const NAT64_WELL_KNOWN_PREFIX: readonly [ipaddr.IPv6, number] = [ipaddr.IPv6.parse('64:ff9b::'), 96]
// Clash/mihomo TUN and Surge Enhanced Mode resolve every domain into this range; the answers are
// proxy handles routed back out through the tunnel, not intranet hosts.
const FAKE_IP_IPV4_RANGE: readonly [ipaddr.IPv4, number] = [ipaddr.IPv4.parse('198.18.0.0'), 15]

function normalizeHostname(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1).toLowerCase()
  }

  return hostname.toLowerCase()
}

function parseIpHostname(hostname: string): ipaddr.IPv4 | ipaddr.IPv6 | undefined {
  const normalized = normalizeHostname(hostname)

  if (!ipaddr.isValid(normalized)) {
    return undefined
  }

  return ipaddr.process(normalized)
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()

  return BLOCKED_HOSTNAMES.has(normalized) || normalized.endsWith('.localhost') || normalized.endsWith('.localhost.')
}

/** Embedded IPv4 of a NAT64 well-known-prefix address, which is how IPv6-only networks reach IPv4. */
function getNat64EmbeddedIpv4(address: ipaddr.IPv6): ipaddr.IPv4 | undefined {
  const [prefixAddress, prefixBits] = NAT64_WELL_KNOWN_PREFIX

  if (!address.match(prefixAddress, prefixBits)) {
    return undefined
  }

  return new ipaddr.IPv4(address.toByteArray().slice(12))
}

function isBlockedIpv4(address: ipaddr.IPv4): boolean {
  const [fakeIpAddress, fakeIpBits] = FAKE_IP_IPV4_RANGE

  return !address.match(fakeIpAddress, fakeIpBits) && BLOCKED_IPV4_RANGES.has(address.range())
}

function isBlockedIpHostname(hostname: string): boolean {
  const address = parseIpHostname(hostname)

  if (!address) {
    return false
  }

  if (address instanceof ipaddr.IPv4) {
    return isBlockedIpv4(address)
  }

  const nat64EmbeddedIpv4 = getNat64EmbeddedIpv4(address)
  if (nat64EmbeddedIpv4) {
    return isBlockedIpv4(nat64EmbeddedIpv4)
  }

  const [publicRangeAddress, publicRangeBits] = PUBLIC_IPV6_RANGE

  return (
    !address.match(publicRangeAddress, publicRangeBits) ||
    BLOCKED_IPV6_RANGES.has(address.range()) ||
    BLOCKED_IPV6_CIDR_RANGES.some(([rangeAddress, bits]) => address.match(rangeAddress, bits))
  )
}

function isLoopbackHostname(hostname: string): boolean {
  if (isLocalHostname(hostname)) {
    return true
  }

  const address = parseIpHostname(hostname)
  return Boolean(address && address.range() === 'loopback')
}

function getEffectivePort(url: URL): string {
  if (url.port) {
    return url.port
  }

  switch (url.protocol) {
    case 'http:':
      return '80'
    case 'https:':
      return '443'
    default:
      return ''
  }
}

function isBlockedHostname(hostname: string): boolean {
  return isLocalHostname(hostname) || isBlockedIpHostname(hostname)
}

function hasMatchingConfiguredOrigin(url: URL, configuredApiHost: string): boolean {
  let configuredUrl: URL
  try {
    configuredUrl = new URL(configuredApiHost)
  } catch {
    return false
  }

  if (
    (configuredUrl.protocol !== 'http:' && configuredUrl.protocol !== 'https:') ||
    configuredUrl.username ||
    configuredUrl.password ||
    url.protocol !== configuredUrl.protocol ||
    getEffectivePort(url) !== getEffectivePort(configuredUrl)
  ) {
    return false
  }

  const normalizedHostname = normalizeHostname(url.hostname)
  const normalizedConfiguredHostname = normalizeHostname(configuredUrl.hostname)

  return (
    normalizedHostname === normalizedConfiguredHostname ||
    (isLoopbackHostname(url.hostname) && isLoopbackHostname(configuredUrl.hostname))
  )
}

/**
 * Literal URL guard: rejects non-http(s) schemes, embedded credentials, and
 * literal local/private addresses, returning the normalized URL.
 * Pass `configuredApiHost` to allow a provider's own loopback/private endpoint
 * when it matches the user-configured host.
 *
 * Pass `allowPrivateNetwork` from the `app.fetch.allow_private_network`
 * preference when this precheck guards a `fetchRemoteText()` call, so the
 * literal guard does not reject what the pinned fetch would accept.
 *
 * This is the literal guard only; hostname DNS results are not checked here.
 */
export function sanitizeRemoteUrl(rawUrl: string, configuredApiHost?: string, allowPrivateNetwork = false): string {
  const parsedUrl = parseRemoteUrl(rawUrl)

  const allowMatchingConfiguredOrigin =
    configuredApiHost !== undefined && hasMatchingConfiguredOrigin(parsedUrl, configuredApiHost)

  if (!allowPrivateNetwork && isBlockedHostname(parsedUrl.hostname) && !allowMatchingConfiguredOrigin) {
    throw new Error(`Unsafe remote url: local or private addresses are not allowed (${parsedUrl.hostname})`)
  }

  return parsedUrl.toString()
}

function parseRemoteUrl(rawUrl: string): URL {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(rawUrl)
  } catch {
    throw new Error(`Invalid remote url: ${rawUrl}`)
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`Invalid remote url: ${rawUrl}`)
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw new Error('Unsafe remote url: credentials are not allowed')
  }

  return parsedUrl
}
