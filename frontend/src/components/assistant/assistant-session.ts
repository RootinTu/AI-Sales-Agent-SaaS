import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  deleteMcpConversation,
  getMcpConversations,
  getMcpMessages,
  isDesktopClient,
  streamMcpChatMessage,
  type AssistantMessage,
  type AssistantMode,
  type AssistantStorageMode,
  type AssistantToolTrace,
  type SendMcpChatMessageInput,
} from '../../api/mcp-chat-api'
import { getAiModelStatus } from '../../api/ai-settings-api'
import { uploadFile, type UploadedFile } from '../../api/files-api'
import { useIsGuest } from '../../auth/use-auth'
import {
  deleteLocalAgentConversation,
  getLocalAgentMessages,
  listLocalAgentConversations,
  saveLocalAgentTurn,
} from './agent-local-storage'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoningSummary?: string | null
  traces?: AssistantToolTrace[]
  attachments?: UploadedFile[]
  data?: Record<string, unknown>
  createdAt: string
  streaming?: boolean
  progress?: string
  progressSteps?: string[]
  thinkingLabel?: string
  error?: string
}

export interface ComposerAttachment {
  id: string
  file: File
  filename: string
  sizeBytes: number
  uploaded?: UploadedFile
}

export interface AssistantToolGuide {
  tool: string
  label: string
  say: string
  result: string
}

interface UseAssistantSessionOptions {
  mode: AssistantMode
  welcomeMessage: ChatMessage
  guestDemoMessages: ChatMessage[]
  pendingProgressText: string
  selectedModel?: string
  usesIndependentChannel?: boolean
  storageMode?: AssistantStorageMode
  storageScope?: string
}

/**
 * 管理双模式助手的会话列表、消息历史、附件和 SSE 流式调用状态。
 * 保持纯状态与回调输出（不向外返回 Ref），兼顾业务「轻辅助」与独立「自主 Agent」复用。
 */
