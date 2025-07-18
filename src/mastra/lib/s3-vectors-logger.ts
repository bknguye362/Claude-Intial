// S3 Vectors Operation Logger
// Stores operation logs that can be retrieved through the chatbot

export interface S3VectorLog {
  timestamp: string;
  operation: string;
  details: {
    action?: 'created' | 'updated';
    documentId?: string;
    filename?: string;
    chunksCreated?: number;
    chunksUpdated?: number;
    totalChunks?: number;
    searchQuery?: string;
    resultsFound?: number;
    error?: string;
  };
  success: boolean;
}

class S3VectorsLogger {
  private logs: S3VectorLog[] = [];
  private maxLogs: number = 100;

  log(operation: string, details: S3VectorLog['details'], success: boolean = true) {
    const logEntry: S3VectorLog = {
      timestamp: new Date().toISOString(),
      operation,
      details,
      success
    };

    this.logs.unshift(logEntry); // Add to beginning
    
    // Keep only recent logs
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(0, this.maxLogs);
    }

    // Also log to console for debugging
    const logMessage = `[S3 Vectors ${success ? '✓' : '✗'}] ${operation}: ${JSON.stringify(details)}`;
    if (success) {
      console.log(logMessage);
    } else {
      console.error(logMessage);
    }
  }

  getRecentLogs(limit: number = 10): S3VectorLog[] {
    return this.logs.slice(0, limit);
  }

  getLogsSince(since: Date): S3VectorLog[] {
    return this.logs.filter(log => new Date(log.timestamp) > since);
  }

  getLogsByDocument(documentId: string): S3VectorLog[] {
    return this.logs.filter(log => log.details.documentId === documentId);
  }

  getSummary(): {
    totalOperations: number;
    successfulOperations: number;
    failedOperations: number;
    recentDocuments: string[];
    operationCounts: Record<string, number>;
  } {
    const summary = {
      totalOperations: this.logs.length,
      successfulOperations: this.logs.filter(l => l.success).length,
      failedOperations: this.logs.filter(l => !l.success).length,
      recentDocuments: [] as string[],
      operationCounts: {} as Record<string, number>
    };

    // Get unique recent documents
    const docSet = new Set<string>();
    this.logs.forEach(log => {
      if (log.details.documentId) {
        docSet.add(log.details.documentId);
      }
      if (log.details.filename) {
        docSet.add(log.details.filename);
      }
      
      // Count operations
      summary.operationCounts[log.operation] = (summary.operationCounts[log.operation] || 0) + 1;
    });
    
    summary.recentDocuments = Array.from(docSet).slice(0, 10);
    
    return summary;
  }

  clear() {
    this.logs = [];
  }
}

// Singleton instance
export const s3VectorsLogger = new S3VectorsLogger();