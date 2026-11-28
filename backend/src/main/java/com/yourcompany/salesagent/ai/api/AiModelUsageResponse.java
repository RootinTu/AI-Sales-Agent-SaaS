package com.yourcompany.salesagent.ai.api;

import java.time.Instant;
import java.util.List;

public record AiModelUsageResponse(
		long inputTokens,
		long outputTokens,
		long cachedInputTokens,
		long totalTokens,
		long successfulCalls,
		Instant lastCalledAt,
		Long remainingTokens,
		String remainingStatus,
		Long memberAllocatedTokens,
		long memberUsedTokens,
		Long memberRemainingTokens,
		List<ModelUsageItem> models,
		Long memberEmbeddingAllocatedTokens,
		long memberEmbeddingUsedTokens,
		Long memberEmbeddingRemainingTokens,
		long embeddingTotalTokens,
		long embeddingSuccessfulCalls,
		AgentUsageSummary agent) {

	public AiModelUsageResponse(
			long inputTokens,
			long outputTokens,
			long cachedInputTokens,
			long totalTokens,
			long successfulCalls,
			Instant lastCalledAt,
			Long remainingTokens,
			String remainingStatus,
			Long memberAllocatedTokens,
			long memberUsedTokens,
			Long memberRemainingTokens) {
		this(
				inputTokens,
				outputTokens,
				cachedInputTokens,
				totalTokens,
				successfulCalls,
				lastCalledAt,
				remainingTokens,
				remainingStatus,
				memberAllocatedTokens,
				memberUsedTokens,
				memberRemainingTokens,
				List.of(),
				null,
				0L,
				null,
				0L,
				0L,
				AgentUsageSummary.empty());
	}

	public AiModelUsageResponse(
			long inputTokens,
			long outputTokens,
			long cachedInputTokens,
			long totalTokens,
			long successfulCalls,
			Instant lastCalledAt,
			Long remainingTokens,
			String remainingStatus,
			Long memberAllocatedTokens,
			long memberUsedTokens,
			Long memberRemainingTokens,
			List<ModelUsageItem> models) {
		this(
				inputTokens,
				outputTokens,
				cachedInputTokens,
				totalTokens,
				successfulCalls,
				lastCalledAt,
				remainingTokens,
				remainingStatus,
				memberAllocatedTokens,
				memberUsedTokens,
				memberRemainingTokens,
				models,
				null,
				0L,
				null,
				0L,
				0L,
				AgentUsageSummary.empty());
	}

	public record ModelUsageItem(
			String provider,
			String model,
			long inputTokens,
			long outputTokens,
			long cachedInputTokens,
			long totalTokens,
			long successfulCalls,
			Instant lastCalledAt) {
	}

	public record AgentUsageSummary(
			long inputTokens,
			long outputTokens,
			long cachedInputTokens,
			long totalTokens,
			long successfulCalls,
			Instant lastCalledAt,
			List<ModelUsageItem> models) {

		public static AgentUsageSummary empty() {
			return new AgentUsageSummary(0L, 0L, 0L, 0L, 0L, null, List.of());
		}
	}
}
