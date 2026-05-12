const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const usageTools = require("../usage.js");

const DEFAULT_STATE = {
  settings: {
    apiKeySecret: "",
    rememberKey: false,
    proxyEnabled: true,
    proxyPort: 8787,
    balanceIntervalSec: 60,
    alwaysOnTop: true,
    targetBaseUrl: "https://api.deepseek.com"
  },
  dailyUsage: [],
  balance: null,
  lastBalanceCheckedAt: "",
  lastUsageAt: "",
  importedMeta: null
};

class StateStore extends EventEmitter {
  constructor({ app, safeStorage }) {
    super();
    this.safeStorage = safeStorage;
    this.dataDir = app.getPath("userData");
    this.dataPath = path.join(this.dataDir, "monitor-state.json");
    this.state = structuredClone(DEFAULT_STATE);
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.dataPath)) {
        return;
      }

      const raw = fs.readFileSync(this.dataPath, "utf8");
      const saved = JSON.parse(raw);
      this.state = mergeState(DEFAULT_STATE, saved);
      this.state.dailyUsage = usageTools.mergeDailyUsage([], this.state.dailyUsage);
    } catch (error) {
      this.state = structuredClone(DEFAULT_STATE);
      this.emit("error", error);
    }
  }

  save() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.dataPath, JSON.stringify(this.state, null, 2), "utf8");
  }

  getSettings() {
    return { ...this.state.settings };
  }

  getApiKey() {
    const secret = this.state.settings.apiKeySecret;
    if (!secret) {
      return "";
    }

    if (secret.startsWith("safe:")) {
      if (!this.safeStorage || !this.safeStorage.isEncryptionAvailable()) {
        return "";
      }
      try {
        return this.safeStorage.decryptString(Buffer.from(secret.slice(5), "base64"));
      } catch {
        return "";
      }
    }

    if (secret.startsWith("plain:")) {
      return Buffer.from(secret.slice(6), "base64").toString("utf8");
    }

    return "";
  }

  setSettings(incoming) {
    const next = { ...this.state.settings };

    if (typeof incoming.proxyEnabled === "boolean") {
      next.proxyEnabled = incoming.proxyEnabled;
    }
    if (typeof incoming.alwaysOnTop === "boolean") {
      next.alwaysOnTop = incoming.alwaysOnTop;
    }
    if (typeof incoming.rememberKey === "boolean") {
      next.rememberKey = incoming.rememberKey;
    }
    if (Number.isFinite(Number(incoming.proxyPort))) {
      next.proxyPort = clampInt(incoming.proxyPort, 1024, 65535, DEFAULT_STATE.settings.proxyPort);
    }
    if (Number.isFinite(Number(incoming.balanceIntervalSec))) {
      next.balanceIntervalSec = clampInt(incoming.balanceIntervalSec, 15, 3600, DEFAULT_STATE.settings.balanceIntervalSec);
    }
    if (typeof incoming.targetBaseUrl === "string" && incoming.targetBaseUrl.trim()) {
      next.targetBaseUrl = normalizeBaseUrl(incoming.targetBaseUrl.trim());
    }

    if (typeof incoming.apiKey === "string") {
      const apiKey = incoming.apiKey.trim();
      next.apiKeySecret = incoming.rememberKey && apiKey ? this.encryptApiKey(apiKey) : "";
    } else if (!next.rememberKey) {
      next.apiKeySecret = "";
    }

    this.state.settings = next;
    this.save();
    this.emit("change", this.getSnapshot());
  }

  encryptApiKey(apiKey) {
    if (this.safeStorage && this.safeStorage.isEncryptionAvailable()) {
      return `safe:${this.safeStorage.encryptString(apiKey).toString("base64")}`;
    }
    return `plain:${Buffer.from(apiKey, "utf8").toString("base64")}`;
  }

  setBalance(balance) {
    this.state.balance = balance;
    this.state.lastBalanceCheckedAt = new Date().toISOString();
    this.save();
    this.emit("change", this.getSnapshot());
  }

  clearBalance() {
    this.state.balance = null;
    this.state.lastBalanceCheckedAt = "";
    this.save();
    this.emit("change", this.getSnapshot());
  }

  recordUsage(rawUsage, metadata = {}) {
    const normalized = normalizeUsage(rawUsage);
    if (!normalized.totalTokens && !normalized.promptTokens && !normalized.completionTokens && !normalized.cost) {
      return null;
    }

    const date = usageTools.formatLocalDate(new Date());
    const existing = this.state.dailyUsage.find((item) => item.date === date);
    const bucket = existing || {
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
      updatedAt: ""
    };

    bucket.totalTokens += normalized.totalTokens;
    bucket.promptTokens += normalized.promptTokens;
    bucket.completionTokens += normalized.completionTokens;
    bucket.cacheHitTokens += normalized.cacheHitTokens;
    bucket.cacheMissTokens += normalized.cacheMissTokens;
    bucket.reasoningTokens += normalized.reasoningTokens;
    bucket.cost += normalized.cost;
    bucket.requests += 1;
    bucket.lastModel = metadata.model || bucket.lastModel || "";
    bucket.updatedAt = new Date().toISOString();

    if (!existing) {
      this.state.dailyUsage.push(bucket);
    }

    this.state.dailyUsage = usageTools.mergeDailyUsage([], this.state.dailyUsage);
    this.state.lastUsageAt = bucket.updatedAt;
    this.save();
    this.emit("usage", { day: bucket, usage: normalized, metadata });
    this.emit("change", this.getSnapshot());
    return bucket;
  }

  importDailyUsage(dailyUsage, importedMeta) {
    this.state.dailyUsage = usageTools.mergeDailyUsage(this.state.dailyUsage, dailyUsage);
    this.state.importedMeta = {
      ...importedMeta,
      importedAt: new Date().toISOString()
    };
    this.save();
    this.emit("change", this.getSnapshot());
  }

  resetUsage() {
    this.state.dailyUsage = [];
    this.state.lastUsageAt = "";
    this.state.importedMeta = null;
    this.save();
    this.emit("change", this.getSnapshot());
  }

  getSnapshot(runtime = {}) {
    const settings = this.getSettings();
    const summary = usageTools.summarize(this.state.dailyUsage);
    const apiKeyStorage = settings.apiKeySecret
      ? settings.apiKeySecret.startsWith("safe:")
        ? "encrypted"
        : "plain"
      : "none";

    return {
      settings: {
        proxyEnabled: settings.proxyEnabled,
        proxyPort: settings.proxyPort,
        balanceIntervalSec: settings.balanceIntervalSec,
        alwaysOnTop: settings.alwaysOnTop,
        targetBaseUrl: settings.targetBaseUrl,
        rememberKey: settings.rememberKey,
        hasApiKey: Boolean(settings.apiKeySecret),
        apiKeyStorage
      },
      dailyUsage: this.state.dailyUsage,
      balance: this.state.balance,
      lastBalanceCheckedAt: this.state.lastBalanceCheckedAt,
      lastUsageAt: this.state.lastUsageAt,
      importedMeta: this.state.importedMeta,
      summary,
      runtime
    };
  }
}

