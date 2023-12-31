import { Message } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';

import { AZURE_DEPLOYMENT_ID, OPENAI_API_HOST, OPENAI_API_TYPE, OPENAI_API_VERSION, OPENAI_ORGANIZATION } from '../app/const';

import {
  ParsedEvent,
  ReconnectInterval,
  createParser,
} from 'eventsource-parser';

// 其他依赖和OpenAIError类定义保持不变

export const DifyStream = async (
  query: string,
  key: string,
  user: string,
  existingConversationId: string,
) => {
  // 更新URL
  const url = process.env.DIFY_API_URL || 'https://api.dify.ai/v1/chat-messages';

  // 发起HTTP请求
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key || process.env.DIFY_API_KEY}`
    },
    method: 'POST',
    body: JSON.stringify({
      inputs: {}, // 这里可以根据API文档进行适当的调整
      query: query,
      response_mode: 'streaming',
      user: user,
      conversation_id: existingConversationId // 使用存在的conversation_id
    }),
  });

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();



  // 处理非200的HTTP状态
  if (res.status !== 200) {
    const result = await res.json();
    if (result.error) {
      throw new OpenAIError(
        result.error.message,
        result.error.type,
        result.error.param,
        result.error.code,
      );
    } else {
      throw new Error(`API returned an error: ${decoder.decode(result?.value) || result.statusText}`);
    }
  }

  // 处理成功响应并创建一个ReadableStream
  const stream = new ReadableStream({
    async start(controller) {
      // 添加超时逻辑
      let timeoutId: ReturnType<typeof setTimeout>;
      const timeoutDuration = Number(process.env.DIFY_API_TIMEOUT || 5000);

      const resetTimeout = () => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
          controller.close(); // 关闭流
        }, timeoutDuration);
      };

      resetTimeout(); // 初始化超时

      const onParse = (event: ParsedEvent | ReconnectInterval) => {
        if (event.type === 'event') {
          const data = JSON.parse(event.data);

          // 更新conversation_id
          const newConversationId = data.conversation_id;

          // 如果需要，可以将其他字段也解析出来
          const answer = data.answer;

          // 每次收到数据，重置超时
          resetTimeout();

          // 将解析后的数据加入stream
// 将解析后的数据加入stream，并在每个对象后添加换行符作为分隔符
          const queue = encoder.encode(JSON.stringify({ conversation_id: newConversationId, answer: answer }) + "\n");
          controller.enqueue(queue);

        }
      };
      // console.log('new||ConversationId', newConversationId);

      const parser = createParser(onParse);

      for await (const chunk of res.body as any) {
        parser.feed(decoder.decode(chunk));
      }
    },
  });


  return {
    stream
  };
};

export class OpenAIError extends Error {
  type: string;
  param: string;
  code: string;

  constructor(message: string, type: string, param: string, code: string) {
    super(message);
    this.name = 'OpenAIError';
    this.type = type;
    this.param = param;
    this.code = code;
  }
}

export const OpenAIStream = async (
  model: OpenAIModel,
  systemPrompt: string,
  temperature : number,
  key: string,
  messages: Message[],
) => {
  let url = `${OPENAI_API_HOST}/v1/chat/completions`;
  if (OPENAI_API_TYPE === 'azure') {
    url = `${OPENAI_API_HOST}/openai/deployments/${AZURE_DEPLOYMENT_ID}/chat/completions?api-version=${OPENAI_API_VERSION}`;
  }
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(OPENAI_API_TYPE === 'openai' && {
        Authorization: `Bearer ${key ? key : process.env.OPENAI_API_KEY}`
      }),
      ...(OPENAI_API_TYPE === 'azure' && {
        'api-key': `${key ? key : process.env.OPENAI_API_KEY}`
      }),
      ...((OPENAI_API_TYPE === 'openai' && OPENAI_ORGANIZATION) && {
        'OpenAI-Organization': OPENAI_ORGANIZATION,
      }),
    },
    method: 'POST',
    body: JSON.stringify({
      ...(OPENAI_API_TYPE === 'openai' && {model: model.id}),
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        ...messages,
      ],
      max_tokens: 1000,
      temperature: temperature,
      stream: true,
    }),
  });

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  if (res.status !== 200) {
    const result = await res.json();
    if (result.error) {
      throw new OpenAIError(
        result.error.message,
        result.error.type,
        result.error.param,
        result.error.code,
      );
    } else {
      throw new Error(
        `OpenAI API returned an error: ${
          decoder.decode(result?.value) || result.statusText
        }`,
      );
    }
  }

  const stream = new ReadableStream({
    async start(controller) {
      const onParse = (event: ParsedEvent | ReconnectInterval) => {
        if (event.type === 'event') {
          const data = event.data;

          try {
            const json = JSON.parse(data);
            if (json.choices[0].finish_reason != null) {
              controller.close();
              return;
            }
            const text = json.choices[0].delta.content;
            const queue = encoder.encode(text);
            controller.enqueue(queue);
          } catch (e) {
            controller.error(e);
          }
        }
      };

      const parser = createParser(onParse);

      for await (const chunk of res.body as any) {
        parser.feed(decoder.decode(chunk));
      }
    },
  });

  return stream;
};
