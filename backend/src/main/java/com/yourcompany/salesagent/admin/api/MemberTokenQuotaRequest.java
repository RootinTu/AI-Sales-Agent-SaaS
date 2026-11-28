package com.yourcompany.salesagent.admin.api;

import jakarta.validation.constraints.PositiveOrZero;

public record MemberTokenQuotaRequest(
		@PositiveOrZero(message = "普通模型 Token 额度不能小于 0")
		Long allocatedTokens,
		@PositiveOrZero(message = "向量模型 Token 额度不能小于 0")
		Long embeddingAllocatedTokens,
		Boolean updateAllocatedQuota,
		Boolean updateEmbeddingQuota) {

	public MemberTokenQuotaRequest(Long allocatedTokens) {
		this(allocatedTokens, null, Boolean.TRUE, Boolean.FALSE);
	}

	public MemberTokenQuotaRequest(Long allocatedTokens, Long embeddingAllocatedTokens) {
		this(allocatedTokens, embeddingAllocatedTokens, Boolean.TRUE, Boolean.TRUE);
	}
}
