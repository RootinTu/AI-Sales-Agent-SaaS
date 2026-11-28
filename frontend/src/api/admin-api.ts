import { getJson, requestJson } from './axios-client'

export type MemberRole = 'OWNER' | 'ADMIN' | 'MANAGER' | 'SALES' | 'VIEWER'
export type MemberStatus = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'LEFT'

export interface AdminMember {
  id: string
  userId: string
  email: string
  displayName: string
  role: MemberRole
  status: MemberStatus
  joinedAt: string | null
  lastLoginAt: string | null
  createdAt: string
  allocatedTokens: number | null
  usedTokens: number
  remainingTokens: number | null
  embeddingAllocatedTokens?: number | null
  embeddingUsedTokens?: number
  embeddingRemainingTokens?: number | null
}

export interface AdminMemberPage {
  content: AdminMember[]
  page: number
  size: number
  totalElements: number
  totalPages: number
  first: boolean
  last: boolean
}

export interface MemberQuery {
  keyword: string
  role: string
  status: string
  page: number
  size: number
}

export interface CreateMemberInput {
  displayName: string
  email: string
  role: MemberRole
  initialPassword: string
}

export interface UpdateMemberInput {
  displayName: string
  role: MemberRole
  status: MemberStatus
}

export interface AdminTeam {
  id: string
  slug: string
  name: string
  timezone: string
  locale: string
  planCode: string
  status: string
  totalMembers: number
  activeMembers: number
  adminMembers: number
  createdAt: string
  updatedAt: string
}

export interface UpdateTeamInput {
  name: string
  timezone: string
  locale: string
}

export function getMembers(query: MemberQuery) {
  const params = new URLSearchParams({
    keyword: query.keyword,
    role: query.role,
    status: query.status,
    page: String(query.page),
    size: String(query.size),
  })
  return getJson<AdminMemberPage>(`/api/v1/admin/members?${params.toString()}`)
}

export function createMember(input: CreateMemberInput) {
  return requestJson<AdminMember>('/api/v1/admin/members', {
    method: 'POST',
    data: input,
  })
}

export function updateMember(memberId: string, input: UpdateMemberInput) {
  return requestJson<AdminMember>(`/api/v1/admin/members/${memberId}`, {
    method: 'PUT',
    data: input,
  })
}

export interface TeamTokenBudget {
  totalTokens: number | null
  allocatedTokens: number
  unallocatedTokens: number | null
  embeddingTotalTokens?: number | null
  embeddingAllocatedTokens?: number
  embeddingUnallocatedTokens?: number | null
}

export interface UpdateMemberTokenQuotaInput {
  allocatedTokens?: number | null
  embeddingAllocatedTokens?: number | null
  updateAllocatedQuota?: boolean
  updateEmbeddingQuota?: boolean
}

export interface UpdateTeamTokenBudgetInput {
  totalTokens?: number | null
  embeddingTotalTokens?: number | null
  updateEmbeddingBudget?: boolean
}

export function updateMemberTokenQuota(
  memberId: string,
  input: number | null | UpdateMemberTokenQuotaInput,
) {
  const data = typeof input === 'object' && input !== null
    ? input
    : { allocatedTokens: input, updateAllocatedQuota: true, updateEmbeddingQuota: false }
  return requestJson<AdminMember>(`/api/v1/admin/members/${memberId}/token-quota`, {
    method: 'PUT',
    data,
  })
}

export function getTeamTokenBudget() {
  return getJson<TeamTokenBudget>('/api/v1/admin/token-budget')
}

export function updateTeamTokenBudget(input: number | UpdateTeamTokenBudgetInput) {
  const data = typeof input === 'number'
    ? { totalTokens: input, updateEmbeddingBudget: false }
    : input
  return requestJson<TeamTokenBudget>('/api/v1/admin/token-budget', {
    method: 'PUT',
    data,
  })
}

export function resetMemberPassword(memberId: string, newPassword: string) {
  return requestJson<void>(`/api/v1/admin/members/${memberId}/password`, {
    method: 'PUT',
    data: { newPassword },
  })
}

export function revokeMemberSessions(memberId: string) {
  return requestJson<{ revokedSessions: number }>(`/api/v1/admin/members/${memberId}/revoke-sessions`, {
    method: 'POST',
  })
}

export function getTeam() {
  return getJson<AdminTeam>('/api/v1/admin/team')
}

export function updateTeam(input: UpdateTeamInput) {
  return requestJson<AdminTeam>('/api/v1/admin/team', {
    method: 'PUT',
    data: input,
  })
}
