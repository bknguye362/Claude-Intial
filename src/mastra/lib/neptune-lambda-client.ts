import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

// Lambda function configuration
const LAMBDA_FUNCTION_NAME = 'chatbotRAG';
const AWS_REGION = process.env.AWS_REGION || 'us-east-2';

// Initialize Lambda client
const lambdaClient = new LambdaClient({
  region: AWS_REGION,
  credentials: process.env.AWS_ACCESS_KEY_ID ? {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!
  } : undefined
});

export interface NeptuneNode {
  id: string;
  label: string;
  properties: Record<string, any>;
}

export interface NeptuneEdge {
  id: string;
  label: string;
  from: string;
  to: string;
  properties: Record<string, any>;
}

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  documentCount: number;
  chunkCount: number;
}

// Helper function to invoke Lambda
async function invokeLambda(payload: any): Promise<any> {
  try {
    console.log('[Neptune Lambda] Invoking Lambda with payload:', payload);
    
    const command = new InvokeCommand({
      FunctionName: LAMBDA_FUNCTION_NAME,
      Payload: JSON.stringify(payload)
    });
    
    const response = await lambdaClient.send(command);
    
    if (response.Payload) {
      const result = JSON.parse(new TextDecoder().decode(response.Payload));
      
      if (result.errorMessage) {
        throw new Error(result.errorMessage);
      }
      
      return result;
    }
    
    throw new Error('No payload in Lambda response');
  } catch (error) {
    console.error('[Neptune Lambda] Error invoking Lambda:', error);
    throw error;
  }
}

// Create a document node in Neptune
export async function createDocumentNode(
  documentId: string,
  metadata: Record<string, any>
): Promise<boolean> {
  // TEMPORARY: Lambda createDocumentGraph has a bug - it tries to access .length on undefined
  // This is a Lambda function issue that needs to be fixed on the AWS side
  console.warn(`[Neptune Lambda] SKIPPING document node creation for ${documentId} - Lambda bug`);
  console.warn('[Neptune Lambda] Lambda createDocumentGraph operation has a bug accessing .length on undefined');
  console.warn('[Neptune Lambda] Document metadata would have been:', metadata);
  
  // Return true to allow the rest of the pipeline to continue
  // S3 Vectors will still work even without Neptune graph
  return true;
  
  /* Original code commented out until Lambda is fixed:
  try {
    console.log(`[Neptune Lambda] Creating document node: ${documentId}`);
    
    const result = await invokeLambda({
      operation: 'createDocumentGraph',
      documentId,
      metadata
    });
    
    console.log('[Neptune Lambda] Document node created:', result);
    return true;
  } catch (error) {
    console.error('[Neptune Lambda] Error creating document node:', error);
    return false;
  }
  */
}

// Create a chunk node in Neptune
export async function createChunkNode(
  chunkId: string,
  documentId: string,
  chunkIndex: number,
  content: string,
  summary?: string,
  metadata?: Record<string, any>
): Promise<boolean> {
  // TEMPORARY: Lambda createChunkGraph has a bug - it tries to access .length on undefined
  // This is a Lambda function issue that needs to be fixed on the AWS side
  if (chunkIndex === 0) {
    console.warn(`[Neptune Lambda] SKIPPING chunk node creation for document ${documentId} - Lambda bug`);
    console.warn('[Neptune Lambda] Lambda createChunkGraph operation has a bug accessing .length on undefined');
  }
  
  // Return true to allow the rest of the pipeline to continue
  // S3 Vectors will still work even without Neptune graph
  return true;
  
  /* Original code commented out until Lambda is fixed:
  try {
    console.log(`[Neptune Lambda] Creating chunk node: ${chunkId}`);
    
    const result = await invokeLambda({
      operation: 'createChunkGraph',
      chunkId,
      documentId,
      chunkIndex,
      content: content.substring(0, 1000), // Limit content size
      summary,
      metadata
    });
    
    console.log('[Neptune Lambda] Chunk node created:', result);
    return true;
  } catch (error) {
    console.error('[Neptune Lambda] Error creating chunk node:', error);
    return false;
  }
  */
}

// Create relationships between chunks
export async function createChunkRelationships(
  chunkId: string,
  relatedChunks: Array<{ id: string; relationship: string; strength: number }>
): Promise<boolean> {
  try {
    console.log(`[Neptune Lambda] Creating relationships for chunk: ${chunkId}`);
    
    const result = await invokeLambda({
      operation: 'createRelationships',
      chunkId,
      relationships: relatedChunks
    });
    
    console.log('[Neptune Lambda] Relationships created:', result);
    return true;
  } catch (error) {
    console.error('[Neptune Lambda] Error creating relationships:', error);
    return false;
  }
}

// Query the knowledge graph
export async function queryGraph(
  query: string,
  limit: number = 10
): Promise<any[]> {
  try {
    console.log(`[Neptune Lambda] Querying graph: "${query}"`);
    
    const result = await invokeLambda({
      operation: 'query',
      query,
      limit
    });
    
    console.log(`[Neptune Lambda] Query returned ${result.results?.length || 0} results`);
    return result.results || [];
  } catch (error) {
    console.error('[Neptune Lambda] Error querying graph:', error);
    return [];
  }
}

// Get graph statistics
export async function getGraphStats(): Promise<GraphStats | null> {
  try {
    console.log('[Neptune Lambda] Getting graph statistics');
    
    const result = await invokeLambda({
      operation: 'stats'
    });
    
    console.log('[Neptune Lambda] Graph stats:', result);
    return result;
  } catch (error) {
    console.error('[Neptune Lambda] Error getting graph stats:', error);
    return null;
  }
}

// Explore the graph structure
export async function exploreGraph(): Promise<any> {
  try {
    console.log('[Neptune Lambda] Exploring graph structure');
    
    const result = await invokeLambda({
      operation: 'explore'
    });
    
    console.log('[Neptune Lambda] Graph exploration:', result);
    return result;
  } catch (error) {
    console.error('[Neptune Lambda] Error exploring graph:', error);
    return null;
  }
}

// Find related chunks using graph traversal
export async function findRelatedChunks(
  chunkId: string,
  maxDepth: number = 2
): Promise<string[]> {
  try {
    console.log(`[Neptune Lambda] Finding chunks related to: ${chunkId}`);
    
    const result = await invokeLambda({
      operation: 'findRelated',
      chunkId,
      maxDepth
    });
    
    console.log(`[Neptune Lambda] Found ${result.relatedChunks?.length || 0} related chunks`);
    return result.relatedChunks || [];
  } catch (error) {
    console.error('[Neptune Lambda] Error finding related chunks:', error);
    return [];
  }
}