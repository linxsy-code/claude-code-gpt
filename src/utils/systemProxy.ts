import { execFileNoThrow } from './execFileNoThrow.js'
import { logForDebugging } from './debug.js'
import { getPlatform } from './platform.js'

type SystemProxySettings = {
  source: string
  httpProxy?: string
  httpsProxy?: string
  noProxy?: string
}

let cachedSystemProxySettings: SystemProxySettings | null | undefined

function hasExplicitProxyEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(
    env.https_proxy ||
    env.HTTPS_PROXY ||
    env.http_proxy ||
    env.HTTP_PROXY ||
    env.all_proxy ||
    env.ALL_PROXY
  )
}

function normalizeProxyUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return trimmed
  }
  return `http://${trimmed}`
}

function normalizeNoProxyEntry(entry: string): string[] {
  const trimmed = entry.trim()
  if (!trimmed) {
    return []
  }
  if (trimmed === '<local>') {
    return ['localhost', '127.0.0.1', '::1', '.local']
  }
  if (trimmed === '<-loopback>') {
    return ['localhost', '127.0.0.1', '::1']
  }
  if (trimmed.startsWith('*.')) {
    return [trimmed.slice(1)]
  }
  return [trimmed]
}

function buildNoProxyValue(entries: string[]): string | undefined {
  const seen = new Set<string>()
  const normalized = entries
    .flatMap(normalizeNoProxyEntry)
    .map(entry => entry.trim())
    .filter(entry => {
      if (!entry || seen.has(entry)) {
        return false
      }
      seen.add(entry)
      return true
    })
  return normalized.length > 0 ? normalized.join(',') : undefined
}

function parseProxyServerString(proxyServer: string): {
  httpProxy?: string
  httpsProxy?: string
} {
  const result: {
    httpProxy?: string
    httpsProxy?: string
  } = {}
  const trimmed = proxyServer.trim()

  if (!trimmed) {
    return result
  }

  if (!trimmed.includes('=')) {
    const proxyUrl = normalizeProxyUrl(trimmed)
    return {
      httpProxy: proxyUrl,
      httpsProxy: proxyUrl,
    }
  }

  for (const segment of trimmed.split(';')) {
    const [rawScheme, ...rest] = segment.split('=')
    const rawValue = rest.join('=')
    if (!rawScheme || !rawValue) {
      continue
    }
    const scheme = rawScheme.trim().toLowerCase()
    const proxyUrl = normalizeProxyUrl(rawValue)
    if (!proxyUrl) {
      continue
    }
    if (scheme === 'http') {
      result.httpProxy = proxyUrl
    } else if (scheme === 'https') {
      result.httpsProxy = proxyUrl
    } else if (scheme.startsWith('socks')) {
      // The runtime proxy stack is HTTP CONNECT based, so keep SOCKS as a
      // last-resort fallback only when no HTTP/HTTPS endpoint is configured.
      result.httpProxy ??= proxyUrl
      result.httpsProxy ??= proxyUrl
    }
  }

  result.httpProxy ??= result.httpsProxy
  result.httpsProxy ??= result.httpProxy
  return result
}

async function detectWindowsSystemProxy(): Promise<SystemProxySettings | null> {
  const key =
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
  const { stdout, code, error } = await execFileNoThrow(
    'reg',
    ['query', key],
    {
      timeout: 5000,
      useCwd: false,
    },
  )
  if (code !== 0) {
    logForDebugging(
      `[proxy] failed to query Windows proxy settings: ${error ?? 'unknown error'}`,
      { level: 'warn' },
    )
    return null
  }

  const values = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*([^\s]+)\s+REG_\w+\s+(.+?)\s*$/)
    if (match?.[1] && match[2] !== undefined) {
      values.set(match[1], match[2].trim())
    }
  }

  const proxyEnabled = values.get('ProxyEnable')
  const proxyServer = values.get('ProxyServer')
  const proxyOverride = values.get('ProxyOverride')
  const autoConfigUrl = values.get('AutoConfigURL')

  if (proxyEnabled !== '0x1' || !proxyServer) {
    if (autoConfigUrl) {
      logForDebugging(
        '[proxy] Windows PAC proxy detected but automatic PAC resolution is not supported; falling back to direct networking',
        { level: 'warn' },
      )
    }
    return null
  }

  const parsed = parseProxyServerString(proxyServer)
  if (!parsed.httpProxy && !parsed.httpsProxy) {
    return null
  }

  return {
    source: 'windows-registry',
    httpProxy: parsed.httpProxy,
    httpsProxy: parsed.httpsProxy,
    noProxy: buildNoProxyValue(
      proxyOverride ? proxyOverride.split(/[;,]+/) : [],
    ),
  }
}

