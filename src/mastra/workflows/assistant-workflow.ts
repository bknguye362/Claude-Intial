import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { createIndexWithNewman, uploadVectorsWithNewman } from '../lib/newman-executor.js';

// Azure OpenAI configuration for embeddings
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'https://franklin-open-ai-test.openai.azure.com';
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || process.env.OPENAI_API_KEY || '';
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2023-12-01-preview';
const EMBEDDINGS_DEPLOYMENT = 'text-embedding-ada-002';

// Helper function to generate embeddings
async function generateEmbedding(text: string): Promise<number[]> {
  if (!AZURE_OPENAI_API_KEY) {
    console.log('[Assistant Workflow] No API key for embeddings, using mock embeddings...');
    const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    // Note: queries index has dimension 384, not 1536
    return Array(384).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
  }

  try {
    const url = `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${EMBEDDINGS_DEPLOYMENT}/embeddings?api-version=${AZURE_OPENAI_API_VERSION}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_OPENAI_API_KEY
      },
      body: JSON.stringify({
        input: text.slice(0, 8000),
        model: 'text-embedding-ada-002'
      })
    });

    if (!response.ok) {
      throw new Error(`Embedding API error: ${response.status} ${response.statusText}`);
    }

    const data: any = await response.json();
    return data.data[0].embedding;
  } catch (error) {
    console.error('[Assistant Workflow] Error generating embedding:', error);
    const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return Array(1536).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
  }
}

// Check if input is a question
function isQuestion(input: string): boolean {
  const questionPatterns = [
    /\?/,
    /^what\s/i,
    /^how\s/i,
    /^why\s/i,
    /^when\s/i,
    /^where\s/i,
    /^who\s/i,
    /^which\s/i,
    /^explain\s/i,
    /^can\s/i,
    /^could\s/i,
    /^should\s/i,
    /^would\s/i,
    /^is\s/i,
    /^are\s/i,
    /^do\s/i,
    /^does\s/i,
    /^did\s/i,
  ];
  
  return questionPatterns.some(pattern => pattern.test(input));
}

// New step to automatically vectorize questions
const autoVectorizeQuestion = createStep({
  id: 'auto-vectorize-question',
  description: 'Automatically detects and vectorizes questions',
  inputSchema: z.object({
    message: z.string().describe('User message to check and potentially vectorize'),
  }),
  outputSchema: z.object({
    message: z.string(),
    isQuestion: z.boolean(),
    vectorized: z.boolean(),
    vectorKey: z.string().optional(),
  }),
  execute: async ({ inputData }) => {
    console.log(`[Assistant Workflow - AutoVectorize] Step executed with input:`, inputData);
    
    if (!inputData) {
      throw new Error('Input data not found');
    }

    const message = inputData.message;
    console.log(`[Assistant Workflow - AutoVectorize] Checking message: "${message}"`);
    
    const isQuestionResult = isQuestion(message);
    console.log(`[Assistant Workflow - AutoVectorize] Is question? ${isQuestionResult}`);
    
    let vectorized = false;
    let vectorKey: string | undefined;

    if (isQuestionResult) {
      console.log(`[Assistant Workflow] AUTO-DETECTED QUESTION: "${message}"`);
      console.log(`[Assistant Workflow] Automatically vectorizing question...`);
      
      try {
        // Generate embedding for the question
        console.log(`[Assistant Workflow] Generating embedding...`);
        const embedding = await generateEmbedding(message);
        console.log(`[Assistant Workflow] Generated embedding with length: ${embedding.length}`);
        
        const timestamp = Date.now();
        vectorKey = `auto-question-${timestamp}`;
        
        // Create vector in same format as PDF chunker
        const vectors = [{
          key: vectorKey,
          embedding: embedding,
          metadata: {
            question: message,
            timestamp: new Date().toISOString(),
            source: 'assistant-workflow-auto',
            type: 'user-question',
            automatic: true
          }
        }];
        
        // Upload to queries index
        console.log(`[Assistant Workflow] Uploading question vector to 'queries' index...`);
        console.log(`[Assistant Workflow] Vector details:`, {
          key: vectorKey,
          embeddingLength: embedding.length,
          metadataKeys: Object.keys(vectors[0].metadata)
        });
        
        const uploadedCount = await uploadVectorsWithNewman('queries', vectors);
        console.log(`[Assistant Workflow] Upload result: ${uploadedCount} vectors`);
        
        if (uploadedCount > 0) {
          console.log(`[Assistant Workflow] Successfully auto-vectorized question with key: ${vectorKey}`);
          vectorized = true;
        } else {
          console.log(`[Assistant Workflow] Failed to upload vector - uploadedCount is 0`);
        }
        
      } catch (error) {
        console.error(`[Assistant Workflow] Error auto-vectorizing question:`, error);
        console.error(`[Assistant Workflow] Error stack:`, error instanceof Error ? error.stack : 'No stack');
        // Continue with workflow even if vectorization fails
      }
    } else {
      console.log(`[Assistant Workflow] Not a question: "${message}"`);
    }

    return { 
      message: inputData.message, 
      isQuestion: isQuestionResult,
      vectorized: vectorized,
      vectorKey: vectorKey
    };
  },
});

const analyzeIntent = createStep({
  id: 'analyze-intent',
  description: 'Analyzes user intent to route to appropriate response',
  inputSchema: z.object({
    message: z.string().describe('User message to analyze'),
    isQuestion: z.boolean(),
    vectorized: z.boolean(),
    vectorKey: z.string().optional(),
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
    
    // Check for PDF file uploads (case-insensitive)
    if (message.toLowerCase().includes('[uploaded files:') || message.includes('.pdf')) {
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
  .then(autoVectorizeQuestion)
  .then(analyzeIntent)
  .then(generateResponse);

assistantWorkflow.commit();

export { assistantWorkflow };