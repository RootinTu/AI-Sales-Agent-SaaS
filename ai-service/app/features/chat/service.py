from collections.abc import AsyncIterator

from langchain_core.messages import HumanMessage, SystemMessage

from app.features.chat.prompts import (
    AGENT_ASSISTANT_SYSTEM_PROMPT,
    ANALYSIS_SYSTEM_PROMPT,
    ASSISTANT_SYSTEM_PROMPT,
)
from app.features.chat.schemas import AnalyzeRequest, ChatRequest, StreamEvent
from app.llm.factory import create_chat_model
from app.llm.messages import message_metadata, message_text, message_usage
from app.llm.schemas import ModelResponse


def _history_text(request: ChatRequest) -> str:
    if not request.conversation_history:
        return "无"
    lines: list[str] = []
    for turn in request.conversation_history[-10:]:
        role_label = "用户" if turn.role.lower() == "user" else "助手"
        lines.append(f"[{role_label}]: {turn.content[:500]}")
    return "\n".join(lines)


async def stream_assistant_reply(request: ChatRequest) -> AsyncIterator[StreamEvent]:
    model = create_chat_model(request, stream_usage=True)
    if request.mode == "AGENT":
        system_prompt = AGENT_ASSISTANT_SYSTEM_PROMPT
        human_content = (
            f"【历史对话记忆】：\n{_history_text(request)}\n\n"
            f"【当前用户请求】：\n{request.user_request}\n\n"
            f"【本轮多步已核实的业务结果】：\n{request.verified_result}"
        )
    else:
        system_prompt = ASSISTANT_SYSTEM_PROMPT
        human_content = f"用户请求：\n{request.user_request}\n已核实的业务结果：\n{request.verified_result}"
    messages = [
        SystemMessage(content=system_prompt),
        HumanMessage(content=human_content),
    ]
    async for chunk in model.astream(messages):
        text = message_text(chunk.content)
        usage = message_usage(chunk)
        request_id, model_name = message_metadata(chunk, request.model)
        if text:
            yield StreamEvent(type="delta", text=text, provider_request_id=request_id, model=model_name)
        if usage:
            yield StreamEvent(
                type="usage",
                usage=usage,
                provider_request_id=request_id,
                model=model_name,
            )


async def analyze_chat(request: AnalyzeRequest) -> ModelResponse:
    model = create_chat_model(request)
    response = await model.ainvoke([
        SystemMessage(content=ANALYSIS_SYSTEM_PROMPT),
        HumanMessage(content=f"客户信息：\n{request.customer_context}\n\n待分析聊天原文：\n{request.chat_content}"),
    ])
    request_id, model_name = message_metadata(response, request.model)
    return ModelResponse(
        content=message_text(response.content),
        usage=message_usage(response),
        provider_request_id=request_id,
        model=model_name,
    )
