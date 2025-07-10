import { mastra } from './index.js';

// Simple HTTP server example for the assistant chatbot
const PORT = 3000;

async function handleRequest(body: any) {
  // Use agentId from request body, default to assistantAgent
  const agentId = body.agentId || 'assistantAgent';
  console.log(`[API Endpoint] Handling request for agent: ${agentId}`);
  console.log(`[API Endpoint] Message: ${body.message}`);
  
  const agent = mastra.getAgent(agentId);
  
  if (!body.message) {
    console.error('[API Endpoint] No message provided in request');
    return { error: 'Message is required' };
  }

  const messages = [
    { role: 'user' as const, content: body.message }
  ];

  try {
    let response = '';
    console.log(`[API Endpoint] Starting stream processing for: "${body.message}"`);
    
    // Add error checking for OpenAI API key
    if (!process.env.OPENAI_API_KEY) {
      console.error('[API Endpoint] OPENAI_API_KEY is not set!');
      throw new Error('OpenAI API key is not configured');
    }
    
    console.log(`[API Endpoint] OpenAI API Key present: ${process.env.OPENAI_API_KEY ? 'Yes' : 'No'}`);
    console.log(`[API Endpoint] Creating stream for agent: ${agentId}`);
    
    let stream;
    try {
      // Log the agent structure to understand what methods it has
      console.log(`[API Endpoint] Agent methods:`, Object.getOwnPropertyNames(Object.getPrototypeOf(agent)));
      
      // Try the streamText method which Mastra agents might use
      console.log(`[API Endpoint] Calling agent.streamText with messages:`, JSON.stringify(messages));
      stream = await agent.streamText(messages);
      console.log(`[API Endpoint] Stream created successfully`);
    } catch (streamCreationError) {
      console.error('[API Endpoint] Failed to create stream:', streamCreationError);
      throw streamCreationError;
    }
    
    let chunkCount = 0;
    let rateLimitError = false;
    
    try {
      console.log(`[API Endpoint] Stream object created, starting iteration...`);
      console.log(`[API Endpoint] Stream object type:`, typeof stream);
      console.log(`[API Endpoint] Stream has textStream:`, stream && 'textStream' in stream);
      
      if (!stream || !stream.textStream) {
        throw new Error('Stream object is missing textStream property');
      }
      
      for await (const chunk of stream.textStream) {
        response += chunk;
        chunkCount++;
        console.log(`[API Endpoint] Chunk ${chunkCount} (${chunk.length} chars): ${chunk.substring(0, 50)}...`);
      }
    } catch (streamError) {
      console.error('[API Endpoint] Error during stream iteration:', streamError);
      console.error('[API Endpoint] Stream error details:', streamError instanceof Error ? streamError.stack : 'Unknown stream error');
      
      // Check if it's a rate limit error
      if (streamError instanceof Error && streamError.message.includes('Rate limit')) {
        console.error('[API Endpoint] Rate limit error detected');
        response = 'I apologize, but I\'m currently experiencing high demand. Please try again in about 20 seconds. (OpenAI rate limit reached)';
        rateLimitError = true;
      } else {
        throw streamError;
      }
    }
    
    console.log(`[API Endpoint] Stream complete. Total chunks: ${chunkCount}`);
    console.log(`[API Endpoint] Final response length: ${response.length} characters`);
    console.log(`[API Endpoint] Response preview: ${response.substring(0, 200)}...`);

    // Check if response is empty or invalid (and not already handled by rate limit error)
    if (!rateLimitError && (!response || response.trim() === '')) {
      console.error('[API Endpoint] Empty response received from agent');
      // Check if we're hitting rate limits
      const errorMessage = chunkCount === 0 
        ? 'I apologize, but I\'m unable to process your request right now. This might be due to rate limiting. Please try again in 20-30 seconds.'
        : 'I apologize, but I was unable to generate a proper response. Please try again.';
      response = errorMessage;
    }
    
    // Enhanced response format similar to Azure OpenAI
    const result = {
      choices: [{
        message: {
          role: 'assistant',
          content: response
        },
        finish_reason: response ? 'stop' : 'error',
        index: 0
      }],
      model: 'gpt-4o-mini',
      timestamp: new Date().toISOString(),
      usage: {
        prompt_tokens: body.message.length, // Approximate
        completion_tokens: response.length, // Approximate
        total_tokens: body.message.length + response.length
      }
    };
    
    console.log('[API Endpoint] Returning response format:', JSON.stringify(result).substring(0, 200) + '...');
    return result;
  } catch (error) {
    console.error('[API Endpoint] Error processing request:', error);
    console.error('[API Endpoint] Error stack:', error instanceof Error ? error.stack : 'No stack trace');
    
    // Try to provide a more helpful error response
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    // Always return a valid response format that the client expects
    return {
      choices: [{
        message: {
          role: 'assistant',
          content: `I apologize, but I encountered an error while processing your request. ${errorMessage.includes('API') ? 'The search functionality is not properly configured.' : 'Please try again or rephrase your question.'}`
        },
        finish_reason: 'error',
        index: 0
      }],
      model: 'gpt-4o-mini',
      timestamp: new Date().toISOString(),
      error: true,
      errorDetails: errorMessage
    };
  }
}

// Export the handler for use with any HTTP framework
export { handleRequest };
