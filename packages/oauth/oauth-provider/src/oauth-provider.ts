import { safeFetchWrap } from '@atproto-labs/fetch-node'
import { SimpleStore } from '@atproto-labs/simple-store'
import { SimpleStoreMemory } from '@atproto-labs/simple-store-memory'
import { Jwks, Keyset } from '@atproto/jwk'
import {
  AccessToken,
  CLIENT_ASSERTION_TYPE_JWT_BEARER,
  OAuthAuthenticationRequestParameters,
  OAuthAuthorizationServerMetadata,
  OAuthClientIdentification,
  OAuthClientMetadata,
  OAuthParResponse,
  OAuthTokenResponse,
  OAuthTokenType,
  atprotoLoopbackClientMetadata,
  oauthAuthenticationRequestParametersSchema,
} from '@atproto/oauth-types'
import { Redis, type RedisOptions } from 'ioredis'
import z, { ZodError } from 'zod'

import { AccessTokenType } from './access-token/access-token-type.js'
import { AccountManager } from './account/account-manager.js'
import {
  AccountStore,
  DeviceAccountInfo,
  SignInCredentials,
  asAccountStore,
  signInCredentialsSchema,
} from './account/account-store.js'
import { Account } from './account/account.js'
import { authorizeAssetsMiddleware } from './assets/assets-middleware.js'
import { ClientAuth, authJwkThumbprint } from './client/client-auth.js'
import { ClientId, clientIdSchema } from './client/client-id.js'
import {
  ClientManager,
  LoopbackMetadataGetter,
} from './client/client-manager.js'
import { ClientStore, ifClientStore } from './client/client-store.js'
import { Client } from './client/client.js'
import { AUTHENTICATION_MAX_AGE, TOKEN_MAX_AGE } from './constants.js'
import { DeviceId } from './device/device-id.js'
import { DeviceManager } from './device/device-manager.js'
import { DeviceStore, asDeviceStore } from './device/device-store.js'
import { AccessDeniedError } from './errors/access-denied-error.js'
import { AccountSelectionRequiredError } from './errors/account-selection-required-error.js'
import { ConsentRequiredError } from './errors/consent-required-error.js'
import { InvalidClientError } from './errors/invalid-client-error.js'
import { InvalidGrantError } from './errors/invalid-grant-error.js'
import { InvalidParametersError } from './errors/invalid-parameters-error.js'
import { InvalidRequestError } from './errors/invalid-request-error.js'
import { LoginRequiredError } from './errors/login-required-error.js'
import { OAuthError } from './errors/oauth-error.js'
import { UnauthorizedClientError } from './errors/unauthorized-client-error.js'
import { WWWAuthenticateError } from './errors/www-authenticate-error.js'
import {
  Handler,
  IncomingMessage,
  Middleware,
  Router,
  ServerResponse,
  combineMiddlewares,
  setupCsrfToken,
  staticJsonHandler,
  validateCsrfToken,
  validateFetchDest,
  validateFetchMode,
  validateFetchSite,
  validateReferer,
  validateRequestPayload,
  validateSameOrigin,
  writeJson,
} from './lib/http/index.js'
import { dateToEpoch, dateToRelativeSeconds } from './lib/util/date.js'
import { Override } from './lib/util/type.js'
import { CustomMetadata, buildMetadata } from './metadata/build-metadata.js'
import { OAuthHooks } from './oauth-hooks.js'
import { OAuthVerifier, OAuthVerifierOptions } from './oauth-verifier.js'
import { AuthorizationResultAuthorize } from './output/build-authorize-data.js'
import {
  buildErrorPayload,
  buildErrorStatus,
} from './output/build-error-payload.js'
import { Customization } from './output/customization.js'
import { OutputManager } from './output/output-manager.js'
import {
  AuthorizationResultRedirect,
  sendAuthorizeRedirect,
} from './output/send-authorize-redirect.js'
import { ReplayStore, ifReplayStore } from './replay/replay-store.js'
import { RequestInfo } from './request/request-info.js'
import { RequestManager } from './request/request-manager.js'
import { RequestStoreMemory } from './request/request-store-memory.js'
import { RequestStoreRedis } from './request/request-store-redis.js'
import { RequestStore, ifRequestStore } from './request/request-store.js'
import { RequestUri, requestUriSchema } from './request/request-uri.js'
import {
  AuthorizationRequestJar,
  AuthorizationRequestQuery,
  PushedAuthorizationRequest,
  authorizationRequestQuerySchema,
  pushedAuthorizationRequestSchema,
} from './request/types.js'
import { isTokenId } from './token/token-id.js'
import { TokenManager } from './token/token-manager.js'
import { TokenStore, asTokenStore } from './token/token-store.js'
import {
  CodeGrantRequest,
  Introspect,
  IntrospectionResponse,
  RefreshGrantRequest,
  Revoke,
  TokenRequest,
  introspectSchema,
  revokeSchema,
  tokenRequestSchema,
} from './token/types.js'
import { VerifyTokenClaimsOptions } from './token/verify-token-claims.js'

export type OAuthProviderStore = Partial<
  ClientStore &
    AccountStore &
    DeviceStore &
    TokenStore &
    RequestStore &
    ReplayStore
