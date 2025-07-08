import { createServer } from 'http';
import { handleRequest } from './api-endpoint.js';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { existsSync } from 'fs';
import { randomBytes } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = join(__dirname, 'uploads');

// Ensure upload directory exists
if (!existsSync(UPLOAD_DIR)) {
  await mkdir(UPLOAD_DIR, { recursive: true });
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
if (!process.env.OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY environment variable is not set');
  console.error('Please set it on Heroku using: heroku config:set OPENAI_API_KEY=your-api-key');
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
        if (file.contentType === 'application/pdf') {
          // Save PDF file
          const fileId = randomBytes(16).toString('hex');
          const filename = `${fileId}.pdf`;
          const filepath = join(UPLOAD_DIR, filename);
          
          await writeFile(filepath, file.data);
          
          uploadedFiles.push({
            originalName: file.filename,
            savedName: filename,
            path: filepath,
            size: file.data.length
          });
          
          console.log(`Saved PDF file: ${file.filename} as ${filename}`);
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
      
      console.log('Received request body:', body);
      requestData = JSON.parse(body);
    }
    
    console.log('Processing message:', requestData.message);
    if (uploadedFiles.length > 0) {
      console.log('With uploaded files:', uploadedFiles.map(f => f.originalName));
    }
    
    const result = await handleRequest(requestData);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
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
  console.log(`🔑 OpenAI API Key: ${process.env.OPENAI_API_KEY ? 'Set ✓' : 'Missing ✗'}`);
  console.log(`🔍 Google Search API: ${process.env.GOOGLE_API_KEY && process.env.GOOGLE_SEARCH_ENGINE_ID ? 'Set ✓' : 'Missing ✗'}`);
});