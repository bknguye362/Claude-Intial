import { createServer } from 'http';
import { handleRequest } from './api-endpoint.js';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 3000;

// Check for required environment variables
if (!process.env.OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY environment variable is not set');
  console.error('Please set it on Heroku using: heroku config:set OPENAI_API_KEY=your-api-key');
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

  let body = '';
  
  // Collect request body
  req.on('data', chunk => {
    body += chunk.toString();
  });

  req.on('end', async () => {
    try {
      console.log('Received request body:', body);
      const parsedBody = JSON.parse(body);
      console.log('Processing message:', parsedBody.message);
      
      const result = await handleRequest(parsedBody);
      
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
});

server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`🌐 Web interface available at http://localhost:${PORT}`);
  console.log(`📝 POST /chat - Send messages to the assistant`);
  console.log(`🔑 OpenAI API Key: ${process.env.OPENAI_API_KEY ? 'Set ✓' : 'Missing ✗'}`);
});