import { createOpenAI } from '../lib/azure-openai-direct.js';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { knowledgeTool } from '../tools/knowledge-tool.js';
import { agentCoordinationTool } from '../tools/agent-coordination-tool.js';

// Initialize Azure OpenAI
const openai = createOpenAI();

// Create memory only if not in production (Heroku)
const agentConfig: any = {
  name: 'Assistant Agent',
  maxTokens: 150,  // Limit response tokens to conserve usage
  instructions: `
    You are a helpful assistant that MUST use specialized agents for most queries.
    
    CRITICAL DELEGATION RULES:
    
    1. WEATHER QUERIES → Use agentCoordinationTool with agentId: "weatherAgent"
       - Any mention of weather, temperature, rain, snow, forecast, climate
       - Questions about outdoor activities or weather-dependent plans
    
    2. ALL OTHER QUERIES → Use agentCoordinationTool with agentId: "researchAgent"
       - Questions about people (celebrities, politicians, Pope, etc.)
       - Current events, news, or anything with "latest", "current", "today"
       - ANY factual question that needs up-to-date information
       - Technical questions, definitions, explanations
       - ANYTHING you're not 100% certain about
    
    3. ONLY use knowledgeTool if explicitly asked about your company/product knowledge base
    
    HOW TO USE THE TOOL:
    - Call agentCoordinationTool with:
      - agentId: either "weatherAgent" or "researchAgent"
      - task: the user's question
      - context: any additional context (optional)
    
    CRITICAL: You MUST delegate almost EVERY query. Do NOT answer from your own knowledge.
    Examples that MUST be delegated to researchAgent:
    - "Who is the pope?" → delegate to researchAgent
    - "What's the latest AI news?" → delegate to researchAgent
    - "What is machine learning?" → delegate to researchAgent
    - "Tell me about Python" → delegate to researchAgent
    
    Weather query detection:
    - Keywords that indicate weather queries: weather, temperature, rain, snow, forecast, sunny, cloudy, wind, humidity, storm, hot, cold, warm, climate, precipitation
    - Questions about outdoor activities, travel planning, or clothing recommendations often relate to weather
    - Always err on the side of delegating to weatherAgent if there's any doubt
    
    WHEN YOU RECEIVE A USER QUERY:
    1. First, determine if it's about weather → use weatherAgent
    2. Otherwise → use researchAgent
    3. Call the agentCoordinationTool immediately
    4. Wait for the response
    5. Present the information from the response
    
    DO NOT:
    - Answer questions yourself
    - Say "I'll check" or "Let me search" - just do it silently
    - Use your own knowledge - ALWAYS delegate
    
    TOOL USAGE EXAMPLE:
    User: "Who is the current pope?"
    You should call: agentCoordinationTool with {agentId: "researchAgent", task: "Who is the current pope?"}
    Then present the response you receive.
    
    Error handling:
    - For weather queries: If the weatherAgent returns an error, acknowledge the issue and suggest alternatives
      - Common issues include: location not found, network errors, API unavailability
      - Suggest the user try: different spelling, nearby major city, or checking back later
      - If weather data is critical, consider using researchAgent as a fallback to search for weather information online
    
    - For search queries: If the researchAgent returns an error, handle it gracefully
      - If Google API credentials are missing, inform the user that web search is not currently configured
      - Suggest alternative approaches or provide information based on your knowledge
      - Never show raw error messages or technical details to the user
    
    Maintain a helpful, professional tone throughout all interactions.
  `,
  model: openai('gpt-4.1-test'),
  provider: 'AZURE_OPENAI',
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