function normalizeUsage(usage) {
  const promptTokens = numberFrom(usage && (usage.prompt_tokens ?? usage.input_tokens));
  const completionTokens = numberFrom(usage && (usage.completion_tokens ?? usage.output_tokens));
  const cacheHitTokens = numberFrom(usage && usage.prompt_cache_hit_tokens);
  const cacheMissTokens = numberFrom(usage && usage.prompt_cache_miss_tokens);
  const reasoningTokens = numberFrom(
    usage && (
      usage.reasoning_tokens
      || usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens
    )
  );
  const totalTokens = numberFrom(usage && usage.total_tokens) || promptTokens + completionTokens;
  const cost = numberFrom(usage && (usage.cost || usage.amount));

  return {
    totalTokens,
    promptTokens,
    completionTokens,
    cacheHitTokens,
    cacheMissTokens,
    reasoningTokens,
    cost
  };
}

function numberFrom(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function normalizeBaseUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return DEFAULT_STATE.settings.targetBaseUrl;
  }
}

function mergeState(defaults, saved) {
  return {
    ...structuredClone(defaults),
    ...saved,
    settings: {
      ...defaults.settings,
      ...(saved && saved.settings ? saved.settings : {})
    },
    dailyUsage: Array.isArray(saved && saved.dailyUsage) ? saved.dailyUsage : []
  };
}

module.exports = {
  StateStore,
  normalizeUsage
};