>

export {
  Keyset,
  type CustomMetadata,
  type Customization,
  type Handler,
  type OAuthAuthorizationServerMetadata,
}

export type RouterOptions<
  Req extends IncomingMessage = IncomingMessage,
  Res extends ServerResponse = ServerResponse,
> = {
  onError?: (req: Req, res: Res, err: unknown, message: string) => void
}

export type OAuthProviderOptions = Override<
  OAuthVerifierOptions & OAuthHooks,
  {
    /**
     * Maximum age a device/account session can be before requiring
     * re-authentication.
     */
    authenticationMaxAge?: number

    /**
     * Maximum age access & id tokens can be before requiring a refresh.
     */
    tokenMaxAge?: number

    /**
     * Additional metadata to be included in the discovery document.
     */
    metadata?: CustomMetadata

    /**
     * UI customizations
     */
    customization?: Customization

    /**
     * A custom fetch function that can be used to fetch the client metadata from
     * the internet. By default, the fetch function is a safeFetchWrap() function
     * that protects against SSRF attacks, large responses & known bad domains. If
     * you want to disable all protections, you can provide `globalThis.fetch` as
     * fetch function.
     */
    safeFetch?: typeof globalThis.fetch

    /**
     * A redis instance to use for replay protection. If not provided, replay
     * protection will use memory storage.
     */
    redis?: Redis | RedisOptions | string

    /**
     * This will be used as the default store for all the stores. If a store is
     * not provided, this store will be used instead. If the `store` does not
     * implement a specific store, a runtime error will be thrown. Make sure that
     * this store implements all the interfaces not provided in the other
     * `<name>Store` options.
     */
    store?: OAuthProviderStore

    accountStore?: AccountStore
    deviceStore?: DeviceStore
    clientStore?: ClientStore
    replayStore?: ReplayStore
    requestStore?: RequestStore
    tokenStore?: TokenStore

    /**
     * In order to speed up the client fetching process, you can provide a cache
     * to store HTTP responses.
     *
     * @note the cached entries should automatically expire after a certain time (typically 10 minutes)
     */
    clientJwksCache?: SimpleStore<string, Jwks>

    /**
     * In order to speed up the client fetching process, you can provide a cache
     * to store HTTP responses.
     *
     * @note the cached entries should automatically expire after a certain time (typically 10 minutes)
     */
    clientMetadataCache?: SimpleStore<string, OAuthClientMetadata>

    /**
     * In order to enable loopback clients, you can provide a function that
     * returns the client metadata for a given loopback URL. This is useful for
     * development and testing purposes. This function is not called for internet
     * clients.
     *
     * @default is as specified by ATPROTO
     */
    loopbackMetadata?: null | false | LoopbackMetadataGetter
  }
>

export class OAuthProvider extends OAuthVerifier {
  public readonly metadata: OAuthAuthorizationServerMetadata
  public readonly customization?: Customization

  public readonly authenticationMaxAge: number

  public readonly accountManager: AccountManager
  public readonly deviceStore: DeviceStore
  public readonly clientManager: ClientManager
  public readonly requestManager: RequestManager
  public readonly tokenManager: TokenManager

  public constructor({
    metadata,
    customization = undefined,
    authenticationMaxAge = AUTHENTICATION_MAX_AGE,
    tokenMaxAge = TOKEN_MAX_AGE,

    safeFetch = safeFetchWrap(),
    redis,
    store, // compound store implementation

    // Requires stores
    accountStore = asAccountStore(store),
    deviceStore = asDeviceStore(store),
    tokenStore = asTokenStore(store),

    // These are optional
    clientStore = ifClientStore(store),
    replayStore = ifReplayStore(store),
    requestStore = ifRequestStore(store),

    clientJwksCache = new SimpleStoreMemory({
      maxSize: 50_000_000,
      ttl: 600e3,
    }),
    clientMetadataCache = new SimpleStoreMemory({
      maxSize: 50_000_000,
      ttl: 600e3,
    }),

    loopbackMetadata = atprotoLoopbackClientMetadata,

    // OAuthHooks & OAuthVerifierOptions
    ...rest
  }: OAuthProviderOptions) {
    super({ replayStore, redis, ...rest })

    requestStore ??= redis
      ? new RequestStoreRedis({ redis })
      : new RequestStoreMemory()

    this.authenticationMaxAge = authenticationMaxAge
    this.metadata = buildMetadata(this.issuer, this.keyset, metadata)
    this.customization = customization

    this.deviceStore = deviceStore

    this.accountManager = new AccountManager(accountStore)
    this.clientManager = new ClientManager(
      this.metadata,
      this.keyset,
      rest,
      clientStore || null,
      loopbackMetadata || null,
      safeFetch,
      clientJwksCache,
      clientMetadataCache,
    )
    this.requestManager = new RequestManager(
      requestStore,
      this.signer,
      this.metadata,
      rest,
    )
    this.tokenManager = new TokenManager(
      tokenStore,
      this.signer,
      rest,
      this.accessTokenType,
      tokenMaxAge,
    )
  }

  get jwks() {
    return this.keyset.publicJwks
  }

