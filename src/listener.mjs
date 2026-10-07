import { createServer } from 'node:http';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';

export async function listenGateway(gateway, { port = 0 } = {}) {
  const nodeHandler = toNodeHandler(gateway, { maxRequestBodySize: 64 * 1024 });
  const host = localhostHostValidation();
  const origin = localhostOriginValidation();
  const http = createServer(async (req, res) => {
    if (!host(req, res) || !origin(req, res)) return;
    if (req.url === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(gateway.health()));
    } else if (req.url === '/mcp') await nodeHandler(req, res);
    else res.writeHead(404).end();
  });
  http.requestTimeout = 10_000;
  http.headersTimeout = 5000;
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(port, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${http.address().port}/mcp`,
    async close() { await gateway.close(); await new Promise(resolve => http.close(resolve)); } };
}
