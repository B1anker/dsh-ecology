import { expect, test } from '@rstest/core'
import {
  buildAuthorizeUrl,
  createConcurrencyGate,
  exchangeCode,
  fetchGitHubUser,
  GitHubRequestError,
  revokeAccessToken,
} from '../../src/github.js'

const credentials = { clientId: 'client', clientSecret: 'secret' }

test('buildAuthorizeUrl uses fixed hosts, empty scope, and PKCE', () => {
  const url = new URL(
    buildAuthorizeUrl({
      clientId: 'client',
      redirectUri: 'https://dsh.example.com/auth/github/callback',
      state: 'state',
      codeChallenge: 'challenge',
    }),
  )
  expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize')
  expect(url.searchParams.get('client_id')).toBe('client')
  expect(url.searchParams.get('redirect_uri')).toBe('https://dsh.example.com/auth/github/callback')
  expect(url.searchParams.get('state')).toBe('state')
  expect(url.searchParams.get('code_challenge')).toBe('challenge')
  expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  expect(url.searchParams.get('scope')).toBe('')
})

test('exchangeCode returns the access token from a JSON body', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ access_token: 'tok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  await expect(
    exchangeCode({
      code: 'code',
      codeVerifier: 'verifier',
      redirectUri: 'https://dsh.example.com/auth/github/callback',
      credentials,
      options: { timeoutMs: 1000, fetchImpl },
    }),
  ).resolves.toBe('tok')
})

test('exchangeCode rejects missing tokens and non-2xx responses', async () => {
  await expect(
    exchangeCode({
      code: 'code',
      codeVerifier: 'verifier',
      redirectUri: 'https://dsh.example.com/auth/github/callback',
      credentials,
      options: {
        timeoutMs: 1000,
        fetchImpl: async () => new Response('{}', { status: 200 }),
      },
    }),
  ).rejects.toMatchObject({ code: 'missing_token' })

  await expect(
    exchangeCode({
      code: 'code',
      codeVerifier: 'verifier',
      redirectUri: 'https://dsh.example.com/auth/github/callback',
      credentials,
      options: {
        timeoutMs: 1000,
        fetchImpl: async () => new Response('nope', { status: 500 }),
      },
    }),
  ).rejects.toBeInstanceOf(GitHubRequestError)
})

test('fetchGitHubUser requires a positive integer id', async () => {
  await expect(
    fetchGitHubUser('tok', {
      timeoutMs: 1000,
      fetchImpl: async () =>
        new Response(JSON.stringify({ id: 99, login: 'octocat' }), { status: 200 }),
    }),
  ).resolves.toEqual({ id: 99, login: 'octocat' })

  await expect(
    fetchGitHubUser('tok', {
      timeoutMs: 1000,
      fetchImpl: async () => new Response(JSON.stringify({ login: 'octocat' }), { status: 200 }),
    }),
  ).rejects.toMatchObject({ code: 'missing_user_id' })
})

test('revokeAccessToken treats 204 and 404 as success', async () => {
  await expect(
    revokeAccessToken('tok', credentials, {
      timeoutMs: 1000,
      fetchImpl: async () => new Response(null, { status: 204 }),
    }),
  ).resolves.toBeUndefined()
  await expect(
    revokeAccessToken('tok', credentials, {
      timeoutMs: 1000,
      fetchImpl: async () => new Response('gone', { status: 404 }),
    }),
  ).resolves.toBeUndefined()
  await expect(
    revokeAccessToken('tok', credentials, {
      timeoutMs: 1000,
      fetchImpl: async () => new Response('nope', { status: 500 }),
    }),
  ).rejects.toMatchObject({ code: 'http_status' })
})

test('createConcurrencyGate bounds simultaneous holders', () => {
  const gate = createConcurrencyGate(1)
  expect(gate.tryAcquire()).toBe(true)
  expect(gate.tryAcquire()).toBe(false)
  gate.release()
  expect(gate.tryAcquire()).toBe(true)
  expect(gate.active).toBe(1)
})
