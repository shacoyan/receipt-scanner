import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { URL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env manually (no dotenv dependency)
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
  console.log('[dev-server] Loaded .env');
} else {
  console.warn('[dev-server] .env file not found at', envPath);
}

// Import handlers
const uploadHandler = (await import('./upload.js')).default;
const receiptsHandler = (await import('./receipts.js')).default;
const processHandler = (await import('./process.js')).default;
const registerHandler = (await import('./register.js')).default;

/**
 * Create a Vercel-compatible response object from Node's ServerResponse
 */
function createVercelRes(nodeRes) {
  const res = {
    _headers: {},
    _statusCode: 200,
    setHeader(name, value) {
      this._headers[name.toLowerCase()] = value;
      return this;
    },
    getHeader(name) {
      return this._headers[name.toLowerCase()];
    },
    status(code) {
      this._statusCode = code;
      return this;
    },
    json(data) {
      const body = JSON.stringify(data);
      nodeRes.writeHead(this._statusCode, {
        ...this._headers,
        'content-type': 'application/json',
      });
      nodeRes.end(body);
      return this;
    },
    send(data) {
      nodeRes.writeHead(this._statusCode, this._headers);
      nodeRes.end(data);
      return this;
    },
    end(data) {
      nodeRes.writeHead(this._statusCode, this._headers);
      nodeRes.end(data);
      return this;
    },
  };
  return res;
}

/**
 * Parse JSON body from request (for non-formidable routes)
 */
function parseJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw || undefined);
      }
    });
  });
}

const PORT = 3001;

const server = http.createServer(async (nodeReq, nodeRes) => {
  // CORS headers
  nodeRes.setHeader('Access-Control-Allow-Origin', '*');
  nodeRes.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  nodeRes.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (nodeReq.method === 'OPTIONS') {
    nodeRes.writeHead(204);
    nodeRes.end();
    return;
  }

  const parsedUrl = new URL(nodeReq.url, `http://localhost:${PORT}`);
  const pathname = parsedUrl.pathname;

  // Build query object from search params (support multiple values for same key)
  const query = {};
  for (const [key, value] of parsedUrl.searchParams) {
    if (query[key] !== undefined) {
      query[key] = Array.isArray(query[key]) ? [...query[key], value] : [query[key], value];
    } else {
      query[key] = value;
    }
  }

  const res = createVercelRes(nodeRes);

  try {
    if (pathname === '/api/upload' && nodeReq.method === 'POST') {
      // upload.js uses formidable which reads the raw stream — pass nodeReq directly
      const req = nodeReq;
      req.query = query;
      await uploadHandler(req, res);
    } else if (pathname === '/api/receipts' && (nodeReq.method === 'GET' || nodeReq.method === 'PATCH' || nodeReq.method === 'DELETE')) {
      const req = nodeReq;
      req.query = query;
      if (nodeReq.method === 'PATCH' || nodeReq.method === 'DELETE') {
        req.body = await parseJsonBody(nodeReq);
      }
      await receiptsHandler(req, res);
    } else if (pathname === '/api/process' && nodeReq.method === 'POST') {
      const req = nodeReq;
      req.query = query;
      req.body = await parseJsonBody(nodeReq);
      await processHandler(req, res);
    } else if (pathname === '/api/register' && nodeReq.method === 'POST') {
      const req = nodeReq;
      req.query = query;
      req.body = await parseJsonBody(nodeReq);
      await registerHandler(req, res);
    } else {
      nodeRes.writeHead(404, { 'content-type': 'application/json' });
      nodeRes.end(JSON.stringify({ error: 'Not found' }));
    }
  } catch (err) {
    console.error('[dev-server] Unhandled error:', err);
    if (!nodeRes.headersSent) {
      nodeRes.writeHead(500, { 'content-type': 'application/json' });
      nodeRes.end(JSON.stringify({ error: err.message }));
    }
  }
});

server.listen(PORT, () => {
  console.log(`[dev-server] API server running on http://localhost:${PORT}`);
});
