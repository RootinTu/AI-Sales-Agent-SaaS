package com.yourcompany.salesagent.assistant.infrastructure;

import java.time.Instant;
import java.util.UUID;

public record AssistantConversationRow(
		UUID id,
		UUID organizationId,
		UUID userId,
		UUID memberId,
		String title,
		String channel,
		String mode,
		String status,
		Instant lastMessageAt,
		Instant expiresAt,
		Instant createdAt,
		Instant updatedAt,
		Integer version) {

	public AssistantConversationRow(
			UUID id,
			UUID organizationId,
			UUID userId,
			UUID memberId,
			String title,
			String channel,
			String status,
			Instant lastMessageAt,
			Instant createdAt,
			Instant updatedAt,
			Integer version) {
		this(id, organizationId, userId, memberId, title, channel, "LIGHT", status, lastMessageAt, null, createdAt, updatedAt, version);
	}
}
