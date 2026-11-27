package com.yourcompany.salesagent.ai.infrastructure;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.ConstructorBinding;
import org.springframework.util.StringUtils;

@ConfigurationProperties("app.ai.defaults")
public record AiModelDefaultsProperties(
		String baseUrl,
		String model,
		String embeddingModel,
		int embeddingDimensions) {

	public static final String DEFAULT_EMBEDDING_MODEL = "qwen3.7-text-embedding-flash";
	public static final int DEFAULT_EMBEDDING_DIMENSIONS = 1024;

	@ConstructorBinding
	public AiModelDefaultsProperties(
			String baseUrl,
			String model,
			String embeddingModel,
			Integer embeddingDimensions) {
		this(
				baseUrl,
				model,
				StringUtils.hasText(embeddingModel) ? embeddingModel.strip() : DEFAULT_EMBEDDING_MODEL,
				embeddingDimensions != null && embeddingDimensions > 0 ? embeddingDimensions : DEFAULT_EMBEDDING_DIMENSIONS);
	}

	public AiModelDefaultsProperties(String baseUrl, String model) {
		this(baseUrl, model, DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_DIMENSIONS);
	}
}