export function useAssistantChatSession({
  mode,
  welcomeMessage,
  guestDemoMessages,
  pendingProgressText,
  selectedModel,
  usesIndependentChannel = false,
  storageMode = 'CLOUD',
  storageScope,
}: UseAssistantSessionOptions) {
  const isGuest = useIsGuest()
  const queryClient = useQueryClient()
  const isLocalStorage = mode === 'AGENT' && storageMode === 'LOCAL'
  const [input, setInput] = useState('')
  const [focusSignal, setFocusSignal] = useState(0)
  const [activeConversationId, setActiveConversationId] = useState<string | undefined>()
  const [messages, setMessages] = useState<ChatMessage[]>(() => (isGuest ? guestDemoMessages : [welcomeMessage]))
  const [localVersion, setLocalVersion] = useState(0)
  const [useLocalMessages, setUseLocalMessages] = useState(true)
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState('')
  const [uploadingAttachments, setUploadingAttachments] = useState(false)
  const pendingId = useRef('')
  const pendingUserMessage = useRef<ChatMessage | null>(null)
  const pendingConversationId = useRef<string | undefined>(undefined)
  const busy = useRef(false)
  const streamController = useRef<AbortController | null>(null)

  const localConversations = useMemo(
    () => {
      void localVersion
      return isLocalStorage ? listLocalAgentConversations(storageScope) : []
    },
    [isLocalStorage, storageScope, localVersion],
  )

  const conversationsQuery = useQuery({
    queryKey: ['mcp-conversations', mode],
    queryFn: () => getMcpConversations(mode),
    enabled: !isGuest && !isLocalStorage,
  })

  const messagesQuery = useQuery({
    queryKey: ['mcp-messages', activeConversationId],
    queryFn: () => getMcpMessages(activeConversationId!),
    enabled: !isGuest && !isLocalStorage && Boolean(activeConversationId),
  })

  const modelQuery = useQuery({
    queryKey: ['ai-model-status'],
    queryFn: getAiModelStatus,
    enabled: !isGuest,
  })

  const conversations = isLocalStorage
    ? localConversations
    : (conversationsQuery.data?.content ?? [])
  const quotaUnavailable = !isGuest && !usesIndependentChannel && !modelQuery.isLoading && (
    modelQuery.data?.usage?.memberAllocatedTokens == null
    || (modelQuery.data.usage.memberRemainingTokens ?? 0) <= 0
  )
  const disabled = isGuest || quotaUnavailable
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId)

  const displayedMessages = useMemo(() => {
    if (isLocalStorage || useLocalMessages) return messages
    return (messagesQuery.data?.content ?? [])
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map(toChatMessage)
  }, [isLocalStorage, useLocalMessages, messages, messagesQuery.data])
  const chatMessages = displayedMessages.filter((message) => message.id !== 'welcome')

  const chatMutation = useMutation({
    retry: false,
    mutationFn: (request: SendMcpChatMessageInput) => streamMcpChatMessage(request, (event) => {
      if (event.type === 'meta') {
        pendingConversationId.current = event.data.conversationId
        return
      }
      setMessages((current) => current.map((message) => {
        if (message.id !== pendingId.current) return message
        if (event.type === 'delta') return { ...message, content: message.content + event.data.text }
        if (event.type === 'progress') {
          const text = event.data.text.trim()
          const currentSteps = message.progressSteps ?? []
          const nextSteps = text && currentSteps[currentSteps.length - 1] !== text
            ? [...currentSteps, text].slice(-6)
            : currentSteps
          return { ...message, progress: text, progressSteps: nextSteps }
        }
        if (event.type === 'summary') return { ...message, reasoningSummary: event.data.text }
        if (event.type === 'tool') {
          return {
            ...message,
            traces: [
              ...(message.traces ?? []).filter((trace) => !(trace.name === event.data.name && trace.status === 'RUNNING')),
              event.data,
            ],
          }
        }
        if (event.type === 'error') return { ...message, error: event.data.message }
        return message
      }))
    }, streamController.current?.signal),
    onSuccess: (response) => {
      setActiveConversationId(response.conversationId)
      setAttachments([])
      const finalAssistantMessage: ChatMessage = {
        id: response.messageId,
        role: 'assistant',
        content: response.content,
        reasoningSummary: response.reasoningSummary,
        traces: response.toolTraces,
        data: response.data,
        createdAt: response.createdAt,
      }
      setMessages((current) => current.map((message) => message.id !== pendingId.current ? message : {
        ...finalAssistantMessage,
        error: message.error,
      }))
      if (isLocalStorage && pendingUserMessage.current) {
        saveLocalAgentTurn(
          storageScope,
          response.conversationId,
          pendingUserMessage.current,
          finalAssistantMessage,
          isDesktopClient() ? 'DESKTOP' : 'WEB',
        )
        setLocalVersion((count) => count + 1)
      } else {
        void queryClient.invalidateQueries({ queryKey: ['mcp-conversations', mode] })
        void queryClient.invalidateQueries({ queryKey: ['mcp-messages', response.conversationId] })
      }
      void queryClient.invalidateQueries({ queryKey: ['agent-runs'] })
      void queryClient.invalidateQueries({ queryKey: ['approvals'] })
      void queryClient.invalidateQueries({ queryKey: ['follow-ups'] })
      void queryClient.invalidateQueries({ queryKey: ['customers'] })
      void queryClient.invalidateQueries({ queryKey: ['opportunities'] })
      void queryClient.invalidateQueries({ queryKey: ['ai-model-status'] })
    },
    onError: (error) => {
      setMessages((current) => current.map((message) => message.id !== pendingId.current ? message : {
        ...message,
        streaming: false,
        error: error instanceof Error ? error.message : '连接中断，请查看历史记录确认执行结果。',
      }))
      if (!isLocalStorage) {
        void queryClient.invalidateQueries({ queryKey: ['mcp-conversations', mode] })
      }
    },
    onSettled: () => {
      busy.current = false
      pendingUserMessage.current = null
      streamController.current = null
    },
  })

  useEffect(() => () => streamController.current?.abort(), [])

  function handleAttachmentChange(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (!selectedFiles.length || chatMutation.isPending || uploadingAttachments) return
    setAttachmentError('')
    if (attachments.length + selectedFiles.length > 5) {
      setAttachmentError('一次消息最多携带 5 个附件')
      return
    }
    const oversized = selectedFiles.find((file) => file.size > 10 * 1024 * 1024)
    if (oversized) {
      setAttachmentError(`${oversized.name} 超过 10MB，请压缩后再上传`)
      return
    }
    setAttachments((current) => [...current, ...selectedFiles.map((file) => ({
      id: crypto.randomUUID(),
      file,
      filename: file.name,
      sizeBytes: file.size,
    }))])
  }

  function removeAttachment(fileId: string) {
    if (chatMutation.isPending || uploadingAttachments) return
    setAttachments((current) => current.filter((file) => file.id !== fileId))
  }

  async function submit(message = input) {
    const content = message.trim()
    if (!content || busy.current || disabled || uploadingAttachments) return
    busy.current = true
    setAttachmentError('')
    setUploadingAttachments(true)
    let submittedAttachments: UploadedFile[]
    try {
      submittedAttachments = await Promise.all(attachments.map((attachment) => (
        attachment.uploaded ?? uploadFile(attachment.file)
      )))
      setAttachments((current) => current.map((attachment, index) => ({
        ...attachment,
        uploaded: submittedAttachments[index] ?? attachment.uploaded,
      })))
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : '附件上传失败，请重试')
      busy.current = false
      setUploadingAttachments(false)
      return
    }
    setUploadingAttachments(false)
    streamController.current = new AbortController()
    pendingId.current = crypto.randomUUID()
    setUseLocalMessages(true)
    const initialThinking = buildInitialThinkingChain(mode, content, pendingProgressText)
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      attachments: submittedAttachments,
      createdAt: new Date().toISOString(),
    }
    pendingUserMessage.current = userMessage
    const localHistory = isLocalStorage
      ? displayedMessages
        .filter((item) => item.id !== 'welcome' && item.content.trim())
        .slice(-12)
        .map((item) => ({
          role: item.role,
          content: item.content.slice(0, 3500),
        }))
      : undefined
    setMessages([...displayedMessages, userMessage, {
      id: pendingId.current,
      role: 'assistant',
      content: '',
      streaming: true,
      thinkingLabel: initialThinking.title,
      progress: initialThinking.steps[initialThinking.steps.length - 1],
      progressSteps: initialThinking.steps,
      data: { assistantMode: mode, storageMode: isLocalStorage ? 'LOCAL' : 'CLOUD' },
      createdAt: new Date().toISOString(),
    }])
    setInput('')
    setAttachmentError('')
    chatMutation.mutate({
      conversationId: activeConversationId ?? pendingConversationId.current,
      message: content,
      attachmentIds: submittedAttachments.map((file) => file.id),
      mode,
      model: selectedModel || undefined,
      storageMode: isLocalStorage ? 'LOCAL' : 'CLOUD',
      history: localHistory,
    })
  }

  function applyToolTemplate(template: string) {
    if (chatMutation.isPending) return
    setInput(template)
    setFocusSignal((count) => count + 1)
  }

  function startNewConversation() {
    setActiveConversationId(undefined)
    setUseLocalMessages(true)
    pendingConversationId.current = undefined
    setMessages([welcomeMessage])
    setInput('')
    setAttachments([])
    setAttachmentError('')
  }

  function selectConversation(conversationId: string) {
    setActiveConversationId(conversationId)
    if (isLocalStorage) {
      setUseLocalMessages(true)
      const stored = getLocalAgentMessages(storageScope, conversationId)
      setMessages(stored.length > 0 ? stored : [welcomeMessage])
    } else {
      setUseLocalMessages(false)
    }
  }

  async function deleteConversation(conversationId: string) {
    if (chatMutation.isPending) return
    if (isLocalStorage) {
      deleteLocalAgentConversation(storageScope, conversationId)
      setLocalVersion((count) => count + 1)
    } else {
      await deleteMcpConversation(conversationId)
      await queryClient.invalidateQueries({ queryKey: ['mcp-conversations', mode] })
    }
    if (activeConversationId === conversationId) {
      startNewConversation()
    }
  }

  const readableStatus = isGuest
    ? '演示会话'
    : chatMutation.isPending
      ? '正在执行'
      : activeConversation
        ? (isLocalStorage ? '仅存本地' : '历史已保存')
        : (isLocalStorage ? '新建本地会话' : '新会话')

  return {
    isGuest,
    input,
    setInput,
    focusSignal,
    activeConversationId,
    conversationsQuery,
    messagesQuery,
    modelQuery,
    conversations,
    quotaUnavailable,
    disabled,
    chatMessages,
    isPending: chatMutation.isPending,
    attachments,
    attachmentError,
    uploadingAttachments,
    readableStatus,
    handleAttachmentChange,
    removeAttachment,
    submit,
    applyToolTemplate,
    startNewConversation,
    selectConversation,
    deleteConversation,
  }
}

