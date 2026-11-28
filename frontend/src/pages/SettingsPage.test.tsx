import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsPage } from './SettingsPage'
import { fetchRequestJson, fetchRequestMethod, fetchRequestUrl } from '../test/fetch-request'
vi.mock('../auth/use-auth', () => ({ useAuth: () => ({ role: 'OWNER' }), useIsGuest: () => false }))
vi.mock('../api/mail-api', () => ({ getMailAccount: async () => ({ host: '', port: 993, username: '', ssl: true, folder: 'INBOX', enabled: false, passwordConfigured: false, version: -1, lastSyncAt: null, lastError: null, syncing: false }), saveMailAccount: vi.fn(), testMailAccount: vi.fn() }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SettingsPage', () => {
  it('手动保存加密模型配置后可以测试连接', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = fetchRequestUrl(input)
      const method = fetchRequestMethod(input, init)
      if (url.endsWith('/api/v1/ai/model') && method === 'PUT') {
        return new Response(JSON.stringify({ provider: 'QWEN', model: 'qwen3.7-plus', embeddingModel: 'qwen3.7-text-embedding-flash', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKeyConfigured: true, ready: true, status: 'READY' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.endsWith('/api/v1/ai/model/test') && method === 'POST') {
        return new Response(JSON.stringify({ provider: 'QWEN', model: 'qwen3.7-plus', status: 'CONNECTED', responsePreview: '连接成功', latencyMs: 328 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.endsWith('/api/v1/ai/model')) {
        return new Response(JSON.stringify({ provider: 'QWEN', model: 'qwen-plus', embeddingModel: 'qwen3.7-text-embedding-flash', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKeyConfigured: false, ready: false, status: 'MISSING_API_KEY' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.endsWith('/api/v1/email/settings')) {
        return new Response(JSON.stringify({ host: null, port: null, username: null, fromAddress: null, smtpAuth: true, starttlsEnabled: true, starttlsRequired: false, passwordConfigured: false, ready: false, status: 'MISSING_CONFIGURATION' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ service: 'sales-agent', status: 'UP', timestamp: '2026-08-25T08:00:00Z' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const user = userEvent.setup()

    render(
      <QueryClientProvider client={queryClient}>
        <SettingsPage />
      </QueryClientProvider>,
    )

    expect(await screen.findAllByText('待配置')).not.toHaveLength(0)
    const modelSection = screen.getByRole('heading', { name: 'AI 模型' }).closest('section')
    expect(modelSection).not.toBeNull()
    const modelForm = within(modelSection!)
    expect(modelForm.getByDisplayValue('qwen-plus')).toBeInTheDocument()

    await user.clear(modelForm.getByLabelText('模型名称'))
    await user.type(modelForm.getByLabelText('模型名称'), 'qwen3.7-plus')
    await user.type(modelForm.getByLabelText('API Key'), 'sk-manual-test')
    await user.click(modelForm.getByRole('button', { name: '保存配置' }))

    expect(await modelForm.findByText('配置已加密保存。')).toBeInTheDocument()
    expect(modelForm.getByLabelText('API Key')).toHaveValue('')
    const saveCall = fetchMock.mock.calls.find(([input, init]) => (
      fetchRequestUrl(input).endsWith('/api/v1/ai/model')
      && fetchRequestMethod(input, init) === 'PUT'
    ))
    expect(saveCall).toBeDefined()
    expect(await fetchRequestJson(saveCall![0], saveCall![1])).toEqual({
      provider: 'QWEN',
      model: 'qwen3.7-plus',
      embeddingModel: 'qwen3.7-text-embedding-flash',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'sk-manual-test',
    })

    await user.click(modelForm.getByRole('button', { name: '测试连接' }))

    expect(await modelForm.findByText(/连接成功 · 328 ms/)).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([input, init]) => (
      fetchRequestUrl(input).endsWith('/api/v1/ai/model/test')
      && fetchRequestMethod(input, init) === 'POST'
    ))).toBe(true)
  })

  it('支持为自主 Agent 单独配置火山引擎 Agent Plan、测试连接并查看按模型用量', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = fetchRequestUrl(input)
      const method = fetchRequestMethod(input, init)
      if (url.endsWith('/api/v1/ai/model') && method === 'PUT') {
        return new Response(JSON.stringify({
          provider: 'QWEN',
          model: 'qwen4-max',
          embeddingModel: 'qwen3.7-text-embedding-flash',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          apiKeyConfigured: true,
          ready: true,
          status: 'READY',
          agent: {
            enabled: true,
            provider: 'VOLCENGINE_ARK',
            model: 'doubao-seed-2.1-pro',
            baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
            apiKeyConfigured: true,
            ready: true,
            status: 'READY',
          },
          usage: {
            inputTokens: 1500,
            outputTokens: 500,
            cachedInputTokens: 0,
            totalTokens: 2000,
            successfulCalls: 3,
            lastCalledAt: '2026-11-28T06:00:00Z',
            remainingTokens: null,
            remainingStatus: 'CHAT_API_DOES_NOT_RETURN_ACCOUNT_REMAINING',
            memberAllocatedTokens: 400000,
            memberUsedTokens: 2000,
            memberRemainingTokens: 398000,
            models: [
              { provider: 'QWEN', model: 'qwen4-max', inputTokens: 1000, outputTokens: 300, cachedInputTokens: 0, totalTokens: 1300, successfulCalls: 2, lastCalledAt: '2026-11-28T06:00:00Z' },
              { provider: 'VOLCENGINE_ARK', model: 'doubao-seed-2.1-pro', inputTokens: 500, outputTokens: 200, cachedInputTokens: 0, totalTokens: 700, successfulCalls: 1, lastCalledAt: '2026-11-28T06:00:00Z' },
            ],
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.endsWith('/api/v1/ai/model/agent/test') && method === 'POST') {
        return new Response(JSON.stringify({ provider: 'VOLCENGINE_ARK', model: 'doubao-seed-2.1-pro', status: 'CONNECTED', responsePreview: 'OK', latencyMs: 412 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.endsWith('/api/v1/ai/model')) {
        return new Response(JSON.stringify({
          provider: 'QWEN',
          model: 'qwen4-max',
          embeddingModel: 'qwen3.7-text-embedding-flash',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          apiKeyConfigured: true,
          ready: true,
          status: 'READY',
          agent: {
            enabled: false,
            provider: 'VOLCENGINE_ARK',
            model: '',
            baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
            apiKeyConfigured: false,
            ready: false,
            status: 'INHERIT_DEFAULT',
          },
          usage: {
            inputTokens: 1000,
            outputTokens: 300,
            cachedInputTokens: 0,
            totalTokens: 1300,
            successfulCalls: 2,
            lastCalledAt: '2026-11-28T06:00:00Z',
            remainingTokens: null,
            remainingStatus: 'CHAT_API_DOES_NOT_RETURN_ACCOUNT_REMAINING',
            memberAllocatedTokens: 400000,
            memberUsedTokens: 1300,
            memberRemainingTokens: 398700,
            models: [
              { provider: 'QWEN', model: 'qwen4-max', inputTokens: 1000, outputTokens: 300, cachedInputTokens: 0, totalTokens: 1300, successfulCalls: 2, lastCalledAt: '2026-11-28T06:00:00Z' },
            ],
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.endsWith('/api/v1/email/settings')) {
        return new Response(JSON.stringify({ host: null, port: null, username: null, fromAddress: null, smtpAuth: true, starttlsEnabled: true, starttlsRequired: false, passwordConfigured: false, ready: false, status: 'MISSING_CONFIGURATION' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ service: 'sales-agent', status: 'UP', timestamp: '2026-08-25T08:00:00Z' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const user = userEvent.setup()

    render(
      <QueryClientProvider client={queryClient}>
        <SettingsPage />
      </QueryClientProvider>,
    )

    const modelSection = (await screen.findByRole('heading', { name: 'AI 模型' })).closest('section')!
    const modelForm = within(modelSection)
    expect(await modelForm.findByText('按模型用量统计')).toBeInTheDocument()
    expect(modelForm.getByText('qwen4-max')).toBeInTheDocument()

    await user.click(modelForm.getByLabelText('启用自主 Agent 专用模型'))
    await user.type(modelForm.getByLabelText('Agent 模型名称'), 'doubao-seed-2.1-pro')
    await user.type(modelForm.getByLabelText('Agent API Key'), 'ark-plan-key')
    await user.click(modelForm.getByRole('button', { name: '保存配置' }))

    expect(await modelForm.findByText('配置已加密保存。')).toBeInTheDocument()
    expect(modelForm.getByText('doubao-seed-2.1-pro')).toBeInTheDocument()

    const saveCall = fetchMock.mock.calls.find(([input, init]) => (
      fetchRequestUrl(input).endsWith('/api/v1/ai/model')
      && fetchRequestMethod(input, init) === 'PUT'
    ))
    expect(await fetchRequestJson(saveCall![0], saveCall![1])).toEqual({
      provider: 'QWEN',
      model: 'qwen4-max',
      embeddingModel: 'qwen3.7-text-embedding-flash',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      agentEnabled: true,
      agentProvider: 'VOLCENGINE_ARK',
      agentModel: 'doubao-seed-2.1-pro',
      agentBaseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
      agentApiKey: 'ark-plan-key',
    })

    await user.click(modelForm.getByRole('button', { name: '测试 Agent 连接' }))
    expect(await modelForm.findByText(/Agent 连接成功 · doubao-seed-2\.1-pro · 412 ms/)).toBeInTheDocument()
  }, 15000)
})
