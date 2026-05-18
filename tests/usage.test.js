const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const usageTools = require("../usage.js");
const { normalizeUsage } = require("../src/state-store");
const { parseUsageText } = require("../src/usage-importer");
const { UsageApiServer, isAllowedCorsOrigin: isAllowedApiCorsOrigin } = require("../src/usage-api-core");
const { buildUpstreamUrl, createSseUsageParser, isAllowedCorsOrigin: isAllowedProxyCorsOrigin } = require("../src/proxy-server");

const csv = `created_at,model,prompt_tokens,completion_tokens,total_tokens,amount
2026-05-08 10:00:00,deepseek-chat,100,50,150,0.001
2026-05-08 11:00:00,deepseek-chat,200,30,230,0.002
2026-05-09,deepseek-reasoner,10,90,100,0.003
`;

const parsed = usageTools.parseCsv(csv);
const aggregated = usageTools.aggregateUsage(parsed.rows);
assert.equal(aggregated.daily.length, 2);
assert.equal(aggregated.daily[0].date, "2026-05-08");
assert.equal(aggregated.daily[0].totalTokens, 380);
assert.equal(aggregated.daily[0].models.flash.totalTokens, 380);
assert.equal(aggregated.daily[1].completionTokens, 90);
assert.equal(aggregated.daily[1].models.pro.totalTokens, 100);

const normalized = normalizeUsage({
  prompt_tokens: 4,
  completion_tokens: 6,
  completion_tokens_details: {
    reasoning_tokens: 2
  }
});
assert.equal(normalized.totalTokens, 10);
assert.equal(normalized.reasoningTokens, 2);

let captured = null;
const parser = createSseUsageParser((payload) => {
  captured = payload;
});
parser.push(Buffer.from('data: {"id":"1","usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3},"model":"deepseek-chat"}\n\n'));
parser.push(Buffer.from("data: [DONE]\n\n"));
parser.flush();
assert.equal(captured.usage.total_tokens, 3);
assert.equal(captured.model, "deepseek-chat");

const upstream = buildUpstreamUrl("http://example.com/v1/chat/completions?x=1", "https://api.deepseek.com");
assert.equal(upstream.href, "https://api.deepseek.com/v1/chat/completions?x=1");

assert.equal(isAllowedApiCorsOrigin("http://127.0.0.1:3000"), true);
assert.equal(isAllowedApiCorsOrigin("http://localhost:5173"), true);
assert.equal(isAllowedApiCorsOrigin("https://example.com"), false);
assert.equal(isAllowedProxyCorsOrigin("null"), false);

const usagePayload = {
  code: 0,
  data: {
    biz_data: {
      days: [
        {
          date: "2026-05-10",
          usage: [
            {
              model: "deepseek-v4-pro",
              usage: [
                { type: "PROMPT_TOKEN", amount: "10" },
                { type: "RESPONSE_TOKEN", amount: "5" },
                { type: "REQUEST", amount: "2" }
              ]
            },
            {
              model: "deepseek-v4-flash",
              usage: [
                { type: "PROMPT_CACHE_HIT_TOKEN", amount: "7" },
                { type: "PROMPT_CACHE_MISS_TOKEN", amount: "3" },
                { type: "RESPONSE_TOKEN", amount: "4" },
                { type: "REQUEST", amount: "1" }
              ]
            }
          ]
        }
      ],
      total: []
    }
  }
};
const parsedUsagePayload = parseUsageText(JSON.stringify(usagePayload), {
  contentType: "application/json",
  url: "https://platform.deepseek.com/api/v0/usage/amount?year=2026&month=5"
});
assert.equal(parsedUsagePayload.daily.length, 1);
assert.equal(parsedUsagePayload.daily[0].totalTokens, 29);
assert.equal(parsedUsagePayload.daily[0].models.pro.totalTokens, 15);
assert.equal(parsedUsagePayload.daily[0].models.flash.totalTokens, 14);
assert.equal(parsedUsagePayload.daily[0].requests, 3);

const tempDataFile = path.join(os.tmpdir(), `deepseek-usage-${Date.now()}.json`);
const usageServer = new UsageApiServer({ dataFile: tempDataFile });
try {
  usageServer.importDailyUsage([parsedUsagePayload.daily[0]]);
  usageServer.importDailyUsage([{
    ...parsedUsagePayload.daily[0],
    models: {
      flash: usageTools.emptyModelBucket(),
      pro: usageTools.emptyModelBucket()
    }
  }]);
  const storedDay = usageServer.getUsage().daily[0];
  assert.equal(storedDay.models.pro.totalTokens, 15);
  assert.equal(storedDay.models.flash.totalTokens, 14);
} finally {
  fs.rmSync(tempDataFile, { force: true });
}

console.log("usage tests ok");