export type AssistantChatSession = ReturnType<typeof useAssistantChatSession>

function toChatMessage(message: AssistantMessage): ChatMessage {
  return {
    id: message.id,
    role: message.role === 'user' ? 'user' : 'assistant',
    content: message.content,
    reasoningSummary: message.reasoningSummary,
    traces: message.toolTraces,
    attachments: dataAttachments(message.data),
    data: message.data,
    createdAt: message.createdAt,
  }
}

export function buildInitialThinkingChain(
  mode: AssistantMode,
  prompt: string,
  fallbackStep: string,
): { title: string; steps: string[] } {
  const text = prompt.trim()
  if (mode === 'AGENT') {
    if (/邮件|起草|发给|发送/.test(text)) {
      return {
        title: '自主 Agent 思考中',
        steps: ['加载多轮会话记忆与客户背景', '规划客户/报价与知识库检索，准备起草待审批邮件'],
      }
    }
    if (/商机|报价|客户|分析|跟进/.test(text)) {
      return {
        title: '自主 Agent 思考中',
        steps: ['读取上下文记忆并拆解跨模块目标', '规划多步 CRM 数据排查与自主执行路径'],
      }
    }
    return {
      title: '自主 Agent 思考中',
      steps: ['加载自主 Agent 记忆上下文', fallbackStep],
    }
  }
  if (/审批|批准/.test(text)) {
    return {
      title: '工作流处理中',
      steps: [fallbackStep, '解析审批指令并读取待审批记录'],
    }
  }
  if (/跟进|任务/.test(text)) {
    return {
      title: '工作流处理中',
      steps: [fallbackStep, '查询当前开放中的跟进任务'],
    }
  }
  if (/新增客户|导入聊天|发送方案|发送报价/.test(text)) {
    return {
      title: '工作流处理中',
      steps: [fallbackStep, '提取业务字段并校验客户档案'],
    }
  }
  if (/知识库|政策|折扣|打折|制度|流程|怎么|如何|什么|为什么/.test(text)) {
    return {
      title: '知识检索与问答中',
      steps: [fallbackStep, '理解问题语义并检索企业知识库'],
    }
  }
  return {
    title: '助手正在处理',
    steps: [fallbackStep],
  }
}

export function shouldShowStreamError(message: ChatMessage) {
  if (!message.error?.trim()) return false
  return !message.content.includes(message.error.trim())
}

export function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

export function formatCompactNumber(value: number) {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

export function formatFileSize(value: number) {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  if (value >= 1024) return `${Math.ceil(value / 1024)} KB`
  return `${value} B`
}

function dataAttachments(data: Record<string, unknown> | null | undefined): UploadedFile[] {
  const value = data?.attachments
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id : ''
    const filename = typeof record.filename === 'string'
      ? record.filename
      : typeof record.name === 'string' ? record.name : ''
    if (!id || !filename) return []
    return [{
      id,
      customerId: typeof record.customerId === 'string' ? record.customerId : null,
      filename,
      contentType: typeof record.contentType === 'string' ? record.contentType : 'application/octet-stream',
      sizeBytes: typeof record.sizeBytes === 'number' ? record.sizeBytes : 0,
      sha256: typeof record.sha256 === 'string' ? record.sha256 : '',
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    }]
  })
}
