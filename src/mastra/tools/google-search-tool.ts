import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

interface GoogleSearchResult {
  title: string;
  link: string;
  snippet: string;
}

interface GoogleSearchResponse {
  items?: GoogleSearchResult[];
  error?: {
    code: number;
    message: string;
  };
}

export const googleSearchTool = createTool({
  id: 'google-search',
  description: 'Search the web using Google Search API to find current information',
  inputSchema: z.object({
    query: z.string().describe('The search query'),
    numResults: z.number().optional().default(3).describe('Number of results to return (max 10)'),
  }),
  outputSchema: z.object({
    results: z.array(z.object({
      title: z.string(),
      link: z.string(),
      snippet: z.string(),
    })),
    query: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    console.log(`[Google Search Tool] Searching for: ${context.query}`);
    
    const apiKey = process.env.GOOGLE_API_KEY;
    const searchEngineId = process.env.GOOGLE_SEARCH_ENGINE_ID;

    if (!apiKey || !searchEngineId) {
      console.error('[Google Search Tool] Missing API credentials');
      console.error('GOOGLE_API_KEY:', apiKey ? 'Set' : 'Missing');
      console.error('GOOGLE_SEARCH_ENGINE_ID:', searchEngineId ? 'Set' : 'Missing');
      
      return {
        results: [],
        query: context.query,
        error: 'Google Search API credentials not configured. Please set GOOGLE_API_KEY and GOOGLE_SEARCH_ENGINE_ID environment variables.',
      };
    }

    try {
      const numResults = Math.min(context.numResults || 5, 10);
      const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${searchEngineId}&q=${encodeURIComponent(context.query)}&num=${numResults}`;
      
      console.log(`[Google Search Tool] API URL: ${url.replace(apiKey, 'API_KEY_HIDDEN')}`);
      
      const response = await fetch(url);
      console.log(`[Google Search Tool] Response status: ${response.status}`);
      
      if (!response.ok) {
        console.error(`[Google Search Tool] API error response: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json() as GoogleSearchResponse;
      console.log(`[Google Search Tool] Response data:`, JSON.stringify(data).substring(0, 200) + '...');

      if (data.error) {
        console.error(`[Google Search Tool] API returned error:`, data.error);
        return {
          results: [],
          query: context.query,
          error: `Google Search API error: ${data.error.message}`,
        };
      }

      const results = (data.items || []).map(item => ({
        title: item.title,
        link: item.link,
        snippet: item.snippet,
      }));

      console.log(`[Google Search Tool] Found ${results.length} results`);
      
      return {
        results,
        query: context.query,
      };
    } catch (error) {
      console.error(`[Google Search Tool] Exception during search:`, error);
      return {
        results: [],
        query: context.query,
        error: `Failed to perform search: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
});