package com.yourcompany.salesagent.admin.api;

public record TeamTokenBudgetResponse(
		Long totalTokens,
		long allocatedTokens,
		Long unallocatedTokens,
		Long embeddingTotalTokens,
		long embeddingAllocatedTokens,
		Long embeddingUnallocatedTokens) {

	public TeamTokenBudgetResponse(Long totalTokens, long allocatedTokens, Long unallocatedTokens) {
		this(totalTokens, allocatedTokens, unallocatedTokens, null, 0L, null);
	}
}