  protected loginRequired(
    client: Client,
    parameters: OAuthAuthenticationRequestParameters,
    info: DeviceAccountInfo,
  ) {
    /** in seconds */
    const authAge = (Date.now() - info.authenticatedAt.getTime()) / 1e3

    // Fool-proof (invalid date, or suspiciously in the future)
    if (!Number.isFinite(authAge) || authAge < 0) {
      return true
    }

    return authAge >= this.authenticationMaxAge
  }

  protected async authenticateClient(
    client: Client,
    credentials: OAuthClientIdentification,
  ): Promise<ClientAuth> {
    const { clientAuth, nonce } = await client.verifyCredentials(credentials, {
      audience: this.issuer,
    })

    if (nonce != null) {
      const unique = await this.replayManager.uniqueAuth(nonce, client.id)
      if (!unique) {
        throw new InvalidClientError(`${clientAuth.method} jti reused`)
      }
    }

    return clientAuth
  }

  protected async decodeJAR(
    client: Client,
    input: AuthorizationRequestJar,
  ): Promise<
    | {
        payload: OAuthAuthenticationRequestParameters
      }
    | {
        payload: OAuthAuthenticationRequestParameters
        protectedHeader: { kid: string; alg: string }
        jkt: string
      }
  > {
    const result = await client.decodeRequestObject(input.request)
    const payload = oauthAuthenticationRequestParametersSchema.parse(
      result.payload,
    )

    if (!result.payload.jti) {
      throw new InvalidParametersError(
        payload,
        'Request object must contain a jti claim',
      )
    }

    if (!(await this.replayManager.uniqueJar(result.payload.jti, client.id))) {
      throw new InvalidParametersError(
        payload,
        'Request object jti is not unique',
      )
    }

    if ('protectedHeader' in result) {
      if (!result.protectedHeader.kid) {
        throw new InvalidParametersError(payload, 'Missing "kid" in header')
      }

      return {
        jkt: await authJwkThumbprint(result.key),
        payload,
        protectedHeader: result.protectedHeader as {
          alg: string
          kid: string
        },
      }
    }

    if ('header' in result) {
      return {
        payload,
      }
    }

    // Should never happen
    throw new Error('Invalid request object')
  }

  /**
   * @see {@link https://datatracker.ietf.org/doc/html/rfc9126}
   */
  protected async pushedAuthorizationRequest(
    input: PushedAuthorizationRequest,
    dpopJkt: null | string,
  ): Promise<OAuthParResponse> {
    try {
      const client = await this.clientManager.getClient(input.client_id)
      const clientAuth = await this.authenticateClient(client, input)

      const { payload: parameters } =
        'request' in input // Handle JAR
          ? await this.decodeJAR(client, input)
          : { payload: input }

      const { uri, expiresAt } =
        await this.requestManager.createAuthorizationRequest(
          client,
          clientAuth,
          parameters,
          null,
          dpopJkt,
        )

      return {
        request_uri: uri,
        expires_in: dateToRelativeSeconds(expiresAt),
      }
    } catch (err) {
      // https://datatracker.ietf.org/doc/html/rfc9126#section-2.3-1
      // > Since initial processing of the pushed authorization request does not
      // > involve resource owner interaction, error codes related to user
      // > interaction, such as consent_required defined by [OIDC], are never
      // > returned.
      if (err instanceof AccessDeniedError) {
        throw new InvalidRequestError(err.error_description, err)
      }
      throw err
    }
  }

  private async loadAuthorizationRequest(
    client: Client,
    deviceId: DeviceId,
    input: AuthorizationRequestQuery,
  ): Promise<RequestInfo> {
    // Load PAR
    if ('request_uri' in input) {
      return this.requestManager.get(input.request_uri, client.id, deviceId)
    }

    // Handle JAR
    if ('request' in input) {
      const requestObject = await this.decodeJAR(client, input)

      if ('protectedHeader' in requestObject && requestObject.protectedHeader) {
        // Allow using signed JAR during "/authorize" as client authentication.
        // This allows clients to skip PAR to initiate trusted sessions.
        const clientAuth: ClientAuth = {
          method: CLIENT_ASSERTION_TYPE_JWT_BEARER,
          kid: requestObject.protectedHeader.kid,
          alg: requestObject.protectedHeader.alg,
          jkt: requestObject.jkt,
        }

        return this.requestManager.createAuthorizationRequest(
          client,
          clientAuth,
          requestObject.payload,
          deviceId,
          null,
        )
      }

      return this.requestManager.createAuthorizationRequest(
        client,
        { method: 'none' },
        requestObject.payload,
        deviceId,
        null,
      )
    }

    return this.requestManager.createAuthorizationRequest(
      client,
      { method: 'none' },
      input,
      deviceId,
      null,
    )
  }

  private async deleteRequest(
    uri: RequestUri,
    parameters: OAuthAuthenticationRequestParameters,
  ) {
    try {
      await this.requestManager.delete(uri)
    } catch (err) {
      throw AccessDeniedError.from(parameters, err)
    }
  }

