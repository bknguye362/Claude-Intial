import { createOpenAI } from '../lib/azure-openai-direct.js';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { knowledgeTool } from '../tools/knowledge-tool.js';
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
    
    TODAY'S DATE: ${new Date().toLocaleDateString('en-US', { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    })} (${new Date().toISOString().split('T')[0]})
    CURRENT YEAR: ${new Date().getFullYear()}
    
    TOOLS AVAILABLE:
    - googleSearchTool: Search Google for current information
    - webScraperTool: Extract content from web pages
    - knowledgeTool: Search internal knowledge base
    
    WORKFLOW FOR ALL QUERIES:
    1. For current events, news, facts, people, or ANY question needing up-to-date info:
       - ALWAYS use googleSearchTool first to find relevant information
       - Include the current year (${new Date().getFullYear()}) in search queries when appropriate
       - Then use webScraperTool on the most relevant URLs (1-2 URLs max)
       - Analyze the scraped content and provide a comprehensive answer
    
    2. For internal company/product knowledge only:
       - Use knowledgeTool
    
    3. For weather queries:
       - Use googleSearchTool to search for weather information
       - Scrape weather websites if needed
    
    CRITICAL RULES:
    - These are FUNCTION CALLS that you MUST use
    - Do NOT output tool names as text
    - Do NOT mention other agents
    - ALWAYS search and scrape for factual questions
    
    Example for "Who is the current pope?":
    1. USE googleSearchTool with query "current pope ${new Date().getFullYear()}"
    2. USE webScraperTool on the top result URL
    3. Provide answer based on scraped content
    
    You MUST use these tools. They are your only source of current information!
    
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
    knowledgeTool
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