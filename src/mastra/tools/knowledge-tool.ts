import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

// Simple in-memory knowledge base
const knowledgeBase: Record<string, string> = {
  'company': 'Our company was founded in 2020 and specializes in AI solutions.',
  'products': 'We offer three main products: AI Chat Assistant, Data Analytics Platform, and Custom AI Solutions.',
  'pricing': 'Our pricing starts at $99/month for the basic plan, $299/month for professional, and custom pricing for enterprise.',
  'support': 'We provide 24/7 support via email at support@example.com and live chat on our website.',
  'features': 'Key features include: Natural language processing, Real-time analytics, Custom model training, API access, and Multi-language support.',
};

export const knowledgeTool = createTool({
  id: 'search-knowledge',
  description: 'Search internal knowledge base for information',
  inputSchema: z.object({
    query: z.string().describe('Search query or topic'),
  }),
  outputSchema: z.object({
    results: z.array(z.object({
      topic: z.string(),
      content: z.string(),
      relevance: z.number(),
    })),
  }),
  execute: async ({ context }) => {
    const query = context.query.toLowerCase();
    const results = [];

    // Simple keyword matching
    for (const [topic, content] of Object.entries(knowledgeBase)) {
      if (topic.includes(query) || content.toLowerCase().includes(query)) {
        results.push({
          topic,
          content,
          relevance: topic.includes(query) ? 1.0 : 0.5,
        });
      }
    }

    // Sort by relevance
    results.sort((a, b) => b.relevance - a.relevance);

    return { results };
  },
});