import { mastra } from './index.ts';

// Simple HTTP server example for the assistant chatbot
const PORT = 3000;

async function handleRequest(body: any) {
  const agent = mastra.getAgent('assistantAgent');
  
  if (!body.message) {
    return { error: 'Message is required' };
  }

  const messages = [
    { role: 'user' as const, content: body.message }
  ];

  try {
    let response = '';
    console.log('Processing message:', body.message);
    
    const stream = await agent.stream(messages);
    
    for await (const chunk of stream.textStream) {
      response += chunk;
      console.log('Chunk received:', chunk);
    }
    
    console.log('Final response:', response);

    // Enhanced response format similar to Azure OpenAI
    return {
      choices: [{
        message: {
          role: 'assistant',
          content: response || 'I apologize, but I was unable to generate a response. Please try again.'
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
  } catch (error) {
    console.error('Error processing request:', error);
    return {
      error: 'Failed to process request',
      details: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

// Export the handler for use with any HTTP framework
export { handleRequest };
