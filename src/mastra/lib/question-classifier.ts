// Question Classification System for routing queries to appropriate agents/tools

export interface QuestionClassification {
  type: 'web_search' | 'database_query' | 'hybrid' | 'ambiguous';
  confidence: number;
  reasoning: string;
  suggestedAgent: 'researchAgent' | 'fileAgent' | 'both';
  keywords: string[];
  indicators: string[];
}

// Keywords that strongly indicate web search
const WEB_SEARCH_INDICATORS = {
  // Current events & news
  temporal: [
    'current', 'latest', 'recent', 'today', 'yesterday', 'this week', 
    'this month', 'this year', '2024', '2025', 'now', 'nowadays',
    'breaking news', 'news', 'update', 'happening'
  ],
  
  // People & places (usually need current info)
  entities: [
    'who is', 'where is', 'president', 'ceo', 'leader', 'pope',
    'prime minister', 'celebrity', 'company', 'stock price',
    'weather', 'temperature', 'forecast'
  ],
  
  // Web-specific queries
  webSpecific: [
    'google', 'search', 'online', 'website', 'url', 'link',
    'internet', 'trending', 'viral', 'social media', 'twitter',
    'youtube', 'reddit', 'facebook', 'instagram'
  ],
  
  // General knowledge that changes
  dynamic: [
    'price', 'cost', 'rate', 'statistics', 'population',
    'ranking', 'top 10', 'best', 'worst', 'comparison',
    'vs', 'versus', 'difference between'
  ],
  
  // How-to and general questions
  general: [
    'how to', 'tutorial', 'guide', 'tips', 'advice',
    'what is the', 'why does', 'can you explain',
    'tell me about', 'information about'
  ]
};

// Keywords that strongly indicate database/document query
const DATABASE_INDICATORS = {
  // Document references
  documentRef: [
    'document', 'pdf', 'file', 'textbook', 'book', 'chapter',
    'section', 'page', 'paragraph', 'quote', 'excerpt',
    'uploaded', 'stored', 'indexed', 'saved'
  ],
  
  // Academic/technical content
  academic: [
    'theorem', 'formula', 'equation', 'definition', 'concept',
    'theory', 'principle', 'law', 'rule', 'axiom',
    'proof', 'derivation', 'example', 'exercise', 'problem'
  ],
  
  // Specific content queries
  specific: [
    'in the', 'from the', 'according to', 'as mentioned',
    'as stated', 'as described', 'in chapter', 'on page',
    'the author', 'the text', 'the passage', 'the article'
  ],
  
  // Knowledge base queries
  knowledgeBase: [
    'our', 'my', 'database', 'knowledge base', 'corpus',
    'collection', 'repository', 'archive', 'library',
    'what did I upload', 'what files', 'list all'
  ],
  
  // Summary and analysis
  analysis: [
    'summarize', 'summary', 'outline', 'key points',
    'main idea', 'thesis', 'conclusion', 'analysis',
    'interpretation', 'meaning', 'significance'
  ]
};

