const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");

class DeepSeekProxyServer {
  constructor({ store, onChange }) {
    this.store = store;
    this.onChange = onChange;
    this.server = null;
    this.runtime = {
      running: false,
      port: 0,
      error: "",
      startedAt: ""
    };
  }

  async start() {
    await this.stop();

    const settings = this.store.getSettings();
    if (!settings.proxyEnabled) {
      this.runtime = { running: false, port: settings.proxyPort, error: "", startedAt: "" };
      this.notify();
      return this.runtime;
    }

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((error) => {
        setCors(req, res);
        writeJson(res, 500, { error: "proxy_error", message: error.message || "Proxy request failed." });
      });
    });

    this.server.on("error", (error) => {
      this.runtime = {
        running: false,
        port: settings.proxyPort,
        error: error.message,
        startedAt: ""
      };
      this.notify();
    });

    await new Promise((resolve, reject) => {
      this.server.listen(settings.proxyPort, "127.0.0.1", () => {
        this.runtime = {
          running: true,
          port: settings.proxyPort,
          error: "",
          startedAt: new Date().toISOString()
        };
        this.notify();
        resolve();
      });
      this.server.once("error", reject);
    });

    return this.runtime;
  }

  async stop() {
    if (!this.server) {
      return;
    }

    const closing = this.server;
    this.server = null;
    await new Promise((resolve) => closing.close(resolve));
    this.runtime = {
      running: false,
      port: this.runtime.port,
      error: "",
      startedAt: ""
    };
    this.notify();
  }

  getRuntime() {
    return { ...this.runtime };
  }

  notify() {
    if (typeof this.onChange === "function") {
      this.onChange(this.getRuntime());
    }
  }

  async handleRequest(req, res) {
    const corsAllowed = setCors(req, res);

    if (req.method === "OPTIONS") {
      res.writeHead(corsAllowed ? 204 : 403);
      res.end();
      return;
    }

    if (!corsAllowed) {
      writeJson(res, 403, {
        error: "forbidden_origin",
        message: "This local proxy only accepts requests from loopback origins."
      });
      return;
    }

    if (req.url === "/health") {
      writeJson(res, 200, {
        status: "ok",
        proxy: this.getRuntime()
      });
      return;
    }

    const settings = this.store.getSettings();
    const apiKey = getBearerToken(req.headers.authorization) || this.store.getApiKey();
    if (!apiKey) {
      writeJson(res, 401, {
        error: "missing_api_key",
        message: "Set an API key in the desktop widget, or send Authorization: Bearer <key>."
      });
      return;
    }

    const body = await readRequestBody(req);
    const upstream = buildUpstreamUrl(req.url, settings.targetBaseUrl);
    const requestMeta = parseRequestMeta(body);

    await this.forwardToDeepSeek({
      req,
      res,
      upstream,
      body,
      apiKey,
      requestMeta
    });
  }

  forwardToDeepSeek({ req, res, upstream, body, apiKey, requestMeta }) {
    return new Promise((resolve, reject) => {
      const upstreamHeaders = buildUpstreamHeaders(req.headers, upstream, apiKey, body.length);
      const upstreamReq = https.request({
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || 443,
        path: `${upstream.pathname}${upstream.search}`,
        method: req.method,
        headers: upstreamHeaders
      }, (upstreamRes) => {
        setCors(req, res);
        const headers = filterResponseHeaders(upstreamRes.headers);
        res.writeHead(upstreamRes.statusCode || 502, headers);

        const contentType = String(upstreamRes.headers["content-type"] || "");
        if (contentType.includes("text/event-stream")) {
          const parser = createSseUsageParser((usagePayload) => {
            this.store.recordUsage(usagePayload.usage, {
              model: usagePayload.model || requestMeta.model,
              streamed: true,
              path: upstream.pathname
            });
          });

          upstreamRes.on("data", (chunk) => {
            parser.push(chunk);
            res.write(chunk);
          });
          upstreamRes.on("end", () => {
            parser.flush();
            res.end();
            resolve();
          });
          upstreamRes.on("error", reject);
          return;
        }

        const chunks = [];
        upstreamRes.on("data", (chunk) => chunks.push(chunk));
        upstreamRes.on("end", () => {
          const payload = Buffer.concat(chunks);
          captureJsonUsage(payload, contentType, (usagePayload) => {
            this.store.recordUsage(usagePayload.usage, {
              model: usagePayload.model || requestMeta.model,
              streamed: false,
              path: upstream.pathname
            });
          });
          res.end(payload);
          resolve();
        });
        upstreamRes.on("error", reject);
      });

      upstreamReq.on("error", reject);
      if (body.length) {
        upstreamReq.write(body);
      }
      upstreamReq.end();
    });
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > 25 * 1024 * 1024) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function buildUpstreamHeaders(headers, upstream, apiKey, bodyLength) {
  const blocked = new Set([
    "host",
    "connection",
    "content-length",
    "accept-encoding",
    "proxy-connection",
    "upgrade",
    "keep-alive"
  ]);
  const next = {};

  Object.entries(headers).forEach(([key, value]) => {
    if (!blocked.has(key.toLowerCase()) && value != null) {
      next[key] = value;
    }
  });

  next.host = upstream.host;
  next.authorization = `Bearer ${apiKey}`;
  next["accept-encoding"] = "identity";
  if (bodyLength) {
    next["content-length"] = bodyLength;
  }

  return next;
}

