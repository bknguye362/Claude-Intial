// Direct Azure OpenAI integration for Mastra agents
// This bypasses complex Vercel AI SDK requirements

export function createOpenAI(options?: any) {
  const apiKey = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || process.env.OPENAI_API_KEY;
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT || 'https://franklin-open-ai-test.openai.azure.com';
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2025-01-01-preview';
  
  if (!apiKey) {
    throw new Error('API key required. Set AZURE_OPENAI_API_KEY or AZURE_API_KEY');
  }

  // Return a function that creates model configurations
  return (deploymentName: string) => {
    console.log(`[Azure Direct] Creating model for deployment: ${deploymentName}`);
    const baseURL = `${endpoint}/openai/deployments/${deploymentName}`;
    
    // Create a simple wrapper that Mastra's Agent can use
    const model = {
      modelId: deploymentName,
      provider: 'azure-openai',
      
      // The key method that agents use
      async stream(messages: any[]) {
        console.log('[Azure Direct] Stream called with messages:', messages.length);
        console.log('[Azure Direct] Messages content:', JSON.stringify(messages));
        
        try {
          const requestBody = {
            messages: messages.length > 0 ? messages : [{ role: 'user', content: 'Hello' }],
            max_tokens: 150,
            temperature: 0.7,
            stream: true,
          };
          console.log('[Azure Direct] Sending request body:', JSON.stringify(requestBody));
          
          const response = await fetch(`${baseURL}/chat/completions?api-version=${apiVersion}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'api-key': apiKey,
            },
            body: JSON.stringify(requestBody),
          });

          if (!response.ok) {
            const error = await response.text();
            console.error('[Azure Direct] API Error:', error);
            throw new Error(`Azure OpenAI error: ${response.status}`);
          }

          // Create text stream generator
          async function* generateText() {
            const reader = response.body?.getReader();
            if (!reader) throw new Error('No response body');
            
            const decoder = new TextDecoder();
            let buffer = '';
            let tokenCount = 0;
            
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                
                for (const line of lines) {
                  if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;
                    
                    try {
                      const json = JSON.parse(data);
                      const content = json.choices?.[0]?.delta?.content;
                      if (content) {
                        tokenCount += content.length;
                        yield content;
                      }
                    } catch (e) {
                      // Ignore parse errors
                    }
                  }
                }
              }
            } finally {
              reader.releaseLock();
            }
          }

          return {
            textStream: generateText(),
            usage: Promise.resolve({ promptTokens: messages.length * 10, completionTokens: 50, totalTokens: messages.length * 10 + 50 })
          };
        } catch (error) {
          console.error('[Azure Direct] Stream error:', error);
          // Return empty stream on error
          return {
            textStream: (async function* () {
              yield 'I apologize, but I encountered an error connecting to Azure OpenAI.';
            })(),
            usage: Promise.resolve({ promptTokens: 0, completionTokens: 0, totalTokens: 0 })
          };
        }
      }
    };
    
    // Add any additional methods the AI SDK might expect
    Object.assign(model, {
      // For generate compatibility
      doGenerate: async (params: any) => {
        console.log('[Azure Direct] doGenerate called with params:', JSON.stringify(params));
        const messages = params.prompt || params.messages || [];
        
        try {
          const response = await fetch(`${baseURL}/chat/completions?api-version=${apiVersion}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'api-key': apiKey,
            },
            body: JSON.stringify({
              messages: messages,
              max_tokens: params.maxTokens || 150,
              temperature: params.temperature || 0.7,
              stream: false,
            }),
          });

          if (!response.ok) {
            const error = await response.text();
            console.error('[Azure Direct] Generate API Error:', error);
            throw new Error(`Azure OpenAI error: ${response.status}`);
          }

          const data: any = await response.json();
          const content = data.choices?.[0]?.message?.content || '';
          
          return {
            text: content,
            usage: {
              promptTokens: data.usage?.prompt_tokens || 0,
              completionTokens: data.usage?.completion_tokens || 0,
              totalTokens: data.usage?.total_tokens || 0,
            },
            finishReason: data.choices?.[0]?.finish_reason || 'stop',
            rawResponse: { headers: {} },
          };
        } catch (error) {
          console.error('[Azure Direct] doGenerate error:', error);
          throw error;
        }
      },
      
      // For Vercel AI SDK compatibility if needed
      doStream: async (params: any) => {
        console.log('[Azure Direct] doStream called with params:', JSON.stringify(params));
        const result = await model.stream(params.messages || []);
        return {
          stream: new ReadableStream({
            async start(controller) {
              try {
                for await (const text of result.textStream) {
                  controller.enqueue({ type: 'text-delta', textDelta: text });
                }
                controller.enqueue({ 
                  type: 'finish', 
                  finishReason: 'stop',
                  usage: { promptTokens: 50, completionTokens: 50 }
                });
                controller.close();
              } catch (error) {
                controller.error(error);
              }
            }
          }),
          rawCall: { rawPrompt: params.messages || [], rawSettings: {} },
          warnings: [],
          usage: Promise.resolve({
            promptTokens: 0,
            completionTokens: 0, 
            totalTokens: 0
          })
        };
      }
    });
    
    return model;
  };
}