#!/usr/bin/env node

import https from 'https';
import crypto from 'crypto';
import { URL } from 'url';

// AWS credentials (must be set in environment variables)
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const AWS_REGION = process.env.AWS_REGION || 'us-east-2';
const SERVICE = 's3vectors';

function sign(key, msg) {
  return crypto.createHmac('sha256', key).update(msg).digest();
}

function getSignatureKey(key, dateStamp, regionName, serviceName) {
  const kDate = sign(('AWS4' + key), dateStamp);
  const kRegion = sign(kDate, regionName);
  const kService = sign(kRegion, serviceName);
  const kSigning = sign(kService, 'aws4_request');
  return kSigning;
}

function makeRequest(method, path, body = {}) {
  return new Promise((resolve, reject) => {
    const host = `s3vectors.${AWS_REGION}.api.aws`;
    const endpoint = `https://${host}${path}`;
    
    const bodyStr = JSON.stringify(body);
    const contentType = 'application/json';
    
    // Create a date for headers and the credential string
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.substr(0, 8);
    
    // Create canonical request
    const canonicalUri = path;
    const canonicalQuerystring = '';
    const payloadHash = crypto.createHash('sha256').update(bodyStr).digest('hex');
    const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'content-type;host;x-amz-date';
    const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuerystring}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    
    // Create string to sign
    const algorithm = 'AWS4-HMAC-SHA256';
    const credentialScope = `${dateStamp}/${AWS_REGION}/${SERVICE}/aws4_request`;
    const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${crypto.createHash('sha256').update(canonicalRequest).digest('hex')}`;
    
    // Calculate signature
    const signingKey = getSignatureKey(AWS_SECRET_ACCESS_KEY, dateStamp, AWS_REGION, SERVICE);
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    
    // Create authorization header
    const authorizationHeader = `${algorithm} Credential=${AWS_ACCESS_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    
    const options = {
      hostname: host,
      path: path,
      method: method,
      headers: {
        'Content-Type': contentType,
        'Content-Length': Buffer.byteLength(bodyStr),
        'X-Amz-Date': amzDate,
        'Authorization': authorizationHeader
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            console.log('Raw response:', data);
            resolve({});
          }
        } else {
          console.log(`HTTP ${res.statusCode}: ${data}`);
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });
    
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function deleteAllIndices() {
  console.log('=== DELETE ALL S3 VECTOR INDICES ===\n');
  console.log(`Region: ${AWS_REGION}\n`);
  
  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
    console.error('Error: AWS credentials not set. Please set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables.');
    return;
  }
  
  try {
    // List all indices
    console.log('1. Fetching indices...');
    const listResult = await makeRequest('POST', '/ListIndexes', {
      vectorBucketName: 'chatbotvectors362'
    });
    
    // The API returns "indexes" not "indices"
    const indices = listResult.indexes || [];
    
    if (indices.length === 0) {
      console.log('   No indices found');
      return;
    }
    
    console.log(`   Found ${indices.length} indices:\n`);
    indices.forEach(idx => {
      console.log(`   - ${idx.indexName || idx.name || idx} (${idx.vectorCount || 0} vectors)`);
    });
    
    console.log('\n2. Deleting indices...\n');
    
    for (const index of indices) {
      process.stdout.write(`   Deleting ${index.indexName}...`);
      
      try {
        await makeRequest('POST', '/DeleteIndex', {
          vectorBucketName: 'chatbotvectors362',
          indexName: index.indexName
        });
        console.log(' ✅');
      } catch (error) {
        console.log(' ❌');
      }
      
      // Small delay between deletions
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log('\n✅ All indices deleted!');
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

deleteAllIndices().catch(console.error);