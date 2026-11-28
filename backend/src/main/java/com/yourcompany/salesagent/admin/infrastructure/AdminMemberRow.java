package com.yourcompany.salesagent.admin.infrastructure;

import java.time.Instant;
import java.util.UUID;

import com.yourcompany.salesagent.admin.domain.MemberRole;
import com.yourcompany.salesagent.admin.domain.MemberStatus;

public record AdminMemberRow(
		UUID id,
		UUID userId,
		String email,
		String displayName,
		MemberRole role,
		MemberStatus status,
		Instant joinedAt,
		Instant lastLoginAt,
		Instant createdAt,
		Long allocatedTokens,
		long usedTokens,
		Long embeddingAllocatedTokens,
		long embeddingUsedTokens) {

	public AdminMemberRow(
			UUID id,
			UUID userId,
			String email,
			String displayName,
			MemberRole role,
			MemberStatus status,
			Instant joinedAt,
			Instant lastLoginAt,
			Instant createdAt,
			Long allocatedTokens,
			long usedTokens) {
		this(id, userId, email, displayName, role, status, joinedAt, lastLoginAt, createdAt, allocatedTokens, usedTokens, null, 0L);
	}
}
