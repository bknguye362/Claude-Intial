import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

const analyzeIntent = createStep({
  id: 'analyze-intent',
  description: 'Analyzes user intent to route to appropriate response',
  inputSchema: z.object({
    message: z.string().describe('User message to analyze'),
  }),
  outputSchema: z.object({
    message: z.string(),
    intent: z.enum(['greeting', 'product_info', 'pricing', 'support', 'general']),
    confidence: z.number(),
    keywords: z.array(z.string()),
  }),
  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('Input data not found');
    }

    const message = inputData.message.toLowerCase();
    
    // Simple intent detection
    let intent: 'greeting' | 'product_info' | 'pricing' | 'support' | 'general' = 'general';
    let confidence = 0.5;
    const keywords: string[] = [];

    if (message.match(/hello|hi|hey|good morning|good afternoon/)) {
      intent = 'greeting';
      confidence = 0.9;
      keywords.push('greeting');
    } else if (message.includes('product') || message.includes('feature')) {
      intent = 'product_info';
      confidence = 0.8;
      keywords.push('product', 'features');
    } else if (message.includes('price') || message.includes('cost') || message.includes('pricing')) {
      intent = 'pricing';
      confidence = 0.9;
      keywords.push('pricing');
    } else if (message.includes('support') || message.includes('help') || message.includes('contact')) {
      intent = 'support';
      confidence = 0.8;
      keywords.push('support');
    }
    
    // Mark as general (research-needed) for current events and factual queries
    if (
      message.includes('news') ||
      message.includes('latest') ||
      message.includes('current') ||
      message.includes('today') ||
      message.includes('recent') ||
      message.includes('who is') ||
      message.includes('what is') ||
      message.includes('tell me about') ||
      message.includes('pope') ||
      message.includes('president') ||
      message.includes('happening')
    ) {
      intent = 'general';  // This will trigger research in the assistant
      confidence = 0.9;
      keywords.push('research', 'current-info');
    }
    
    // Check for PDF file uploads
    if (message.includes('[uploaded files:') || message.includes('.pdf')) {
      intent = 'general';  // Use general intent to handle with special context
      confidence = 0.9;
      keywords.push('pdf-upload');
    }

    return { message: inputData.message, intent, confidence, keywords };
  },
});

const generateResponse = createStep({
  id: 'generate-response',
  description: 'Generates appropriate response based on intent',
  inputSchema: z.object({
    message: z.string(),
    intent: z.enum(['greeting', 'product_info', 'pricing', 'support', 'general']),
    confidence: z.number(),
    keywords: z.array(z.string()),
  }),
  outputSchema: z.object({
    response: z.string(),
  }),
  execute: async ({ inputData, mastra }) => {
    if (!inputData) {
      throw new Error('Input data not found');
    }

    const agent = mastra?.getAgent('assistantAgent');
    if (!agent) {
      throw new Error('Assistant agent not found');
    }

    // Add context based on intent
    let context = '';
    if (inputData.intent === 'greeting') {
      context = 'The user is greeting you. Be warm and welcoming.';
    } else if (inputData.intent === 'pricing') {
      context = 'The user is asking about pricing. Be clear about our pricing tiers.';
    } else if (inputData.intent === 'support') {
      context = 'The user needs support. Be especially helpful and empathetic.';
    } else if (inputData.intent === 'general' && inputData.keywords.includes('research')) {
      context = 'The user is asking about current events or factual information. You MUST use your agentCoordinationTool to delegate this to researchAgent for accurate, up-to-date information.';
    } else if (inputData.intent === 'general' && inputData.keywords.includes('pdf-upload')) {
      context = 'The user has uploaded a PDF file. You MUST use your agentCoordinationTool to delegate this to fileAgent for PDF processing. The fileAgent has access to PDF reading and processing tools.';
    }

    const response = await agent.stream([
      {
        role: 'system',
        content: context,
      },
      {
        role: 'user',
        content: inputData.message,
      },
    ]);

    let responseText = '';
    for await (const chunk of response.textStream) {
      process.stdout.write(chunk);
      responseText += chunk;
    }

    return { response: responseText };
  },
});

const assistantWorkflow = createWorkflow({
  id: 'assistant-workflow',
  inputSchema: z.object({
    message: z.string().describe('User message to process'),
  }),
  outputSchema: z.object({
    response: z.string(),
  }),
})
  .then(analyzeIntent)
  .then(generateResponse);

assistantWorkflow.commit();

export { assistantWorkflow };