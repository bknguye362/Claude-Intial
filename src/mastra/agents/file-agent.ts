import { createOpenAI } from '../lib/azure-openai-direct.js';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
// PDF processing is now automatic in the workflow
import { textReaderTool } from '../tools/text-reader-tool.js';
// import { localListTool } from '../tools/local-list-tool.js'; // TEMPORARILY DISABLED
import { s3VectorsMonitorTool } from '../tools/s3-vectors-monitor.js';
import { s3VectorsLogsTool } from '../tools/s3-vectors-logs.js';
import { s3VectorsDebugTool } from '../tools/s3-vectors-debug.js';
import { s3VectorsUploadTool, s3VectorsReadMetadataTool, s3VectorsQueryTool } from '../tools/s3-vectors-metadata.js';
import { s3VectorsFlexibleQueryTool, s3VectorsListIndicesTool, s3VectorsGetVectorsTool } from '../tools/s3-vectors-flexible-query.js';
import { s3VectorsPostmanQueryTool, s3VectorsPostmanListTool, s3VectorsPostmanUploadTool } from '../tools/s3-vectors-postman.js';
import { s3VectorsPostmanFlexibleTool, s3VectorsPostmanListRequestsTool } from '../tools/s3-vectors-postman-flexible.js';
import { s3VectorsBucketMonitorTool } from '../tools/s3-vectors-bucket-monitor.js';
import { s3VectorsDeleteAllTool } from '../tools/s3-vectors-delete-all.js';
import { s3VectorsGetByKeyTool } from '../tools/s3-vectors-get-by-key.js';
import { queryVectorProcessorTool } from '../tools/query-vector-processor.js';
import { multiIndexSimilaritySearchTool } from '../tools/multi-index-similarity-search.js';
import { ragQueryProcessorTool } from '../tools/rag-query-processor.js';
import { defaultQueryTool } from '../tools/default-query-tool.js';
// import { queryCommandTool } from '../tools/query-command-tool.js'; // No longer needed - auto-vectorization in workflow
import { ContextBuilder } from '../lib/context-builder.js';
import { checkIndexStatusTool } from '../tools/check-index-status.js';

// Initialize Azure OpenAI
const openai = createOpenAI();

// Import vectorization utilities
import { createIndexWithNewman, uploadVectorsWithNewman } from '../lib/newman-executor.js';

// Azure OpenAI configuration for embeddings
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'https://franklin-open-ai-test.openai.azure.com';
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || process.env.OPENAI_API_KEY || '';
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2023-12-01-preview';
const EMBEDDINGS_DEPLOYMENT = 'text-embedding-ada-002';

