// @ts-nocheck
import { afterEach, expect, it, vi } from 'vitest'
import { apiGet } from '../lib/api'

afterEach(() => vi.unstubAllGlobals())

it('apiGet sends a bearer-authenticated GET', async () => {
  let options: any
  vi.stubGlobal('wx', {
    getStorageSync: (key: string) => key === 'pr_token' ? 'token-value' : '',
    request: (input: any) => {
      options = input
      input.success({ statusCode: 200, data: { ok: true } })
      return { abort() {} }
    },
  })
  await expect(apiGet('/api/me')).resolves.toEqual({ ok: true })
  expect(options.method).toBe('GET')
  expect(options.url.endsWith('/api/me')).toBe(true)
  expect(options.header.Authorization).toBe('Bearer token-value')
})
