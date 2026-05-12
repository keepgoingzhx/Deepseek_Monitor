const { createUsageApiServer } = require("./src/usage-api-core");

const server = createUsageApiServer({
  port: Number(process.env.PORT || 8787),
  baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com"
});

server.start().then((runtime) => {
  console.log(`DeepSeek usage API running at http://127.0.0.1:${runtime.port}`);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});

process.on("SIGINT", async () => {
  await server.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await server.stop();
  process.exit(0);
});