  protected async authorize(
    deviceId: DeviceId,
    input: AuthorizationRequestQuery,
  ): Promise<AuthorizationResultRedirect | AuthorizationResultAuthorize> {
    const { issuer } = this
    const client = await this.clientManager.getClient(input.client_id)

    try {
      const { uri, parameters, clientAuth } =
        await this.loadAuthorizationRequest(client, deviceId, input)

      try {
        const sessions = await this.getSessions(
          client,
          clientAuth,
          deviceId,
          parameters,
        )

        if (parameters.prompt === 'none') {
          const ssoSessions = sessions.filter((s) => s.matchesHint)
          if (ssoSessions.length > 1) {
            throw new AccountSelectionRequiredError(parameters)
          }
          if (ssoSessions.length < 1) {
            throw new LoginRequiredError(parameters)
          }

          const ssoSession = ssoSessions[0]!
          if (ssoSession.loginRequired) {
            throw new LoginRequiredError(parameters)
          }
          if (ssoSession.consentRequired) {
            throw new ConsentRequiredError(parameters)
          }

          const code = await this.requestManager.setAuthorized(
            client,
            uri,
            deviceId,
            ssoSession.account,
          )

          return { issuer, client, parameters, redirect: { code } }
        }

        // Automatic SSO when a did was provided
        if (parameters.prompt == null && parameters.login_hint != null) {
          const ssoSessions = sessions.filter((s) => s.matchesHint)
          if (ssoSessions.length === 1) {
            const ssoSession = ssoSessions[0]!
            if (!ssoSession.loginRequired && !ssoSession.consentRequired) {
              const code = await this.requestManager.setAuthorized(
                client,
                uri,
                deviceId,
                ssoSession.account,
              )

              return { issuer, client, parameters, redirect: { code } }
            }
          }
        }

        return {
          issuer,
          client,
          parameters,
          authorize: {
            uri,
            sessions,
            scopeDetails: parameters.scope
              ?.split(/\s+/)
              .filter(Boolean)
              .sort((a, b) => a.localeCompare(b))
              .map((scope) => ({
                scope,
                // @TODO Allow to customize the scope descriptions (e.g.
                // using a hook)
                description: undefined,
              })),
          },
        }
      } catch (err) {
        await this.deleteRequest(uri, parameters)

        // Transform into an AccessDeniedError to allow redirecting the user
        // to the client with the error details.
        throw AccessDeniedError.from(parameters, err)
      }
    } catch (err) {
      if (err instanceof AccessDeniedError) {
        return {
          issuer,
          client,
          parameters: err.parameters,
          redirect: err.toJSON(),
        }
      }

      throw err
    }
  }

  protected async getSessions(
    client: Client,
    clientAuth: ClientAuth,
    deviceId: DeviceId,
    parameters: OAuthAuthenticationRequestParameters,
  ): Promise<
    {
      account: Account
      info: DeviceAccountInfo

      selected: boolean
      loginRequired: boolean
      consentRequired: boolean

      matchesHint: boolean
    }[]
  > {
    const accounts = await this.accountManager.list(deviceId)

    const hint = parameters.login_hint
    const matchesHint = (account: Account): boolean =>
      (!!account.sub && account.sub === hint) ||
      (!!account.preferred_username && account.preferred_username === hint)

    return accounts.map(({ account, info }) => ({
      account,
      info,

      selected:
        parameters.prompt !== 'select_account' &&
        matchesHint(account) &&
        // If an account uses the sub of another account as preferred_username,
        // there might be multiple accounts matching the hint. In that case,
        // selecting the account automatically may have unexpected results (i.e.
        // not able to login using desired account).
        accounts.reduce(
          (acc, a) => acc + (matchesHint(a.account) ? 1 : 0),
          0,
        ) === 1,
      loginRequired:
        parameters.prompt === 'login' ||
        this.loginRequired(client, parameters, info),
      consentRequired:
        parameters.prompt === 'consent' ||
        // @TODO the "authorizedClients" should also include the scopes that
        // were already authorized for the client. Otherwise a client could
        // use silent authentication to get additional scopes without consent.
        !info.authorizedClients.includes(client.id),

      matchesHint: hint == null || matchesHint(account),
    }))
  }

  protected async signIn(
    deviceId: DeviceId,
    uri: RequestUri,
    clientId: ClientId,
    credentials: SignInCredentials,
  ): Promise<{
    account: Account
    consentRequired: boolean
  }> {
    const client = await this.clientManager.getClient(clientId)

    // Ensure the request is still valid (and update the request expiration)
    // @TODO use the returned scopes to determine if consent is required
    await this.requestManager.get(uri, clientId, deviceId)

    const { account, info } = await this.accountManager.signIn(
      credentials,
      deviceId,
    )

    return {
      account,
      consentRequired: client.info.isFirstParty
        ? false
        : // @TODO: the "authorizedClients" should also include the scopes that
          // were already authorized for the client. Otherwise a client could
          // use silent authentication to get additional scopes without consent.
          !info.authorizedClients.includes(client.id),
    }
  }

