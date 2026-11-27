package com.yourcompany.salesagent.ai.api;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

public record AiModelUpdateRequest(
		@NotBlank @Pattern(regexp = "QWEN") String provider,
		@NotBlank @Size(max = 120) String model,
		@Size(max = 120) String embeddingModel,
		@NotBlank @Size(max = 500) String baseUrl,
		@Size(max = 500) String apiKey) {

	public AiModelUpdateRequest(String provider, String model, String baseUrl, String apiKey) {
		this(provider, model, null, baseUrl, apiKey);
	}
}

