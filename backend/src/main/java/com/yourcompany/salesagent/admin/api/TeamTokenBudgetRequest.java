package com.yourcompany.salesagent.admin.api;

import jakarta.validation.constraints.PositiveOrZero;

public record TeamTokenBudgetRequest(
		@PositiveOrZero(message = "普通模型团队总额不能小于 0") Long totalTokens,
		@PositiveOrZero(message = "向量模型团队总额不能小于 0") Long embeddingTotalTokens,
		Boolean updateEmbeddingBudget) {

	public TeamTokenBudgetRequest(Long totalTokens) {
		this(totalTokens, null, Boolean.FALSE);
	}

	public TeamTokenBudgetRequest(Long totalTokens, Long embeddingTotalTokens) {
		this(totalTokens, embeddingTotalTokens, Boolean.TRUE);
	}
}
