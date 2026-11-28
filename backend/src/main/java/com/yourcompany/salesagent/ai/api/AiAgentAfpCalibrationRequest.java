package com.yourcompany.salesagent.ai.api;

import java.math.BigDecimal;

import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;

public record AiAgentAfpCalibrationRequest(
		@DecimalMin(value = "0", message = "AFP 数值不能小于 0")
		@DecimalMax(value = "100000000", message = "AFP 数值过大")
		BigDecimal fiveHourUsedAfp,
		@DecimalMin(value = "0", message = "AFP 数值不能小于 0")
		@DecimalMax(value = "100000000", message = "AFP 数值过大")
		BigDecimal weeklyUsedAfp,
		@DecimalMin(value = "0", message = "AFP 数值不能小于 0")
		@DecimalMax(value = "100000000", message = "AFP 数值过大")
		BigDecimal monthlyUsedAfp) {
}
