// Worker configuration for handling long-running tasks
// This helps prevent timeouts by processing tasks asynchronously

export const WORKER_CONFIG = {
  // Maximum time for a single operation (in ms)
  MAX_PROCESSING_TIME: 20000, // 20 seconds
  
  // Chunk processing settings
  CHUNK_SIZE: 500, // Smaller chunks for faster processing
  MAX_CHUNKS_PER_BATCH: 10, // Process in batches to avoid memory issues
  
  // Retry settings
  MAX_RETRIES: 2,
  RETRY_DELAY: 1000, // 1 second
  
  // Timeout prevention
  KEEP_ALIVE_INTERVAL: 10000, // Send keep-alive every 10 seconds
  REQUEST_TIMEOUT: 25000, // 25 seconds (under Heroku's 30s limit)
};

// Helper to check if we're approaching timeout
export function isApproachingTimeout(startTime: number): boolean {
  const elapsed = Date.now() - startTime;
  return elapsed > WORKER_CONFIG.MAX_PROCESSING_TIME;
}

// Helper to send keep-alive signal
export function startKeepAlive(res: any): NodeJS.Timeout {
  return setInterval(() => {
    try {
      res.write(' '); // Send space to keep connection alive
    } catch (e) {
      // Connection might be closed
    }
  }, WORKER_CONFIG.KEEP_ALIVE_INTERVAL);
}