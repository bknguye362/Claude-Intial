import { IncomingMessage, ServerResponse } from 'http';
import { getProcessingStatus } from '../lib/pdf-processor-streaming.js';

export async function checkPDFStatus(req: IncomingMessage & { params?: any }, res: ServerResponse) {
  const { statusId } = req.params || {};
  
  if (!statusId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Status ID is required' }));
    return;
  }
  
  const status = getProcessingStatus(statusId);
  
  if (!status) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Status not found' }));
    return;
  }
  
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    statusId,
    status: status.status,
    progress: status.progress,
    totalChunks: status.totalChunks,
    processedChunks: status.processedChunks,
    indexName: status.indexName,
    error: status.error,
    startTime: status.startTime,
    lastUpdate: status.lastUpdate,
    elapsedSeconds: Math.round((status.lastUpdate.getTime() - status.startTime.getTime()) / 1000)
  }));
}