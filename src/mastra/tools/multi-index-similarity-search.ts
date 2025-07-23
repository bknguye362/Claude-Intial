import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';

const execAsync = promisify(exec);

interface SimilarityResult {
  indexName: string;
  key: string;
  score: number;
  metadata: Record<string, any>;
  content?: string;
}

export const multiIndexSimilaritySearchTool = createTool({
  id: 'multi-index-similarity-search',
  description: 'Search across multiple S3 Vector indexes to find the most similar chunks to a given query vector',
  inputSchema: z.object({
    queryVector: z.array(z.number()).describe('The query vector to search with'),
    indexPatterns: z.array(z.string()).optional().describe('Patterns to filter indexes (e.g., ["file-*", "document-*"]). If not provided, searches all indexes.'),
    topK: z.number().default(10).describe('Number of top results to return per index'),
    globalTopK: z.number().default(20).describe('Total number of top results to return across all indexes'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    results: z.array(z.object({
      indexName: z.string(),
      key: z.string(),
      score: z.number(),
      metadata: z.record(z.any()),
      content: z.string().optional(),
    })),
    searchedIndexes: z.array(z.string()),
    message: z.string(),
  }),
  execute: async ({ context }) => {
    const bucketName = process.env.S3_VECTORS_BUCKET || 'chatbotvectors362';
    const region = process.env.S3_VECTORS_REGION || 'us-east-2';
    
    let envFile: string | null = null;
    const allResults: SimilarityResult[] = [];
    const searchedIndexes: string[] = [];
    
    try {
      // Create environment file for Newman
      const envData = {
        values: [
          { key: 'AWS_ACCESS_KEY_ID', value: process.env.AWS_ACCESS_KEY_ID },
          { key: 'AWS_SECRET_ACCESS_KEY', value: process.env.AWS_SECRET_ACCESS_KEY },
          { key: 'AWS_REGION', value: region },
          { key: 'BUCKET_NAME', value: bucketName },
        ]
      };
      
      envFile = `/tmp/newman-env-multi-search-${Date.now()}.json`;
      await writeFile(envFile, JSON.stringify(envData));
      
      // Step 1: List all indexes
      console.log(`[Multi-Index Search] Listing all indexes in bucket...`);
      
      const listCollection = {
        info: {
          name: 'List All Indexes',
          schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
        },
        auth: {
          type: 'awsv4',
          awsv4: [
            { key: 'accessKey', value: '{{AWS_ACCESS_KEY_ID}}', type: 'string' },
            { key: 'secretKey', value: '{{AWS_SECRET_ACCESS_KEY}}', type: 'string' },
            { key: 'region', value: '{{AWS_REGION}}', type: 'string' },
            { key: 'service', value: 's3vectors', type: 'string' }
          ]
        },
        item: [{
          name: 'List Indexes',
          request: {
            method: 'POST',
            header: [{ key: 'Content-Type', value: 'application/json' }],
            body: {
              mode: 'raw',
              raw: JSON.stringify({
                vectorBucketName: bucketName
              })
            },
            url: {
              raw: `https://s3vectors.${region}.api.aws/ListIndexes`,
              protocol: 'https',
              host: ['s3vectors', region, 'api', 'aws'],
              path: ['ListIndexes']
            }
          }
        }]
      };
      
      const listCollectionFile = `/tmp/newman-list-collection-${Date.now()}.json`;
      await writeFile(listCollectionFile, JSON.stringify(listCollection));
      
      const listOutputFile = `/tmp/newman-list-output-${Date.now()}.json`;
      const listCommand = `npx newman run "${listCollectionFile}" --environment "${envFile}" --reporters json --reporter-json-export "${listOutputFile}"`;
      
      let indexes: string[] = [];
      
      try {
        await execAsync(listCommand);
        
        if (existsSync(listOutputFile)) {
          const outputData = await import('fs').then(fs => fs.promises.readFile(listOutputFile, 'utf-8'));
          const output = JSON.parse(outputData);
          
          const response = output.run?.executions?.[0]?.response;
          if (response && response.stream) {
            const responseBody = JSON.parse(response.stream.toString());
            if (responseBody.indexes) {
              indexes = responseBody.indexes.map((idx: any) => idx.indexName);
              console.log(`[Multi-Index Search] Found ${indexes.length} indexes`);
            }
          }
        }
      } finally {
        if (existsSync(listCollectionFile)) await unlink(listCollectionFile);
        if (existsSync(listOutputFile)) await unlink(listOutputFile);
      }
      
      // Step 2: Filter indexes based on patterns
      let targetIndexes = indexes;
      if (context.indexPatterns && context.indexPatterns.length > 0) {
        targetIndexes = indexes.filter(indexName => {
          return context.indexPatterns!.some(pattern => {
            const regex = new RegExp('^' + pattern.replace('*', '.*') + '$');
            return regex.test(indexName);
          });
        });
        console.log(`[Multi-Index Search] Filtered to ${targetIndexes.length} indexes matching patterns`);
      }
      
      // Exclude query indexes from search (we don't want to search in query indexes)
      targetIndexes = targetIndexes.filter(indexName => !indexName.startsWith('query-'));
      
      if (targetIndexes.length === 0) {
        return {
          success: false,
          results: [],
          searchedIndexes: [],
          message: 'No indexes found matching the specified patterns'
        };
      }
      
      // Step 3: Search each index
      console.log(`[Multi-Index Search] Searching ${targetIndexes.length} indexes...`);
      
      for (const indexName of targetIndexes) {
        console.log(`[Multi-Index Search] Searching index: ${indexName}`);
        
        const queryCollection = {
          info: {
            name: 'Query Vectors',
            schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
          },
          auth: {
            type: 'awsv4',
            awsv4: [
              { key: 'accessKey', value: '{{AWS_ACCESS_KEY_ID}}', type: 'string' },
              { key: 'secretKey', value: '{{AWS_SECRET_ACCESS_KEY}}', type: 'string' },
              { key: 'region', value: '{{AWS_REGION}}', type: 'string' },
              { key: 'service', value: 's3vectors', type: 'string' }
            ]
          },
          item: [{
            name: 'Query',
            request: {
              method: 'POST',
              header: [{ key: 'Content-Type', value: 'application/json' }],
              body: {
                mode: 'raw',
                raw: JSON.stringify({
                  vectorBucketName: bucketName,
                  indexName: indexName,
                  queryVector: {
                    float32: context.queryVector
                  },
                  topK: context.topK,
                  returnMetadata: true,
                  returnValues: false  // We don't need the vector values
                })
              },
              url: {
                raw: `https://s3vectors.${region}.api.aws/QueryVectors`,
                protocol: 'https',
                host: ['s3vectors', region, 'api', 'aws'],
                path: ['QueryVectors']
              }
            }
          }]
        };
        
        const queryCollectionFile = `/tmp/newman-query-collection-${Date.now()}.json`;
        await writeFile(queryCollectionFile, JSON.stringify(queryCollection));
        
        const queryOutputFile = `/tmp/newman-query-output-${Date.now()}.json`;
        const queryCommand = `npx newman run "${queryCollectionFile}" --environment "${envFile}" --reporters json --reporter-json-export "${queryOutputFile}"`;
        
        try {
          await execAsync(queryCommand);
          
          if (existsSync(queryOutputFile)) {
            const outputData = await import('fs').then(fs => fs.promises.readFile(queryOutputFile, 'utf-8'));
            const output = JSON.parse(outputData);
            
            const response = output.run?.executions?.[0]?.response;
            if (response && response.stream) {
              const responseBody = JSON.parse(response.stream.toString());
              
              if (responseBody.vectors && Array.isArray(responseBody.vectors)) {
                searchedIndexes.push(indexName);
                
                // Add results from this index
                for (const vector of responseBody.vectors) {
                  allResults.push({
                    indexName: indexName,
                    key: vector.key,
                    score: vector.score || 0,
                    metadata: vector.metadata || {},
                    content: vector.metadata?.content || vector.metadata?.text || ''
                  });
                }
              }
            }
          }
        } catch (error) {
          console.error(`[Multi-Index Search] Error searching index ${indexName}:`, error);
        } finally {
          if (existsSync(queryCollectionFile)) await unlink(queryCollectionFile);
          if (existsSync(queryOutputFile)) await unlink(queryOutputFile);
        }
      }
      
      // Step 4: Sort all results by score and take top K globally
      allResults.sort((a, b) => b.score - a.score);
      const topResults = allResults.slice(0, context.globalTopK);
      
      console.log(`[Multi-Index Search] Found ${allResults.length} total results, returning top ${topResults.length}`);
      
      return {
        success: true,
        results: topResults,
        searchedIndexes: searchedIndexes,
        message: `Successfully searched ${searchedIndexes.length} indexes and found ${topResults.length} relevant results`
      };
      
    } catch (error) {
      console.error('[Multi-Index Search] Error:', error);
      return {
        success: false,
        results: [],
        searchedIndexes: [],
        message: `Error during multi-index search: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    } finally {
      if (envFile && existsSync(envFile)) await unlink(envFile);
    }
  },
});