// Helper function to generate embeddings
async function generateEmbedding(text: string): Promise<number[]> {
  if (!AZURE_OPENAI_API_KEY) {
    console.log('[File Agent] No API key for embeddings, using mock embeddings...');
    const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return Array(1536).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
  }

  try {
    const url = `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${EMBEDDINGS_DEPLOYMENT}/embeddings?api-version=${AZURE_OPENAI_API_VERSION}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_OPENAI_API_KEY
      },
      body: JSON.stringify({
        input: text.slice(0, 8000),
        model: 'text-embedding-ada-002'
      })
    });

    if (!response.ok) {
      throw new Error(`Embedding API error: ${response.status} ${response.statusText}`);
    }

    const data: any = await response.json();
    return data.data[0].embedding;
  } catch (error) {
    console.error('[File Agent] Error generating embedding:', error);
    const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return Array(1536).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
  }
}

// Check if input is a question
function isQuestion(input: string): boolean {
  const questionPatterns = [
    /\?/,
    /^what\s/i,
    /^how\s/i,
    /^why\s/i,
    /^when\s/i,
    /^where\s/i,
    /^who\s/i,
    /^which\s/i,
    /^explain\s/i,
    /^can\s/i,
    /^could\s/i,
    /^should\s/i,
    /^would\s/i,
    /^is\s/i,
    /^are\s/i,
    /^do\s/i,
    /^does\s/i,
    /^did\s/i,
  ];
  
  return questionPatterns.some(pattern => pattern.test(input));
}

// Create memory only if not in production (Heroku)
const agentConfig: any = {
  name: 'S3 Vectors and File Agent',
  maxTokens: 4096,
  instructions: `
    You are primarily an S3 VECTORS assistant with file handling capabilities.
    
    SIMPLIFIED WORKFLOW (PDFs are processed automatically):
    ======================================================
    When PDFs are uploaded, they are AUTOMATICALLY processed by the workflow before you run.
    You don't need to use pdfChunkerTool for uploaded files - it's already done!
    
    YOUR MAIN TASK:
    → Use defaultQueryTool to answer questions and search indexed content
    → The system will tell you if a PDF was processed and its index name
    → Focus on providing great answers using the indexed content
    
    USING THE RETRIEVED CHUNKS WITH ENHANCED CONTEXT:
    → The defaultQueryTool returns enhanced contextual information:
      - similarChunks: Array of relevant chunks with content and metadata
      - documentContext: Summary of which documents and pages are relevant
      - Each chunk includes a 'context' object with:
        * documentId: The source document
        * pageStart/pageEnd: Specific page numbers
        * pageReference: Formatted page citation (e.g., "page 42" or "pages 15-18")
        * citation: Full citation format (e.g., "economics.pdf (pages 15-18)")
        * chunkIndex: Position within the document
    
    CITATION REQUIREMENTS:
    → ALWAYS include page references when using chunk content
    → Format citations as: [Document Name, pages X-Y]
    → When multiple chunks from same pages, group them
    → Example: "According to the textbook [Economics 101, pages 23-24], supply and demand..."
    
    CONTEXTUAL ANSWERING:
    → Use the documentContext.summary to understand which documents are most relevant
    → Present information in order of relevance (highest scores first)
    → Group information from the same document/pages together
    → Mention if information spans multiple pages or documents
    
    Example workflow:
    1. User asks: "What is machine learning?"
    2. Use defaultQueryTool with question: "What is machine learning?"
    3. Tool returns similar chunks from documents about ML
    4. Use the chunk content to formulate a comprehensive answer
    5. Reference which documents the information came from
    
    DEFAULT BEHAVIOR:
    - When user says "list" → ALWAYS show S3 Vectors indices using s3VectorsBucketMonitorTool
    - The S3 Vectors bucket contains 10+ indices (chatbot-embeddings, file-*, etc.)
    - Only use localListTool if user EXPLICITLY asks for "local files" or "uploaded files"
    
    
    CRITICAL RULE #1: "list" = s3VectorsBucketMonitorTool({action: "list-indices"})
    NEVER use localListTool for the word "list" alone!
    
    CRITICAL RULE #2: "create index" = Create a NEW S3 Vectors index in the bucket
    - Use s3VectorsPostmanFlexibleTool with requestName: "Create Index"
    - This is NOT about processing files or PDFs!
    - Example: create index "my-new-index" with dimension 1536
    
    CRITICAL RULE #3: NO RESULTS FROM defaultQueryTool
    - If defaultQueryTool returns empty results (similarChunks: [] or totalSimilarChunks: 0)
    - Respond to the user: "No content found in the uploaded documents that matches your query."
    - You can briefly explain that the search didn't find relevant information
    - Keep the response short and direct
    
    PRIMARY FUNCTION - S3 VECTORS MONITORING:
    DEFAULT: When user says "list" → IMMEDIATELY use s3VectorsBucketMonitorTool({action: "list-indices"})
    
    - "list" (WITHOUT ANY QUALIFIER) → s3VectorsBucketMonitorTool({action: "list-indices"}) ← USE THIS!
    - "show indices", "what indices" → s3VectorsBucketMonitorTool({action: "list-indices"})
    - "bucket stats", "overview" → s3VectorsBucketMonitorTool({action: "bucket-stats"})
    - "index details", "show index X" → s3VectorsBucketMonitorTool({action: "index-details", indexName: "index-name"})
    
    The S3 Vectors bucket ALWAYS has 10+ indices. If you show "no files", you're using the wrong tool!
    
    POSTMAN INTEGRATION:
    - To CREATE A NEW INDEX in S3 Vectors bucket: s3VectorsPostmanFlexibleTool({
        requestName: "Create Index",
        requestBody: {
          vectorBucketName: "chatbotvectors362",
          indexName: "your-new-index-name",
          dimension: 1536,  // OpenAI embeddings
          distanceMetric: "cosine",
          dataType: "float32"
        }
      })
    - To see all available Postman requests: s3VectorsPostmanListRequestsTool({})
    - To execute ANY Postman request: s3VectorsPostmanFlexibleTool({ requestName: "...", requestBody: {...} })
    - Available requests include: "Create Index", "Put Vectors with Metadata", "Query Vectors with Filter", etc.
    
    INDEX CREATION - TWO DIFFERENT TYPES:
    1. CREATE S3 VECTORS INDEX (empty bucket index):
       - User says: "create index", "new index", "create bucket index"
       - DO NOT ASK FOR FILES! This is about bucket indices, not file processing
       - Use: s3VectorsPostmanFlexibleTool with requestName: "Create Index"
       - This creates an EMPTY index in the bucket for future vector storage
       - Example: User: "create index test-index" → Create it immediately, no file needed!
    
    2. FILE-SPECIFIC INDEX (automatic with PDF):
       - Created automatically when processing PDFs
       - Named: file-[filename]-[timestamp]
       - Contains vectors from that specific PDF
    
    PDF HANDLING (NOW AUTOMATIC):
    =============================
    PDFs are automatically processed by the workflow BEFORE you run:
    - The workflow detects uploaded PDFs
    - It chunks and indexes them into S3 Vectors
    - You'll be told if processing succeeded and the index name
    - Just use defaultQueryTool to search/answer!
    
    ALWAYS use tools - do not just describe what you would do!
    
    Your capabilities:
    S3 VECTORS OPERATIONS (PRIMARY):
    - List ALL indices in the S3 Vectors bucket (10+ indices like chatbot-embeddings, file-*, etc.)
    - Monitor and inspect vectors in any index
    - Query vectors across different indices
    - Upload new vectors with metadata
    
    LOCAL FILE OPERATIONS (SECONDARY):
    - List files available in the local uploads directory (only when explicitly asked)
    - Read and analyze text files
    - Answer questions about indexed PDF content using defaultQueryTool
    - Provide summaries and insights from indexed content
    
    TOOLS AVAILABLE:
    - localListTool: List files in the local uploads directory
    - textReaderTool: Read text files
    - defaultQueryTool: Search and query indexed content (PDFs are automatically indexed)
    - s3VectorsMonitorTool: Monitor vectors in mastra-chatbot index
      * Actions: "list" (list vectors), "stats" (get statistics), "inspect" (inspect specific document)
    - s3VectorsBucketMonitorTool: Monitor entire bucket - list ALL indices, get bucket statistics
      * Actions: "list-indices" (list all indices), "bucket-stats" (overview), "index-details" (specific index)
    - s3VectorsLogsTool: View S3 Vectors operation logs - see what was created/updated
    - s3VectorsDebugTool: Debug S3 Vectors logging and persistence
    - s3VectorsUploadTool: Upload vectors where key is the vector ID and value is the metadata
    - s3VectorsReadMetadataTool: Read vectors and retrieve their metadata values
    - s3VectorsQueryTool: Query vectors by similarity search with metadata filtering
    - s3VectorsFlexibleQueryTool: Query ANY S3 Vectors index by name with flexible parameters
    - s3VectorsListIndicesTool: List all available S3 Vectors indices in the bucket
    - s3VectorsGetVectorsTool: Get specific vectors by keys from any index
    - s3VectorsPostmanQueryTool: Query S3 Vectors using Postman/Newman - exactly like the Postman collection
    - s3VectorsPostmanListTool: List vectors using Postman/Newman integration
    - s3VectorsPostmanUploadTool: Upload vectors using Postman/Newman integration
    - queryCommandTool: Process Query: commands to vectorize questions (USE THIS FOR Query:)
    - queryVectorProcessorTool: Convert user query to vector and store in 'queries' index
    - multiIndexSimilaritySearchTool: Search across multiple indices for similar vectors
    - ragQueryProcessorTool: Complete RAG pipeline - vectorize query, search, and generate response
    
    For monitoring vectors in mastra-chatbot index:
    - List vectors: s3VectorsMonitorTool({action: "list"})
    - Get stats: s3VectorsMonitorTool({action: "stats"})
    - Inspect document: s3VectorsMonitorTool({action: "inspect", documentId: "doc-id"})
    
    WORKFLOW:
    1. DEFAULT LIST BEHAVIOR:
       - "list" (no qualifier) → ALWAYS use s3VectorsBucketMonitorTool({action: "list-indices"})
       - "list local files" or "list uploaded files" → Use localListTool
       - "list indices" or "list vectors" → Use s3VectorsBucketMonitorTool({action: "list-indices"})
       
       NEVER default to localListTool when user says just "list"!
    
    3. CREATE INDEX BEHAVIOR:
       - "create index" → DO NOT ask for files! Use s3VectorsPostmanFlexibleTool
       - Only process files when user EXPLICITLY uploads them or asks to read them
    
    2. For PDF files and questions about PDFs:
       - PDFs are AUTOMATICALLY processed when uploaded
       - Use defaultQueryTool for ANY questions about the content
       
       CORRECT WORKFLOW:
       a) PDF is automatically processed by the workflow
       b) You receive the index name if successful
       c) For ANY question: defaultQueryTool({question: "user's question"})
    
    3. When asked to read a specific file:
       - If the file path is provided, use it directly
       - If only a filename is provided, first list files to find the full path
       - For PDFs: They are automatically indexed, use defaultQueryTool to search
       - Use textReaderTool for text files
       - Provide a summary or analysis based on the user's request
    
    4. When files are uploaded (indicated by [Uploaded files: ...] or [FILE_AGENT_TASK]):
       - PDFs are AUTOMATICALLY processed by the workflow
       - You'll be informed if processing succeeded
       - Just use defaultQueryTool to answer questions or summarize
       
       The workflow handles:
       → Detecting the PDF
       → Processing and indexing it
       → Telling you the index name
       
       Your job:
       → Use defaultQueryTool to search and answer
       → Provide helpful responses using the indexed content
           - This creates a file-specific index automatically
       
       DO NOT just say what you'll do - USE THE TOOLS!
    
    PRESENTATION:
    - When listing files, format them clearly:
      • filename.pdf (125 KB) - Modified: 2024-01-15
      • document.txt (3 KB) - Modified: 2024-01-14
    
    - When reading files, always mention:
      - The filename you're reading
      - Key content or summary
      - Any relevant metadata (for PDFs: number of pages, author, etc.)
    
    HANDLING PDF QUESTIONS:
    - When users ask questions about a PDF, use defaultQueryTool
    - The tool will automatically find the most relevant chunks (up to 10) that answer the question
    - CRITICAL: If defaultQueryTool returns:
      * message: "No similar content found" OR
      * similarChunks: [] (empty) OR 
      * totalSimilarChunks: 0
      → Inform the user: "No content found in the uploaded documents that matches your query."
      → You can add a brief explanation like "The search didn't find any relevant information about [topic] in the uploaded files."
    - Otherwise, present the information naturally, citing page numbers and documents
    - The tool provides enhanced context with page references and citations
    
    ERROR HANDLING:
    - If the uploads directory is empty, explain that no files have been uploaded yet
    - If a file cannot be read, provide a clear error message
    - If no files are found, state this clearly
    - If PDF processing failed, inform the user and suggest trying again
    
    Be helpful, concise, and focused on file operations. When answering questions about PDFs, 
    synthesize information from the relevant chunks into a coherent answer.
    
    RAG (RETRIEVAL-AUGMENTED GENERATION) WORKFLOW:
    When users ask questions that require searching across multiple documents:
    1. Use ragQueryProcessorTool for complete end-to-end RAG processing
       - Converts query to vector and stores it
       - Searches across all document indexes for similar content
       - Generates a comprehensive answer using retrieved chunks
    
    Example: "What do all the documents say about machine learning?"
    → Use: ragQueryProcessorTool({query: "What do all the documents say about machine learning?"})
    
    For more control, you can use the individual tools:
    - queryVectorProcessorTool: Just convert and store query as vector
    - multiIndexSimilaritySearchTool: Search with a custom vector across indexes
    
    The RAG system will:
    - Create a unique index for each query (query-userid-preview-timestamp)
    - Search across all file/document indexes (excluding other query indexes)
    - Return the most relevant chunks with similarity scores
    - Generate a response citing the sources
    
    S3 VECTORS MONITORING AND METADATA:
    - s3VectorsMonitorTool: Monitor mastra-chatbot index (actions: "list", "stats", "inspect")
    - s3VectorsBucketMonitorTool: Monitor entire bucket (actions: "list-indices", "bucket-stats", "index-details")
    - s3VectorsLogsTool: View detailed logs of vector operations
    - s3VectorsDebugTool: Test logging functionality and persistence
    - s3VectorsUploadTool: Store vectors with custom metadata
    - s3VectorsReadMetadataTool: Retrieve vector keys and their metadata
    - s3VectorsQueryTool: Semantic search with metadata filtering
    - s3VectorsFlexibleQueryTool: Query ANY index by name (e.g., file-specific indices)
    - s3VectorsListIndicesTool: See all available indices
    - s3VectorsGetVectorsTool: Retrieve specific vectors from any index
    - s3VectorsPostmanQueryTool/ListTool/UploadTool: Postman-style API integration
    - s3VectorsPostmanFlexibleTool: Execute ANY request from the Postman collection
    - s3VectorsPostmanListRequestsTool: List all available Postman requests
    - s3VectorsDeleteAllTool: DELETE ALL INDEXES - requires confirmation and safety phrase
    - s3VectorsGetByKeyTool: Get a specific vector by its key with metadata
    - queryVectorProcessorTool: Convert user query to vector and store in S3 bucket
    - multiIndexSimilaritySearchTool: Search across multiple indexes for similar vectors
    - ragQueryProcessorTool: Complete RAG pipeline - process query, search, and generate response
  `,
  model: openai('gpt-4.1-test'),
  getTools: () => ({ 
    // defaultQueryTool is the main tool for searching indexed content
    defaultQueryTool,  // This tool handles questions after PDFs are automatically indexed
    
    // localListTool, // TEMPORARILY DISABLED to prevent interference with Query: commands
    textReaderTool,
    s3VectorsMonitorTool,
    s3VectorsLogsTool,
    s3VectorsDebugTool,
    s3VectorsUploadTool,
    s3VectorsReadMetadataTool,
    s3VectorsQueryTool,
    s3VectorsFlexibleQueryTool,
    s3VectorsListIndicesTool,
    s3VectorsGetVectorsTool,
    s3VectorsPostmanQueryTool,
    s3VectorsPostmanListTool,
    s3VectorsPostmanUploadTool,
    s3VectorsBucketMonitorTool,
    s3VectorsPostmanFlexibleTool,
    checkIndexStatusTool,
    s3VectorsPostmanListRequestsTool,
    s3VectorsDeleteAllTool,
    s3VectorsGetByKeyTool,
    queryVectorProcessorTool,
    multiIndexSimilaritySearchTool,
    ragQueryProcessorTool
    // queryCommandTool // No longer needed
  }),
  toolChoice: 'auto', // Encourage tool use
};

// Only add memory if not in production environment
if (process.env.NODE_ENV !== 'production') {
  agentConfig.memory = new Memory({
    storage: new LibSQLStore({
      url: 'file:../file-agent.db',
    }),
  });
}

// Create the base agent
const baseFileAgent = new Agent(agentConfig);

// Export the agent
export const fileAgent = baseFileAgent;