async function detectMacSystemProxy(): Promise<SystemProxySettings | null> {
  const { stdout, code, error } = await execFileNoThrow(
    'scutil',
    ['--proxy'],
    {
      timeout: 5000,
      useCwd: false,
    },
  )
  if (code !== 0) {
    logForDebugging(
      `[proxy] failed to query macOS proxy settings: ${error ?? 'unknown error'}`,
      { level: 'warn' },
    )
    return null
  }

  const values = new Map<string, string>()
  const exceptionEntries: string[] = []
  let inExceptionsList = false

  for (const line of stdout.split(/\r?\n/)) {
    if (/^\s*ExceptionsList\s*:/.test(line)) {
      inExceptionsList = true
      continue
    }
    if (inExceptionsList) {
      const exceptionMatch = line.match(/^\s*\d+\s*:\s*(.+?)\s*$/)
      if (exceptionMatch?.[1]) {
        exceptionEntries.push(exceptionMatch[1].trim())
        continue
      }
      if (/^\s*}\s*$/.test(line)) {
        inExceptionsList = false
      }
    }

    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/)
    if (match?.[1] && match[2] !== undefined) {
      values.set(match[1], match[2].trim())
    }
  }

  const httpEnabled = values.get('HTTPEnable') === '1'
  const httpsEnabled = values.get('HTTPSEnable') === '1'
  const pacEnabled = values.get('ProxyAutoConfigEnable') === '1'

  if (!httpEnabled && !httpsEnabled) {
    if (pacEnabled) {
      logForDebugging(
        '[proxy] macOS PAC proxy detected but automatic PAC resolution is not supported; falling back to direct networking',
        { level: 'warn' },
      )
    }
    return null
  }

  const httpProxy =
    httpEnabled &&
    values.get('HTTPProxy') &&
    values.get('HTTPPort')
      ? normalizeProxyUrl(
          `${values.get('HTTPProxy')}:${values.get('HTTPPort')}`,
        )
      : undefined
  const httpsProxy =
    httpsEnabled &&
    values.get('HTTPSProxy') &&
    values.get('HTTPSPort')
      ? normalizeProxyUrl(
          `${values.get('HTTPSProxy')}:${values.get('HTTPSPort')}`,
        )
      : undefined

  if (!httpProxy && !httpsProxy) {
    return null
  }

  return {
    source: 'macos-scutil',
    httpProxy: httpProxy ?? httpsProxy,
    httpsProxy: httpsProxy ?? httpProxy,
    noProxy: buildNoProxyValue(exceptionEntries),
  }
}

function parseGSettingsString(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed || trimmed === "''") {
    return undefined
  }
  return trimmed.replace(/^'(.*)'$/, '$1')
}

