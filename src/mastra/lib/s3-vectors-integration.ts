// S3 Vectors integration for the Mastra chatbot
// Uses the new S3 Vectors service for efficient vector storage and search

import { exec } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import { s3VectorsLogger } from './s3-vectors-persistent-logger';

const execAsync = promisify(exec);

export interface S3VectorDocument {
  id: string;
  content: string;
  embedding: number[];
  metadata?: {
    filename?: string;
    pageStart?: number;
    pageEnd?: number;
    chunkIndex?: number;
    totalChunks?: number;
    documentId?: string;
    timestamp?: string;
  };
}

export class S3VectorsService {
  private bucketName: string;
  private indexName: string;
  private region: string;
  private dimensions: number;
  private awsPath: string;

  constructor(
    bucketName: string = process.env.AWS_S3_VECTOR_BUCKET || 'chatbotvectors362',
    indexName: string = 'mastra-chatbot',
    region: string = process.env.AWS_REGION || 'us-east-2',
    dimensions: number = 1536 // OpenAI embeddings dimension
  ) {
    this.bucketName = bucketName;
    this.indexName = indexName;
    this.region = region;
    this.dimensions = dimensions;
    this.awsPath = process.env.AWS_CLI_PATH || '~/.local/bin/aws';
  }

  // Initialize the vector index
  async initialize(): Promise<void> {
    try {
      console.log(`[S3 Vectors] Initializing index '${this.indexName}'...`);
      
      // Check if index exists by trying to get it
      const getCommand = `${this.awsPath} s3vectors get-index --vector-bucket-name ${this.bucketName} --index-name ${this.indexName} --region ${this.region}`;
      
      try {
        await execAsync(getCommand);
        console.log(`[S3 Vectors] Index '${this.indexName}' already exists`);
      } catch (error: any) {
        if (error.message.includes('NotFoundException')) {
          // Create the index
          const createCommand = `${this.awsPath} s3vectors create-index --vector-bucket-name ${this.bucketName} --index-name ${this.indexName} --dimension ${this.dimensions} --distance-metric cosine --data-type float32 --region ${this.region}`;
          await execAsync(createCommand);
          console.log(`[S3 Vectors] Created index '${this.indexName}'`);
        } else {
          throw error;
        }
      }
    } catch (error) {
      console.error('[S3 Vectors] Initialization error:', error);
      throw error;
    }
  }

