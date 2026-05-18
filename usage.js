(function initUsageModule(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.DeepSeekUsage = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function buildUsageModule() {
  const DATE_HINTS = [
    "date",
    "day",
    "time",
    "created",
    "created_at",
    "request_time",
    "timestamp",
    "usage_date",
    "日期",
    "时间",
    "统计日期",
    "账单日期"
  ];

  const COST_HINTS = [
    "amount",
    "cost",
    "fee",
    "charge",
    "money",
    "spend",
    "spent",
    "price",
    "费用",
    "金额",
    "消费",
    "花费"
  ];

  const MODEL_HINTS = [
    "model",
    "model_id",
    "model_name",
    "model name"
  ];

  function normalizeHeader(header) {
    return String(header || "")
      .replace(/^\uFEFF/, "")
      .trim()
      .toLowerCase()
      .replace(/[\s./\\\-()[\]{}:]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  function parseCsv(text) {
    const input = String(text || "").replace(/^\uFEFF/, "");
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;

    for (let index = 0; index < input.length; index += 1) {
      const char = input[index];
      const next = input[index + 1];

      if (char === '"') {
        if (inQuotes && next === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (char === "," && !inQuotes) {
        row.push(field);
        field = "";
        continue;
      }

      if ((char === "\n" || char === "\r") && !inQuotes) {
        if (char === "\r" && next === "\n") {
          index += 1;
        }
        row.push(field);
        if (row.some((value) => String(value).trim() !== "")) {
          rows.push(row);
        }
        row = [];
        field = "";
        continue;
      }

      field += char;
    }

    row.push(field);
    if (row.some((value) => String(value).trim() !== "")) {
      rows.push(row);
    }

    if (!rows.length) {
      return { headers: [], rows: [] };
    }

    const headers = rows[0].map((header, index) => {
      const clean = String(header || "").replace(/^\uFEFF/, "").trim();
      return clean || `column_${index + 1}`;
    });

    const records = rows.slice(1).map((values) => {
      const record = {};
      headers.forEach((header, index) => {
        record[header] = values[index] == null ? "" : String(values[index]).trim();
      });
      return record;
    });

    return { headers, rows: records };
  }

  function parseNumber(value) {
    if (value == null) {
      return 0;
    }
    const cleaned = String(value)
      .trim()
      .replace(/,/g, "")
      .replace(/[￥$]/g, "")
      .replace(/\b(CNY|USD|RMB)\b/gi, "")
      .replace(/[^\d.+\-eE]/g, "");

    if (!cleaned || cleaned === "-" || cleaned === ".") {
      return 0;
    }

    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function findKey(row, candidates, options) {
    const mode = options && options.mode ? options.mode : "includes";
    const entries = Object.keys(row).map((key) => ({
      raw: key,
      normalized: normalizeHeader(key)
    }));
    const normalizedCandidates = candidates.map(normalizeHeader);

    const exact = entries.find((entry) => normalizedCandidates.includes(entry.normalized));
    if (exact) {
      return exact.raw;
    }

    if (mode === "exact") {
      return "";
    }

    const included = entries.find((entry) => {
      return normalizedCandidates.some((candidate) => {
        return candidate && (entry.normalized.includes(candidate) || entry.raw.includes(candidate));
      });
    });

    return included ? included.raw : "";
  }

  function findKeys(row, predicate) {
    return Object.keys(row).filter((key) => predicate(normalizeHeader(key), key));
  }

  function normalizeDate(value) {
    const raw = String(value || "").trim();
    if (!raw) {
      return "";
    }

    const isoLike = raw.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
    if (isoLike) {
      return [
        isoLike[1],
        isoLike[2].padStart(2, "0"),
        isoLike[3].padStart(2, "0")
      ].join("-");
    }

    const slashDate = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
    if (slashDate) {
      return [
        slashDate[3],
        slashDate[1].padStart(2, "0"),
        slashDate[2].padStart(2, "0")
      ].join("-");
    }

    if (/^\d{10}$/.test(raw) || /^\d{13}$/.test(raw)) {
      const millis = raw.length === 10 ? Number(raw) * 1000 : Number(raw);
      return formatLocalDate(new Date(millis));
    }

    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      return formatLocalDate(parsed);
    }

    return "";
  }

  function formatLocalDate(date) {
    // Use UTC — DeepSeek's API returns billing data keyed by UTC dates,
    // and the stored daily usage uses UTC dates throughout.
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function getDateValue(row) {
    const dateKey = findKey(row, DATE_HINTS);
    if (!dateKey) {
      return "";
    }
    return normalizeDate(row[dateKey]);
  }

  function getMetric(row, candidates) {
    const key = findKey(row, candidates);
    return key ? parseNumber(row[key]) : 0;
  }

  function getTokenTotalFromAnyColumn(row, typedKeys) {
    const tokenKeys = findKeys(row, (normalized, raw) => {
      const looksToken = normalized.includes("token") || raw.includes("用量");
      const isTyped = typedKeys.includes(raw);
      const isPrice = COST_HINTS.some((hint) => normalized.includes(normalizeHeader(hint)) || raw.includes(hint));
      return looksToken && !isTyped && !isPrice;
    });

    return tokenKeys.reduce((sum, key) => sum + parseNumber(row[key]), 0);
  }

  function extractUsage(row) {
    const totalKey = findKey(row, [
      "total_tokens",
      "tokens_total",
      "token_total",
      "total_token",
      "total token",
      "tokens",
      "token_count",
      "总token",
      "总tokens",
      "总用量",
      "token用量"
    ]);
    const promptKey = findKey(row, [
      "prompt_tokens",
      "input_tokens",
      "input_token",
      "prompt token",
      "input token",
      "输入token",
      "输入tokens",
      "输入用量"
    ]);
    const completionKey = findKey(row, [
      "completion_tokens",
      "output_tokens",
      "output_token",
      "completion token",
      "output token",
      "输出token",
      "输出tokens",
      "输出用量"
    ]);
    const cacheHitKey = findKey(row, [
      "prompt_cache_hit_tokens",
      "cache_hit_tokens",
      "cache hit",
      "缓存命中token",
      "缓存命中tokens",
      "缓存命中"
    ]);
    const cacheMissKey = findKey(row, [
      "prompt_cache_miss_tokens",
      "cache_miss_tokens",
      "cache miss",
      "缓存未命中token",
      "缓存未命中tokens",
      "缓存未命中"
    ]);
    const reasoningKey = findKey(row, [
      "reasoning_tokens",
      "reasoning token",
      "思考token",
      "推理token",
      "推理tokens"
    ]);

    const typedKeys = [totalKey, promptKey, completionKey, cacheHitKey, cacheMissKey, reasoningKey].filter(Boolean);
    const cacheHitTokens = cacheHitKey ? parseNumber(row[cacheHitKey]) : 0;
    const cacheMissTokens = cacheMissKey ? parseNumber(row[cacheMissKey]) : 0;
    const promptTokens = promptKey ? parseNumber(row[promptKey]) : cacheHitTokens + cacheMissTokens;
    const completionTokens = completionKey ? parseNumber(row[completionKey]) : 0;
    const reasoningTokens = reasoningKey ? parseNumber(row[reasoningKey]) : 0;
    const fallbackTokens = getTokenTotalFromAnyColumn(row, typedKeys);
    const totalTokens = totalKey
      ? parseNumber(row[totalKey])
      : promptTokens + completionTokens || fallbackTokens;

    const costKey = findKey(row, COST_HINTS);
    const cost = costKey ? parseNumber(row[costKey]) : 0;

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

  function getModelBucketKey(row) {
    const modelKey = findKey(row, MODEL_HINTS, { mode: "exact" });
    const model = modelKey ? String(row[modelKey] || "").toLowerCase() : "";
    if (!model) {
      return "";
    }

    const hasFlash = /flash|deepseek[-_]chat|deepseek[-_]v3|\bchat\b/.test(model);
    const hasPro = /pro|reasoner|deepseek[-_]r1|\br1\b/.test(model);
    if (hasFlash && !hasPro) {
      return "flash";
    }
    if (hasPro && !hasFlash) {
      return "pro";
    }
    return "";
  }

  function aggregateUsage(rows) {
    const daily = new Map();
    let skipped = 0;
    let tokenRows = 0;

    rows.forEach((row) => {
      const date = getDateValue(row);
      const usage = extractUsage(row);

      if (!date || (!usage.totalTokens && !usage.promptTokens && !usage.completionTokens && !usage.cost)) {
        skipped += 1;
        return;
      }

      if (usage.totalTokens || usage.promptTokens || usage.completionTokens) {
        tokenRows += 1;
      }

      if (!daily.has(date)) {
        daily.set(date, {
          date,
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

      const bucket = daily.get(date);
      const modelBucketKey = getModelBucketKey(row);
      bucket.totalTokens += usage.totalTokens;
      bucket.promptTokens += usage.promptTokens;
      bucket.completionTokens += usage.completionTokens;
      bucket.cacheHitTokens += usage.cacheHitTokens;
      bucket.cacheMissTokens += usage.cacheMissTokens;
      bucket.reasoningTokens += usage.reasoningTokens;
      bucket.cost += usage.cost;
      bucket.requests += 1;

      if (modelBucketKey) {
        if (!bucket.models) {
          bucket.models = { flash: emptyModelBucket(), pro: emptyModelBucket() };
        }
        const modelBucket = bucket.models[modelBucketKey];
        modelBucket.totalTokens += usage.totalTokens;
        modelBucket.promptTokens += usage.promptTokens;
        modelBucket.completionTokens += usage.completionTokens;
        modelBucket.cacheHitTokens += usage.cacheHitTokens;
        modelBucket.cacheMissTokens += usage.cacheMissTokens;
        modelBucket.reasoningTokens += usage.reasoningTokens;
        modelBucket.cost += usage.cost;
        modelBucket.requests += 1;
      }
    });

    return {
      daily: Array.from(daily.values()).sort((a, b) => a.date.localeCompare(b.date)),
      skipped,
      tokenRows
    };
  }

  function mergeDailyUsage(existing, incoming) {
    const byDate = new Map();

    (existing || []).forEach((item) => {
      if (item && item.date) {
        byDate.set(item.date, cloneUsageDay(item));
      }
    });

    (incoming || []).forEach((item) => {
      if (item && item.date) {
        const existingDay = byDate.get(item.date);
        if (existingDay && item.models) {
          // Preserve existing model data and merge with incoming models
          const merged = cloneUsageDay(item);
          merged.models = {
            flash: cloneModelBucket(existingDay.models && existingDay.models.flash
              ? (existingDay.models.flash.totalTokens ? existingDay.models.flash : item.models.flash)
              : item.models.flash),
            pro: cloneModelBucket(existingDay.models && existingDay.models.pro
              ? (existingDay.models.pro.totalTokens ? existingDay.models.pro : item.models.pro)
              : item.models.pro)
          };
          byDate.set(item.date, merged);
        } else {
          byDate.set(item.date, cloneUsageDay(item));
        }
      }
    });

    return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  function cloneModelBucket(m) {
    if (!m || typeof m !== "object") {
      return emptyModelBucket();
    }
    return {
      totalTokens: Number(m.totalTokens) || 0,
      promptTokens: Number(m.promptTokens) || 0,
      completionTokens: Number(m.completionTokens) || 0,
      cacheHitTokens: Number(m.cacheHitTokens) || 0,
      cacheMissTokens: Number(m.cacheMissTokens) || 0,
      reasoningTokens: Number(m.reasoningTokens) || 0,
      cost: Number(m.cost) || 0,
      requests: Number(m.requests) || 0
    };
  }

  function emptyModelBucket() {
    return {
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      reasoningTokens: 0,
      cost: 0,
      requests: 0
    };
  }

  function cloneUsageDay(item) {
    const models = item ? item.models : null;
    return {
      date: item.date,
      totalTokens: Number(item.totalTokens) || 0,
      promptTokens: Number(item.promptTokens) || 0,
      completionTokens: Number(item.completionTokens) || 0,
      cacheHitTokens: Number(item.cacheHitTokens) || 0,
      cacheMissTokens: Number(item.cacheMissTokens) || 0,
      reasoningTokens: Number(item.reasoningTokens) || 0,
      cost: Number(item.cost) || 0,
      requests: Number(item.requests) || 0,
      models: models && typeof models === "object"
        ? {
            flash: cloneModelBucket(models.flash),
            pro: cloneModelBucket(models.pro)
          }
        : { flash: emptyModelBucket(), pro: emptyModelBucket() }
    };
  }

  function summarize(daily, now) {
    const today = formatLocalDate(now || new Date());
    const month = today.slice(0, 7);
    const list = (daily || []).map(cloneUsageDay).sort((a, b) => a.date.localeCompare(b.date));
    const latest = list[list.length - 1] || null;

    const todayItems = list.filter((item) => item.date === today);
    const monthItems = list.filter((item) => item.date.slice(0, 7) === month);

    function modelSum(field, modelKey) {
      return todayItems.reduce((sum, item) => {
        const bucket = item.models && item.models[modelKey];
        return bucket ? sum + (Number(bucket[field]) || 0) : sum;
      }, 0);
    }

    function modelMonthSum(field, modelKey) {
      return monthItems.reduce((sum, item) => {
        const bucket = item.models && item.models[modelKey];
        return bucket ? sum + (Number(bucket[field]) || 0) : sum;
      }, 0);
    }

    return {
      today,
      todayTokens: sumWhere(todayItems, () => true, "totalTokens"),
      monthTokens: sumWhere(monthItems, () => true, "totalTokens"),
      monthCost: sumWhere(monthItems, () => true, "cost"),
      latest,
      firstDate: list[0] ? list[0].date : "",
      lastDate: latest ? latest.date : "",
      days: list.length,
      flash: {
        todayTokens: modelSum("totalTokens", "flash"),
        todayRequests: modelSum("requests", "flash"),
        todayCost: modelSum("cost", "flash"),
        monthTokens: modelMonthSum("totalTokens", "flash"),
        monthCost: modelMonthSum("cost", "flash")
      },
      pro: {
        todayTokens: modelSum("totalTokens", "pro"),
        todayRequests: modelSum("requests", "pro"),
        todayCost: modelSum("cost", "pro"),
        monthTokens: modelMonthSum("totalTokens", "pro"),
        monthCost: modelMonthSum("cost", "pro")
      }
    };
  }

  function sumWhere(list, predicate, field) {
    return list.reduce((sum, item) => (predicate(item) ? sum + (Number(item[field]) || 0) : sum), 0);
  }

  return {
    aggregateUsage,
    cloneModelBucket,
    emptyModelBucket,
    formatLocalDate,
    mergeDailyUsage,
    normalizeDate,
    parseCsv,
    parseNumber,
    summarize
  };
});
