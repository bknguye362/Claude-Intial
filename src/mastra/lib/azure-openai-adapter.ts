import { AzureOpenAI } from '@azure/openai';

// Azure OpenAI adapter for Vercel AI SDK
export function createAzureOpenAI(options?: {
  apiKey?: string;
  endpoint?: string;
  apiVersion?: string;
}) {
  const endpoint = options?.endpoint || process.env.AZURE_OPENAI_ENDPOINT || 'https://franklin-open-ai-test.openai.azure.com';
  const apiKey = options?.apiKey || process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY;
  const apiVersion = options?.apiVersion || process.env.AZURE_OPENAI_API_VERSION || '2025-01-01-preview';

  if (!apiKey) {
    throw new Error('Azure OpenAI API key is required. Set AZURE_OPENAI_API_KEY or AZURE_API_KEY environment variable.');
  }

  console.log('[Azure OpenAI] Initializing with:', {
    endpoint,
    apiVersion,
    hasApiKey: !!apiKey
  });

  const client = new AzureOpenAI({
    endpoint,
    apiKey,
    apiVersion,
  });

  // Return a function that creates models
  return (deploymentName: string) => {
    console.log(`[Azure OpenAI] Creating model for deployment: ${deploymentName}`);
    
    return {
      modelId: deploymentName,
      provider: 'azure-openai',
      
      // Main method used by Vercel AI SDK
      async doStream(params: any) {
        console.log(`[Azure OpenAI] Starting stream with params:`, {
          deployment: deploymentName,
          messageCount: params.messages?.length,
          maxTokens: params.maxTokens
        });

        try {
          const messages = params.messages.map((msg: any) => ({
            role: msg.role,
            content: typeof msg.content === 'string' 
              ? msg.content 
              : msg.content.map((c: any) => c.text).join(' ')
          }));

          const streamResponse = await client.streamChatCompletions(
            deploymentName,
            messages,
            {
              maxTokens: params.maxTokens || 150,
              temperature: params.temperature || 0.7,
              topP: params.topP || 1,
              frequencyPenalty: params.frequencyPenalty || 0,
              presencePenalty: params.presencePenalty || 0,
            }
          );

          // Convert Azure stream to Vercel AI SDK format
          const stream = new ReadableStream({
            async start(controller) {
              try {
                for await (const chunk of streamResponse) {
                  if (chunk.choices?.[0]?.delta?.content) {
                    const text = chunk.choices[0].delta.content;
                    controller.enqueue({ type: 'text-delta', textDelta: text });
                  }
                  
                  if (chunk.choices?.[0]?.finishReason) {
                    controller.enqueue({ 
                      type: 'finish', 
                      finishReason: chunk.choices[0].finishReason 
                    });
                  }
                }
                controller.close();
              } catch (error) {
                console.error('[Azure OpenAI] Stream error:', error);
                controller.error(error);
              }
            }
          });

          return {
            stream: stream,
            rawCall: { rawPrompt: messages, rawSettings: {} },
            warnings: []
          };
        } catch (error) {
          console.error('[Azure OpenAI] Error in doStream:', error);
          throw error;
        }
      },

      // For backward compatibility with agent.stream()
      async stream(messages: any[]) {
        const params = {
          messages,
          maxTokens: this.maxTokens || 150,
          temperature: 0.7
        };
        
        const result = await this.doStream(params);
        
        // Create text stream from the main stream
        const reader = result.stream.getReader();
        
        async function* textStreamGenerator() {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              
              // Extract text from the stream data
              if (value?.type === 'text-delta' && value?.textDelta) {
                yield value.textDelta;
              }
            }
          } finally {
            reader.releaseLock();
          }
        }

        return {
          textStream: textStreamGenerator()
        };
      },
      
      // Store maxTokens for later use
      maxTokens: 150
    };
  };
}

// Export as openai for drop-in replacement
export { createAzureOpenAI as createOpenAI };