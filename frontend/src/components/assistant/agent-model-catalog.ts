export type AgentModelTier = 'FAST' | 'STANDARD' | 'ADVANCED' | 'CUSTOM'

export interface AgentModelMeta {
  id: string
  tier: AgentModelTier
  tierLabel: string
  afpCoeff: number | null
  recommended?: boolean
  retiring?: boolean
  summary: string
}

export const DEFAULT_AGENT_MODEL = 'doubao-seed-2.1-pro'

export const AGENT_PLAN_SMALL_DEFAULTS = {
  planName: 'Agent Plan Small',
  fiveHourAfp: 2000,
  weeklyAfp: 7000,
  monthlyAfp: 20000,
} as const

/**
 * 火山引擎方舟 Agent Plan 官方语言模型分层与 AFP 抵扣系数（不含音频输入）：
 * 公式：AFP = (输入 token × 系数 + 输出 token × 系数) / 10,000
 */
export const VOLCENGINE_AGENT_MODEL_CATALOG: AgentModelMeta[] = [
  // 极速档（0.25 AFP/万 token）
  {
    id: 'doubao-seed-2.0-mini',
    tier: 'FAST',
    tierLabel: '文本生成（极速）',
    afpCoeff: 0.25,
    summary: '极速低耗 · 适合高频轻量检索与摘要',
  },
  // 标准档（0.5 AFP/万 token）
  {
    id: 'doubao-seed-2.1-lite',
    tier: 'STANDARD',
    tierLabel: '文本生成（标准）',
    afpCoeff: 0.5,
    summary: '均衡标准 · 日常客户跟进与结构化整理',
  },
  {
    id: 'deepseek-v4-flash',
    tier: 'STANDARD',
    tierLabel: '文本生成（标准）',
    afpCoeff: 0.5,
    summary: '高性价比快速推理',
  },
  {
    id: 'glm-5.3-flash',
    tier: 'STANDARD',
    tierLabel: '文本生成（标准）',
    afpCoeff: 0.5,
    summary: '快速响应与中文长文本处理',
  },
  // 进阶档（2 ~ 8 AFP/万 token）
  {
    id: 'deepseek-v4.1-flash-economy',
    tier: 'ADVANCED',
    tierLabel: '文本生成（进阶）',
    afpCoeff: 2,
    summary: '进阶经济档 · 多步工具调用性价比之选',
  },
  {
    id: 'doubao-seed-2.1-pro',
    tier: 'ADVANCED',
    tierLabel: '文本生成（进阶）',
    afpCoeff: 2.5,
    recommended: true,
    summary: '默认推荐 · 复杂多步 ReAct 规划均衡首选',
  },
  {
    id: 'doubao-seed-evolving',
    tier: 'ADVANCED',
    tierLabel: '文本生成（进阶）',
    afpCoeff: 2.5,
    summary: '进化版推理 · 适合复杂销售策略拆解',
  },
  {
    id: 'deepseek-v4.1-flash',
    tier: 'ADVANCED',
    tierLabel: '文本生成（进阶）',
    afpCoeff: 2.5,
    summary: '快速深度推理与多工具协同',
  },
  {
    id: 'glm-5.3',
    tier: 'ADVANCED',
    tierLabel: '文本生成（进阶）',
    afpCoeff: 4.5,
    summary: '强中文写作与商机方案起草',
  },
  {
    id: 'glm-5.4',
    tier: 'ADVANCED',
    tierLabel: '文本生成（进阶）',
    afpCoeff: 4.5,
    summary: 'GLM 最新进阶模型',
  },
  {
    id: 'deepseek-v4-pro',
    tier: 'ADVANCED',
    tierLabel: '文本生成（进阶）',
    afpCoeff: 5.5,
    summary: '强深度逻辑分析与复杂决策',
  },
  {
    id: 'kimi-k3.1-pro',
    tier: 'ADVANCED',
    tierLabel: '文本生成（进阶）',
    afpCoeff: 7,
    summary: '超长上下文文档深度研读',
  },
  {
    id: 'kimi-k2.8-preview',
    tier: 'ADVANCED',
    tierLabel: '文本生成（进阶）',
    afpCoeff: 8,
    summary: '高阶预览推理模型（高燃料消耗）',
  },
]

const CATALOG_MAP = new Map<string, AgentModelMeta>(
  VOLCENGINE_AGENT_MODEL_CATALOG.map((item) => [item.id.toLowerCase(), item]),
)

export const VOLCENGINE_AGENT_PRESET_MODELS: string[] = VOLCENGINE_AGENT_MODEL_CATALOG.map((item) => item.id)

export function getAgentModelMeta(modelId: string): AgentModelMeta {
  const normalized = modelId.trim().toLowerCase()
  const exact = CATALOG_MAP.get(normalized)
  if (exact) return exact
  if (normalized === 'glm-latest') {
    return {
      id: modelId,
      tier: 'ADVANCED',
      tierLabel: '文本生成（进阶）',
      afpCoeff: 4.5,
      summary: 'GLM-5.3 别名',
    }
  }
  if (normalized === 'kimi-k3') {
    return {
      id: modelId,
      tier: 'ADVANCED',
      tierLabel: '文本生成（进阶）',
      afpCoeff: 7,
      retiring: true,
      summary: '即将下线，建议改用 kimi-k3.1-pro',
    }
  }
  return {
    id: modelId,
    tier: 'CUSTOM',
    tierLabel: '其他可用模型',
    afpCoeff: null,
    summary: '自定义模型',
  }
}

export interface AgentModelTierGroup {
  tier: AgentModelTier
  label: string
  hint: string
  models: AgentModelMeta[]
}

const TIER_ORDER: Array<{ tier: AgentModelTier; label: string; hint: string }> = [
  { tier: 'ADVANCED', label: '文本生成（进阶）', hint: '2x ~ 8x AFP' },
  { tier: 'STANDARD', label: '文本生成（标准）', hint: '0.5x AFP' },
  { tier: 'FAST', label: '文本生成（极速）', hint: '0.25x AFP' },
  { tier: 'CUSTOM', label: '其他可用模型', hint: '自定义' },
]

export function groupAgentModelsByTier(modelIds: string[]): AgentModelTierGroup[] {
  const buckets = new Map<AgentModelTier, AgentModelMeta[]>()
  for (const rawId of modelIds) {
    const id = rawId.trim()
    if (!id) continue
    const meta = getAgentModelMeta(id)
    const list = buckets.get(meta.tier) ?? []
    list.push({ ...meta, id })
    buckets.set(meta.tier, list)
  }
  return TIER_ORDER
    .map((entry) => ({
      ...entry,
      models: buckets.get(entry.tier) ?? [],
    }))
    .filter((group) => group.models.length > 0)
}

export function formatAfpValue(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '0'
  if (value === 0) return '0'
  if (value < 0.01) return '<0.01'
  return value >= 100 ? value.toFixed(1) : value.toFixed(2).replace(/\.?0+$/, '')
}

export function formatAfpCoeff(coeff: number | null | undefined) {
  if (coeff == null) return ''
  return `${coeff}x`
}
