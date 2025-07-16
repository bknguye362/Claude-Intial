// Simple Azure OpenAI configuration using standard OpenAI SDK approach
// This creates a wrapper that mimics the @ai-sdk/openai interface

export function createOpenAI(options?: any) {
  const apiKey = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || process.env.OPENAI_API_KEY;
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT || 'https://franklin-open-ai-test.openai.azure.com';
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2025-01-01-preview';
  
  if (!apiKey) {
    throw new Error('API key required. Set AZURE_OPENAI_API_KEY or AZURE_API_KEY');
  }

  console.log('[Azure OpenAI Simple] Configuration:', {
    endpoint,
    apiVersion,
    hasApiKey: !!apiKey
  });

  // Return a function that creates model configurations
  return (deploymentName: string) => {
    const baseURL = `${endpoint}/openai/deployments/${deploymentName}`;
    
    return {
      modelId: deploymentName,
      provider: 'azure-openai',
      
      // For Mastra/Vercel AI SDK compatibility
      async doStream(params: any) {
        const messages = params.messages || [];
        const maxTokens = params.maxTokens || 4096;
        
        console.log(`[Azure OpenAI Simple] Streaming from ${deploymentName}`);
        console.log(`[Azure OpenAI Simple] Messages:`, JSON.stringify(messages));
        console.log(`[Azure OpenAI Simple] Params:`, JSON.stringify({ maxTokens, temperature: params.temperature }));
        
        try {
          const response = await fetch(`${baseURL}/chat/completions?api-version=${apiVersion}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'api-key': apiKey,
            },
            body: JSON.stringify({
              messages: messages.length > 0 ? messages : [{ role: 'system', content: 'You are a helpful assistant.' }],
              max_tokens: maxTokens,
              temperature: params.temperature || 0.7,
              stream: true,
            }),
          });

          if (!response.ok) {
            const error = await response.text();
            console.error('[Azure OpenAI Simple] API Error:', error);
            throw new Error(`Azure OpenAI API error: ${response.status}`);
          }

          // Create a transform stream that parses SSE data
          const reader = response.body?.getReader();
          const decoder = new TextDecoder();
          
          const stream = new ReadableStream({
            async start(controller) {
              if (!reader) return;
              
              try {
                let buffer = '';
                
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  
                  buffer += decoder.decode(value, { stream: true });
                  const lines = buffer.split('\n');
                  buffer = lines.pop() || '';
                  
                  for (const line of lines) {
                    if (line.startsWith('data: ')) {
                      const data = line.slice(6);
                      if (data === '[DONE]') {
                        controller.enqueue({ 
                          type: 'finish', 
                          finishReason: 'stop',
                          usage: { promptTokens: 50, completionTokens: 50 }
                        });
                        continue;
                      }
                      
                      try {
                        const json = JSON.parse(data);
                        const content = json.choices?.[0]?.delta?.content;
                        if (content) {
                          controller.enqueue({ type: 'text-delta', textDelta: content });
                        }
                        
                        // If this is the first chunk, send usage metadata
                        if (json.usage) {
                          controller.enqueue({ 
                            type: 'usage',
                            usage: {
                              promptTokens: json.usage.prompt_tokens || 0,
                              completionTokens: json.usage.completion_tokens || 0,
                              totalTokens: json.usage.total_tokens || 0
                            }
                          });
                        }
                      } catch (e) {
                        console.error('[Azure OpenAI Simple] Parse error:', e);
                      }
                    }
                  }
                }
                
                controller.close();
              } catch (error) {
                console.error('[Azure OpenAI Simple] Stream error:', error);
                controller.error(error);
              }
            }
          });

          return {
            stream,
            rawCall: { rawPrompt: messages, rawSettings: {} },
            warnings: [],
            usage: Promise.resolve({
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: 0
            })
          };
        } catch (error) {
          console.error('[Azure OpenAI Simple] Error:', error);
          throw error;
        }
      },
      
      // For agent.stream() compatibility
      async stream(messages: any[]) {
        const result = await this.doStream({ messages, maxTokens: 4096 });
        const reader = result.stream.getReader();
        
        async function* textStreamGenerator() {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              
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
      }
    };
  };
}