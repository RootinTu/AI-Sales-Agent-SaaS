import { getJson, requestJson } from './axios-client'

export type AiModelProvider = 'QWEN' | 'VOLCENGINE_ARK' | 'OPENAI_COMPATIBLE'
export type AiModelStatusCode = 'READY' | 'MISSING_API_KEY' | 'ENCRYPTION_KEY_UNAVAILABLE'
export type AiAgentModelStatusCode = 'READY' | 'INHERIT_DEFAULT' | 'ENCRYPTION_KEY_UNAVAILABLE'

export interface AiAgentModelStatus {
  enabled: boolean
  provider: AiModelProvider
  model: string
  baseUrl: string
  apiKeyConfigured: boolean
  ready: boolean
  status: AiAgentModelStatusCode
  availableModels?: string[]
}

export interface AiModelUsageBreakdownItem {
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  totalTokens: number
  successfulCalls: number
  lastCalledAt: string | null
  estimatedAfp?: number | null
}

export interface AiAgentUsageSummary {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  totalTokens: number
  successfulCalls: number
  lastCalledAt: string | null
  models: AiModelUsageBreakdownItem[]
  totalEstimatedAfp?: number
  last5HoursAfp?: number
  last7DaysAfp?: number
  last30DaysAfp?: number
  fiveHourAfpLimit?: number
  weeklyAfpLimit?: number
  monthlyAfpLimit?: number
  calibratedAt?: string | null
}

export interface AiModelStatus {
  provider: AiModelProvider
  model: string
  embeddingModel?: string
  baseUrl: string
  apiKeyConfigured: boolean
  ready: boolean
  status: AiModelStatusCode
  usage?: AiModelUsage
  agent?: AiAgentModelStatus
}

export interface AiModelUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  totalTokens: number
  successfulCalls: number
  lastCalledAt: string | null
  remainingTokens: number | null
  remainingStatus: string
  memberAllocatedTokens: number | null
  memberUsedTokens: number
  memberRemainingTokens: number | null
  models?: AiModelUsageBreakdownItem[]
  memberEmbeddingAllocatedTokens?: number | null
  memberEmbeddingUsedTokens?: number
  memberEmbeddingRemainingTokens?: number | null
  embeddingTotalTokens?: number
  embeddingSuccessfulCalls?: number
  agent?: AiAgentUsageSummary
}

export interface AiModelTestResult {
  provider: AiModelProvider | string
  model: string
  status: 'CONNECTED'
  responsePreview: string
  latencyMs: number
}

export interface AiModelUpdateInput {
  provider: AiModelProvider
  model: string
  embeddingModel?: string
  baseUrl: string
  apiKey?: string
  agentEnabled?: boolean
  agentProvider?: AiModelProvider
  agentModel?: string
  agentBaseUrl?: string
  agentApiKey?: string
  agentAvailableModels?: string[]
}

export function getAiModelStatus() {
  return getJson<AiModelStatus>('/api/v1/ai/model')
}

export function saveAiModelConfiguration(input: AiModelUpdateInput) {
  return requestJson<AiModelStatus>('/api/v1/ai/model', {
    method: 'PUT',
    data: input,
  })
}

export function testAiModelConnection() {
  return requestJson<AiModelTestResult>('/api/v1/ai/model/test', { method: 'POST' })
}

export interface AiAgentAfpCalibrationInput {
  fiveHourUsedAfp?: number | null
  weeklyUsedAfp?: number | null
  monthlyUsedAfp?: number | null
}

export function testAgentModelConnection() {
  return requestJson<AiModelTestResult>('/api/v1/ai/model/agent/test', { method: 'POST' })
}

export function calibrateAgentAfp(input: AiAgentAfpCalibrationInput) {
  return requestJson<AiModelStatus>('/api/v1/ai/model/agent/afp-calibration', {
    method: 'PUT',
    data: input,
  })
}
