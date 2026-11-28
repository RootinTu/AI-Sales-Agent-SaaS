package com.yourcompany.salesagent.assistant.api;

import java.time.Instant;
import java.util.UUID;

public record AssistantConversationResponse(
		UUID id,
		String title,
		String channel,
		String mode,
		String status,
		Instant lastMessageAt,
		Instant expiresAt,
		Instant createdAt,
		Instant updatedAt) {

	public AssistantConversationResponse(
			UUID id,
			String title,
			String channel,
			String status,
			Instant lastMessageAt,
			Instant createdAt,
			Instant updatedAt) {
		this(id, title, channel, "LIGHT", status, lastMessageAt, null, createdAt, updatedAt);
	}
}
