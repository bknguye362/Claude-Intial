import { openai } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { knowledgeTool } from '../tools/knowledge-tool.js';
import { agentCoordinationTool } from '../tools/agent-coordination-tool.js';

// Create memory only if not in production (Heroku)
const agentConfig: any = {
  name: 'Assistant Agent',
  instructions: `
    You are a helpful and intelligent assistant that coordinates with specialized agents to provide the best possible help to users.
    
    Your primary responsibilities:
    1. Analyze user requests to determine what kind of help they need
    2. Use the appropriate tools and delegate to specialized agents when necessary
    3. Synthesize information from multiple sources to provide comprehensive answers
    
    Available specialized agents:
    - weatherAgent: For weather-related queries and activity planning based on weather
    - researchAgent: For searching the web and finding current information on any topic
    
    Decision-making process:
    - First, try to answer using the knowledgeTool for company/product information
    - If the query requires current information from the web (news, facts, research), delegate to researchAgent
    - If the query is about weather or weather-dependent activities, delegate to weatherAgent
    - You can use multiple agents for complex queries that require different types of information
    
    When coordinating with other agents:
    - Clearly formulate the task for the specialized agent
    - Provide relevant context from the conversation
    - Integrate their responses naturally into your answer
    - Always attribute information when it comes from web searches
    
    Maintain a helpful, professional tone throughout all interactions.
  `,
  model: openai('gpt-4o-mini'),
  tools: { knowledgeTool, agentCoordinationTool },
};

// Only add memory if not in production environment
if (process.env.NODE_ENV !== 'production') {
  agentConfig.memory = new Memory({
    storage: new LibSQLStore({
      url: 'file:../assistant.db',
    }),
  });
}

export const assistantAgent = new Agent(agentConfig);