function filterResponseHeaders(headers) {
  const blocked = new Set([
    "content-encoding",
    "content-length",
    "connection",
    "transfer-encoding",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "upgrade"
  ]);
  const next = {};

  Object.entries(headers).forEach(([key, value]) => {
    if (!blocked.has(key.toLowerCase()) && value != null) {
      next[key] = value;
    }
  });

  return next;
}

function setCors(req, res) {
  const origin = String(req.headers.origin || "");
  const allowed = isAllowedCorsOrigin(origin);
  res.setHeader("Vary", "Origin");
  if (allowed && origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  return allowed;
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function isAllowedCorsOrigin(origin) {
  if (!origin) {
    return true;
  }

  try {
    const url = new URL(origin);
    const hostname = url.hostname.toLowerCase();
    return (
      (url.protocol === "http:" || url.protocol === "https:")
      && (
        hostname === "localhost"
        || hostname === "127.0.0.1"
        || hostname === "::1"
        || hostname === "[::1]"
      )
    );
  } catch {
    return false;
  }
}

function getBearerToken(value) {
  const match = String(value || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function parseRequestMeta(body) {
  if (!body.length) {
    return {};
  }

  try {
    const payload = JSON.parse(body.toString("utf8"));
    return {
      model: payload.model || ""
    };
  } catch {
    return {};
  }
}

function buildUpstreamUrl(requestUrl, targetBaseUrl) {
  const base = new URL(targetBaseUrl);
  const raw = String(requestUrl || "/");

  if (/^https?:\/\//i.test(raw)) {
    const parsed = new URL(raw);
    return new URL(`${parsed.pathname}${parsed.search}`, base);
  }

  return new URL(raw, base);
}

function captureJsonUsage(payload, contentType, onUsage) {
  if (!contentType.includes("json")) {
    return;
  }

  try {
    const json = JSON.parse(payload.toString("utf8"));
    if (json && json.usage) {
      onUsage({ usage: json.usage, model: json.model || "" });
    }
  } catch {
    // The original upstream response is still returned unchanged.
  }
}

function createSseUsageParser(onUsage) {
  let buffer = "";

  function parseBlock(block) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());

    if (!dataLines.length) {
      return;
    }

    const data = dataLines.join("\n");
    if (!data || data === "[DONE]") {
      return;
    }

    try {
      const json = JSON.parse(data);
      if (json && json.usage) {
        onUsage({ usage: json.usage, model: json.model || "" });
      }
    } catch {
      // Ignore partial or non-JSON SSE messages.
    }
  }

  return {
    push(chunk) {
      buffer += chunk.toString("utf8");
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || "";
      blocks.forEach(parseBlock);
    },
    flush() {
      if (buffer.trim()) {
        parseBlock(buffer);
      }
      buffer = "";
    }
  };
}

module.exports = {
  DeepSeekProxyServer,
  buildUpstreamUrl,
  createSseUsageParser,
  isAllowedCorsOrigin
};