function parseGSettingsNumber(value: string): number | undefined {
  const parsed = Number.parseInt(value.trim(), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function parseGSettingsArray(value: string): string[] {
  const matches = value.match(/'([^']+)'/g)
  return matches ? matches.map(match => match.slice(1, -1)) : []
}

async function readGSettingsValue(
  schema: string,
  key: string,
): Promise<string | undefined> {
  const { stdout, code } = await execFileNoThrow(
    'gsettings',
    ['get', schema, key],
    {
      timeout: 3000,
      useCwd: false,
    },
  )
  if (code !== 0) {
    return undefined
  }
  return stdout.trim()
}

async function detectLinuxSystemProxy(): Promise<SystemProxySettings | null> {
  const mode = parseGSettingsString(
    (await readGSettingsValue('org.gnome.system.proxy', 'mode')) ?? '',
  )
  if (!mode || mode === 'none') {
    return null
  }
  if (mode === 'auto') {
    logForDebugging(
      '[proxy] GNOME PAC proxy detected but automatic PAC resolution is not supported; falling back to direct networking',
      { level: 'warn' },
    )
    return null
  }
  if (mode !== 'manual') {
    return null
  }

  const [
    httpHost,
    httpPortRaw,
    httpsHost,
    httpsPortRaw,
    ignoreHostsRaw,
  ] = await Promise.all([
    readGSettingsValue('org.gnome.system.proxy.http', 'host'),
    readGSettingsValue('org.gnome.system.proxy.http', 'port'),
    readGSettingsValue('org.gnome.system.proxy.https', 'host'),
    readGSettingsValue('org.gnome.system.proxy.https', 'port'),
    readGSettingsValue('org.gnome.system.proxy', 'ignore-hosts'),
  ])

  const httpHostValue = parseGSettingsString(httpHost ?? '')
  const httpsHostValue = parseGSettingsString(httpsHost ?? '')
  const httpPort = parseGSettingsNumber(httpPortRaw ?? '')
  const httpsPort = parseGSettingsNumber(httpsPortRaw ?? '')

  const httpProxy =
    httpHostValue && httpPort
      ? normalizeProxyUrl(`${httpHostValue}:${httpPort}`)
      : undefined
  const httpsProxy =
    httpsHostValue && httpsPort
      ? normalizeProxyUrl(`${httpsHostValue}:${httpsPort}`)
      : undefined

  if (!httpProxy && !httpsProxy) {
    return null
  }

  return {
    source: 'linux-gsettings',
    httpProxy: httpProxy ?? httpsProxy,
    httpsProxy: httpsProxy ?? httpProxy,
    noProxy: buildNoProxyValue(parseGSettingsArray(ignoreHostsRaw ?? '')),
  }
}

async function detectSystemProxySettings(): Promise<SystemProxySettings | null> {
  switch (getPlatform()) {
    case 'windows':
      return detectWindowsSystemProxy()
    case 'macos':
      return detectMacSystemProxy()
    case 'linux':
      return detectLinuxSystemProxy()
    default:
      return null
  }
}

function applyProxySettingsToEnvironment(settings: SystemProxySettings): void {
  const httpProxy = settings.httpProxy ?? settings.httpsProxy
  const httpsProxy = settings.httpsProxy ?? settings.httpProxy
  const allProxy = httpsProxy ?? httpProxy

  if (httpProxy) {
    process.env.HTTP_PROXY ??= httpProxy
    process.env.http_proxy ??= httpProxy
  }
  if (httpsProxy) {
    process.env.HTTPS_PROXY ??= httpsProxy
    process.env.https_proxy ??= httpsProxy
  }
  if (allProxy) {
    process.env.ALL_PROXY ??= allProxy
    process.env.all_proxy ??= allProxy
  }
  if (settings.noProxy) {
    process.env.NO_PROXY ??= settings.noProxy
    process.env.no_proxy ??= settings.noProxy
  }
}

export async function ensureSystemProxyEnvironmentVariables(): Promise<boolean> {
  if (hasExplicitProxyEnv()) {
    return false
  }

  if (cachedSystemProxySettings === undefined) {
    cachedSystemProxySettings = await detectSystemProxySettings()
  }

  if (!cachedSystemProxySettings) {
    return false
  }

  applyProxySettingsToEnvironment(cachedSystemProxySettings)
  logForDebugging(
    `[proxy] applied system proxy settings from ${cachedSystemProxySettings.source}`,
  )
  return true
}

export function applySystemProxyEnvironmentVariablesFromCache(): boolean {
  if (hasExplicitProxyEnv() || !cachedSystemProxySettings) {
    return false
  }

  applyProxySettingsToEnvironment(cachedSystemProxySettings)
  return true
}

