import { createOpenAI } from '../lib/azure-openai-direct.js';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { knowledgeTool } from '../tools/knowledge-tool.js';
import { agentCoordinationTool } from '../tools/agent-coordination-tool.js';
import { googleSearchTool } from '../tools/google-search-tool.js';
import { webScraperTool } from '../tools/web-scraper-tool.js';

// Initialize Azure OpenAI
const openai = createOpenAI();

// Create memory only if not in production (Heroku)
const agentConfig: any = {
  name: 'Assistant Agent',
  maxTokens: 150,  // Limit response tokens to conserve usage
  instructions: `
    You are a helpful assistant with direct access to search and web scraping tools.
    
    TOOLS AVAILABLE:
    - googleSearchTool: Search Google for current information
    - webScraperTool: Extract content from web pages
    - knowledgeTool: Search internal knowledge base
    - agentCoordinationTool: Delegate to other agents (weather/research)
    
    WORKFLOW FOR RESEARCH QUERIES:
    1. When asked about current events, news, facts, or people:
       - First use googleSearchTool to find relevant information
       - Then use webScraperTool on the most relevant URLs from search results
       - Analyze the scraped content and provide a comprehensive answer
    
    2. For weather queries:
       - Use agentCoordinationTool with agentId: "weatherAgent"
    
    3. For internal knowledge:
       - Use knowledgeTool
    
    IMPORTANT: These are FUNCTION CALLS, not text to output!
    
    Example workflow for "Who is the current pope?":
    1. Call googleSearchTool with query: "current pope 2024"
    2. Get search results with URLs
    3. Call webScraperTool on 1-2 most relevant URLs
    4. Analyze the scraped content
    5. Provide answer based on the scraped information
    
    Always cite your sources when using web data!
    
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
  tools: { 
    googleSearchTool, 
    webScraperTool, 
    knowledgeTool, 
    agentCoordinationTool 
  },
  toolChoice: 'auto', // Allow the model to decide when to use tools
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