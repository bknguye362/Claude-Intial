// Shared types for contextualization

export interface ChunkContext {
  documentId: string;
  pageStart?: number;
  pageEnd?: number;
  chunkIndex?: number;
  totalChunks?: number;
  timestamp?: string;
  pageReference?: string;
  citation?: string;
}

export interface DocumentSummary {
  documentId: string;
  relevantChunks: number;
  relevantPages: number[];
  pageRanges: string;
  chunkIndices: number[];
  averageScore: number;
}