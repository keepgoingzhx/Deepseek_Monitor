const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const DEFAULT_DATA_FILE = path.join(__dirname, "..", ".local", "deepseek-usage.json");
const DEFAULT_BASE_URL = "https://api.deepseek.com";

class UsageApiServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = Number(options.port || process.env.PORT || 8787);
    this.baseUrl = normalizeBaseUrl(options.baseUrl || process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL);
    this.dataFile = options.dataFile || DEFAULT_DATA_FILE;
    this.getApiKey = typeof options.getApiKey === "function" ? options.getApiKey : defaultApiKeyProvider;
    this.server = null;
    this.stateCache = null;
    this.stateCacheSignature = "";
    this._writeTimer = null;
    this._pendingState = null;
    this.runtime = {
      running: false,
      port: this.port,
      baseUrl: this.baseUrl,
      error: "",
      startedAt: ""
    };
  }

  async start() {
    if (this.server) {
      return this.getRuntime();
    }

    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        setCors(req, res);
        sendJson(res, 500, {
          ok: false,
          error: "server_error",
          message: error instanceof Error ? error.message : "Internal Server Error"
        });
      });
    });

    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, "127.0.0.1", resolve);
    });

    this.runtime = {
      running: true,
      port: this.port,
      baseUrl: this.baseUrl,
      error: "",
      startedAt: new Date().toISOString()
    };
    this.emit("runtime", this.getRuntime());
    return this.getRuntime();
  }

  async stop() {
    this.flushState();
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;
    await new Promise((resolve) => server.close(resolve));
    this.runtime = {
      running: false,
      port: this.port,
      baseUrl: this.baseUrl,
      error: "",
      startedAt: ""
    };
    this.emit("runtime", this.getRuntime());
  }

  async restart(options = {}) {
    await this.stop();
    if (options.port) {
      this.port = Number(options.port);
    }
    if (options.baseUrl) {
      this.baseUrl = normalizeBaseUrl(options.baseUrl);
    }
    this.runtime.port = this.port;
    this.runtime.baseUrl = this.baseUrl;
    return this.start();
  }

  getRuntime() {
    return { ...this.runtime };
  }

  getUsage(filters = {}) {
    const state = this.readState();
    const date = filters.date || "";
    const from = filters.from || "";
    const to = filters.to || "";
    const daily = state.daily
      .filter((item) => !date || item.date === date)
      .filter((item) => !from || item.date >= from)
      .filter((item) => !to || item.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date));

    return {
      ok: true,
      summary: summarize(daily),
      daily
    };
  }

  resetUsage() {
    this.writeState({ daily: [] });
    this.flushState();
    this.emit("usage", this.getUsage());
  }

  importDailyUsage(dailyUsage) {
    const state = this.readState();
    const merged = new Map();
    state.daily.forEach((item) => merged.set(item.date, normalizeDay(item)));
    dailyUsage.forEach((item) => {
      const day = normalizeDay(item);
      const existing = merged.get(day.date);
      if (existing && isSameUsageDay(existing, day)) {
        merged.set(day.date, existing);
        return;
      }
      day.updatedAt = day.updatedAt || new Date().toISOString();
      merged.set(day.date, day);
    });
    const nextDaily = Array.from(merged.values()).sort((a, b) => a.date.localeCompare(b.date));
    if (isSameUsageState(state.daily, nextDaily)) {
      return;
    }
    this.writeState({ daily: nextDaily });
    this.flushState();
    this.emit("usage", this.getUsage());
  }

  async handle(req, res) {
    const corsAllowed = setCors(req, res);

    if (req.method === "OPTIONS") {
      res.writeHead(corsAllowed ? 204 : 403);
      res.end();
      return;
    }

    if (!corsAllowed) {
      sendJson(res, 403, {
        ok: false,
        error: "forbidden_origin",
        message: "This local API only accepts requests from loopback origins."
      });
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, runtime: this.getRuntime() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/deepseek/usage") {
      sendJson(res, 200, this.getUsage({
        date: url.searchParams.get("date") || "",
        from: url.searchParams.get("from") || "",
        to: url.searchParams.get("to") || ""
      }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/deepseek/balance") {
      await this.proxyBalance(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/deepseek/chat/completions") {
      await this.proxyChatCompletions(req, res);
      return;
    }

    sendJson(res, 404, {
      ok: false,
      error: "not_found",
      message: "Use GET /api/deepseek/usage or POST /api/deepseek/chat/completions."
    });
  }

  async proxyChatCompletions(req, res) {
    const apiKey = this.resolveApiKey(req);
    if (!apiKey) {
      sendJson(res, 401, {
        ok: false,
        error: "missing_api_key",
        message: "Set DEEPSEEK_API_KEY or send Authorization: Bearer <key>."
      });
      return;
    }

    const requestBody = await readBody(req);
    const requestPayload = parseJson(requestBody);
    const upstreamBody = prepareDeepSeekBody(requestPayload, requestBody);

    const upstream = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: upstreamBody
    });

    const contentType = upstream.headers.get("content-type") || "";
    res.writeHead(upstream.status, responseHeaders(contentType));

    if (contentType.includes("text/event-stream")) {
      await this.streamAndCaptureUsage(upstream, res, requestPayload || {});
      return;
    }

    const text = await upstream.text();
    this.captureJsonUsage(text, requestPayload || {});
    res.end(text);
  }

  async proxyBalance(req, res) {
    const apiKey = this.resolveApiKey(req);
    if (!apiKey) {
      sendJson(res, 401, {
        ok: false,
        error: "missing_api_key",
        message: "Set DEEPSEEK_API_KEY or send Authorization: Bearer <key>."
      });
      return;
    }

    const upstream = await fetch(`${this.baseUrl}/user/balance`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json"
      }
    });

    const text = await upstream.text();
    res.writeHead(upstream.status, responseHeaders(upstream.headers.get("content-type") || "application/json"));
    res.end(text);
  }

  resolveApiKey(req) {
    const header = getBearerToken(req.headers.authorization);
    return header || this.getApiKey(req) || "";
  }

  recordUsage(usage, meta = {}) {
    if (!usage) {
      return;
    }

    const normalized = normalizeUsage(usage);
    if (!normalized.totalTokens && !normalized.promptTokens && !normalized.completionTokens) {
      return;
    }

    const state = this.readState();
    const date = formatDate(new Date());
    let bucket = state.daily.find((item) => item.date === date);

    if (!bucket) {
      bucket = {
        date,
        totalTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        reasoningTokens: 0,
        cost: 0,
        requests: 0,
        lastModel: "",
        updatedAt: "",
        models: { flash: emptyModelBucket(), pro: emptyModelBucket() }
      };
      state.daily.push(bucket);
    }

    bucket.totalTokens += normalized.totalTokens;
    bucket.promptTokens += normalized.promptTokens;
    bucket.completionTokens += normalized.completionTokens;
    bucket.cacheHitTokens += normalized.cacheHitTokens;
    bucket.cacheMissTokens += normalized.cacheMissTokens;
    bucket.reasoningTokens += normalized.reasoningTokens;
    bucket.cost += normalized.cost;
    bucket.requests += 1;
    bucket.lastModel = meta.model || bucket.lastModel;
    bucket.updatedAt = new Date().toISOString();

    // Populate per-model buckets from the request model name
    if (meta.model) {
      if (!bucket.models) {
        bucket.models = { flash: emptyModelBucket(), pro: emptyModelBucket() };
      }
      const m = String(meta.model).toLowerCase();
      const isFlash = /flash|deepseek[-_]chat|deepseek[-_]v3/.test(m);
      const isPro = /pro|reasoner|r1|deepseek[-_]r1/.test(m);
      const mb = isFlash ? bucket.models.flash : isPro ? bucket.models.pro : null;
      if (mb) {
        mb.totalTokens += normalized.totalTokens;
        mb.promptTokens += normalized.promptTokens;
        mb.completionTokens += normalized.completionTokens;
        mb.cacheHitTokens += normalized.cacheHitTokens;
        mb.cacheMissTokens += normalized.cacheMissTokens;
        mb.reasoningTokens += normalized.reasoningTokens;
        mb.cost += normalized.cost;
        mb.requests += 1;
      }
    }

    this.writeState(state);
    this.emit("usage", this.getUsage());
  }

  captureJsonUsage(text, requestPayload) {
    const payload = parseJson(Buffer.from(text));
    if (payload && payload.usage) {
      this.recordUsage(payload.usage, {
        model: payload.model || requestPayload.model || ""
      });
    }
  }

  async streamAndCaptureUsage(upstream, res, requestPayload) {
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      const chunk = Buffer.from(value);
      res.write(chunk);
      buffer += decoder.decode(value, { stream: true });

      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || "";
      blocks.forEach((block) => this.captureSseBlock(block, requestPayload));
    }

    if (buffer.trim()) {
      this.captureSseBlock(buffer, requestPayload);
    }
    res.end();
  }

  captureSseBlock(block, requestPayload) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");

    if (!data || data === "[DONE]") {
      return;
    }

    const payload = parseJson(Buffer.from(data));
    if (payload && payload.usage) {
      this.recordUsage(payload.usage, {
        model: payload.model || requestPayload.model || ""
      });
    }
  }

  readState() {
    try {
      if (!fs.existsSync(this.dataFile)) {
        this.stateCache = { daily: [] };
        this.stateCacheSignature = "";
        return { daily: [] };
      }
      const stat = fs.statSync(this.dataFile);
      const signature = `${stat.size}:${stat.mtimeMs}`;
      if (this.stateCache && this.stateCacheSignature === signature) {
        return cloneState(this.stateCache);
      }

      const state = JSON.parse(fs.readFileSync(this.dataFile, "utf8"));
      const normalized = {
        daily: Array.isArray(state.daily) ? state.daily.map(normalizeDay).filter((item) => item.date) : []
      };
      this.stateCache = normalized;
      this.stateCacheSignature = signature;
      return cloneState(normalized);
    } catch {
      return { daily: [] };
    }
  }

  writeState(state) {
    this._pendingState = state;
    if (this._writeTimer) return;
    this._writeTimer = setTimeout(() => {
      this._writeTimer = null;
      this.flushState();
    }, 500);
  }

  flushState() {
    const state = this._pendingState;
    if (!state) return;
    this._pendingState = null;
    if (this._writeTimer) {
      clearTimeout(this._writeTimer);
      this._writeTimer = null;
    }
    fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
    const normalized = {
      daily: Array.isArray(state.daily) ? state.daily.map(normalizeDay).filter((item) => item.date) : []
    };
    fs.writeFileSync(this.dataFile, JSON.stringify(normalized, null, 2), "utf8");
    this.stateCache = normalized;
    try {
      const stat = fs.statSync(this.dataFile);
      this.stateCacheSignature = `${stat.size}:${stat.mtimeMs}`;
    } catch {
      this.stateCacheSignature = "";
    }
  }
}

