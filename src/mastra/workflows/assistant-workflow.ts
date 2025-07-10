import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

const analyzeIntent = createStep({
  id: 'analyze-intent',
  description: 'Analyzes user intent to determine if research or weather agent is needed',
  inputSchema: z.object({
    message: z.string().describe('User message to analyze'),
  }),
  outputSchema: z.object({
    message: z.string(),
    intent: z.enum(['weather', 'research_needed', 'greeting', 'general']),
    needsAgent: z.boolean(),
    agentType: z.enum(['weatherAgent', 'researchAgent', 'none']).optional(),
    confidence: z.number(),
    keywords: z.array(z.string()),
  }),
  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('Input data not found');
    }

    const message = inputData.message.toLowerCase();
    
    let intent: 'weather' | 'research_needed' | 'greeting' | 'general' = 'general';
    let needsAgent = false;
    let agentType: 'weatherAgent' | 'researchAgent' | 'none' = 'none';
    let confidence = 0.5;
    const keywords: string[] = [];

    // Check for weather queries
    if (message.match(/weather|temperature|rain|snow|forecast|sunny|cloudy|wind|humidity|storm|hot|cold|warm|climate/)) {
      intent = 'weather';
      needsAgent = true;
      agentType = 'weatherAgent';
      confidence = 0.9;
      keywords.push('weather');
    }
    // Check for simple greetings that don't need research
    else if (message.match(/^(hello|hi|hey|good morning|good afternoon)$/)) {
      intent = 'greeting';
      needsAgent = false;
      confidence = 0.9;
      keywords.push('greeting');
    }
    // Everything else needs research for current information
    else if (
      message.includes('who') || 
      message.includes('what') || 
      message.includes('when') ||
      message.includes('where') ||
      message.includes('how') ||
      message.includes('latest') ||
      message.includes('current') ||
      message.includes('news') ||
      message.includes('today') ||
      message.includes('pope') ||
      message.includes('president') ||
      message.includes('tell me about')
    ) {
      intent = 'research_needed';
      needsAgent = true;
      agentType = 'researchAgent';
      confidence = 0.9;
      keywords.push('research', 'factual');
    }

    return { 
      message: inputData.message, 
      intent, 
      needsAgent,
      agentType,
      confidence, 
      keywords 
    };
  },
});

const generateResponse = createStep({
  id: 'generate-response',
  description: 'Generates response using agent coordination when needed',
  inputSchema: z.object({
    message: z.string(),
    intent: z.enum(['weather', 'research_needed', 'greeting', 'general']),
    needsAgent: z.boolean(),
    agentType: z.enum(['weatherAgent', 'researchAgent', 'none']).optional(),
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

    // If research or weather is needed, use the agent coordination tool
    if (inputData.needsAgent && inputData.agentType && inputData.agentType !== 'none') {
      console.log(`[Workflow] Delegating to ${inputData.agentType} for: ${inputData.message}`);
      
      // Get the specified agent
      const agent = mastra?.getAgent(inputData.agentType);
      if (!agent) {
        throw new Error(`Agent ${inputData.agentType} not found`);
      }

      // Call the agent directly
      const stream = await agent.stream([
        {
          role: 'user',
          content: inputData.message,
        },
      ]);

      let responseText = '';
      console.log(`[Workflow] Collecting response from ${inputData.agentType}...`);
      
      for await (const chunk of stream.textStream) {
        responseText += chunk;
      }
      
      console.log(`[Workflow] Received ${responseText.length} characters from ${inputData.agentType}`);
      return { response: responseText };
    }
    
    // For simple greetings or general queries, use the assistant agent
    const assistantAgent = mastra?.getAgent('assistantAgent');
    if (!assistantAgent) {
      throw new Error('Assistant agent not found');
    }

    // Add context based on intent
    let context = '';
    if (inputData.intent === 'greeting') {
      context = 'The user is greeting you. Be warm and welcoming. Keep it brief.';
    } else {
      context = 'Provide a helpful response based on the user query.';
    }

    const response = await assistantAgent.stream([
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