  protected async acceptRequest(
    deviceId: DeviceId,
    uri: RequestUri,
    clientId: ClientId,
    sub: string,
  ): Promise<AuthorizationResultRedirect> {
    const { issuer } = this
    const client = await this.clientManager.getClient(clientId)

    try {
      const { parameters, clientAuth } = await this.requestManager.get(
        uri,
        clientId,
        deviceId,
      )

      try {
        const { account, info } = await this.accountManager.get(deviceId, sub)

        // The user is trying to authorize without a fresh login
        if (this.loginRequired(client, parameters, info)) {
          throw new LoginRequiredError(
            parameters,
            'Account authentication required.',
          )
        }

        const code = await this.requestManager.setAuthorized(
          client,
          uri,
          deviceId,
          account,
        )

        await this.accountManager.addAuthorizedClient(
          deviceId,
          account,
          client,
          clientAuth,
        )

        return { issuer, client, parameters, redirect: { code } }
      } catch (err) {
        await this.deleteRequest(uri, parameters)

        // throw AccessDeniedError.from(parameters, err)
        throw err
      }
    } catch (err) {
      if (err instanceof AccessDeniedError) {
        const { parameters } = err
        return { issuer, client, parameters, redirect: err.toJSON() }
      }

      throw err
    }
  }

  protected async rejectRequest(
    deviceId: DeviceId,
    uri: RequestUri,
    clientId: ClientId,
  ): Promise<AuthorizationResultRedirect> {
    try {
      const { parameters } = await this.requestManager.get(
        uri,
        clientId,
        deviceId,
      )

      await this.deleteRequest(uri, parameters)

      // Trigger redirect (see catch block)
      throw new AccessDeniedError(parameters, 'Access denied')
    } catch (err) {
      if (err instanceof AccessDeniedError) {
        return {
          issuer: this.issuer,
          client: await this.clientManager.getClient(clientId),
          parameters: err.parameters,
          redirect: err.toJSON(),
        }
      }

      throw err
    }
  }

  protected async token(
    input: TokenRequest,
    dpopJkt: null | string,
  ): Promise<OAuthTokenResponse> {
    const client = await this.clientManager.getClient(input.client_id)
    const clientAuth = await this.authenticateClient(client, input)

    if (!client.metadata.grant_types.includes(input.grant_type)) {
      throw new InvalidGrantError(
        `"${input.grant_type}" grant type is not allowed for this client`,
      )
    }

    if (input.grant_type === 'authorization_code') {
      return this.codeGrant(client, clientAuth, input, dpopJkt)
    }

    if (input.grant_type === 'refresh_token') {
      return this.refreshTokenGrant(client, clientAuth, input, dpopJkt)
    }

    throw new InvalidGrantError(
      // @ts-expect-error: fool proof
      `Grant type "${input.grant_type}" not supported`,
    )
  }

  protected async codeGrant(
    client: Client,
    clientAuth: ClientAuth,
    input: CodeGrantRequest,
    dpopJkt: null | string,
  ): Promise<OAuthTokenResponse> {
    try {
      const { sub, deviceId, parameters } = await this.requestManager.findCode(
        client,
        clientAuth,
        input.code,
      )

      // the following check prevents re-use of PKCE challenges, enforcing the
      // clients to generate a new challenge for each authorization request. The
      // replay manager typically prevents replay over a certain time frame,
      // which might not cover the entire lifetime of the token (depending on
      // the implementation of the replay store). For this reason, we should
      // ideally ensure that the code_challenge was not already used by any
      // existing token or any other pending request.
      //
      // The current implementation will cause client devs not issuing a new
      // code challenge for each authorization request to fail, which should be
      // a good enough incentive to follow the best practices, until we have a
      // better implementation.
      //
      // @TODO: Use tokenManager to ensure uniqueness of code_challenge
      if (parameters.code_challenge) {
        const unique = await this.replayManager.uniqueCodeChallenge(
          parameters.code_challenge,
        )
        if (!unique) {
          throw new InvalidGrantError(
            'code_challenge',
            'Code challenge already used',
          )
        }
      }

      const { account, info } = await this.accountManager.get(deviceId, sub)

      return await this.tokenManager.create(
        client,
        clientAuth,
        account,
        { id: deviceId, info },
        parameters,
        input,
        dpopJkt,
      )
    } catch (err) {
      // If a token is replayed, requestManager.findCode will throw. In that
      // case, we need to revoke any token that was issued for this code.

      await this.tokenManager.revoke(input.code)

      // @TODO (?) in order to protect the user, we should maybe also mark the
      // account-device association as expired ?

      throw err
    }
  }

  async refreshTokenGrant(
    client: Client,
    clientAuth: ClientAuth,
    input: RefreshGrantRequest,
    dpopJkt: null | string,
  ): Promise<OAuthTokenResponse> {
    return this.tokenManager.refresh(client, clientAuth, input, dpopJkt)
  }

  /**
   * @see {@link https://datatracker.ietf.org/doc/html/rfc7009#section-2.1 rfc7009}
   */
  protected async revoke(input: Revoke) {
    // @TODO this should also remove the account-device association (or, at
    // least, mark it as expired)
    await this.tokenManager.revoke(input.token)
  }

