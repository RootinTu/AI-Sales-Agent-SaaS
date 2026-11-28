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
		List<ModelUsageItem> models) {

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
				List.of());
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
}
