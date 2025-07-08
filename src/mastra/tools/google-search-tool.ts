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
    numResults: z.number().optional().default(5).describe('Number of results to return (max 10)'),
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
    const apiKey = process.env.GOOGLE_API_KEY;
    const searchEngineId = process.env.GOOGLE_SEARCH_ENGINE_ID;

    if (!apiKey || !searchEngineId) {
      return {
        results: [],
        query: context.query,
        error: 'Google Search API credentials not configured. Please set GOOGLE_API_KEY and GOOGLE_SEARCH_ENGINE_ID environment variables.',
      };
    }

    try {
      const numResults = Math.min(context.numResults || 5, 10);
      const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${searchEngineId}&q=${encodeURIComponent(context.query)}&num=${numResults}`;
      
      const response = await fetch(url);
      const data = await response.json() as GoogleSearchResponse;

      if (data.error) {
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

      return {
        results,
        query: context.query,
      };
    } catch (error) {
      return {
        results: [],
        query: context.query,
        error: `Failed to perform search: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
});