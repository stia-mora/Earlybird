// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

function formatMessagesForLlm(messages) {
  const formatted = [];
  for (const msg of messages || []) {
    if (msg.role === 'system') {
      const content = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map(c => c.text || '').join('\n')
          : JSON.stringify(msg.content);
      formatted.push({ role: 'system', content });
    } else if (msg.role === 'user') {
      let content;
      if (typeof msg.content === 'string') {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        const textParts = msg.content.filter(c => c.type === 'text').map(c => c.text);
        content = textParts.join('\n');
      } else {
        content = String(msg.content || '');
      }
      formatted.push({ role: 'user', content });
    } else if (msg.role === 'assistant') {
      const textParts = (msg.content || []).filter(c => c.type === 'text').map(c => c.text);
      const text = textParts.join('\n');
      const toolCalls = (msg.content || []).filter(c => c.type === 'toolCall').map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}),
        },
      }));
      const item = { role: 'assistant', content: text || (toolCalls.length > 0 ? null : '') };
      if (toolCalls.length > 0) item.tool_calls = toolCalls;
      formatted.push(item);
    } else if (msg.role === 'toolResult') {
      const text = Array.isArray(msg.content)
        ? msg.content.map(c => c.text || '').join('\n')
        : String(msg.content || '');
      formatted.push({
        role: 'tool',
        tool_call_id: msg.toolCallId,
        content: text,
      });
    }
  }
  return formatted;
}

