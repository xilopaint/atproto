import { parseOAuthClientIdUrl } from './oauth-client-id-url.js'
import { OAuthClientId } from './oauth-client-id.js'
import { isIP } from './util.js'

/**
 * @see {@link https://drafts.aaronpk.com/draft-parecki-oauth-client-id-metadata-document/draft-parecki-oauth-client-id-metadata-document.html}
 */
export type OAuthClientIdDiscoverable = OAuthClientId & `https://${string}`

export function isOAuthClientIdDiscoverable(
  clientId: string,
): clientId is OAuthClientIdDiscoverable {
  try {
    parseOAuthDiscoverableClientId(clientId)
    return true
  } catch {
    return false
  }
}

export function assertOAuthDiscoverableClientId(
  value: string,
): asserts value is OAuthClientIdDiscoverable {
  void parseOAuthDiscoverableClientId(value)
}

export function parseOAuthDiscoverableClientId(clientId: string): URL {
  const url = parseOAuthClientIdUrl(clientId)

  // Optimization: cheap checks first

  if (url.hostname === 'localhost') {
    throw new TypeError('ClientID must not be a loopback hostname')
  }

  if (url.protocol !== 'https:') {
    throw new TypeError('ClientID must use the "https:" protocol')
  }

  if (url.hash) {
    throw new TypeError('ClientID must not contain a fragment')
  }

  if (url.username || url.password) {
    throw new TypeError('ClientID must not contain credentials')
  }

  if (url.pathname === '/') {
    throw new TypeError(
      'ClientID must contain a path (e.g. "/client-metadata.json")',
    )
  }

  // Note: Query string is allowed
  // Note: no restriction on the port for non-loopback URIs

  if (isIP(url.hostname)) {
    throw new TypeError('ClientID must not be an IP address')
  }

  return url
}
