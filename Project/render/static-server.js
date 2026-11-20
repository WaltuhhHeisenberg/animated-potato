/**
 * Minimal static file server used by the headless renderer.
 * Serves the project root plus the local three.js from node_modules
 * (so the render never depends on a CDN being reachable).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
};

function safeJoin(root, urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const p = path.normalize(path.join(root, clean));
  return p.startsWith(root) ? p : null;
}

/**
 * @param {object} opts
 * @param {string} opts.root        project root
 * @param {string} opts.threeDir    directory containing three.module.js
 * @param {string} opts.sceneMap    absolute path of the scene map to serve at /scene-map.json
 */
function createServer({ root, threeDir, sceneMap }) {
  return http.createServer((req, res) => {
    const url = req.url || '/';

    const send = (file, status = 200) => {
      fs.readFile(file, (err, buf) => {
        if (err) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('not found: ' + url);
          return;
        }
        res.writeHead(status, {
          'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
        });
        res.end(buf);
      });
    };

    if (url === '/' || url.startsWith('/?')) return send(path.join(root, 'render', 'frames.html'));

    if (url === '/scene-map.json') return send(sceneMap);

    if (url.startsWith('/vendor/addons/')) {
      const f = safeJoin(path.join(threeDir, 'examples', 'jsm'), url.slice('/vendor/addons'.length));
      return f ? send(f) : notFound();
    }
    if (url === '/vendor/three.module.js') {
      return send(path.join(threeDir, 'build', 'three.module.js'));
    }

    const f = safeJoin(root, url);
    if (!f) return notFound();
    send(f);

    function notFound() {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found: ' + url);
    }
  });
}

module.exports = { createServer };
