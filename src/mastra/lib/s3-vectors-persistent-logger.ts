// S3 Vectors Persistent Logger
// Stores operation logs to disk so they persist across executions

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface S3VectorLog {
  timestamp: string;
  operation: string;
  details: {
    action?: 'created' | 'updated';
    documentId?: string;
    filename?: string;
    indexName?: string;
    chunksCreated?: number;
    chunksUpdated?: number;
    chunksStored?: number;
    totalChunks?: number;
    searchQuery?: string;
    resultsFound?: number;
    error?: string;
  };
  success: boolean;
}

class S3VectorsPersistentLogger {
  private logFile: string;
  private maxLogs: number = 500;
  private logs: S3VectorLog[] = [];

  constructor() {
    // Store logs in the uploads directory which persists
    this.logFile = join(process.cwd(), 'src', 'mastra', 'uploads', 's3-vectors-logs.json');
    this.loadLogs();
  }

  private loadLogs() {
    try {
      if (existsSync(this.logFile)) {
        const data = readFileSync(this.logFile, 'utf-8');
        this.logs = JSON.parse(data);
        console.log(`[S3 Vectors Logger] Loaded ${this.logs.length} existing logs`);
      } else {
        console.log('[S3 Vectors Logger] No existing logs found, starting fresh');
        this.logs = [];
        this.saveLogs();
      }
    } catch (error) {
      console.error('[S3 Vectors Logger] Error loading logs:', error);
      this.logs = [];
    }
  }

  private saveLogs() {
    try {
      writeFileSync(this.logFile, JSON.stringify(this.logs, null, 2));
    } catch (error) {
      console.error('[S3 Vectors Logger] Error saving logs:', error);
    }
  }

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

    // Save to disk
    this.saveLogs();

    // Also log to console
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
    this.saveLogs();
  }
}

// Create singleton that persists
let loggerInstance: S3VectorsPersistentLogger | null = null;

export function getS3VectorsLogger(): S3VectorsPersistentLogger {
  if (!loggerInstance) {
    loggerInstance = new S3VectorsPersistentLogger();
  }
  return loggerInstance;
}

// Export for backward compatibility
export const s3VectorsLogger = getS3VectorsLogger();