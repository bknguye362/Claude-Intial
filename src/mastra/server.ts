import { createServer } from 'http';
import { handleRequest } from './api-endpoint.js';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { existsSync } from 'fs';
import { randomBytes } from 'crypto';
// S3 imports removed - using local storage only

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = join(__dirname, 'uploads');

// S3 Configuration - DISABLED, always use local storage
const USE_S3 = false; // Always use local storage, even on Heroku
const s3Client = null; // No S3 client needed

// Ensure upload directory exists (always create it)
if (!existsSync(UPLOAD_DIR)) {
  await mkdir(UPLOAD_DIR, { recursive: true });
  console.log(`Created uploads directory at: ${UPLOAD_DIR}`);
}

// Parse multipart form data
async function parseMultipartData(req: any, boundary: string): Promise<{ fields: any, files: any[] }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const fields: any = {};
    const files: any[] = [];

    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const parts = buffer.toString('binary').split(`--${boundary}`);

      for (const part of parts) {
        if (part.includes('Content-Disposition')) {
          const contentDisposition = part.match(/Content-Disposition: (.+)/)?.[1] || '';
          const nameMatch = contentDisposition.match(/name="([^"]+)"/);
          const filenameMatch = contentDisposition.match(/filename="([^"]+)"/);
          
          if (nameMatch) {
            const fieldName = nameMatch[1];
            const contentStart = part.indexOf('\r\n\r\n') + 4;
            const contentEnd = part.lastIndexOf('\r\n');
            
            if (filenameMatch) {
              // It's a file
              const filename = filenameMatch[1];
              const contentTypeMatch = part.match(/Content-Type: (.+)/);
              const contentType = contentTypeMatch ? contentTypeMatch[1].trim() : 'application/octet-stream';
              
              const fileData = Buffer.from(part.substring(contentStart, contentEnd), 'binary');
              files.push({
                fieldName,
                filename,
                contentType,
                data: fileData
              });
            } else {
              // It's a regular field
              const value = part.substring(contentStart, contentEnd);
              fields[fieldName] = value;
            }
          }
        }
      }

      resolve({ fields, files });
    });

    req.on('error', reject);
  });
}

// Check for required environment variables
const azureKey = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY;
const openaiKey = process.env.OPENAI_API_KEY;

if (!azureKey && !openaiKey) {
  console.error('ERROR: No API key found. Set either AZURE_OPENAI_API_KEY or OPENAI_API_KEY');
  console.error('For Azure: heroku config:set AZURE_OPENAI_API_KEY=your-azure-key');
  console.error('For OpenAI: heroku config:set OPENAI_API_KEY=your-openai-key');
}

if (!process.env.GOOGLE_API_KEY || !process.env.GOOGLE_SEARCH_ENGINE_ID) {
  console.warn('WARNING: Google Search API credentials not set');
  console.warn('To enable web search functionality, set both:');
  console.warn('- GOOGLE_API_KEY');
  console.warn('- GOOGLE_SEARCH_ENGINE_ID');
  console.warn('Use: heroku config:set GOOGLE_API_KEY=your-key GOOGLE_SEARCH_ENGINE_ID=your-id');
}

