package com.yourcompany.salesagent.admin.api;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

public record AdminMemberPasswordResetRequest(
		@NotBlank(message = "请输入新密码")
		@Size(min = 10, max = 72, message = "新密码长度需为 10 到 72 个字符")
		@Pattern(
				regexp = "^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d).+$",
				message = "新密码必须同时包含大写字母、小写字母和数字")
		String newPassword) {
}
