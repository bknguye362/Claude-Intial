import { createOpenAI } from '../lib/azure-openai-direct.js';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { agentCoordinationTool } from '../tools/agent-coordination-tool.js';
import { classifyQuestion, generateRoutingPrompt } from '../lib/question-classifier.js';

// Initialize Azure OpenAI
const openai = createOpenAI();

// Create memory only if not in production (Heroku)
const agentConfig: any = {
  name: 'Assistant Agent V2',
  maxTokens: 4096,
  getTools: () => ({ 
    agentCoordinationTool
  }),
  instructions: `
    You are an intelligent assistant that routes questions to the appropriate specialized agent.
    
    AVAILABLE AGENTS:
    - fileAgent: Searches indexed documents, PDFs, and uploaded files in the database
    - researchAgent: Searches the web using Google for current information
    
    ENHANCED ROUTING LOGIC:
    
    You will receive a classification analysis with each question that includes:
    - Type: web_search, database_query, hybrid, or ambiguous
    - Confidence: How certain the classification is
    - Reasoning: Why this classification was made
    - Keywords: Important terms from the question
    
    ROUTING RULES:
    
    1. HIGH CONFIDENCE (>80%) WEB SEARCH:
       → Route directly to researchAgent
       Examples: "current news", "today's weather", "who is the president"
    
    2. HIGH CONFIDENCE (>80%) DATABASE QUERY:
       → Route directly to fileAgent
       Examples: "chapter 5", "in the PDF", "uploaded document"
    
    3. HYBRID OR LOW CONFIDENCE:
       → Try fileAgent first (more specific)
       → If no results, try researchAgent (broader search)
    
    4. SPECIAL CASES:
       - URLs in question → researchAgent
       - [Uploaded files:] tag → fileAgent
       - "list files" → fileAgent
       - Mathematical/technical questions → fileAgent first
       - Current events/prices → researchAgent
    
    IMPORTANT BEHAVIORAL RULES:
    - ALWAYS use agentCoordinationTool - you have NO other tools
    - NEVER answer questions yourself
    - Process routing silently (don't say "let me check")
    - Present results naturally as your own knowledge
    - If fileAgent returns empty, try researchAgent automatically
    
    TODAY'S DATE: ${new Date().toLocaleDateString('en-US', { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    })} (${new Date().toISOString().split('T')[0]})
    
    WORKFLOW:
    
    1. Analyze the question classification (provided in context)
    2. Route to appropriate agent based on classification
    3. If first agent returns no results, try the other
    4. Present the information naturally
    
    Remember: You're a router, not an answerer. Always delegate!
  `,
  model: openai('gpt-4.1-test'),
  provider: 'AZURE_OPENAI',
  toolChoice: 'required',
  
  // Pre-process function to add classification
  beforeInvoke: async (params: any) => {
    const userMessage = params.messages?.[params.messages.length - 1]?.content || '';
    
    // Classify the question
    const classification = classifyQuestion(userMessage);
    const routingHint = generateRoutingPrompt(classification);
    
    // Add classification to the context
    const enhancedMessage = `
[QUESTION CLASSIFICATION]
${routingHint}

[USER QUESTION]
${userMessage}
    `.trim();
    
    // Log classification for debugging
    console.log('[Assistant V2] Question Classification:', {
      type: classification.type,
      confidence: `${(classification.confidence * 100).toFixed(1)}%`,
      suggestedAgent: classification.suggestedAgent,
      keywords: classification.keywords
    });
    
    // Update the last message with enhanced context
    if (params.messages && params.messages.length > 0) {
      params.messages[params.messages.length - 1].content = enhancedMessage;
    }
    
    return params;
  }
};

// Only add memory if not in production environment
if (process.env.NODE_ENV !== 'production') {
  agentConfig.memory = new Memory({
    storage: new LibSQLStore({
      url: 'file:../assistant-v2.db',
    }),
  });
}

export const assistantAgentV2 = new Agent(agentConfig);