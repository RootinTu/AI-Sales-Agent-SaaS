from typing import Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field

from app.llm.schemas import ModelConfiguration, ModelUsage


class ChatHistoryTurn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    role: Literal["user", "assistant", "system", "USER", "ASSISTANT", "SYSTEM"] = "user"
    content: str = ""


class ChatRequest(ModelConfiguration):
    model_config = ConfigDict(populate_by_name=True)

    user_request: str = Field(validation_alias=AliasChoices("user_request", "userRequest"))
    verified_result: str = Field(validation_alias=AliasChoices("verified_result", "verifiedResult"))
    mode: Literal["LIGHT", "AGENT"] = Field(
        default="LIGHT",
        validation_alias=AliasChoices("mode", "assistantMode"),
    )
    conversation_history: list[ChatHistoryTurn] = Field(
        default_factory=list,
        max_length=20,
        validation_alias=AliasChoices("conversation_history", "conversationHistory"),
    )


class AnalyzeRequest(ModelConfiguration):
    customer_context: str
    chat_content: str = Field(min_length=1)


class StreamEvent(BaseModel):
    type: str
    text: str | None = None
    usage: ModelUsage | None = None
    provider_request_id: str | None = None
    model: str | None = None
