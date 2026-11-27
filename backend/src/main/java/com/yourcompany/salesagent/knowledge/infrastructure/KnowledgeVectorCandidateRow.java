package com.yourcompany.salesagent.knowledge.infrastructure;

import java.util.UUID;

import com.yourcompany.salesagent.knowledge.api.KnowledgeChunkResponse;

public record KnowledgeVectorCandidateRow(
		UUID id,
		UUID documentId,
		int chunkIndex,
		Integer pageNumber,
		String title,
		String content,
		long revision,
		Double vectorScore) {

	public KnowledgeChunkResponse toChunk() {
		return new KnowledgeChunkResponse(id, documentId, chunkIndex, pageNumber, title, content, revision);
	}
}
