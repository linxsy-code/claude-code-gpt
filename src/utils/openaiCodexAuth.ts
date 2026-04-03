import {
  getOAuthApiKey,
  refreshOpenAICodexToken,
  type OAuthCredentials,
} from '@mariozechner/pi-ai/oauth'
import { getSecureStorage } from './secureStorage/index.js'

const STORAGE_KEY = 'openaiCodexOauth'
const OPENAI_CODEX_PROVIDER_ID = 'openai-codex'

export type OpenAICodexOAuthCredentials = OAuthCredentials & {
  email?: string
  accountId?: string
  profileName?: string
}

export type OpenAICodexTokenSource = 'OPENAI_CODEX_ACCESS_TOKEN' | 'stored'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeExpires(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }
  const numeric = Number(trimmed)
  if (Number.isFinite(numeric)) {
    return numeric
  }
  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) {
    return null
  }
  try {
    const decoded = Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')
    const parsed = JSON.parse(decoded)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function getOpenAICodexAccountInfoFromToken(token: string): {
  email?: string
  accountId?: string
  profileName?: string
} {
  const payload = decodeJwtPayload(token)
  const profile = isRecord(payload?.['https://api.openai.com/profile'])
    ? payload['https://api.openai.com/profile']
    : null
  const auth = isRecord(payload?.['https://api.openai.com/auth'])
    ? payload['https://api.openai.com/auth']
    : null
  const email = normalizeString(profile?.email)
  const accountId =
    normalizeString(auth?.chatgpt_account_id) ??
    normalizeString(auth?.chatgpt_account_user_id) ??
    normalizeString(auth?.chatgpt_user_id) ??
    normalizeString(auth?.user_id)

  if (email) {
    return { email, accountId, profileName: email }
  }
  if (accountId) {
    return {
      accountId,
      profileName: `id-${Buffer.from(accountId).toString('base64url')}`,
    }
  }
  return {}
}

function normalizeCredentials(
  value: unknown,
): OpenAICodexOAuthCredentials | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const access = normalizeString(value.access)
  const refresh = normalizeString(value.refresh)
  const expires = normalizeExpires(value.expires)
  if (!access || !refresh || expires === undefined) {
    return undefined
  }
  return {
    access,
    refresh,
    expires,
    email: normalizeString(value.email),
    accountId: normalizeString(value.accountId),
    profileName: normalizeString(value.profileName),
  }
}

function getEnvCredentials():
  | { access: string; refresh?: string; expires?: number }
  | undefined {
  const access = normalizeString(process.env.OPENAI_CODEX_ACCESS_TOKEN)
  const refresh = normalizeString(process.env.OPENAI_CODEX_REFRESH_TOKEN)
  const expires = normalizeExpires(process.env.OPENAI_CODEX_EXPIRES_AT)
  if (!access && !refresh) {
    return undefined
  }
  return { ...(access && { access }), ...(refresh && { refresh }), ...(expires !== undefined && { expires }) } as {
    access: string
    refresh?: string
    expires?: number
  }
}

export function getStoredOpenAICodexOAuthCredentials():
  | OpenAICodexOAuthCredentials
  | undefined {
  const envCredentials = getEnvCredentials()
  if (envCredentials?.access && envCredentials.refresh && envCredentials.expires) {
    const tokenInfo = getOpenAICodexAccountInfoFromToken(envCredentials.access)
    return {
      access: envCredentials.access,
      refresh: envCredentials.refresh,
      expires: envCredentials.expires,
      ...tokenInfo,
    }
  }

  const storageData = getSecureStorage().read()
  const stored = isRecord(storageData) ? storageData[STORAGE_KEY] : undefined
  return normalizeCredentials(stored)
}

export function getOpenAICodexAccessTokenSync(): string | undefined {
  return (
    normalizeString(process.env.OPENAI_CODEX_ACCESS_TOKEN) ||
    getStoredOpenAICodexOAuthCredentials()?.access
  )
}

export function getOpenAICodexTokenSource(): OpenAICodexTokenSource | undefined {
  if (normalizeString(process.env.OPENAI_CODEX_ACCESS_TOKEN)) {
    return 'OPENAI_CODEX_ACCESS_TOKEN'
  }
  return getStoredOpenAICodexOAuthCredentials() ? 'stored' : undefined
}

export function hasOpenAICodexOAuthCredentials(): boolean {
  return !!getOpenAICodexAccessTokenSync()
}

export function saveOpenAICodexOAuthCredentials(
  credentials: OpenAICodexOAuthCredentials,
): { success: boolean; warning?: string } {
  const secureStorage = getSecureStorage()
  const storageData = secureStorage.read() || {}
  const tokenInfo = getOpenAICodexAccountInfoFromToken(credentials.access)
  ;(storageData as Record<string, unknown>)[STORAGE_KEY] = {
    access: credentials.access,
    refresh: credentials.refresh,
    expires: credentials.expires,
    email: credentials.email ?? tokenInfo.email,
    accountId: credentials.accountId ?? tokenInfo.accountId,
    profileName: credentials.profileName ?? tokenInfo.profileName,
  }
  return secureStorage.update(storageData)
}

export function clearOpenAICodexOAuthCredentials(): boolean {
  const secureStorage = getSecureStorage()
  const storageData = secureStorage.read()
  if (!isRecord(storageData) || !(STORAGE_KEY in storageData)) {
    return true
  }
  const next = { ...storageData }
  delete next[STORAGE_KEY]
  return secureStorage.update(next).success
}

export async function resolveOpenAICodexAccessToken(): Promise<string> {
  const envAccess = normalizeString(process.env.OPENAI_CODEX_ACCESS_TOKEN)
  if (envAccess) {
    return envAccess
  }

  const envRefresh = normalizeString(process.env.OPENAI_CODEX_REFRESH_TOKEN)
  const envExpires = normalizeExpires(process.env.OPENAI_CODEX_EXPIRES_AT)
  if (envRefresh && envExpires !== undefined && Date.now() >= envExpires) {
    const refreshed = await refreshOpenAICodexToken(envRefresh)
    return refreshed.access
  }

  const credentials = getStoredOpenAICodexOAuthCredentials()
  if (!credentials) {
    throw new Error(
      'OpenAI Codex OAuth credentials not found. Run `claude auth login --provider openai-codex` or set OPENAI_CODEX_ACCESS_TOKEN.',
    )
  }

  const result = await getOAuthApiKey(OPENAI_CODEX_PROVIDER_ID, {
    [OPENAI_CODEX_PROVIDER_ID]: credentials,
  })
  if (!result) {
    throw new Error(
      'OpenAI Codex OAuth credentials not found. Run `claude auth login --provider openai-codex` or set OPENAI_CODEX_ACCESS_TOKEN.',
    )
  }

  if (
    result.newCredentials.access !== credentials.access ||
    result.newCredentials.refresh !== credentials.refresh ||
    result.newCredentials.expires !== credentials.expires
  ) {
    void saveOpenAICodexOAuthCredentials({
      ...credentials,
      ...result.newCredentials,
    })
  }

  return result.apiKey
}
