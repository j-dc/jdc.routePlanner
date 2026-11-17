import { createServer } from 'node:http';

createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ features: [] }));
}).listen(2322, '0.0.0.0');