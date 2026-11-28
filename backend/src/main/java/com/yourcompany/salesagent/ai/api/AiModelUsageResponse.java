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
			Instant lastCalledAt,
			Double estimatedAfp) {

		public ModelUsageItem(
				String provider,
				String model,
				long inputTokens,
				long outputTokens,
				long cachedInputTokens,
				long totalTokens,
				long successfulCalls,
				Instant lastCalledAt) {
			this(provider, model, inputTokens, outputTokens, cachedInputTokens, totalTokens, successfulCalls, lastCalledAt, null);
		}
	}

	public record AgentUsageSummary(
			long inputTokens,
			long outputTokens,
			long cachedInputTokens,
			long totalTokens,
			long successfulCalls,
			Instant lastCalledAt,
			List<ModelUsageItem> models,
			double totalEstimatedAfp,
			double last5HoursAfp,
			double last7DaysAfp,
			double last30DaysAfp,
			double fiveHourAfpLimit,
			double weeklyAfpLimit,
			double monthlyAfpLimit) {

		public AgentUsageSummary(
				long inputTokens,
				long outputTokens,
				long cachedInputTokens,
				long totalTokens,
				long successfulCalls,
				Instant lastCalledAt,
				List<ModelUsageItem> models) {
			this(inputTokens, outputTokens, cachedInputTokens, totalTokens, successfulCalls, lastCalledAt, models,
					0.0, 0.0, 0.0, 0.0, 2000.0, 7000.0, 20000.0);
		}

		public static AgentUsageSummary empty() {
			return new AgentUsageSummary(0L, 0L, 0L, 0L, 0L, null, List.of());
		}
	}
}