function createUsageApiServer(options) {
  return new UsageApiServer(options);
}

function cloneState(state) {
  return {
    daily: Array.isArray(state.daily) ? state.daily.map((item) => ({ ...item })) : []
  };
}

function normalizeUsage(usage) {
  const promptTokens = toNumber(usage.prompt_tokens ?? usage.input_tokens);
  const completionTokens = toNumber(usage.completion_tokens ?? usage.output_tokens);
  const totalTokens = toNumber(usage.total_tokens) || promptTokens + completionTokens;
  const reasoningTokens = toNumber(
    usage.reasoning_tokens
    || usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens
  );

  return {
    totalTokens,
    promptTokens,
    completionTokens,
    cacheHitTokens: toNumber(usage.prompt_cache_hit_tokens),
    cacheMissTokens: toNumber(usage.prompt_cache_miss_tokens),
    reasoningTokens,
    cost: toNumber(usage.cost || usage.amount)
  };
}

function normalizeDay(item) {
  const models = item && item.models;
  return {
    date: String(item.date || ""),
    totalTokens: toNumber(item.totalTokens),
    promptTokens: toNumber(item.promptTokens),
    completionTokens: toNumber(item.completionTokens),
    cacheHitTokens: toNumber(item.cacheHitTokens),
    cacheMissTokens: toNumber(item.cacheMissTokens),
    reasoningTokens: toNumber(item.reasoningTokens),
    cost: toNumber(item.cost),
    requests: toNumber(item.requests),
    lastModel: String(item.lastModel || ""),
    updatedAt: String(item.updatedAt || ""),
    models: models && typeof models === "object"
      ? {
          flash: normalizeModelBucket(models.flash),
          pro: normalizeModelBucket(models.pro)
        }
      : { flash: emptyModelBucket(), pro: emptyModelBucket() }
  };
}