  /**
   * @see {@link https://datatracker.ietf.org/doc/html/rfc7662#section-2.1 rfc7662}
   */
  protected async introspect(
    input: Introspect,
  ): Promise<IntrospectionResponse> {
    const client = await this.clientManager.getClient(input.client_id)
    const clientAuth = await this.authenticateClient(client, input)

    // RFC7662 states the following:
    //
    // > To prevent token scanning attacks, the endpoint MUST also require some
    // > form of authorization to access this endpoint, such as client
    // > authentication as described in OAuth 2.0 [RFC6749] or a separate OAuth
    // > 2.0 access token such as the bearer token described in OAuth 2.0 Bearer
    // > Token Usage [RFC6750]. The methods of managing and validating these
    // > authentication credentials are out of scope of this specification.
    if (clientAuth.method === 'none') {
      throw new UnauthorizedClientError('Client authentication required')
    }

    const start = Date.now()
    try {
      const tokenInfo = await this.tokenManager.clientTokenInfo(
        client,
        clientAuth,
        input.token,
      )

      return {
        active: true,

        scope: tokenInfo.data.parameters.scope,
        client_id: tokenInfo.data.clientId,
        username: tokenInfo.account.preferred_username,
        token_type: tokenInfo.data.parameters.dpop_jkt ? 'DPoP' : 'Bearer',
        authorization_details: tokenInfo.data.details ?? undefined,

        aud: tokenInfo.account.aud,
        exp: dateToEpoch(tokenInfo.data.expiresAt),
        iat: dateToEpoch(tokenInfo.data.updatedAt),
        iss: this.signer.issuer,
        jti: tokenInfo.id,
        sub: tokenInfo.account.sub,
      }
    } catch (err) {
      // Prevent brute force & timing attack (only for inactive tokens)
      await new Promise((r) => setTimeout(r, 750 - (Date.now() - start)))

      return {
        active: false,
      }
    }
  }

  protected override async authenticateToken(
    tokenType: OAuthTokenType,
    token: AccessToken,
    dpopJkt: string | null,
    verifyOptions?: VerifyTokenClaimsOptions,
  ) {
    if (isTokenId(token)) {
      this.assertTokenTypeAllowed(tokenType, AccessTokenType.id)

      return this.tokenManager.authenticateTokenId(
        tokenType,
        token,
        dpopJkt,
        verifyOptions,
      )
    }

    return super.authenticateToken(tokenType, token, dpopJkt, verifyOptions)
  }

  /**
   * @returns An http request handler that can be used with node's http server
   * or as a middleware with express / connect.
   */
  public httpHandler<
    T = void,
    Req extends IncomingMessage = IncomingMessage,
    Res extends ServerResponse = ServerResponse,
  >(options?: RouterOptions<Req, Res>): Handler<T, Req, Res> {
    const router = this.buildRouter<T, Req, Res>(options)
    return router.buildHandler()
  }

