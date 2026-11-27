package com.yourcompany.salesagent.knowledge.api;

public record KnowledgeBackfillResponse(
		int processed,
		int succeeded,
		int failed,
		int remaining,
		String embeddingModel) {
}
