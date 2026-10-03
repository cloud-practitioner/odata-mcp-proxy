import {
  createOAuthCallbackHandler,
  createXsuaaOAuthProvider,
  createXsuaaTokenVerifier,
  matchesRedirectPattern,
  OAuthStateCodec,
  type Logger,
  type XsuaaCredentials,
} from '@arc-mcp/xsuaa-auth';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidClientMetadataError, InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Express } from 'express';
import { z } from 'zod';

const flowSchema = z.object({ challenge: z.string(), state: z.string().optional() });
const codeSchema = z.object({ code: z.string().min(1), challenge: z.string() });

class FlowStateCodec extends OAuthStateCodec {
  decodeFlow(token: string) {
    const decoded = super.decode(token);
    if (decoded.kind !== 'ok') return undefined;
    try {
      const flow = flowSchema.parse(JSON.parse(decoded.clientState ?? ''));
      return { ...decoded, flow };
    } catch {
      return undefined;
    }
  }

  override decode(token: string) {
    const decoded = this.decodeFlow(token);
    return decoded
      ? { ...decoded, clientState: decoded.flow.state }
      : { kind: 'error' as const, reason: 'invalid_payload' as const };
  }
}

export function setupXsuaaAuth(app: Express, credentials: XsuaaCredentials, appUrl: string, logger: Logger) {
  const security = z.object({
    'oauth2-configuration': z.object({ 'redirect-uris': z.array(z.string().min(1)).min(1) }),
  }).parse(JSON.parse(readFileSync(new URL('../../xs-security.json', import.meta.url), 'utf8')));
  const patterns = security['oauth2-configuration']['redirect-uris'];
  const { provider: upstream, clientStore } = createXsuaaOAuthProvider(credentials, appUrl, {
    redirectUriPatterns: patterns,
    defaultRedirectUris: patterns.filter((uri) => !uri.includes('*')),
    logger,
  });
  const stateCodec = new FlowStateCodec(credentials.clientsecret);
  const codeCodec = new OAuthStateCodec(credentials.clientsecret, { kdfLabel: 'odata-mcp-code/v1' });
  const refreshCodec = new OAuthStateCodec(credentials.clientsecret, {
    kdfLabel: 'odata-mcp-refresh/v1',
    ttlSeconds: 0,
  });
  const exchangeGrant = async (grant: Record<string, string>): Promise<OAuthTokens> => {
    const response = await fetch(`${credentials.url}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...grant,
        client_id: credentials.clientid,
        client_secret: credentials.clientsecret,
      }),
    });
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) {
        const rejection = await response.json().catch(() => undefined);
        if (rejection?.error === 'invalid_grant') {
          throw new InvalidGrantError('The upstream authorization grant is invalid or expired');
        }
      }
      throw new Error(`XSUAA token exchange failed: ${response.status}`);
    }
    const tokens = await response.json() as OAuthTokens;
    return {
      access_token: tokens.access_token,
      token_type: tokens.token_type ?? 'bearer',
      expires_in: tokens.expires_in,
      refresh_token: tokens.refresh_token,
      scope: tokens.scope,
    };
  };
  const bindRefreshToken = (tokens: OAuthTokens, clientId: string): OAuthTokens => ({
    ...tokens,
    refresh_token: tokens.refresh_token
      ? refreshCodec.encode({ clientId, clientRedirectUri: appUrl, clientState: tokens.refresh_token })
      : undefined,
  });
  const unwrapRefreshToken = (token: string, clientId: string) => {
    const decoded = refreshCodec.decode(token);
    if (decoded.kind !== 'ok' || decoded.clientId !== clientId || !decoded.clientState) {
      throw new InvalidGrantError('Refresh token is not bound to this client');
    }
    return decoded.clientState;
  };
  const authorizationGrant = (clientId: string, code: string, redirectUri?: string) => {
    const decoded = codeCodec.decode(code);
    if (decoded.kind !== 'ok' || decoded.clientId !== clientId ||
        (redirectUri !== undefined && redirectUri !== decoded.clientRedirectUri)) {
      throw new InvalidGrantError('Authorization code is not bound to this client or redirect URI');
    }
    try {
      return codeSchema.parse(JSON.parse(decoded.clientState ?? ''));
    } catch {
      throw new InvalidGrantError('Invalid authorization code');
    }
  };
  const provider: OAuthServerProvider = {
    clientsStore: {
      getClient: async (id) => {
        const client = await clientStore.getClient(id);
        return client?.redirect_uris.every((uri) => matchesRedirectPattern(uri, patterns)) ? client : undefined;
      },
      registerClient: async (client) => {
        if (!client.redirect_uris.every((uri) => matchesRedirectPattern(uri, patterns))) {
          throw new InvalidClientMetadataError('Redirect URI is not allowed');
        }
        const method = client.token_endpoint_auth_method ?? 'client_secret_post';
        if (method !== 'none' && method !== 'client_secret_post') {
          throw new InvalidClientMetadataError('token_endpoint_auth_method must be none or client_secret_post');
        }
        return clientStore.registerClient({ ...client, token_endpoint_auth_method: method });
      },
    },
    skipLocalPkceValidation: true,
    authorize: (client, params, res) => upstream.authorize(client, {
      ...params,
      state: JSON.stringify({ challenge: params.codeChallenge, state: params.state }),
    }, res),
    challengeForAuthorizationCode: async (client, code) => authorizationGrant(client.client_id, code).challenge,
    exchangeAuthorizationCode: async (client, code, verifier, redirectUri) => {
      const grant = authorizationGrant(client.client_id, code, redirectUri);
      if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
          createHash('sha256').update(verifier).digest('base64url') !== grant.challenge) {
        throw new InvalidGrantError('code_verifier does not match the challenge');
      }
      return bindRefreshToken(
        await exchangeGrant({
          grant_type: 'authorization_code',
          code: grant.code,
          code_verifier: verifier,
          redirect_uri: `${appUrl}/oauth/callback`,
        }),
        client.client_id,
      );
    },
    exchangeRefreshToken: async (client, token) => bindRefreshToken(
      await exchangeGrant({
        grant_type: 'refresh_token',
        refresh_token: unwrapRefreshToken(token, client.client_id),
      }),
      client.client_id,
    ),
    verifyAccessToken: (token) => upstream.verifyAccessToken(token),
    revokeToken: async (client, request) => {
      let token: string;
      try {
        token = unwrapRefreshToken(request.token, client.client_id);
      } catch {
        if (request.token_type_hint === 'refresh_token') return;
        try {
          await upstream.verifyAccessToken(request.token);
        } catch {
          return;
        }
        token = request.token;
      }
      await upstream.revokeToken(client, { ...request, token });
    },
  };
  app.use('/authorize', (req, _res, next) => {
    const params = req.method === 'POST' ? req.body : req.query;
    if (typeof params?.client_id === 'string' && typeof params?.redirect_uri === 'string') {
      clientStore.ensureRedirectUri(params.client_id, params.redirect_uri);
    }
    next();
  });
  const callback = createOAuthCallbackHandler(stateCodec, clientStore, { logger });
  app.get('/oauth/callback', async (req, res, next) => {
    const decoded = stateCodec.decodeFlow(typeof req.query.state === 'string' ? req.query.state : '');
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (decoded && (!decoded.clientId || !matchesRedirectPattern(decoded.clientRedirectUri, patterns) ||
        await clientStore.checkRedirectUri(decoded.clientId, decoded.clientRedirectUri) !== 'ok')) {
      res.status(400).send('Invalid OAuth redirect target');
      return;
    }
    if (!decoded?.clientId || !code || req.query.error) {
      await callback(req, res, next);
      return;
    }
    const target = new URL(decoded.clientRedirectUri);
    target.searchParams.set('code', codeCodec.encode({
      clientId: decoded.clientId,
      clientRedirectUri: decoded.clientRedirectUri,
      clientState: JSON.stringify({ code, challenge: decoded.flow.challenge }),
    }));
    if (decoded.flow.state !== undefined) target.searchParams.set('state', decoded.flow.state);
    res.redirect(302, target.toString());
  });
  app.use(mcpAuthRouter({
    provider,
    issuerUrl: new URL(appUrl),
    baseUrl: new URL(appUrl),
    resourceServerUrl: new URL(`${appUrl}/mcp`),
    scopesSupported: [],
    resourceName: 'OData MCP Proxy',
    authorizationOptions: { rateLimit: false },
    tokenOptions: { rateLimit: false },
    clientRegistrationOptions: { rateLimit: false },
    revocationOptions: { rateLimit: false },
  }));
  return requireBearerAuth({
    verifier: { verifyAccessToken: createXsuaaTokenVerifier(credentials, { acceptedScopes: [], logger }) },
    resourceMetadataUrl: `${appUrl}/.well-known/oauth-protected-resource/mcp`,
  });
}
