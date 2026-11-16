import { createServer } from 'node:http';

// Deliberately independent of the game, storage, models and user artwork.
const PREVIEW = JSON.stringify({
  status: 'SYNTHETIC_PREVIEW_ONLY',
  preview_only: true,
  public_export_allowed: false,
  license_verified: false,
  actual_public_deployment_enabled: false,
  energy: [100, 104, 101, 108],
});
const STATUS = JSON.stringify({
  status: 'SYNTHETIC_PREVIEW_ONLY',
  preview_only: true,
  actual_public_deployment_enabled: false,
});
const HTML = '<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>架空プレビュー</title><body><h1>架空プレビュー / Fictional preview</h1><p>コード内の架空エネルギー: 100 → 104 → 101 → 108</p><p>利用者のオリジナルゲームではありません。作品・保存データ・予測は含みません。公開準備の完了やライセンス確認を示すものではありません。</p></body></html>';

function validate({ host = '127.0.0.1', port = 8894 } = {}) {
  if (host !== '127.0.0.1') throw new TypeError('Loopback host required');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError('Invalid port');
  }
  return { host, port };
}

export function createPublicPreviewServer(options = {}) {
  validate(options);
  const server = createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    // Close after every response: never consume or retain a request body.
    res.setHeader('Connection', 'close');
    const deny = () => {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden\n');
    };
    if (req.method !== 'GET') return deny();
    const port = req.socket.localPort;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (req.socket.localAddress !== '127.0.0.1' || req.socket.remoteAddress !== '127.0.0.1') return deny();
    // Inspect only headers; duplicate Host and all origin/proxy claims fail closed.
    let hostCount = 0;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i].toLowerCase();
      if (name === 'host') hostCount++;
      if (name === 'origin' || name === 'forwarded' || name.startsWith('x-forwarded-')) return deny();
    }
    if (hostCount !== 1 || !hosts.includes(req.headers.host)) return deny();
    let body;
    let type = 'application/json; charset=utf-8';
    switch (req.url) {
      case '/api/public/preview': body = PREVIEW; break;
      case '/api/public/status': body = STATUS; break;
      case '/': body = HTML; type = 'text/html; charset=utf-8'; break;
      default:
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found\n');
        return;
    }
    res.writeHead(200, { 'Content-Type': type });
    res.end(body);
  });
  // Even a caller using the factory cannot override the literal bind address.
  const listen = server.listen.bind(server);
  server.listen = (port, host, callback) => {
    validate({ host, port });
    return listen(port, '127.0.0.1', callback);
  };
  return server;
}

export async function startPublicPreviewServer(options = {}) {
  const { host, port } = validate(options);
  const server = createPublicPreviewServer({ host, port });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return server;
}

// Importing this module never starts a listener. No environment configuration.
if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  await startPublicPreviewServer({ host: '127.0.0.1', port: 8894 });
}
