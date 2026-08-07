#!/usr/bin/env node
'use strict';
/**
 * ADB MCP Server — StreamableHTTP транспорт.
 *
 * С 1.1.0 это ТОЛЬКО транспорт: инструменты живут в модулях
 * (adb, device, session, ui, files, apps), реестр и диспетчер — в registry.js.
 * Разделение сделано до написания adb_app, а не после: монолит на 700 строк
 * пережил бы ещё одну фичу, но не три.
 *
 * Транспорт и обвязка идентичны ha-filesystem-mcp v2.3.2:
 *  - POST /mcp -> plain application/json (иммунитет к SSE-буферизации туннелей)
 *  - GET /mcp -> 405 (сервер не шлёт server-initiated notifications)
 *  - никакого structuredContent (дублирование base64-пейлоадов)
 */

const http = require('http');
const { TOOLS, callTool } = require('./registry.js');

const PORT = parseInt(process.argv[2] || '3199');
const VERSION = process.env.ADDON_VERSION || '0.0.0-dev';
const ALLOW_SHELL = process.env.ALLOW_SHELL !== 'false';
const ALLOW_UNINSTALL = process.env.ALLOW_UNINSTALL === 'true';
// v0.2.2: tool-call лог под тем же флагом log_requests, что и HTTP-лог proxy.js
const LOG_REQUESTS = process.env.LOG_REQUESTS === 'true';

function fmtArgs(a) {
  try {
    const s = JSON.stringify(a || {});
    return s.length > 300 ? s.slice(0, 300) + '…' : s;
  } catch { return '(unserializable)'; }
}

function fmtOutcome(content) {
  if (!Array.isArray(content) || !content.length) return 'ok';
  const c = content[0];
  if (c.type === 'image') return `image ${Math.round((c.data || '').length * 3 / 4 / 1024)}KB`;
  const len = (c.text || '').length;
  return `ok ${len}B`;
}

function logTool(name, args, t0, outcome) {
  if (!LOG_REQUESTS) return;
  console.log(`[tool] ${new Date().toISOString()} ${name} ${fmtArgs(args)} -> ${outcome} ${Date.now() - t0}ms`);
}

async function handleMcpRequest(body) {
  const { id, method, params } = body;

  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'adb-mcp-server', version: VERSION }
    }};
  }

  if (method === 'notifications/initialized' || method === 'notifications/roots/list_changed') return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } };
  if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } };
  if (method === 'roots/list') return { jsonrpc: '2.0', id, result: { roots: [] } };

  if (method === 'tools/call') {
    const t0 = Date.now();
    try {
      const content = await callTool(params.name, params.arguments || {});
      logTool(params.name, params.arguments, t0, fmtOutcome(content));
      return { jsonrpc: '2.0', id, result: { content } };
    } catch (e) {
      logTool(params.name, params.arguments, t0, `ERROR: ${e.message}`);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true } };
    }
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, mcp-session-id, mcp-protocol-version');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.url !== '/mcp') { res.writeHead(404); res.end('Not found'); return; }
  if (req.method !== 'POST') { res.writeHead(405, { 'Allow': 'POST, OPTIONS' }); res.end(); return; }

  const accept = req.headers['accept'] || '';
  if (!accept.includes('application/json') && !accept.includes('text/event-stream')) {
    res.writeHead(406);
    res.end(JSON.stringify({ error: 'Not Acceptable: Client must accept both application/json and text/event-stream' }));
    return;
  }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { res.writeHead(400); res.end('Bad JSON'); return; }

    const requests = Array.isArray(body) ? body : [body];
    const responses = [];
    for (const r of requests) {
      const resp = await handleMcpRequest(r);
      if (resp !== null) responses.push(resp);
    }

    const result = Array.isArray(body) ? responses : (responses[0] || null);
    if (result === null) { res.writeHead(202); res.end(); return; }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  });
});

server.listen(PORT, () => {
  process.stderr.write(
    `ADB MCP Server v${VERSION} on port ${PORT} ` +
    `(${TOOLS.length} tools, shell ${ALLOW_SHELL ? 'enabled' : 'DISABLED'}, ` +
    `uninstall ${ALLOW_UNINSTALL ? 'ALLOWED' : 'blocked'}, tool log ${LOG_REQUESTS ? 'ON' : 'off'})\n`);
});
