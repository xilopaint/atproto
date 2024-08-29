import { OAuthClientId } from './oauth-client-id.js'

export function parseOAuthClientIdUrl(clientId: OAuthClientId): URL {
  const url = new URL(clientId)

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError('ClientID must use the "https:" or "http:" protocol')
  }

  if (url.pathname.endsWith('/')) {
    throw new TypeError('ClientID path must not end with a trailing slash')
  }

  // URL constructor normalizes the "/./" and "/../" in the pathname, but not
  // "//".
  if (url.pathname !== normalizePath(url.pathname)) {
    throw new TypeError(
      'ClientID must not contain ".", ".." or "//" path segments',
    )
  }

  url.searchParams.sort()

  // URL constructor normalizes the URL, so we need to compare the canonical form
  const canonicalUri = url.pathname === '/' ? url.origin + url.search : url.href
  if (canonicalUri !== clientId) {
    throw new TypeError(
      `ClientID must be in canonical form ("${canonicalUri}", got "${clientId}")`,
    )
  }

  return url
}

function normalizePath(path: string): string {
  const isAbsolute = path.startsWith('/')
  const parts = path.split('/')

  const normalized: string[] = []

  for (const part of parts) {
    if (part === '..') {
      normalized.pop()
    } else if (part !== '.' && part !== '') {
      normalized.push(part)
    }
  }

  return `${isAbsolute ? '/' : ''}${normalized.join('/')}`
}