// Context patterns that help classification
const CONTEXT_PATTERNS = {
  // Patterns that indicate web search
  webPatterns: [
    /who is .* (president|ceo|leader|minister)/i,
    /what is the (current|latest|recent)/i,
    /how much does .* cost/i,
    /where (is|are|can I find)/i,
    /what('s| is) happening/i,
    /news about/i,
    /(stock|crypto|bitcoin) price/i,
    /weather in/i
  ],
  
  // Patterns that indicate database query
  dbPatterns: [
    /chapter \d+/i,
    /section \d+(\.\d+)*/i,
    /page \d+/i,
    /(in|from) the (book|textbook|document|pdf)/i,
    /explain .* from/i,
    /quote from/i,
    /according to the/i,
    /find in (my|our|the) (files|documents)/i,
    /search (for|in) .* (document|file)/i
  ]
};

/**
 * Classify a question to determine if it needs web search or database query
 */
export function classifyQuestion(question: string): QuestionClassification {
  const lowerQuestion = question.toLowerCase();
  const words = lowerQuestion.split(/\s+/);
  
  // Track indicators found
  const webIndicators: string[] = [];
  const dbIndicators: string[] = [];
  
  // Score for each type
  let webScore = 0;
  let dbScore = 0;
  
  // Check web search indicators
  for (const [category, keywords] of Object.entries(WEB_SEARCH_INDICATORS)) {
    for (const keyword of keywords) {
      if (lowerQuestion.includes(keyword)) {
        webIndicators.push(`${category}:${keyword}`);
        webScore += category === 'temporal' || category === 'webSpecific' ? 3 : 2;
      }
    }
  }
  
  // Check database indicators
  for (const [category, keywords] of Object.entries(DATABASE_INDICATORS)) {
    for (const keyword of keywords) {
      if (lowerQuestion.includes(keyword)) {
        dbIndicators.push(`${category}:${keyword}`);
        dbScore += category === 'documentRef' || category === 'specific' ? 3 : 2;
      }
    }
  }
  
  // Check context patterns
  for (const pattern of CONTEXT_PATTERNS.webPatterns) {
    if (pattern.test(lowerQuestion)) {
      webIndicators.push(`pattern:${pattern.source}`);
      webScore += 3;
    }
  }
  
  for (const pattern of CONTEXT_PATTERNS.dbPatterns) {
    if (pattern.test(lowerQuestion)) {
      dbIndicators.push(`pattern:${pattern.source}`);
      dbScore += 3;
    }
  }
  
  // Special cases
  if (lowerQuestion.includes('[uploaded files:')) {
    dbScore += 10; // Strong indicator
    dbIndicators.push('special:uploaded_files_tag');
  }
  
  if (lowerQuestion.includes('http://') || lowerQuestion.includes('https://')) {
    webScore += 5; // URL indicates web search
    webIndicators.push('special:url_detected');
  }
  
  // Calculate confidence
  const totalScore = webScore + dbScore;
  const confidence = totalScore > 0 
    ? Math.max(webScore, dbScore) / totalScore 
    : 0;
  
  // Determine type
  let type: QuestionClassification['type'];
  let suggestedAgent: QuestionClassification['suggestedAgent'];
  let reasoning: string;
  
  if (webScore > dbScore * 1.5) {
    type = 'web_search';
    suggestedAgent = 'researchAgent';
    reasoning = `Strong web search indicators (score: ${webScore}). Found: ${webIndicators.slice(0, 3).join(', ')}`;
  } else if (dbScore > webScore * 1.5) {
    type = 'database_query';
    suggestedAgent = 'fileAgent';
    reasoning = `Strong database indicators (score: ${dbScore}). Found: ${dbIndicators.slice(0, 3).join(', ')}`;
  } else if (webScore > 0 && dbScore > 0) {
    type = 'hybrid';
    suggestedAgent = 'both';
    reasoning = `Mixed indicators (web: ${webScore}, db: ${dbScore}). Try database first, then web if no results.`;
  } else {
    type = 'ambiguous';
    suggestedAgent = 'both';
    reasoning = 'No clear indicators. Will try database first as it\'s more specific, then fall back to web search.';
  }
  
  // Extract key terms for the query
  const keywords = extractKeywords(question);
  
  return {
    type,
    confidence,
    reasoning,
    suggestedAgent,
    keywords,
    indicators: [...webIndicators, ...dbIndicators]
  };
}

/**
 * Extract important keywords from the question
 */
function extractKeywords(question: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
    'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'must', 'can', 'shall', 'what',
    'where', 'when', 'how', 'why', 'who', 'which', 'whom', 'whose'
  ]);
  
  const words = question
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word));
  
  // Also extract any quoted phrases
  const quotedPhrases = question.match(/"[^"]+"/g) || [];
  const cleanQuotes = quotedPhrases.map(q => q.replace(/"/g, ''));
  
  return [...new Set([...words, ...cleanQuotes])];
}

/**
 * Generate an improved prompt for the assistant agent based on classification
 */
export function generateRoutingPrompt(classification: QuestionClassification): string {
  const prompts = {
    web_search: `This appears to be a web search question. Route to researchAgent for current information.`,
    database_query: `This appears to be a database/document question. Route to fileAgent to search indexed content.`,
    hybrid: `This question may need both database and web search. Try fileAgent first, then researchAgent if no results.`,
    ambiguous: `Question type unclear. Try fileAgent first for specific content, fallback to researchAgent for general knowledge.`
  };
  
  return `
${prompts[classification.type]}
Confidence: ${(classification.confidence * 100).toFixed(1)}%
Reasoning: ${classification.reasoning}
Key terms: ${classification.keywords.join(', ')}
  `.trim();
}

/**
 * Examples of usage
 */
export const CLASSIFICATION_EXAMPLES = [
  {
    question: "Who is the current president of France?",
    expected: 'web_search',
    reason: 'Current events, political figure'
  },
  {
    question: "Explain chapter 5 of the economics textbook",
    expected: 'database_query',
    reason: 'Specific document reference'
  },
  {
    question: "What is the weather in Tokyo?",
    expected: 'web_search',
    reason: 'Real-time information needed'
  },
  {
    question: "Find the definition of supply and demand in my uploaded files",
    expected: 'database_query',
    reason: 'Explicit reference to uploaded files'
  },
  {
    question: "What is machine learning?",
    expected: 'hybrid',
    reason: 'Could be in documents or need general explanation'
  },
  {
    question: "Latest news about artificial intelligence",
    expected: 'web_search',
    reason: 'Temporal indicator "latest"'
  },
  {
    question: "Section 21.5 of the document",
    expected: 'database_query',
    reason: 'Specific section reference'
  },
  {
    question: "How much does Bitcoin cost today?",
    expected: 'web_search',
    reason: 'Current price information'
  },
  {
    question: "Summarize the key points from the PDF",
    expected: 'database_query',
    reason: 'PDF reference and summary request'
  },
  {
    question: "Compare Python and JavaScript",
    expected: 'hybrid',
    reason: 'Could use both indexed docs and web info'
  }
];