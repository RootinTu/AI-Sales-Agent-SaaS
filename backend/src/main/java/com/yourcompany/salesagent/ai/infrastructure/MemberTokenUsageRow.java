package com.yourcompany.salesagent.ai.infrastructure;

public record MemberTokenUsageRow(
		Long allocatedTokens,
		long usedTokens,
		Long embeddingAllocatedTokens,
		long embeddingUsedTokens,
		Long teamEmbeddingBudgetTokens) {

	public MemberTokenUsageRow(Long allocatedTokens, long usedTokens) {
		this(allocatedTokens, usedTokens, null, 0L, null);
	}
}
