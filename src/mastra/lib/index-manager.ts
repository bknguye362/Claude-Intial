// Index management utilities for S3 Vectors
import { listIndicesWithNewman } from './newman-executor.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const newman = require('newman');
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Execute a Newman request
async function runNewmanRequest(requestName: string, envOverrides: Record<string, string> = {}): Promise<{ success: boolean; response?: any; error?: string }> {
  return new Promise((resolve) => {
    const collectionPath = join(__dirname, '..', 'postman-s3-vectors.json');
    
    // Base environment
    const environment = {
      values: [
        { key: 'AWS_ACCESS_KEY_ID', value: process.env.AWS_ACCESS_KEY_ID || '', enabled: true },
        { key: 'AWS_SECRET_ACCESS_KEY', value: process.env.AWS_SECRET_ACCESS_KEY || '', enabled: true },
        { key: 'AWS_SESSION_TOKEN', value: process.env.AWS_SESSION_TOKEN || '', enabled: true },
        { key: 'AWS_REGION', value: process.env.AWS_REGION || 'us-east-2', enabled: true },
        { key: 'BUCKET_NAME', value: process.env.S3_VECTORS_BUCKET || 'chatbotvectors362', enabled: true },
        ...Object.entries(envOverrides).map(([key, value]) => ({ key, value, enabled: true }))
      ]
    };
    
    newman.run({
      collection: require(collectionPath),
      environment,
      reporters: ['cli'],
      reporter: { cli: { silent: true } }
    }, (err: any, summary: any) => {
      if (err) {
        resolve({ success: false, error: err.message });
        return;
      }
      
      // Find the specific request execution
      let foundExecution: any = null;
      for (const execution of summary.run.executions || []) {
        if (execution.item && execution.item.name === requestName) {
          foundExecution = execution;
          break;
        }
      }
      
      if (foundExecution && foundExecution.response) {
        try {
          const responseBody = foundExecution.response.stream.toString();
          const responseData = responseBody ? JSON.parse(responseBody) : {};
          resolve({ success: true, response: responseData });
        } catch (e) {
          // Not JSON response, but request was successful
          resolve({ success: true });
        }
      } else {
        resolve({ success: false, error: 'Request not found or failed' });
      }
    });
  });
}

// Delete a specific index
export async function deleteIndex(indexName: string): Promise<boolean> {
  console.log(`[Index Manager] Deleting index: ${indexName}`);
  
  try {
    const result = await runNewmanRequest('Delete Index', {
      INDEX_NAME: indexName
    });
    
    if (result.success) {
      console.log(`[Index Manager] ✅ Successfully deleted index: ${indexName}`);
      return true;
    } else {
      console.error(`[Index Manager] ❌ Failed to delete index: ${indexName}`, result.error);
      return false;
    }
  } catch (error) {
    console.error(`[Index Manager] Error deleting index ${indexName}:`, error);
    return false;
  }
}

// Delete all indices
export async function deleteAllIndices(): Promise<{
  total: number;
  deleted: number;
  failed: string[];
}> {
  console.log(`[Index Manager] ===== DELETING ALL INDICES =====`);
  
  try {
    // Use existing function to list indices
    const indices = await listIndicesWithNewman();
    console.log(`[Index Manager] Found ${indices.length} indices to delete`);
    
    const failed: string[] = [];
    let deleted = 0;
    
    // Delete each index
    for (const index of indices) {
      console.log(`[Index Manager] Deleting ${index}...`);
      const success = await deleteIndex(index);
      
      if (success) {
        deleted++;
      } else {
        failed.push(index);
      }
      
      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log(`[Index Manager] ===== DELETION COMPLETE =====`);
    console.log(`[Index Manager] Total: ${indices.length}, Deleted: ${deleted}, Failed: ${failed.length}`);
    
    return {
      total: indices.length,
      deleted,
      failed
    };
    
  } catch (error) {
    console.error('[Index Manager] Error in deleteAllIndices:', error);
    return { total: 0, deleted: 0, failed: [] };
  }
}

// Delete indices matching a pattern
export async function deleteIndicesByPattern(pattern: string | RegExp): Promise<{
  total: number;
  deleted: number;
  failed: string[];
}> {
  console.log(`[Index Manager] Deleting indices matching pattern: ${pattern}`);
  
  try {
    const allIndices = await listIndicesWithNewman();
    const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
    const matchingIndices = allIndices.filter(index => regex.test(index));
    
    console.log(`[Index Manager] Found ${matchingIndices.length} indices matching pattern`);
    
    const failed: string[] = [];
    let deleted = 0;
    
    for (const index of matchingIndices) {
      console.log(`[Index Manager] Deleting ${index}...`);
      const success = await deleteIndex(index);
      
      if (success) {
        deleted++;
      } else {
        failed.push(index);
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    return {
      total: matchingIndices.length,
      deleted,
      failed
    };
    
  } catch (error) {
    console.error('[Index Manager] Error in deleteIndicesByPattern:', error);
    return { total: 0, deleted: 0, failed: [] };
  }
}

// Get index info
export async function getIndexInfo(indexName: string): Promise<{
  exists: boolean;
  vectorCount?: number;
  dimension?: number;
  error?: string;
}> {
  try {
    const result = await runNewmanRequest('Describe Index', {
      INDEX_NAME: indexName
    });
    
    if (result.success && result.response) {
      return {
        exists: true,
        vectorCount: result.response.vectorCount || 0,
        dimension: result.response.dimension || 1536
      };
    } else {
      return {
        exists: false,
        error: result.error || 'Index not found'
      };
    }
  } catch (error) {
    return {
      exists: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

// List all indices with details
export async function listIndicesWithDetails(): Promise<Array<{
  name: string;
  vectorCount?: number;
  dimension?: number;
}>> {
  try {
    const indices = await listIndicesWithNewman();
    const details = [];
    
    // Get details for each index
    for (const indexName of indices) {
      const info = await getIndexInfo(indexName);
      details.push({
        name: indexName,
        vectorCount: info.vectorCount,
        dimension: info.dimension
      });
      
      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    return details;
  } catch (error) {
    console.error('[Index Manager] Error listing indices with details:', error);
    return [];
  }
}