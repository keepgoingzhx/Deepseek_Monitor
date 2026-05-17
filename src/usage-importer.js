const usageTools = require("../usage.js");

function parseUsageText(text, source = {}) {
  const contentType = String(source.contentType || "").toLowerCase();
  const sourceUrl = String(source.url || "").toLowerCase();
  const input = String(text || "").trim();

  if (!input) {
    return emptyResult();
  }

  if (contentType.includes("csv") || sourceUrl.endsWith(".csv") || looksLikeCsv(input)) {
    return aggregateRows(usageTools.parseCsv(input).rows);
  }

  const json = parseJson(input);
  if (json == null) {
    return emptyResult();
  }

  const deepSeekUsage = collectDeepSeekUsageDaily(json, sourceUrl);
  if (deepSeekUsage.length) {
    return {
      daily: deepSeekUsage,
      rows: deepSeekUsage,
      skipped: 0,
      tokenRows: deepSeekUsage.filter((item) => item.totalTokens > 0).length
    };
  }

  return aggregateRows(collectUsageRecords(json));
}

function parseUsageTables(tables) {
  const rows = [];

  for (const table of tables || []) {
    if (!Array.isArray(table) || table.length < 2) {
      continue;
    }

    const headers = table[0].map((value, index) => String(value || `column_${index + 1}`).trim());
    for (const values of table.slice(1)) {
      const row = {};
      headers.forEach((header, index) => {
        row[header] = values[index] == null ? "" : String(values[index]).trim();
      });
      rows.push(row);
    }
  }

  return aggregateRows(rows);
}

function collectUsageRecords(value, output = [], depth = 0) {
  if (depth > 8 || value == null) {
    return output;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectUsageRecords(item, output, depth + 1));
    return output;
  }

  if (typeof value !== "object") {
    return output;
  }

  const row = flattenObject(value);
  if (usageTools.aggregateUsage([row]).daily.length) {
    output.push(row);
  }

  Object.values(value).forEach((child) => {
    if (child && typeof child === "object") {
      collectUsageRecords(child, output, depth + 1);
    }
  });

  return output;
}

function flattenObject(value, prefix = "", output = {}) {
  for (const [key, child] of Object.entries(value || {})) {
    const cleanKey = prefix ? `${prefix}_${key}` : key;

    if (child == null) {
      output[cleanKey] = "";
      continue;
    }

    if (typeof child === "string" || typeof child === "number" || typeof child === "boolean") {
      output[cleanKey] = child;
      output[key] = child;
      continue;
    }

    if (typeof child === "object" && !Array.isArray(child)) {
      const lower = key.toLowerCase();
      if (
        lower.includes("usage")
        || lower.includes("token")
        || lower.includes("amount")
        || lower.includes("cost")
        || lower.includes("balance")
      ) {
        flattenObject(child, cleanKey, output);
        Object.entries(child).forEach(([nestedKey, nestedValue]) => {
          if (nestedValue == null || typeof nestedValue !== "object") {
            output[nestedKey] = nestedValue;
          }
        });
      }
    }
  }

  return output;
}

function aggregateRows(rows) {
  const aggregated = usageTools.aggregateUsage(rows || []);
  return {
    ...aggregated,
    rows: rows || []
  };
}

