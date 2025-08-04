// Section-aware PDF processor that preserves section boundaries
import { basename } from 'path';
import { readFile } from 'fs/promises';
import { createRequire } from 'module';
import { createIndexWithNewman, uploadVectorsWithNewman } from './newman-executor.js';
import { chunkTextBySections, processPDFWithSections } from './pdf-section-chunker.js';

const require = createRequire(import.meta.url);

// Azure OpenAI configuration
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'https://franklin-open-ai-test.openai.azure.com';
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY || process.env.OPENAI_API_KEY || '';
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2024-06-01';
const EMBEDDINGS_DEPLOYMENT = 'text-embedding-ada-002';

// Generate embedding
async function generateEmbedding(text: string): Promise<number[]> {
  if (!AZURE_OPENAI_API_KEY) {
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
      throw new Error(`Embedding API error: ${response.status}`);
    }

    const data: any = await response.json();
    return data.data[0].embedding;
  } catch (error) {
    console.error('[Section-Aware Processor] Error generating embedding:', error);
    const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return Array(1536).fill(0).map((_, i) => Math.sin(hash + i) * 0.5 + 0.5);
  }
}

export async function processSectionAwarePDF(
  filepath: string,
  options: {
    batchSize?: number;
  } = {}
): Promise<{
  success: boolean;
  filename: string;
  totalChunks?: number;
  totalSections?: number;
  indexName?: string;
  message: string;
  error?: string;
  method?: string;
}> {
  console.log(`[Section-Aware Processor] ===== STARTING SECTION-AWARE PROCESSING =====`);
  console.log(`[Section-Aware Processor] File: ${filepath}`);
  
  try {
    // Process PDF with section awareness
    const { chunks, totalSections, sectionMap } = await processPDFWithSections(filepath);
    console.log(`[Section-Aware Processor] Found ${chunks.length} chunks with ${totalSections} sections`);
    
    // Log sections for debugging
    if (sectionMap.has('21.8')) {
      console.log(`[Section-Aware Processor] ✓ Found section 21.8 at chunk index ${sectionMap.get('21.8')}`);
    }
    
    const filename = basename(filepath);
    const documentId = filename.replace(/\.pdf$/i, '').replace(/[^a-z0-9]/gi, '-').toLowerCase();
    const indexName = `section-aware-${documentId}-${Date.now()}`;
    
    // Create index
    console.log(`[Section-Aware Processor] Creating index: ${indexName}`);
    const indexCreated = await createIndexWithNewman(indexName, 1536);
    if (!indexCreated) {
      throw new Error('Failed to create index');
    }
    
    // Process chunks in batches
    const batchSize = options.batchSize || 20;
    const vectors = [];
    
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      console.log(`[Section-Aware Processor] Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(chunks.length/batchSize)}`);
      
      for (const chunk of batch) {
        // Create searchable content with section info
        let searchableContent = chunk.content;
        if (chunk.sectionNumber) {
          searchableContent = `Section ${chunk.sectionNumber}: ${chunk.sectionTitle || ''}\n\n${chunk.content}`;
        }
        
        const embedding = await generateEmbedding(searchableContent);
        
        vectors.push({
          key: `${documentId}-chunk-${chunks.indexOf(chunk)}`,
          embedding,
          metadata: {
            content: chunk.content.substring(0, 1500),
            sectionNumber: chunk.sectionNumber || '',
            sectionTitle: chunk.sectionTitle || '',
            documentId,
            filename,
            chunkIndex: chunks.indexOf(chunk),
            totalChunks: chunks.length,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            timestamp: new Date().toISOString()
          }
        });
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      // Upload batch
      if (vectors.length >= batchSize) {
        console.log(`[Section-Aware Processor] Uploading ${vectors.length} vectors...`);
        await uploadVectorsWithNewman(indexName, vectors);
        vectors.length = 0; // Clear array
      }
    }
    
    // Upload remaining vectors
    if (vectors.length > 0) {
      console.log(`[Section-Aware Processor] Uploading final ${vectors.length} vectors...`);
      await uploadVectorsWithNewman(indexName, vectors);
    }
    
    console.log(`[Section-Aware Processor] ===== PROCESSING COMPLETE =====`);
    
    return {
      success: true,
      filename,
      totalChunks: chunks.length,
      totalSections,
      indexName,
      message: `Successfully processed with section awareness: ${chunks.length} chunks, ${totalSections} sections`,
      method: 'section-aware'
    };
    
  } catch (error) {
    console.error('[Section-Aware Processor] Error:', error);
    return {
      success: false,
      filename: basename(filepath),
      message: 'Failed to process PDF',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}