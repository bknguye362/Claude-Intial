import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import cheerio from 'cheerio';

// Context window limit for GPT-4o-mini (approximately 128k tokens, but we'll use a conservative character limit)
const CONTEXT_WINDOW_CHARS = 100000;
const SEPARATOR = '\n' + '='.repeat(80) + '\n\n';

// Store for the superdocument (cleared after each use)
let currentSuperdocument = '';

export const webScraperTool = createTool({
  id: 'web-scraper',
  description: 'Scrape web content from URLs and extract text content',
  inputSchema: z.object({
    urls: z.array(z.string()).describe('Array of URLs to scrape'),
    maxContentLength: z.number().optional().default(5000).describe('Maximum characters to extract per page'),
  }),
  outputSchema: z.object({
    superdocument: z.string().describe('Formatted document with all scraped content'),
    scrapedPages: z.array(z.object({
      url: z.string(),
      title: z.string().optional(),
      content: z.string(),
      error: z.string().optional(),
    })),
    truncated: z.boolean().describe('Whether content was truncated to fit context window'),
    sectionsIncluded: z.number().describe('Number of sections included in the superdocument'),
  }),
  execute: async ({ context }) => {
    console.log(`[Web Scraper Tool] Scraping ${context.urls.length} URLs`);
    
    // Clear any previous superdocument
    currentSuperdocument = '';
    
    const scrapedPages = [];
    const superdocumentSections = [];
    
    for (const url of context.urls) {
      try {
        console.log(`[Web Scraper Tool] Fetching: ${url}`);
        
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; ResearchBot/1.0)',
          },
        });
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const html = await response.text();
        const $ = cheerio.load(html);
        
        // Remove script and style elements
        $('script, style').remove();
        
        // Extract title
        const title = $('title').text().trim() || 'Untitled';
        
        // Extract main content
        let content = '';
        
        // Try to find main content areas
        const contentSelectors = [
          'main',
          'article',
          '[role="main"]',
          '#content',
          '.content',
          'body'
        ];
        
        for (const selector of contentSelectors) {
          const element = $(selector).first();
          if (element.length) {
            content = element.text();
            break;
          }
        }
        
        // Clean up the content
        content = content
          .replace(/\s+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
          .substring(0, context.maxContentLength);
        
        scrapedPages.push({
          url,
          title,
          content,
        });
        
        // Create section for superdocument
        const section = `URL: ${url}\nTitle: ${title}\nContent:\n${content}\n`;
        superdocumentSections.push(section);
        
      } catch (error) {
        console.error(`[Web Scraper Tool] Error scraping ${url}:`, error);
        scrapedPages.push({
          url,
          content: '',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        
        const errorSection = `URL: ${url}\nError: ${error instanceof Error ? error.message : 'Unknown error'}\n`;
        superdocumentSections.push(errorSection);
      }
    }
    
    // Build superdocument while respecting context window limits
    let totalChars = 0;
    let sectionsIncluded = 0;
    const includedSections = [];
    
    for (const section of superdocumentSections) {
      const sectionWithSeparator = section + SEPARATOR;
      if (totalChars + sectionWithSeparator.length <= CONTEXT_WINDOW_CHARS) {
        includedSections.push(section);
        totalChars += sectionWithSeparator.length;
        sectionsIncluded++;
      } else {
        console.log(`[Web Scraper Tool] Truncating superdocument at ${sectionsIncluded} sections to fit context window`);
        break;
      }
    }
    
    // Create final superdocument
    currentSuperdocument = includedSections.join(SEPARATOR);
    
    console.log(`[Web Scraper Tool] Successfully scraped ${scrapedPages.filter(p => !p.error).length} out of ${context.urls.length} pages`);
    console.log(`[Web Scraper Tool] Included ${sectionsIncluded} sections in superdocument (${totalChars} chars)`);
    
    // Schedule clearing of superdocument after a short delay (to ensure it's been processed)
    setTimeout(() => {
      console.log('[Web Scraper Tool] Clearing superdocument from memory');
      currentSuperdocument = '';
    }, 1000);
    
    return {
      superdocument: currentSuperdocument,
      scrapedPages,
      truncated: sectionsIncluded < superdocumentSections.length,
      sectionsIncluded,
    };
  },
});