  // Store a single document embedding
  async storeEmbedding(document: S3VectorDocument): Promise<{ action: 'created' | 'updated', key: string }> {
    try {
      // First, try to check if vector already exists
      let existingVector = false;
      try {
        const checkCommand = `${this.awsPath} s3vectors get-vectors --vector-bucket-name ${this.bucketName} --index-name ${this.indexName} --keys ${document.id} --region ${this.region}`;
        const { stdout } = await execAsync(checkCommand);
        const result = JSON.parse(stdout);
        existingVector = result.vectors && result.vectors.length > 0;
      } catch (error) {
        // Vector doesn't exist yet
        existingVector = false;
      }

      const vectorData = {
        key: document.id,
        data: {
          float32: document.embedding
        },
        metadata: {
          content: document.content.substring(0, 1000), // Limit content size
          ...document.metadata,
          lastUpdated: new Date().toISOString()
        }
      };

      // Save to temp file
      const fs = require('fs').promises;
      const tempFile = `/tmp/vector-${Date.now()}.json`;
      await fs.writeFile(tempFile, JSON.stringify([vectorData]));

      const command = `${this.awsPath} s3vectors put-vectors --vector-bucket-name ${this.bucketName} --index-name ${this.indexName} --vectors file://${tempFile} --region ${this.region}`;
      await execAsync(command);
      
      // Clean up temp file
      await fs.unlink(tempFile);
      
      const action = existingVector ? 'updated' : 'created';
      console.log(`[S3 Vectors] ${action.toUpperCase()} embedding: ${document.id}`);
      
      s3VectorsLogger.log('storeEmbedding', {
        action,
        documentId: document.id,
        filename: document.metadata?.filename
      });
      
      return { action, key: document.id };
    } catch (error) {
      console.error('[S3 Vectors] Error storing embedding:', error);
      s3VectorsLogger.log('storeEmbedding', {
        documentId: document.id,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, false);
      throw error;
    }
  }

  // Store multiple embeddings (batch)
  async storeEmbeddings(documents: S3VectorDocument[]): Promise<{ created: number, updated: number, total: number }> {
    console.log(`[S3 Vectors] Storing ${documents.length} embeddings...`);
    
    let created = 0;
    let updated = 0;
    
    // First, check which vectors already exist
    const existingKeys = new Set<string>();
    try {
      const listCommand = `${this.awsPath} s3vectors list-vectors --vector-bucket-name ${this.bucketName} --index-name ${this.indexName} --region ${this.region}`;
      const { stdout } = await execAsync(listCommand);
      const result = JSON.parse(stdout);
      if (result.vectors) {
        result.vectors.forEach((v: any) => existingKeys.add(v.key));
      }
    } catch (error) {
      console.log('[S3 Vectors] Could not list existing vectors, assuming all are new');
    }
    
    // S3 Vectors might have batch limits, so process in chunks
    const batchSize = 25;
    for (let i = 0; i < documents.length; i += batchSize) {
      const batch = documents.slice(i, i + batchSize);
      
      // Count new vs existing in this batch
      const batchNew = batch.filter(doc => !existingKeys.has(doc.id)).length;
      const batchExisting = batch.length - batchNew;
      
      const vectorData = batch.map(doc => ({
        key: doc.id,
        data: {
          float32: doc.embedding
        },
        metadata: {
          content: doc.content.substring(0, 1000),
          ...doc.metadata,
          lastUpdated: new Date().toISOString()
        }
      }));

      const fs = require('fs').promises;
      const tempFile = `/tmp/vectors-batch-${Date.now()}.json`;
      await fs.writeFile(tempFile, JSON.stringify(vectorData));

      try {
        const command = `${this.awsPath} s3vectors put-vectors --vector-bucket-name ${this.bucketName} --index-name ${this.indexName} --vectors file://${tempFile} --region ${this.region}`;
        await execAsync(command);
        
        created += batchNew;
        updated += batchExisting;
        
        console.log(`[S3 Vectors] Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(documents.length / batchSize)}: ${batchNew} new, ${batchExisting} updated`);
      } catch (error) {
        console.error(`[S3 Vectors] Error storing batch:`, error);
      } finally {
        await fs.unlink(tempFile);
      }
    }
    
    console.log(`[S3 Vectors] Summary: ${created} created, ${updated} updated, ${documents.length} total`);
    
    s3VectorsLogger.log('storeBatch', {
      chunksCreated: created,
      chunksUpdated: updated,
      totalChunks: documents.length
    });
    
    return { created, updated, total: documents.length };
  }

  // Search for similar vectors
  async searchSimilar(queryEmbedding: number[], topK: number = 5, filter?: Record<string, any>): Promise<Array<{ key: string; score?: number; metadata?: any }>> {
    try {
      const queryData = {
        queryVector: {
          float32: queryEmbedding
        },
        topK: topK
      };

      if (filter) {
        (queryData as any).filter = filter;
      }

      const fs = require('fs').promises;
      const tempFile = `/tmp/query-${Date.now()}.json`;
      await fs.writeFile(tempFile, JSON.stringify(queryData));

      const command = `${this.awsPath} s3vectors query-vectors --vector-bucket-name ${this.bucketName} --index-name ${this.indexName} --cli-input-json file://${tempFile} --region ${this.region}`;
      const { stdout } = await execAsync(command);
      
      await fs.unlink(tempFile);
      
      const result = JSON.parse(stdout);
      const vectors = result.vectors || [];
      
      s3VectorsLogger.log('search', {
        searchQuery: 'embedding search',
        resultsFound: vectors.length
      });
      
      return vectors;
    } catch (error) {
      console.error('[S3 Vectors] Error searching:', error);
      return [];
    }
  }

  // Store PDF embeddings with S3 Vectors
  async storePDFEmbeddings(
    documentId: string,
    chunks: Array<{ content: string; embedding: number[]; metadata?: any }>,
    filename: string
  ): Promise<{ created: number, updated: number, total: number }> {
    const documents: S3VectorDocument[] = chunks.map((chunk, index) => ({
      id: `${documentId}-chunk-${index}`,
      content: chunk.content,
      embedding: chunk.embedding,
      metadata: {
        documentId,
        filename,
        chunkIndex: index,
        totalChunks: chunks.length,
        timestamp: new Date().toISOString(),
        ...chunk.metadata
      }
    }));

    const stats = await this.storeEmbeddings(documents);
    console.log(`[S3 Vectors] Document "${filename}": ${stats.created} new chunks, ${stats.updated} updated chunks, ${stats.total} total`);
    
    s3VectorsLogger.log('storePDFEmbeddings', {
      documentId,
      filename,
      chunksCreated: stats.created,
      chunksUpdated: stats.updated,
      totalChunks: stats.total
    });
    
    return stats;
  }

  // Search across all PDF documents
  async searchPDFContent(queryEmbedding: number[], topK: number = 5): Promise<Array<{
    content: string;
    score?: number;
    documentId?: string;
    filename?: string;
    chunkIndex?: number;
  }>> {
    const results = await this.searchSimilar(queryEmbedding, topK);
    
    // Map results to include content from metadata
    return results.map(result => ({
      content: result.metadata?.content || '',
      score: result.score,
      documentId: result.metadata?.documentId,
      filename: result.metadata?.filename,
      chunkIndex: result.metadata?.chunkIndex
    }));
  }

  // Delete all embeddings for a document
  async deleteDocumentEmbeddings(documentId: string): Promise<void> {
    try {
      // List all vectors with the documentId prefix
      const listCommand = `${this.awsPath} s3vectors list-vectors --vector-bucket-name ${this.bucketName} --index-name ${this.indexName} --region ${this.region}`;
      const { stdout } = await execAsync(listCommand);
      const allVectors = JSON.parse(stdout).vectors || [];
      
      // Filter vectors for this document
      const documentVectors = allVectors.filter((v: any) => v.key.startsWith(`${documentId}-chunk-`));
      
      if (documentVectors.length > 0) {
        // Delete in batches
        const batchSize = 25;
        for (let i = 0; i < documentVectors.length; i += batchSize) {
          const batch = documentVectors.slice(i, i + batchSize);
          const keys = batch.map((v: any) => v.key).join(' ');
          
          const deleteCommand = `${this.awsPath} s3vectors delete-vectors --vector-bucket-name ${this.bucketName} --index-name ${this.indexName} --keys ${keys} --region ${this.region}`;
          await execAsync(deleteCommand);
        }
        
        console.log(`[S3 Vectors] Deleted ${documentVectors.length} vectors for document: ${documentId}`);
      }
    } catch (error) {
      console.error('[S3 Vectors] Error deleting document embeddings:', error);
    }
  }
}

// Singleton instance
let s3VectorsInstance: S3VectorsService | null = null;

export function getS3VectorsService(): S3VectorsService {
  if (!s3VectorsInstance) {
    s3VectorsInstance = new S3VectorsService();
  }
  return s3VectorsInstance;
}

// Migration helper: Convert from old S3 storage to S3 Vectors
export async function migrateToS3Vectors(oldVectorIndex: any): Promise<void> {
  const service = getS3VectorsService();
  await service.initialize();
  
  const documents: S3VectorDocument[] = oldVectorIndex.chunks.map((chunk: any) => ({
    id: chunk.id || `${oldVectorIndex.documentId}-chunk-${chunk.metadata?.chunkIndex || 0}`,
    content: chunk.content,
    embedding: chunk.embedding,
    metadata: {
      ...chunk.metadata,
      documentId: oldVectorIndex.documentId,
      filename: oldVectorIndex.metadata.filename,
      migratedAt: new Date().toISOString()
    }
  }));
  
  await service.storeEmbeddings(documents);
  console.log(`[S3 Vectors] Migrated ${documents.length} embeddings for document: ${oldVectorIndex.documentId}`);
}