function collectDeepSeekUsageDaily(json, sourceUrl) {
  const payload = unwrapDeepSeekPayload(json);
  const byDate = new Map();
  const shouldParseAmount = sourceUrl.includes("/usage/amount") || looksLikeDeepSeekUsagePayload(payload);
  const shouldParseCost = sourceUrl.includes("/usage/cost") || looksLikeDeepSeekCostPayload(payload);

  if (shouldParseAmount) {
    mergeDeepSeekDays(byDate, parseDeepSeekAmountPayload(payload));
  }

  if (shouldParseCost) {
    mergeDeepSeekDays(byDate, parseDeepSeekCostPayload(payload));
  }

  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function unwrapDeepSeekPayload(value) {
  if (!value || typeof value !== "object") return value;
  const data = value.data && typeof value.data === "object" ? value.data : value;
  if (data && typeof data === "object" && "biz_data" in data) {
    return data.biz_data;
  }
  return data;
}

function looksLikeDeepSeekUsagePayload(value) {
  return Boolean(value && typeof value === "object" && Array.isArray(value.days) && Array.isArray(value.total));
}

function looksLikeDeepSeekCostPayload(value) {
  if (!Array.isArray(value)) return false;
  return value.some((item) => item && typeof item === "object" && Array.isArray(item.days) && "currency" in item);
}

function isSubObjectModelKey(key, value) {
  // Detect model-level sub-objects: keys that are not metric keys themselves
  // but contain metric-keyed children (e.g. "deepseek-chat": { total_tokens: ... })
  if (key === "date" || key === "days" || key === "total" || key === "biz_data") return false;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (isDeepSeekMetricKey(key)) return false;
  // Check children recursively up to 2 levels for metric keys
  const children = Object.values(value);
  return children.some((c) => {
    if (c == null) return false;
    if (typeof c === "number" || typeof c === "string") return isDeepSeekMetricKey(c.toString());
    if (typeof c === "object") {
      // Check one level deeper (for wrapped structures like models.deepseek-chat.total_tokens)
      if (Array.isArray(c)) return false;
      return Object.keys(c).some((k) => isDeepSeekMetricKey(k));
    }
    return false;
  });
}

function modelNameFromKey(key) {
  const k = String(key).toLowerCase();
  // Known model key → display name mapping
  if (/deepseek[-_]chat|chat|flash|deepseek[-_]v3/.test(k)) return "flash";
  if (/deepseek[-_]reasoner|reasoner|r1|pro|deepseek[-_]r1/.test(k)) return "pro";
  // Fallback: treat unknown model keys as "pro" (likely reasoning models)
  return k.slice(0, 12); // truncated raw key as last resort
}

function parseDeepSeekAmountPayload(payload) {
  return uniqueDeepSeekDays(collectDeepSeekDayItems(payload)).map((day) => {
    const bucket = emptyDay(day.date);
    const models = {};

    // Step 1: Identify model sub-objects — two patterns:
    //    a) "models" wrapper:  models: { "deepseek-chat": { total_tokens:... }, ... }
    //    b) direct sub-object: "deepseek-chat": { total_tokens:..., ... }
    function processModelValue(modelKey, modelValue) {
      const modelName = modelNameFromKey(modelKey);
      if (!modelName) return;
      const mb = newModelBucket();
      addDeepSeekMetricsFromNode(modelValue, mb, "tokens");
      mb.promptTokens += mb.cacheHitTokens + mb.cacheMissTokens;
      if (!mb.totalTokens) {
        mb.totalTokens = mb.promptTokens + mb.completionTokens + mb.reasoningTokens;
      } else {
        mb.totalTokens = Math.max(mb.totalTokens, mb.promptTokens + mb.completionTokens + mb.reasoningTokens);
      }
      models[modelName] = mb;
    }

    Object.entries(day).forEach(([key, value]) => {
      if (key === "date") return;
      // Pattern a: "models" wrapper — each child is a model
      if (key === "models" && value && typeof value === "object" && !Array.isArray(value)) {
        Object.entries(value).forEach(([mk, mv]) => processModelValue(mk, mv));
        return;
      }
      // Pattern b: direct model sub-object
      if (isSubObjectModelKey(key, value)) {
        processModelValue(key, value);
      }
    });

    // Step 2: Process only non-model keys into the main (total) bucket
    const modelKeys = new Set(["models"]);
    Object.keys(day).forEach((k) => {
      if (isSubObjectModelKey(k, day[k])) modelKeys.add(k);
    });
    const flat = {};
    Object.entries(day).forEach(([key, value]) => {
      if (key === "date" || modelKeys.has(key)) return;
      flat[key] = value;
    });
    addDeepSeekMetricsFromNode(flat, bucket, "tokens");

    // Step 3: Recompute derived fields on the main bucket
    bucket.promptTokens += bucket.cacheHitTokens + bucket.cacheMissTokens;
    if (!bucket.totalTokens) {
      bucket.totalTokens = bucket.promptTokens + bucket.completionTokens + bucket.reasoningTokens;
    } else {
      bucket.totalTokens = Math.max(bucket.totalTokens, bucket.promptTokens + bucket.completionTokens + bucket.reasoningTokens);
    }

    // Step 4: If the main bucket ended up empty but models have data,
    // compute totals from model sub-buckets
    if (!bucket.totalTokens && !bucket.promptTokens && !bucket.completionTokens) {
      Object.values(models).forEach((mb) => {
        bucket.totalTokens += mb.totalTokens;
        bucket.promptTokens += mb.promptTokens;
        bucket.completionTokens += mb.completionTokens;
        bucket.cacheHitTokens += mb.cacheHitTokens;
        bucket.cacheMissTokens += mb.cacheMissTokens;
        bucket.reasoningTokens += mb.reasoningTokens;
        bucket.cost += mb.cost;
        bucket.requests += mb.requests;
      });
    }

    bucket.models = models;
    return bucket;
  }).filter((item) => item.date && (item.totalTokens || item.requests));
}

function newModelBucket() {
  return {
    totalTokens: 0, promptTokens: 0, completionTokens: 0,
    cacheHitTokens: 0, cacheMissTokens: 0, reasoningTokens: 0,
    cost: 0, requests: 0
  };
}

function parseDeepSeekCostPayload(payload) {
  const byDate = new Map();

  uniqueDeepSeekDays(collectDeepSeekDayItems(payload)).forEach((day) => {
    const date = usageTools.normalizeDate(day.date);
    if (!date) return;
    if (!byDate.has(date)) {
      byDate.set(date, emptyDay(date));
    }
    const bucket = byDate.get(date);
    addDeepSeekMetricsFromNode(day, bucket, "cost");
  });

  return Array.from(byDate.values()).filter((item) => item.date && item.cost);
}

function collectDeepSeekDayItems(value, output = [], depth = 0) {
  if (depth > 8 || value == null) return output;

  if (Array.isArray(value)) {
    value.forEach((item) => collectDeepSeekDayItems(item, output, depth + 1));
    return output;
  }

  if (typeof value !== "object") return output;

  if (Array.isArray(value.days)) {
    value.days.forEach((day) => {
      if (day && typeof day === "object" && getDeepSeekDate(day)) {
        output.push({ ...day, date: getDeepSeekDate(day) });
      }
    });
  }

  const date = getDeepSeekDate(value);
  if (date && (hasDeepSeekUsageShape(value) || hasDeepSeekMetricKeys(value))) {
    output.push({ ...value, date });
  }

  Object.entries(value).forEach(([key, child]) => {
    if (key === "days") return;
    if (child && typeof child === "object") {
      collectDeepSeekDayItems(child, output, depth + 1);
    }
  });

  return uniqueDeepSeekDays(output);
}

function getDeepSeekDate(value) {
  if (!value || typeof value !== "object") return "";
  return usageTools.normalizeDate(value.date || value.day || value.usage_date || value.time || value.timestamp);
}

function hasDeepSeekUsageShape(value) {
  if (!value || typeof value !== "object") return false;
  return Array.isArray(value.data)
    || Array.isArray(value.usage)
    || Array.isArray(value.usages)
    || Array.isArray(value.items)
    || Array.isArray(value.records)
    || Array.isArray(value.children);
}

function hasDeepSeekMetricKeys(value) {
  return Object.keys(value || {}).some((key) => isDeepSeekMetricKey(key));
}

function uniqueDeepSeekDays(days) {
  const seen = new Set();
  return days.filter((day) => {
    const content = day.data || day.usage || day.usages || day.items || day.records || day.children || day;
    const marker = `${day.date}:${JSON.stringify(content).slice(0, 500)}`;
    if (seen.has(marker)) return false;
    seen.add(marker);
    return true;
  });
}

function addDeepSeekMetricsFromNode(value, bucket, mode, depth = 0) {
  if (depth > 10 || value == null) return;

  if (Array.isArray(value)) {
    value.forEach((item) => addDeepSeekMetricsFromNode(item, bucket, mode, depth + 1));
    return;
  }

  if (typeof value !== "object") return;

  const type = getDeepSeekMetricType(value);
  const amount = getDeepSeekMetricAmount(value);
  const handledTypedAmount = Boolean(type && amount);
  if (type && amount) {
    applyDeepSeekMetric(bucket, type, amount, mode);
  }

  Object.entries(value).forEach(([key, child]) => {
    if (child == null) return;
    if (handledTypedAmount && /^(amount|value|count|total|total_amount|number|tokens|token_count)$/i.test(key)) {
      return;
    }
    if (typeof child === "number" || typeof child === "string") {
      if (isDeepSeekMetricKey(key)) {
        applyDeepSeekMetric(bucket, key, usageTools.parseNumber(child), mode);
      }
      return;
    }
    if (typeof child === "object") {
      addDeepSeekMetricsFromNode(child, bucket, mode, depth + 1);
    }
  });
}

function getDeepSeekMetricType(value) {
  return String(
    value.type
    || value.usage_type
    || value.metric
    || value.metric_type
    || value.name
    || value.key
    || value.label
    || ""
  ).trim();
}

function getDeepSeekMetricAmount(value) {
  const keys = ["amount", "value", "count", "total", "total_amount", "number", "tokens", "token_count"];
  for (const key of keys) {
    if (value[key] == null) continue;
    if (typeof value[key] === "object") {
      const nested = getDeepSeekMetricAmount(value[key]);
      if (nested) return nested;
    } else {
      const parsed = usageTools.parseNumber(value[key]);
      if (parsed) return parsed;
    }
  }
  return 0;
}

function isDeepSeekMetricKey(key) {
  const normalized = String(key || "").toUpperCase();
  return /TOKEN|REQUEST|COST|AMOUNT|FEE|PRICE|CHARGE|INPUT|OUTPUT|PROMPT|COMPLETION|RESPONSE|CACHE|HIT|MISS/.test(normalized);
}

function applyDeepSeekMetric(bucket, rawType, amount, mode) {
  if (!amount) return;
  const type = String(rawType || "").toUpperCase();

  if (mode === "cost") {
    bucket.cost += amount;
    return;
  }

  if (/REQUEST|REQ_COUNT|CALL/.test(type) && !/TOKEN/.test(type)) {
    bucket.requests += amount;
    return;
  }

  if (/CACHE.*HIT|HIT.*CACHE|PROMPT_CACHE_HIT/.test(type)) {
    bucket.cacheHitTokens += amount;
    return;
  }

  if (/CACHE.*MISS|MISS.*CACHE|PROMPT_CACHE_MISS/.test(type)) {
    bucket.cacheMissTokens += amount;
    return;
  }

  if (/REASON/.test(type)) {
    bucket.reasoningTokens += amount;
    return;
  }

  if (/RESPONSE|OUTPUT|COMPLETION|GENERATED/.test(type)) {
    bucket.completionTokens += amount;
    return;
  }

  if (/PROMPT|INPUT|CONTEXT/.test(type)) {
    bucket.promptTokens += amount;
    return;
  }

  if (/TOKEN|TOKENS/.test(type)) {
    bucket.totalTokens += amount;
  }
}

function emptyDay(date) {
  return {
    date: usageTools.normalizeDate(date),
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    requests: 0,
    models: {
      flash: newModelBucket(),
      pro: newModelBucket()
    }
  };
}

function mergeDeepSeekDays(byDate, days) {
  days.forEach((day) => {
    if (!day || !day.date) return;
    if (!byDate.has(day.date)) {
      byDate.set(day.date, emptyDay(day.date));
    }
    const bucket = byDate.get(day.date);
    bucket.totalTokens += Number(day.totalTokens) || 0;
    bucket.promptTokens += Number(day.promptTokens) || 0;
    bucket.completionTokens += Number(day.completionTokens) || 0;
    bucket.cacheHitTokens += Number(day.cacheHitTokens) || 0;
    bucket.cacheMissTokens += Number(day.cacheMissTokens) || 0;
    bucket.reasoningTokens += Number(day.reasoningTokens) || 0;
    bucket.cost += Number(day.cost) || 0;
    bucket.requests += Number(day.requests) || 0;

    // Merge model buckets
    if (day.models) {
      mergeModelBucket(bucket.models.flash, day.models.flash);
      mergeModelBucket(bucket.models.pro, day.models.pro);
    }
  });
}

function mergeModelBucket(target, source) {
  if (!source) return;
  target.totalTokens += Number(source.totalTokens) || 0;
  target.promptTokens += Number(source.promptTokens) || 0;
  target.completionTokens += Number(source.completionTokens) || 0;
  target.cacheHitTokens += Number(source.cacheHitTokens) || 0;
  target.cacheMissTokens += Number(source.cacheMissTokens) || 0;
  target.reasoningTokens += Number(source.reasoningTokens) || 0;
  target.cost += Number(source.cost) || 0;
  target.requests += Number(source.requests) || 0;
}

function looksLikeCsv(text) {
  if (/^[\[{]/.test(String(text || "").trim())) {
    return false;
  }
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  return firstLine.includes(",") && /date|day|time|token|amount|cost|日期|时间|用量|金额/i.test(firstLine);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function emptyResult() {
  return {
    daily: [],
    rows: [],
    skipped: 0,
    tokenRows: 0
  };
}

module.exports = {
  collectUsageRecords,
  parseUsageTables,
  parseUsageText
};