const server = createServer(async (req, res) => {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Serve static files
  if (req.method === 'GET' && req.url) {
    let filePath = req.url;
    
    // PDF status endpoint
    const statusMatch = filePath.match(/^\/pdf-status\/(.+)$/);
    if (statusMatch) {
      const { checkPDFStatus } = await import('./api/pdf-status.js');
      const reqWithParams = req as any;
      reqWithParams.params = { statusId: statusMatch[1] };
      return checkPDFStatus(reqWithParams, res);
    }
    
    // Health check endpoint
    if (filePath === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        env: {
          hasAzureKey: !!(process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY),
          hasOpenAIKey: !!process.env.OPENAI_API_KEY,
          hasGoogleKey: !!process.env.GOOGLE_API_KEY,
          nodeVersion: process.version,
          storage: USE_S3 ? {
            type: 's3',
            bucket: process.env.AWS_S3_BUCKET,
            region: process.env.AWS_REGION || 'us-east-1',
            hasCredentials: !!process.env.AWS_ACCESS_KEY_ID
          } : {
            type: 'local',
            path: UPLOAD_DIR
          }
        }
      }));
      return;
    }
    
    // Default to index.html for root
    if (filePath === '/') {
      filePath = '/index.html';
    }
    
    // Only serve files from public directory
    const allowedExtensions = ['.html', '.css', '.js', '.json'];
    const ext = filePath.substring(filePath.lastIndexOf('.'));
    
    if (allowedExtensions.includes(ext)) {
      try {
        const fullPath = join(__dirname, 'public', filePath);
        const content = await readFile(fullPath);
        
        // Set appropriate content type
        const contentTypes: Record<string, string> = {
          '.html': 'text/html',
          '.css': 'text/css',
          '.js': 'application/javascript',
          '.json': 'application/json'
        };
        
        res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
        res.end(content);
        return;
      } catch (error) {
        // File not found, continue to 404
      }
    }
  }

  // Only accept POST requests to /chat
  if (req.method !== 'POST' || req.url !== '/chat') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  const contentType = req.headers['content-type'] || '';
  
  try {
    let requestData: any = {};
    let uploadedFiles: any[] = [];

    if (contentType.includes('multipart/form-data')) {
      // Handle multipart form data (file upload)
      const boundaryMatch = contentType.match(/boundary=(.+)/);
      if (!boundaryMatch) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid multipart request' }));
        return;
      }

      const boundary = boundaryMatch[1];
      const { fields, files } = await parseMultipartData(req, boundary);
      
      // Process uploaded files
      for (const file of files) {
        if (file.contentType === 'application/pdf' || file.contentType === 'text/plain') {
          // Save file with appropriate extension
          const fileId = randomBytes(16).toString('hex');
          const extension = file.contentType === 'application/pdf' ? '.pdf' : '.txt';
          const filename = `${fileId}${extension}`;
          
          // Always save locally
          const filepath = join(UPLOAD_DIR, filename);
          await writeFile(filepath, file.data);
          
          uploadedFiles.push({
            originalName: file.filename,
            savedName: filename,
            path: filepath,
            filePath: filepath, // Add filePath for compatibility
            size: file.data.length
          });
          
          console.log(`Saved ${extension.toUpperCase()} file locally: ${file.filename} as ${filename}`);
        }
      }
      
      requestData = {
        message: fields.message || '',
        agentId: fields.agentId || 'assistantAgent',
        files: uploadedFiles
      };
    } else {
      // Handle JSON request (existing behavior)
      let body = '';
      
      await new Promise<void>((resolve, reject) => {
        req.on('data', chunk => {
          body += chunk.toString();
        });
        
        req.on('end', () => resolve());
        req.on('error', reject);
      });
      
      console.log('[Server] Received request body:', body);
      requestData = JSON.parse(body);
    }
    
    console.log('[Server] Processing message:', requestData.message);
    console.log('[Server] Agent ID:', requestData.agentId);
    if (uploadedFiles.length > 0) {
      console.log('[Server] With uploaded files:', uploadedFiles.map(f => f.originalName));
    }
    
    // Use Server-Sent Events to keep connection alive during Newman operations
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no'
    });
    
    // Send initial event
    res.write('data: {"status":"processing","message":"Starting to process your request..."}\n\n');
    
    // Keep connection alive with periodic messages
    const messages = [
      'Searching through documents...',
      'Running vector similarity search...',
      'Analyzing relevant content...',
      'Preparing response...',
      'Still working on your request...'
    ];
    let messageIndex = 0;
    
    const keepAliveInterval = setInterval(() => {
      const message = messages[messageIndex % messages.length];
      res.write(`data: {"status":"processing","message":"${message}"}\n\n`);
      messageIndex++;
      console.log(`[Server] Sent keepalive: ${message}`);
    }, 8000); // Every 8 seconds
    
    try {
      // Process the request
      const result = await handleRequest(requestData);
      
      // Stop keepalive messages
      clearInterval(keepAliveInterval);
      
      // Log response details
      const responseContent = result?.choices?.[0]?.message?.content || '';
      if (responseContent.length > 200) {
        console.log('[Server] Response length:', responseContent.length, 'characters');
        console.log('[Server] Result preview:', JSON.stringify(result).substring(0, 200) + '...');
      } else {
        console.log('[Server] Result from handleRequest:', JSON.stringify(result));
      }
      
      // Send final result
      console.log('[Server] Sending final response...');
      res.write(`data: {"status":"complete","result":${JSON.stringify(result)}}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      console.log('[Server] Response sent successfully');
    } catch (error) {
      clearInterval(keepAliveInterval);
      console.error('[Server] Error processing request:', error);
      
      const errorResponse = {
        status: 'error',
        error: 'Processing failed',
        details: error instanceof Error ? error.message : 'Unknown error'
      };
      
      res.write(`data: ${JSON.stringify(errorResponse)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } catch (error) {
    console.error('Error processing request:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      error: 'Internal server error', 
      details: error instanceof Error ? error.message : 'Unknown error',
      hint: !process.env.OPENAI_API_KEY ? 'OpenAI API key might be missing' : undefined
    }));
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`🌐 Web interface available at http://localhost:${PORT}`);
  console.log(`📝 POST /chat - Send messages to the assistant`);
  console.log(`📊 GET /pdf-status/:statusId - Check PDF processing status`);
  console.log(`🔑 Azure OpenAI API Key: ${(process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_API_KEY) ? 'Set ✓' : 'Missing ✗'}`);
  console.log(`🔑 OpenAI API Key: ${process.env.OPENAI_API_KEY ? 'Set ✓' : 'Missing ✗'}`);
  console.log(`🌐 Azure Endpoint: ${process.env.AZURE_OPENAI_ENDPOINT || 'Using default'}`);
  console.log(`🔍 Google Search API: ${process.env.GOOGLE_API_KEY && process.env.GOOGLE_SEARCH_ENGINE_ID ? 'Set ✓' : 'Missing ✗'}`);
  console.log(`📦 S3 Storage: ${USE_S3 ? `Enabled (${process.env.AWS_S3_BUCKET}) ✓` : 'Using local storage'}`);
  if (USE_S3) {
    console.log(`   AWS Region: ${process.env.AWS_REGION || 'us-east-1'}`);
    console.log(`   Credentials: ${process.env.AWS_ACCESS_KEY_ID ? 'Using keys' : 'Using IAM role'}`);
  }
});