import http from 'node:http';
http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ kind: 'oci', setting: process.env.SAMPLE_SETTING || null, hostSecret: process.env.HOST_ONLY_SECRET || null, path: req.url }));
}).listen(Number(process.env.PORT || 9000), '0.0.0.0');
