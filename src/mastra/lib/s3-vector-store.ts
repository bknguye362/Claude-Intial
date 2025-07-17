// S3-based vector storage for PDF embeddings
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Readable } from 'stream';

// Initialize S3 client
const s3Client = process.env.AWS_S3_BUCKET ? new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? {
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
  } : {})
}) : null;

const VECTOR_BUCKET = process.env.AWS_S3_VECTOR_BUCKET || process.env.AWS_S3_BUCKET;
const VECTOR_PREFIX = 'pdf-embeddings/';

export interface VectorDocument {
  id: string;
  content: string;
  embedding: number[];
  metadata?: {
    filename?: string;
    pageStart?: number;
    pageEnd?: number;
    chunkIndex?: number;
    totalChunks?: number;
  };
}

export interface VectorIndex {
  documentId: string;
  chunks: VectorDocument[];
  metadata: {
    filename: string;
    totalChunks: number;
    dimensions: number;
    createdAt: string;
    pages?: number;
  };
}

// Helper to convert stream to string
async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// Store embeddings for a PDF document
export async function storeEmbeddings(documentId: string, chunks: VectorDocument[], metadata: any): Promise<boolean> {
  if (!s3Client || !VECTOR_BUCKET) {
    console.log('[S3 Vector Store] S3 not configured, falling back to memory storage');
    return false;
  }

  try {
    const vectorIndex: VectorIndex = {
      documentId,
      chunks,
      metadata: {
        filename: metadata.filename || documentId,
        totalChunks: chunks.length,
        dimensions: chunks[0]?.embedding?.length || 1536,
        createdAt: new Date().toISOString(),
        pages: metadata.pages,
      }
    };

    // Store the vector index
    const key = `${VECTOR_PREFIX}${documentId}.json`;
    const putCommand = new PutObjectCommand({
      Bucket: VECTOR_BUCKET,
      Key: key,
      Body: JSON.stringify(vectorIndex),
      ContentType: 'application/json',
      Metadata: {
        'document-id': documentId,
        'total-chunks': String(chunks.length),
        'filename': metadata.filename || '',
      }
    });

    await s3Client.send(putCommand);
    console.log(`[S3 Vector Store] Stored ${chunks.length} embeddings for document: ${documentId}`);
    return true;
  } catch (error) {
    console.error('[S3 Vector Store] Error storing embeddings:', error);
    return false;
  }
}

// Retrieve embeddings for a PDF document
export async function retrieveEmbeddings(documentId: string): Promise<VectorIndex | null> {
  if (!s3Client || !VECTOR_BUCKET) {
    console.log('[S3 Vector Store] S3 not configured');
    return null;
  }

  try {
    const key = `${VECTOR_PREFIX}${documentId}.json`;
    const getCommand = new GetObjectCommand({
      Bucket: VECTOR_BUCKET,
      Key: key,
    });

    const response = await s3Client.send(getCommand);
    if (response.Body) {
      const data = await streamToString(response.Body as Readable);
      const vectorIndex = JSON.parse(data) as VectorIndex;
      console.log(`[S3 Vector Store] Retrieved ${vectorIndex.chunks.length} embeddings for document: ${documentId}`);
      return vectorIndex;
    }
    return null;
  } catch (error: any) {
    if (error.Code === 'NoSuchKey') {
      console.log(`[S3 Vector Store] No embeddings found for document: ${documentId}`);
    } else {
      console.error('[S3 Vector Store] Error retrieving embeddings:', error);
    }
    return null;
  }
}

// Delete embeddings for a PDF document
export async function deleteEmbeddings(documentId: string): Promise<boolean> {
  if (!s3Client || !VECTOR_BUCKET) {
    return false;
  }

  try {
    const key = `${VECTOR_PREFIX}${documentId}.json`;
    const deleteCommand = new DeleteObjectCommand({
      Bucket: VECTOR_BUCKET,
      Key: key,
    });

    await s3Client.send(deleteCommand);
    console.log(`[S3 Vector Store] Deleted embeddings for document: ${documentId}`);
    return true;
  } catch (error) {
    console.error('[S3 Vector Store] Error deleting embeddings:', error);
    return false;
  }
}

// List all stored vector documents
export async function listVectorDocuments(): Promise<string[]> {
  if (!s3Client || !VECTOR_BUCKET) {
    return [];
  }

  try {
    const listCommand = new ListObjectsV2Command({
      Bucket: VECTOR_BUCKET,
      Prefix: VECTOR_PREFIX,
    });

    const response = await s3Client.send(listCommand);
    const documents = response.Contents?.map(obj => {
      const key = obj.Key || '';
      return key.replace(VECTOR_PREFIX, '').replace('.json', '');
    }).filter(id => id.length > 0) || [];

    console.log(`[S3 Vector Store] Found ${documents.length} vector documents`);
    return documents;
  } catch (error) {
    console.error('[S3 Vector Store] Error listing documents:', error);
    return [];
  }
}

// Cosine similarity function (same as before)
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length) {
    throw new Error('Vectors must have the same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (normA * normB);
}

// Search for similar chunks across all documents
export async function searchSimilarChunks(queryEmbedding: number[], topK: number = 5): Promise<Array<VectorDocument & { score: number, documentId: string }>> {
  const allDocuments = await listVectorDocuments();
  const results: Array<VectorDocument & { score: number, documentId: string }> = [];

  for (const documentId of allDocuments) {
    const vectorIndex = await retrieveEmbeddings(documentId);
    if (vectorIndex) {
      for (const chunk of vectorIndex.chunks) {
        if (chunk.embedding) {
          const score = cosineSimilarity(queryEmbedding, chunk.embedding);
          results.push({
            ...chunk,
            score,
            documentId
          });
        }
      }
    }
  }

  // Sort by score and return top K
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}