  public buildRouter<
    T = void,
    Req extends IncomingMessage = IncomingMessage,
    Res extends ServerResponse = ServerResponse,
  >({
    onError = process.env['NODE_ENV'] === 'development'
      ? (req, res, err, msg): void =>
          console.error(`OAuthProvider error (${msg}):`, err)
      : undefined,
  }: RouterOptions<Req, Res> = {}) {
    const deviceManager = new DeviceManager(this.deviceStore)
    const outputManager = new OutputManager(this.customization)

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const server = this
    const issuerUrl = new URL(server.issuer)
    const issuerOrigin = issuerUrl.origin
    const router = new Router<T, Req, Res>(issuerUrl)

    // Utils

    const csrfCookie = (uri: RequestUri) => `csrf-${uri}`

    /**
     * Creates a middleware that will serve static JSON content.
     */
    const staticJson = (json: unknown): Middleware<void, Req, Res> =>
      combineMiddlewares([
        function (req, res, next) {
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('Access-Control-Allow-Headers', '*')

          res.setHeader('Cache-Control', 'max-age=300')
          next()
        },
        staticJsonHandler(json),
      ])

    /**
     * Wrap an OAuth endpoint in a middleware that will set the appropriate
     * response headers and format the response as JSON.
     */
    const jsonHandler = <T, TReq extends Req, TRes extends Res, Json>(
      buildJson: (this: T, req: TReq, res: TRes) => Json | Promise<Json>,
      status?: number,
    ): Handler<T, TReq, TRes> =>
      async function (req, res) {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Headers', '*')

        // https://www.rfc-editor.org/rfc/rfc6749.html#section-5.1
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Pragma', 'no-cache')

        // https://datatracker.ietf.org/doc/html/rfc9449#section-8.2
        const dpopNonce = server.nextDpopNonce()
        if (dpopNonce) {
          const name = 'DPoP-Nonce'
          res.setHeader(name, dpopNonce)
          res.appendHeader('Access-Control-Expose-Headers', name)
        }

        try {
          const result = await buildJson.call(this, req, res)
          if (result !== undefined) writeJson(res, result, status)
          else if (!res.headersSent) res.writeHead(status ?? 204).end()
        } catch (err) {
          if (!res.headersSent) {
            if (err instanceof WWWAuthenticateError) {
              const name = 'WWW-Authenticate'
              res.setHeader(name, err.wwwAuthenticateHeader)
              res.appendHeader('Access-Control-Expose-Headers', name)
            }

            writeJson(res, buildErrorPayload(err), buildErrorStatus(err))
          } else {
            res.destroy()
          }

          // OAuthError are used to build expected responses, so we don't log
          // them as errors.
          if (!(err instanceof OAuthError) || err.statusCode >= 500) {
            await onError?.(req, res, err, 'Unexpected error')
          }
        }
      }

    const navigationHandler = <T, TReq extends Req, TRes extends Res>(
      handler: (this: T, req: TReq, res: TRes) => void | Promise<void>,
    ): Handler<T, TReq, TRes> =>
      async function (req, res) {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Headers', '*')

        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Pragma', 'no-cache')

        try {
          validateFetchMode(req, res, ['navigate'])
          validateFetchDest(req, res, ['document'])
          validateSameOrigin(req, res, issuerOrigin)

          await handler.call(this, req, res)

          // Should never happen (fool proofing)
          if (!res.headersSent) {
            throw new Error('Navigation handler did not send a response')
          }
        } catch (err) {
          await onError?.(
            req,
            res,
            err,
            `Failed to handle navigation request to "${req.url}"`,
          )

          if (!res.headersSent) {
            await outputManager.sendErrorPage(res, err)
          }
        }
      }

    //- Public OAuth endpoints

    router.get(
      '/.well-known/oauth-authorization-server',
      staticJson(server.metadata),
    )

    // CORS preflight
    const corsPreflight: Middleware = function (req, res, _next) {
      res
        .writeHead(204, {
          // https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Origin
          //
          // > For requests without credentials, the literal value "*" can be
          // > specified as a wildcard; the value tells browsers to allow
          // > requesting code from any origin to access the resource.
          // > Attempting to use the wildcard with credentials results in an
          // > error.
          //
          // A "*" is safer to use than reflecting the request origin.
          'Access-Control-Allow-Origin': '*',
          // https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Methods
          // > The value "*" only counts as a special wildcard value for
          // > requests without credentials (requests without HTTP cookies or
          // > HTTP authentication information). In requests with credentials,
          // > it is treated as the literal method name "*" without special
          // > semantics.
          'Access-Control-Allow-Methods': '*',
          'Access-Control-Allow-Headers': 'Content-Type,Authorization,DPoP',
          'Access-Control-Max-Age': '86400', // 1 day
        })
        .end()
    }

    router.get('/oauth/jwks', staticJson(server.jwks))

    router.options('/oauth/par', corsPreflight)
    router.post(
      '/oauth/par',
      jsonHandler(async function (req, _res) {
        const input = await validateRequest(
          req,
          pushedAuthorizationRequestSchema,
        )

        const dpopJkt = await server.checkDpopProof(
          req.headers['dpop'],
          req.method!,
          this.url,
        )

        return server.pushedAuthorizationRequest(input, dpopJkt)
      }, 201),
    )

    // https://datatracker.ietf.org/doc/html/rfc9126#section-2.3
    // > If the request did not use the POST method, the authorization server
    // > responds with an HTTP 405 (Method Not Allowed) status code.
    router.options('/oauth/par', corsPreflight)
    router.all('/oauth/par', (req, res) => {
      res.writeHead(405).end()
    })

    router.options('/oauth/token', corsPreflight)
    router.post(
      '/oauth/token',
      jsonHandler(async function (req, _res) {
        const input = await validateRequest(req, tokenRequestSchema)

        const dpopJkt = await server.checkDpopProof(
          req.headers['dpop'],
          req.method!,
          this.url,
        )

        return server.token(input, dpopJkt)
      }),
    )

    router.options('/oauth/revoke', corsPreflight)
    router.post(
      '/oauth/revoke',
      jsonHandler(async function (req, res) {
        const input = await validateRequest(req, revokeSchema)

        try {
          await server.revoke(input)
        } catch (err) {
          onError?.(req, res, err, 'Failed to revoke token')
        }
      }),
    )

    router.options('/oauth/revoke', corsPreflight)
    router.get(
      '/oauth/revoke',
      navigationHandler(async function (req, res) {
        const query = Object.fromEntries(this.url.searchParams)
        const input = revokeSchema.parse(query, { path: ['query'] })

        try {
          await server.revoke(input)
        } catch (err) {
          onError?.(req, res, err, 'Failed to revoke token')
        }

        // Same as POST + redirect to callback URL
        // todo: generate JSONP response (if "callback" is provided)

        throw new Error(
          'You are successfully logged out. Redirect not implemented',
        )
      }),
    )

    router.post(
      '/oauth/introspect',
      jsonHandler(async function (req, _res) {
        const input = await validateRequest(req, introspectSchema)
        return server.introspect(input)
      }),
    )

    //- Private authorization endpoints

    router.use(authorizeAssetsMiddleware())

    router.get(
      '/oauth/authorize',
      navigationHandler(async function (req, res) {
        validateFetchSite(req, res, ['cross-site', 'none'])

        const query = Object.fromEntries(this.url.searchParams)
        const input = await authorizationRequestQuerySchema.parseAsync(query, {
          path: ['query'],
        })

        const { deviceId } = await deviceManager.load(req, res)
        const data = await server.authorize(deviceId, input)

        switch (true) {
          case 'redirect' in data: {
            return sendAuthorizeRedirect(res, data)
          }
          case 'authorize' in data: {
            await setupCsrfToken(req, res, csrfCookie(data.authorize.uri))
            return outputManager.sendAuthorizePage(res, data)
          }
          default: {
            // Should never happen
            throw new Error('Unexpected authorization result')
          }
        }
      }),
    )

    const signInPayloadSchema = z.object({
      csrf_token: z.string(),
      request_uri: requestUriSchema,
      client_id: clientIdSchema,
      credentials: signInCredentialsSchema,
    })

    router.options('/oauth/authorize/sign-in', corsPreflight)
    router.post(
      '/oauth/authorize/sign-in',
      jsonHandler(async function (req, res) {
        validateFetchMode(req, res, ['same-origin'])
        validateFetchSite(req, res, ['same-origin'])
        validateSameOrigin(req, res, issuerOrigin)

        const input = await validateRequest(req, signInPayloadSchema)

        validateReferer(req, res, {
          origin: issuerOrigin,
          pathname: '/oauth/authorize',
        })
        validateCsrfToken(
          req,
          res,
          input.csrf_token,
          csrfCookie(input.request_uri),
        )

        const { deviceId } = await deviceManager.load(req, res, true)

        return server.signIn(
          deviceId,
          input.request_uri,
          input.client_id,
          input.credentials,
        )
      }),
    )

    const acceptQuerySchema = z.object({
      csrf_token: z.string(),
      request_uri: requestUriSchema,
      client_id: clientIdSchema,
      account_sub: z.string(),
    })

    // Though this is a "no-cors" request, meaning that the browser will allow
    // any cross-origin request, with credentials, to be sent, the handler will
    // 1) validate the request origin,
    // 2) validate the CSRF token,
    // 3) validate the referer,
    // 4) validate the sec-fetch-site header,
    // 4) validate the sec-fetch-mode header,
    // 5) validate the sec-fetch-dest header (see navigationHandler).
    // And will error if any of these checks fail.
    router.get(
      '/oauth/authorize/accept',
      navigationHandler(async function (req, res) {
        validateFetchSite(req, res, ['same-origin'])

        const query = Object.fromEntries(this.url.searchParams)
        const input = await acceptQuerySchema.parseAsync(query, {
          path: ['query'],
        })

        validateReferer(req, res, {
          origin: issuerOrigin,
          pathname: '/oauth/authorize',
          searchParams: [
            ['request_uri', input.request_uri],
            ['client_id', input.client_id],
          ],
        })
        validateCsrfToken(
          req,
          res,
          input.csrf_token,
          csrfCookie(input.request_uri),
          true,
        )

        const { deviceId } = await deviceManager.load(req, res)

        const data = await server.acceptRequest(
          deviceId,
          input.request_uri,
          input.client_id,
          input.account_sub,
        )

        return await sendAuthorizeRedirect(res, data)
      }),
    )

    const rejectQuerySchema = z.object({
      csrf_token: z.string(),
      request_uri: requestUriSchema,
      client_id: clientIdSchema,
    })

    // Though this is a "no-cors" request, meaning that the browser will allow
    // any cross-origin request, with credentials, to be sent, the handler will
    // 1) validate the request origin,
    // 2) validate the CSRF token,
    // 3) validate the referer,
    // 4) validate the sec-fetch-site header,
    // 4) validate the sec-fetch-mode header,
    // 5) validate the sec-fetch-dest header (see navigationHandler).
    // And will error if any of these checks fail.
    router.get(
      '/oauth/authorize/reject',
      navigationHandler(async function (req, res) {
        validateFetchSite(req, res, ['same-origin'])

        const query = Object.fromEntries(this.url.searchParams)
        const input = await rejectQuerySchema.parseAsync(query, {
          path: ['query'],
        })

        validateReferer(req, res, {
          origin: issuerOrigin,
          pathname: '/oauth/authorize',
          searchParams: [
            ['request_uri', input.request_uri],
            ['client_id', input.client_id],
          ],
        })
        validateCsrfToken(
          req,
          res,
          input.csrf_token,
          csrfCookie(input.request_uri),
          true,
        )

        const { deviceId } = await deviceManager.load(req, res)

        const data = await server.rejectRequest(
          deviceId,
          input.request_uri,
          input.client_id,
        )

        return await sendAuthorizeRedirect(res, data)
      }),
    )

    return router
  }
}

async function validateRequest<S extends z.ZodTypeAny>(
  req: IncomingMessage,
  schema: S,
): Promise<z.TypeOf<S>> {
  try {
    return await validateRequestPayload(req, schema)
  } catch (err) {
    if (err instanceof ZodError) {
      const issue = err.issues[0]
      if (issue?.path.length) {
        // "part" will typically be
        const [part, ...path] = issue.path
        throw new InvalidRequestError(
          `Validation of ${part}'s "${path.join('.')}" with error: ${issue.message}`,
          err,
        )
      }
    }

    throw new InvalidRequestError('Input validation error', err)
  }
}