function normalizeModelBucket(m) {
  if (!m || typeof m !== "object") return emptyModelBucket();
  return {
    totalTokens: toNumber(m.totalTokens),
    promptTokens: toNumber(m.promptTokens),
    completionTokens: toNumber(m.completionTokens),
    cacheHitTokens: toNumber(m.cacheHitTokens),
    cacheMissTokens: toNumber(m.cacheMissTokens),
    reasoningTokens: toNumber(m.reasoningTokens),
    cost: toNumber(m.cost),
    requests: toNumber(m.requests)
  };
}

function emptyModelBucket() {
  return {
    totalTokens: 0, promptTokens: 0, completionTokens: 0,
    cacheHitTokens: 0, cacheMissTokens: 0, reasoningTokens: 0,
    cost: 0, requests: 0
  };
}

function summarize(daily) {
  return daily.reduce((sum, item) => {
    sum.totalTokens += item.totalTokens;
    sum.promptTokens += item.promptTokens;
    sum.completionTokens += item.completionTokens;
    sum.cacheHitTokens += item.cacheHitTokens;
    sum.cacheMissTokens += item.cacheMissTokens;
    sum.reasoningTokens += item.reasoningTokens;
    sum.cost += item.cost;
    sum.requests += item.requests;
    return sum;
  }, {
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    requests: 0
  });
}

