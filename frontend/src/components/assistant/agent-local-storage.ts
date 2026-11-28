import type { AssistantConversation, AssistantStorageMode } from '../../api/mcp-chat-api'
import type { ChatMessage } from './assistant-session'

interface LocalAgentConversationRecord {
  id: string
  title: string
  channel: string
  createdAt: string
  updatedAt: string
  lastMessageAt: string
  messages: ChatMessage[]
}

const STORAGE_PREFIX = 'sales-agent:agent-local-conversations:'
const PREF_STORAGE_MODE_PREFIX = 'sales-agent:agent-storage-mode:'
const PREF_SELECTED_MODEL_PREFIX = 'sales-agent:agent-selected-model:'
const MAX_LOCAL_CONVERSATIONS = 50
const MAX_MESSAGES_PER_CONVERSATION = 120

function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

function normalizeScope(scope?: string) {
  return scope?.trim() || 'default'
}

function readRecords(scope?: string): LocalAgentConversationRecord[] {
  const storage = safeLocalStorage()
  if (!storage) return []
  try {
    const raw = storage.getItem(`${STORAGE_PREFIX}${normalizeScope(scope)}`)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeRecords(scope: string | undefined, records: LocalAgentConversationRecord[]) {
  const storage = safeLocalStorage()
  if (!storage) return
  try {
    const trimmed = records
      .slice()
      .sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime())
      .slice(0, MAX_LOCAL_CONVERSATIONS)
    storage.setItem(`${STORAGE_PREFIX}${normalizeScope(scope)}`, JSON.stringify(trimmed))
  } catch {
    // 浏览器隐私模式或容量满时静默降级，不阻断当前会话显示。
  }
}

export function listLocalAgentConversations(scope?: string): AssistantConversation[] {
  return readRecords(scope).map((record) => ({
    id: record.id,
    title: record.title,
    channel: record.channel,
    mode: 'AGENT',
    status: 'OPEN',
    lastMessageAt: record.lastMessageAt,
    expiresAt: null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    storageMode: 'LOCAL',
  }))
}

export function getLocalAgentMessages(scope: string | undefined, conversationId: string): ChatMessage[] {
  const record = readRecords(scope).find((item) => item.id === conversationId)
  return record ? record.messages : []
}

export function saveLocalAgentTurn(
  scope: string | undefined,
  conversationId: string,
  userMessage: ChatMessage,
  assistantMessage: ChatMessage,
  channel: string,
): AssistantConversation[] {
  const records = readRecords(scope)
  const now = assistantMessage.createdAt || new Date().toISOString()
  const existingIndex = records.findIndex((item) => item.id === conversationId)
  if (existingIndex >= 0) {
    const existing = records[existingIndex]
    const nextMessages = [
      ...existing.messages.filter((item) => item.id !== userMessage.id && item.id !== assistantMessage.id),
      userMessage,
      assistantMessage,
    ].slice(-MAX_MESSAGES_PER_CONVERSATION)
    records[existingIndex] = {
      ...existing,
      updatedAt: now,
      lastMessageAt: now,
      messages: nextMessages,
    }
  } else {
    const cleanTitle = userMessage.content.trim().replace(/\s+/g, ' ')
    const title = cleanTitle.length > 32 ? `${cleanTitle.slice(0, 32)}…` : (cleanTitle || '新建本地 Agent 会话')
    records.unshift({
      id: conversationId,
      title,
      channel,
      createdAt: userMessage.createdAt || now,
      updatedAt: now,
      lastMessageAt: now,
      messages: [userMessage, assistantMessage],
    })
  }
  writeRecords(scope, records)
  return listLocalAgentConversations(scope)
}

export function deleteLocalAgentConversation(scope: string | undefined, conversationId: string): AssistantConversation[] {
  const next = readRecords(scope).filter((item) => item.id !== conversationId)
  writeRecords(scope, next)
  return listLocalAgentConversations(scope)
}

export function readPreferredAgentStorageMode(scope?: string): AssistantStorageMode {
  const storage = safeLocalStorage()
  if (!storage) return 'CLOUD'
  const raw = storage.getItem(`${PREF_STORAGE_MODE_PREFIX}${normalizeScope(scope)}`)
  return raw === 'LOCAL' ? 'LOCAL' : 'CLOUD'
}

export function savePreferredAgentStorageMode(scope: string | undefined, mode: AssistantStorageMode) {
  const storage = safeLocalStorage()
  if (!storage) return
  try {
    storage.setItem(`${PREF_STORAGE_MODE_PREFIX}${normalizeScope(scope)}`, mode)
  } catch {
    // ignore storage errors
  }
}

export function readPreferredAgentModel(scope?: string): string {
  const storage = safeLocalStorage()
  if (!storage) return ''
  return storage.getItem(`${PREF_SELECTED_MODEL_PREFIX}${normalizeScope(scope)}`)?.trim() ?? ''
}

export function savePreferredAgentModel(scope: string | undefined, model: string) {
  const storage = safeLocalStorage()
  if (!storage) return
  try {
    if (model.trim()) {
      storage.setItem(`${PREF_SELECTED_MODEL_PREFIX}${normalizeScope(scope)}`, model.trim())
    } else {
      storage.removeItem(`${PREF_SELECTED_MODEL_PREFIX}${normalizeScope(scope)}`)
    }
  } catch {
    // ignore storage errors
  }
}
