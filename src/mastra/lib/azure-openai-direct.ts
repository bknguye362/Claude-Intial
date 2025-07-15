// Direct Azure OpenAI integration for Mastra agents
// This bypasses complex Vercel AI SDK requirements

// Import tools for manual execution
import { googleSearchTool } from '../tools/google-search-tool.js';
import { webScraperTool } from '../tools/web-scraper-tool.js';
import { knowledgeTool } from '../tools/knowledge-tool.js';
import { pdfReaderTool } from '../tools/pdf-reader-tool.js';
import { pdfChunkerTool } from '../tools/pdf-chunker-tool.js';
import { textReaderTool } from '../tools/text-reader-tool.js';
import { localListTool } from '../tools/local-list-tool.js';
import { agentCoordinationTool } from '../tools/agent-coordination-tool.js';

// Manual tool registry
const manualTools = {
  googleSearchTool,
  webScraperTool,
  knowledgeTool,
  pdfReaderTool,
  pdfChunkerTool,
  textReaderTool,
  localListTool,
  agentCoordinationTool
};

export function createOpenAI(options?: any) {
  const apiKey = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || process.env.OPENAI_API_KEY;
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT || 'https://franklin-open-ai-test.openai.azure.com';
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2023-12-01-preview'; // This version supports function calling
  
  if (!apiKey) {
    console.error('[Azure Direct] No API key found. Checked environment variables:');
    console.error('[Azure Direct] - AZURE_OPENAI_API_KEY:', process.env.AZURE_OPENAI_API_KEY ? 'Set' : 'Not set');
    console.error('[Azure Direct] - AZURE_API_KEY:', process.env.AZURE_API_KEY ? 'Set' : 'Not set');
    console.error('[Azure Direct] - OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? 'Set' : 'Not set');
    throw new Error('API key required. Set AZURE_OPENAI_API_KEY, AZURE_API_KEY, or OPENAI_API_KEY');
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
        console.log('[Azure Direct] *** STREAM METHOD CALLED DIRECTLY ***');
        console.log('[Azure Direct] Stream called with messages:', JSON.stringify(messages).substring(0, 200));
        console.log('[Azure Direct] Stream options:', JSON.stringify(options).substring(0, 200));
        
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
          
          // Add tools if provided OR use hardcoded tools for research agent
          let tools = options?.tools;
          
          // Check if this is for the file agent - look for system messages first
          const isFileAgent = messageArray.some(msg => 
            msg.role === 'system' && msg.content && typeof msg.content === 'string' && 
            msg.content.includes('You are the file agent')
          ) || messageArray.some(msg => 
            msg.content && typeof msg.content === 'string' && 
            (msg.content.includes('file management assistant') || 
             msg.content.includes('file-related operations') ||
             msg.content.includes('PDF processing capabilities') ||
             msg.content.includes('[Uploaded files:') ||
             msg.content.includes('.pdf'))
          );
          
          // Check if this is for the research agent based on the message content
          const isResearchAgent = !isFileAgent && messageArray.some(msg => 
            msg.content && typeof msg.content === 'string' && 
            (msg.content.includes('research assistant') || 
             msg.content.includes('Google Search'))
          );
          
          // Determine which agent is making the call
          let callingAgent = 'Unknown';
          
          // Priority 1: Check for file agent
          if (isFileAgent) {
            callingAgent = 'File Agent';
          } else if (isResearchAgent) {
            callingAgent = 'Research Agent';
          } else if (messageArray.some(msg => msg.content && typeof msg.content === 'string' && msg.content.includes('helpful assistant'))) {
            callingAgent = 'Assistant Agent';
          }
          
          console.log(`[Azure Direct] === AGENT IDENTIFICATION: ${callingAgent} ===`);
          
          // Debug: Log what we're checking
          console.log('[Azure Direct] Agent detection - isFileAgent:', isFileAgent, 'isResearchAgent:', isResearchAgent);
          
          // If no tools provided and this is for the research agent, manually add them
          if ((!tools || Object.keys(tools).length === 0) && callingAgent === 'Research Agent') {
            console.log('[Azure Direct] No tools provided, adding manual tools for research agent');
            
            // Manually define the tools that should be available
            requestBody.tools = [
              {
                type: 'function',
                function: {
                  name: 'googleSearchTool',
                  description: 'Search the web using Google Search API to find current information',
                  parameters: {
                    type: 'object',
                    properties: {
                      query: {
                        type: 'string',
                        description: 'The search query'
                      },
                      numResults: {
                        type: 'number',
                        description: 'Number of results to return (max 10)',
                        default: 3
                      }
                    },
                    required: ['query']
                  }
                }
              },
              {
                type: 'function',
                function: {
                  name: 'webScraperTool',
                  description: 'Scrape web content from URLs and extract text content',
                  parameters: {
                    type: 'object',
                    properties: {
                      urls: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Array of URLs to scrape'
                      },
                      maxContentLength: {
                        type: 'number',
                        description: 'Maximum characters to extract per page',
                        default: 5000
                      }
                    },
                    required: ['urls']
                  }
                }
              },
              {
                type: 'function',
                function: {
                  name: 'knowledgeTool',
                  description: 'Search and retrieve information from the internal knowledge base',
                  parameters: {
                    type: 'object',
                    properties: {
                      query: {
                        type: 'string',
                        description: 'Query to search for'
                      },
                      numResults: {
                        type: 'number',
                        description: 'Maximum number of results to return',
                        default: 5
                      },
                      rerank: {
                        type: 'boolean',
                        description: 'Whether to rerank results',
                        default: true
                      }
                    },
                    required: ['query']
                  }
                }
              }
            ];
            requestBody.tool_choice = 'auto';
            console.log('[Azure Direct] Added manual tools for research agent:', requestBody.tools.map((t: any) => t.function.name));
          } else if ((!tools || Object.keys(tools).length === 0) && callingAgent === 'File Agent') {
            console.log('[Azure Direct] No tools provided, adding manual tools for file agent');
            
            // Manually define the tools for file agent
            requestBody.tools = [
              {
                type: 'function',
                function: {
                  name: 'localListTool',
                  description: 'List files available in the local uploads directory',
                  parameters: {
                    type: 'object',
                    properties: {
                      directory: {
                        type: 'string',
                        description: 'Directory to list files from',
                        default: './uploads'
                      }
                    },
                    required: []
                  }
                }
              },
              {
                type: 'function',
                function: {
                  name: 'pdfChunkerTool',
                  description: 'Advanced PDF processing with chunking and Q&A capabilities',
                  parameters: {
                    type: 'object',
                    properties: {
                      action: {
                        type: 'string',
                        enum: ['process', 'query'],
                        description: 'Action to perform'
                      },
                      filePath: {
                        type: 'string',
                        description: 'Path to the PDF file'
                      },
                      chunkSize: {
                        type: 'number',
                        description: 'Number of lines per chunk',
                        default: 20
                      },
                      query: {
                        type: 'string',
                        description: 'Question to answer (for query action)'
                      }
                    },
                    required: ['action', 'filePath']
                  }
                }
              },
              {
                type: 'function',
                function: {
                  name: 'pdfReaderTool',
                  description: 'Read entire PDF files (basic reading)',
                  parameters: {
                    type: 'object',
                    properties: {
                      filePath: {
                        type: 'string',
                        description: 'Path to the PDF file'
                      }
                    },
                    required: ['filePath']
                  }
                }
              },
              {
                type: 'function',
                function: {
                  name: 'textReaderTool',
                  description: 'Read text files',
                  parameters: {
                    type: 'object',
                    properties: {
                      filePath: {
                        type: 'string',
                        description: 'Path to the text file'
                      }
                    },
                    required: ['filePath']
                  }
                }
              }
            ];
            requestBody.tool_choice = 'auto';
            console.log('[Azure Direct] Added manual tools for file agent:', requestBody.tools.map((t: any) => t.function.name));
          } else if ((!tools || Object.keys(tools).length === 0) && callingAgent === 'Assistant Agent') {
            console.log('[Azure Direct] No tools provided, adding manual tools for assistant agent');
            
            // Manually define the agentCoordinationTool for assistant agent
            requestBody.tools = [
              {
                type: 'function',
                function: {
                  name: 'agentCoordinationTool',
                  description: 'Delegate a task to another specialized agent and get their response',
                  parameters: {
                    type: 'object',
                    properties: {
                      agentId: {
                        type: 'string',
                        enum: ['researchAgent', 'fileAgent'],
                        description: 'The ID of the agent to delegate to'
                      },
                      task: {
                        type: 'string',
                        description: 'The task or question to delegate to the agent'
                      },
                      context: {
                        type: 'string',
                        description: 'Additional context for the agent'
                      }
                    },
                    required: ['agentId', 'task']
                  }
                }
              }
            ];
            requestBody.tool_choice = 'required';
            console.log('[Azure Direct] Added manual tools for assistant agent:', requestBody.tools.map((t: any) => t.function.name));
          } else {
            // Use provided tools
            console.log('[Azure Direct] Tools provided:', Object.keys(tools));
            requestBody.tools = Object.entries(tools).map(([toolName, tool]: [string, any]) => {
              // Convert Zod schema to JSON Schema if needed
              let parameters = tool.parameters;
              if (!parameters && tool.inputSchema) {
                // If inputSchema is a Zod schema, we need to extract its shape
                // For now, we'll create a simple JSON schema
                parameters = {
                  type: 'object',
                  properties: {},
                  required: []
                };
                
                // This is a simplified conversion - in production you'd use zodToJsonSchema
                if (tool.inputSchema?._def?.typeName === 'ZodObject') {
                  const shape = tool.inputSchema._def.shape();
                  for (const [key, value] of Object.entries(shape)) {
                    parameters.properties[key] = { type: 'string' }; // Simplified
                  }
                }
              }
              
              return {
                type: 'function',
                function: {
                  name: toolName, // Use the object key as the function name
                  description: tool.description,
                  parameters: parameters
                }
              };
            });
            requestBody.tool_choice = options.toolChoice || 'auto';
            console.log('[Azure Direct] Converted tools:', JSON.stringify(requestBody.tools));
          }
          
          console.log('[Azure Direct] Request body preview:', JSON.stringify(requestBody).substring(0, 500));
          console.log('[Azure Direct] Tools in request:', requestBody.tools?.length || 0);
          
          const fullURL = `${baseURL}/chat/completions?api-version=${apiVersion}`;
          console.log('[Azure Direct] Making request to:', fullURL);
          console.log('[Azure Direct] Using API key:', apiKey ? `${apiKey.substring(0, 6)}...` : 'MISSING');
          
          const response = await fetch(fullURL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'api-key': apiKey,
            },
            body: JSON.stringify(requestBody),
          });

          if (!response.ok) {
            const errorText = await response.text();
            console.error('[Azure Direct] API Error Response:', response.status, response.statusText);
            console.error('[Azure Direct] Error Details:', errorText);
            console.error('[Azure Direct] Request URL:', fullURL);
            console.error('[Azure Direct] Deployment Name:', deploymentName);
            throw new Error(`Azure OpenAI error: ${response.status} ${response.statusText} - ${errorText}`);
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
            // Access callingAgent from outer scope
            // If we have content and no tool calls, just yield the content
            if (hasContent && toolCalls.length === 0) {
              console.log('[Azure Direct] No tool calls detected, returning content directly');
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
                // Try to get tool from options first, then fallback to manual tools
                const tool = options?.tools?.[toolName] || (manualTools as any)[toolName];
                
                if (tool) {
                  try {
                    console.log(`[Azure Direct] >>> ${callingAgent} is calling tool: ${toolName}`);
                    console.log(`[Azure Direct] Environment check - GOOGLE_API_KEY:`, process.env.GOOGLE_API_KEY ? 'Present' : 'Missing');
                    console.log(`[Azure Direct] Environment check - GOOGLE_SEARCH_ENGINE_ID:`, process.env.GOOGLE_SEARCH_ENGINE_ID ? 'Present' : 'Missing');
                    const args = JSON.parse(toolCall.function.arguments);
                    console.log(`[Azure Direct] Tool arguments:`, args);
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
          console.error('[Azure Direct] Error type:', error instanceof Error ? error.constructor.name : typeof error);
          console.error('[Azure Direct] Error message:', error instanceof Error ? error.message : String(error));
          
          // Provide more specific error messages
          let errorMessage = 'I apologize, but I encountered an error connecting to Azure OpenAI.';
          
          if (error instanceof Error) {
            if (error.message.includes('fetch')) {
              errorMessage += ' Network connection failed. Please check your internet connection and Azure endpoint.';
              console.error('[Azure Direct] Network error - Endpoint:', endpoint);
            } else if (error.message.includes('401')) {
              errorMessage += ' Authentication failed. Please check your API key configuration.';
            } else if (error.message.includes('404')) {
              errorMessage += ' The deployment or endpoint was not found. Please check your Azure OpenAI configuration.';
            } else if (error.message.includes('API key required')) {
              errorMessage += ' No API key found. Please set AZURE_OPENAI_API_KEY, AZURE_API_KEY, or OPENAI_API_KEY environment variable.';
            }
          }
          
          // Return error message stream
          return {
            textStream: (async function* () {
              yield errorMessage;
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
        
        console.log('[Azure Direct] __stream - messages count:', messages.length);
        console.log('[Azure Direct] __stream - tools available:', Object.keys(tools));
        console.log('[Azure Direct] __stream - toolChoice:', toolChoice);
        console.log('[Azure Direct] __stream - First message:', JSON.stringify(messages[0]).substring(0, 200));
        
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
        console.log('[Azure Direct] doStream - messages:', JSON.stringify(messages).substring(0, 500));
        console.log('[Azure Direct] doStream - tools provided:', params.tools ? Object.keys(params.tools) : 'none');
        console.log('[Azure Direct] doStream - toolChoice:', params.toolChoice);
        
        // Pass tools and options if available
        const options: any = {};
        if (params.tools) {
          options.tools = params.tools;
          options.toolChoice = params.toolChoice || 'auto';
          console.log('[Azure Direct] doStream - Passing tools to stream:', Object.keys(params.tools));
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