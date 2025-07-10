// Direct Azure OpenAI integration for Mastra agents
// This bypasses complex Vercel AI SDK requirements

export function createOpenAI(options?: any) {
  const apiKey = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || process.env.OPENAI_API_KEY;
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT || 'https://franklin-open-ai-test.openai.azure.com';
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2023-12-01-preview'; // This version supports function calling
  
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
      async stream(messages: any[], options?: any) {
        console.log('[Azure Direct] Stream called with:', typeof messages, 'value:', messages);
        console.log('[Azure Direct] Stream options:', options);
        
        // Handle both array and string inputs
        let messageArray: any[] = [];
        if (Array.isArray(messages)) {
          messageArray = messages;
        } else if (typeof messages === 'string') {
          messageArray = [{ role: 'user', content: messages }];
        } else if (messages && typeof messages === 'object' && (messages as any).content) {
          messageArray = [messages];
        }
        
        console.log('[Azure Direct] Processed messages:', JSON.stringify(messageArray));
        
        try {
          const requestBody: any = {
            messages: messageArray.length > 0 ? messageArray : [{ role: 'user', content: 'Hello' }],
            max_tokens: 150,
            temperature: 0.7,
            stream: true,
          };
          
          // Add tools if provided
          if (options?.tools) {
            console.log('[Azure Direct] Tools provided:', Object.keys(options.tools));
            requestBody.tools = Object.values(options.tools).map((tool: any) => ({
              type: 'function',
              function: {
                name: tool.name || tool.id,
                description: tool.description,
                parameters: tool.parameters || tool.inputSchema
              }
            }));
            requestBody.tool_choice = options.toolChoice || 'auto';
            console.log('[Azure Direct] Converted tools:', JSON.stringify(requestBody.tools));
          }
          
          console.log('[Azure Direct] Sending to Azure:', JSON.stringify(requestBody));
          
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

          // First, process the initial response to collect any tool calls
          const toolCalls: any[] = [];
          let currentToolCall: any = null;
          let hasContent = false;
          let contentBuffer = '';
          
          // Read the entire response first
          const reader = response.body?.getReader();
          if (!reader) throw new Error('No response body');
          
          const decoder = new TextDecoder();
          let buffer = '';
          
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
                    const delta = json.choices?.[0]?.delta;
                    
                    // Handle regular content
                    if (delta?.content) {
                      hasContent = true;
                      contentBuffer += delta.content;
                    }
                    
                    // Handle tool calls
                    if (delta?.tool_calls) {
                      for (const toolCall of delta.tool_calls) {
                        if (toolCall.index !== undefined) {
                          // New tool call or update existing one
                          if (!toolCalls[toolCall.index]) {
                            toolCalls[toolCall.index] = {
                              id: toolCall.id || `tool_${toolCall.index}`,
                              type: 'function',
                              function: { name: '', arguments: '' }
                            };
                          }
                          currentToolCall = toolCalls[toolCall.index];
                          
                          if (toolCall.function?.name) {
                            currentToolCall.function.name = toolCall.function.name;
                          }
                          if (toolCall.function?.arguments) {
                            currentToolCall.function.arguments += toolCall.function.arguments;
                          }
                        }
                      }
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
          
          // Create text stream generator
          async function* generateText() {
            // If we have content and no tool calls, just yield the content
            if (hasContent && toolCalls.length === 0) {
              yield contentBuffer;
              return;
            }
            
            // If we have tool calls, execute them
            if (toolCalls.length > 0) {
              console.log('[Azure Direct] Tool calls detected:', toolCalls);
              
              // Append the assistant's message with tool calls
              const assistantMessage = {
                role: 'assistant',
                content: contentBuffer || null,
                tool_calls: toolCalls
              };
              messageArray.push(assistantMessage);
              
              // Execute each tool and collect results
              for (const toolCall of toolCalls) {
                const toolName = toolCall.function.name;
                const tool = options?.tools?.[toolName];
                
                if (tool) {
                  try {
                    console.log(`[Azure Direct] Executing tool: ${toolName}`);
                    const args = JSON.parse(toolCall.function.arguments);
                    const result = await tool.execute({ context: args });
                    
                    // Add tool result message
                    messageArray.push({
                      tool_call_id: toolCall.id,
                      role: 'tool',
                      name: toolName,
                      content: JSON.stringify(result)
                    });
                  } catch (error) {
                    console.error(`[Azure Direct] Error executing tool ${toolName}:`, error);
                    messageArray.push({
                      tool_call_id: toolCall.id,
                      role: 'tool',
                      name: toolName,
                      content: JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' })
                    });
                  }
                } else {
                  console.error(`[Azure Direct] Tool not found: ${toolName}`);
                }
              }
              
              // Make second API call with tool results
              console.log('[Azure Direct] Making second API call with tool results');
              const secondRequestBody = {
                messages: messageArray,
                max_tokens: 150,
                temperature: 0.7,
                stream: true,
                // Don't include tools in the second call
              };
              
              const secondResponse = await fetch(`${baseURL}/chat/completions?api-version=${apiVersion}`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'api-key': apiKey,
                },
                body: JSON.stringify(secondRequestBody),
              });
              
              if (!secondResponse.ok) {
                const error = await secondResponse.text();
                console.error('[Azure Direct] Second API Error:', error);
                yield 'I apologize, but I encountered an error processing the tool results.';
                return;
              }
              
              // Stream the final response
              const secondReader = secondResponse.body?.getReader();
              if (!secondReader) throw new Error('No response body for second call');
              
              const secondDecoder = new TextDecoder();
              let secondBuffer = '';
              
              try {
                while (true) {
                  const { done, value } = await secondReader.read();
                  if (done) break;
                  
                  secondBuffer += secondDecoder.decode(value, { stream: true });
                  const lines = secondBuffer.split('\n');
                  secondBuffer = lines.pop() || '';
                  
                  for (const line of lines) {
                    if (line.startsWith('data: ')) {
                      const data = line.slice(6);
                      if (data === '[DONE]') continue;
                      
                      try {
                        const json = JSON.parse(data);
                        const content = json.choices?.[0]?.delta?.content;
                        if (content) {
                          yield content;
                        }
                      } catch (e) {
                        // Ignore parse errors
                      }
                    }
                  }
                }
              } finally {
                secondReader.releaseLock();
              }
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
      // The method Mastra's Agent actually calls
      __stream: async (params: any) => {
        console.log('[Azure Direct] __stream called with params:', JSON.stringify(params).substring(0, 500));
        
        const messages = params.messages || [];
        const tools = params.tools || {};
        const toolChoice = params.toolChoice || 'auto';
        
        console.log('[Azure Direct] __stream - messages:', messages.length);
        console.log('[Azure Direct] __stream - tools:', Object.keys(tools));
        console.log('[Azure Direct] __stream - toolChoice:', toolChoice);
        
        // Call our stream method with tools
        const result = await model.stream(messages, { tools, toolChoice });
        
        // Return in the format Mastra expects
        return {
          textStream: result.textStream,
          usage: result.usage,
          // Add any other properties Mastra might expect
        };
      },
      
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
        console.log('[Azure Direct] doStream called with params:', JSON.stringify(params).substring(0, 500));
        
        // Extract messages from params.prompt which contains the system message and user messages
        const messages = params.prompt || params.messages || [];
        console.log('[Azure Direct] Extracted messages:', JSON.stringify(messages).substring(0, 500));
        
        // Pass tools and options if available
        const options: any = {};
        if (params.tools) {
          options.tools = params.tools;
          options.toolChoice = params.toolChoice;
          console.log('[Azure Direct] Passing tools to stream:', Object.keys(params.tools || {}));
        }
        
        const result = await model.stream(messages, options);
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