function formatToolsForLlm(tools) {
  if (!tools || !tools.length) return undefined;
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function emitAssistantMessage(stream, assistantMsg) {
  stream.push({ type: 'start', partial: assistantMsg });
  let idx = 0;
  for (const item of assistantMsg.content || []) {
    if (item.type === 'text') {
      stream.push({ type: 'text_start', contentIndex: idx, partial: assistantMsg });
      stream.push({ type: 'text_delta', contentIndex: idx, delta: item.text, partial: assistantMsg });
      stream.push({ type: 'text_end', contentIndex: idx, content: item.text, partial: assistantMsg });
    } else if (item.type === 'toolCall') {
      stream.push({ type: 'toolcall_start', contentIndex: idx, partial: assistantMsg });
      stream.push({ type: 'toolcall_delta', contentIndex: idx, delta: '', partial: assistantMsg });
      stream.push({ type: 'toolcall_end', contentIndex: idx, toolCall: item, partial: assistantMsg });
    }
    idx += 1;
  }
  stream.end(assistantMsg);
}

/**
 * Creates a Pi Agent stream function compatible with OpenAI chat completions and EarlyBird clients.
 */
export function createPiStreamFn({
  client,
  apiKey = process.env.EARLYBIRD_LLM_API_KEY || process.env.OPENAI_API_KEY,
  baseUrl = process.env.EARLYBIRD_LLM_BASE_URL || 'https://api.openai.com/v1',
  model = process.env.EARLYBIRD_LLM_MODEL || 'gpt-4o-mini',
  fetchImpl = globalThis.fetch,
  timeoutMs = 120000,
  logger = console,
} = {}) {
  return async function streamFn(requestedModel, context, options = {}) {
    const stream = createAssistantMessageEventStream();
    const effectiveModelId = requestedModel?.id || model;

    (async () => {
      try {
        const messages = formatMessagesForLlm(context.messages);
        const tools = formatToolsForLlm(context.tools);

        // Case 1: Custom client provided with complete() or chat()
        if (client && typeof client.complete === 'function') {
          const systemMsg = messages.find(m => m.role === 'system')?.content || '';
          const userMessages = messages.filter(m => m.role === 'user');
          const toolMessages = messages.filter(m => m.role === 'tool');
          let userMsg;
          if (toolMessages.length === 0) {
            const lastUser = userMessages[userMessages.length - 1];
            userMsg = typeof lastUser?.content === 'string'
              ? lastUser.content
              : JSON.stringify(lastUser?.content || '');
          } else {
            const lastUser = userMessages[userMessages.length - 1];
            const baseText = typeof lastUser?.content === 'string'
              ? lastUser.content
              : JSON.stringify(lastUser?.content || '');
            const toolSummary = toolMessages.map(tm => `[Tool Result ${tm.tool_call_id}]: ${tm.content}`).join('\n\n');
            userMsg = `${baseText}\n\n${toolSummary}`;
          }

          let effectiveSystem = systemMsg;
          if (tools && tools.length > 0 && !systemMsg.includes('【可用工具】')) {
            effectiveSystem += `\n\n【可用工具列表】\n${JSON.stringify(tools, null, 2)}\n若需调用工具，请返回 JSON 包含 tool_calls 数组：[{ "name": "工具名", "arguments": { ... } }]。`;
          }

          const response = await client.complete({ system: effectiveSystem, user: userMsg, tools });
          const content = [];

          if (response?.tool_calls || response?.toolCalls) {
            const rawCalls = response.tool_calls || response.toolCalls;
            for (const tc of rawCalls) {
              let parsedArgs = {};
              try {
                parsedArgs = typeof tc.function?.arguments === 'string'
                  ? JSON.parse(tc.function.arguments)
                  : (tc.function?.arguments || tc.arguments || {});
              } catch {
                parsedArgs = { raw: tc.function?.arguments || tc.arguments };
              }
              content.push({
                type: 'toolCall',
                id: tc.id || `call_${Date.now()}`,
                name: tc.function?.name || tc.name,
                arguments: parsedArgs,
              });
            }
          }

          const textPayload = typeof response === 'string'
            ? response
            : (response?.content || (content.length === 0 ? JSON.stringify(response) : null));

          if (textPayload) {
            content.unshift({ type: 'text', text: textPayload });
          }

          const assistantMsg = {
            role: 'assistant',
            api: 'openai-completions',
            provider: 'earlybird',
            model: effectiveModelId,
            content,
          };

          emitAssistantMessage(stream, assistantMsg);
          return;
        }

        // Case 2: Standard OpenAI-compatible fetch
        if (!apiKey) {
          throw new Error('LLM API key not configured for Pi Agent stream');
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const abortListener = () => controller.abort();
        if (options?.signal) options.signal.addEventListener('abort', abortListener);

        const requestBody = {
          model: effectiveModelId,
          messages,
          temperature: 0.4,
        };
        if (tools && tools.length > 0) {
          requestBody.tools = tools;
        }

        const endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
        const res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          signal: controller.signal,
          body: JSON.stringify(requestBody),
        }).finally(() => {
          clearTimeout(timer);
          if (options?.signal) options.signal.removeEventListener('abort', abortListener);
        });

        const payload = await res.json().catch(() => ({}));
        if (!res.ok || payload.error) {
          throw new Error(payload.error?.message || `LLM HTTP request failed (${res.status})`);
        }

        const choice = payload.choices?.[0];
        const choiceMsg = choice?.message || {};
        const content = [];

        if (choiceMsg.tool_calls && choiceMsg.tool_calls.length > 0) {
          for (const tc of choiceMsg.tool_calls) {
            let parsedArgs = {};
            try {
              parsedArgs = typeof tc.function.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : tc.function.arguments;
            } catch {
              parsedArgs = { raw: tc.function.arguments };
            }
            content.push({
              type: 'toolCall',
              id: tc.id,
              name: tc.function.name,
              arguments: parsedArgs,
            });
          }
        }

        if (choiceMsg.content) {
          content.unshift({ type: 'text', text: choiceMsg.content });
        }

        const assistantMsg = {
          role: 'assistant',
          api: 'openai-completions',
          provider: 'openai',
          model: effectiveModelId,
          content,
        };

        emitAssistantMessage(stream, assistantMsg);
      } catch (error) {
        logger.warn?.('Pi Agent streamFn encountered an error:', error.message);
        const errorMsg = {
          role: 'assistant',
          api: 'openai-completions',
          provider: 'earlybird',
          model: effectiveModelId,
          content: [],
          stopReason: 'error',
          errorMessage: error.message,
        };
        stream.push({ type: 'start', partial: errorMsg });
        stream.end(errorMsg);
      }
    })();

    return stream;
  };
}