function prepareDeepSeekBody(payload, rawBody) {
  if (!payload) {
    return rawBody;
  }

  if (payload.stream === true) {
    payload.stream_options = {
      ...(payload.stream_options || {}),
      include_usage: true
    };
  }

  return JSON.stringify(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 20 * 1024 * 1024) {
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

function parseJson(buffer) {
  try {
    return JSON.parse(Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer));
  } catch {
    return null;
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, responseHeaders("application/json; charset=utf-8"));
  res.end(JSON.stringify(payload));
}

function responseHeaders(contentType) {
  return {
    "content-type": contentType || "application/json; charset=utf-8",
    "cache-control": "no-store"
  };
}

function setCors(req, res) {
  const origin = String(req.headers.origin || "");
  const allowed = isAllowedCorsOrigin(origin);
  res.setHeader("vary", "Origin");
  if (allowed && origin) {
    res.setHeader("access-control-allow-origin", origin);
  }
  res.setHeader("access-control-allow-headers", "authorization, content-type");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  return allowed;
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

function defaultApiKeyProvider() {
  return process.env.DEEPSEEK_API_KEY || "";
}

function normalizeBaseUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return DEFAULT_BASE_URL;
  }
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function isSameUsageDay(left, right) {
  return (
    left.totalTokens === right.totalTokens
    && left.promptTokens === right.promptTokens
    && left.completionTokens === right.completionTokens
    && left.cacheHitTokens === right.cacheHitTokens
    && left.cacheMissTokens === right.cacheMissTokens
    && left.reasoningTokens === right.reasoningTokens
    && left.cost === right.cost
    && left.requests === right.requests
    && isSameModelBucket(left.models && left.models.flash, right.models && right.models.flash)
    && isSameModelBucket(left.models && left.models.pro, right.models && right.models.pro)
  );
}

function isSameModelBucket(left, right) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return (
    left.totalTokens === right.totalTokens
    && left.promptTokens === right.promptTokens
    && left.completionTokens === right.completionTokens
    && left.cacheHitTokens === right.cacheHitTokens
    && left.cacheMissTokens === right.cacheMissTokens
    && left.reasoningTokens === right.reasoningTokens
    && left.cost === right.cost
    && left.requests === right.requests
  );
}

function isSameUsageState(left, right) {
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    return item.date === other.date && isSameUsageDay(item, other);
  });
}

function formatDate(date) {
  // Use UTC — DeepSeek's API returns billing data keyed by UTC dates,
  // and the stored daily usage uses UTC dates throughout.
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_DATA_FILE,
  UsageApiServer,
  createUsageApiServer,
  formatDate,
  isAllowedCorsOrigin,
  normalizeUsage,
  summarize
};
