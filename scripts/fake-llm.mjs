// 本机假模型服务器：不联网、不花 token，专门复现"卡住 / 响应被截断 / 401 / 正常"这几种故障。
//
// 为什么要它：用户报的 `error decoding response body`（响应被截断）、"查询卡住没有停止按钮"
// 这两类问题，用真 API 既复现不出来（它平时是好的），也不该为了复现而反复花钱。
//
// 用法：
//   node scripts/fake-llm.mjs --port 8787 --mode hang        # 收下连接，永不回话 → 复现"卡住"
//   node scripts/fake-llm.mjs --port 8787 --mode truncate    # 声明 200 字节只给 20 字节 → 复现被截断
//   node scripts/fake-llm.mjs --port 8787 --mode unauthorized
//   node scripts/fake-llm.mjs --port 8787 --mode ok
//
// 再让应用指过来（跳过系统代理，否则请求会被 HTTP_PROXY 转走）：
//   $env:MEMORY_CARD_DB="...\tmp\fake.db"; $env:DEEPSEEK_BASE_URL="http://127.0.0.1:8787"
//   $env:DEEPSEEK_API_KEY="sk-fake"; $env:NO_PROXY="127.0.0.1,localhost"

import net from "node:net";

const args = new Map();
for (let i = 2; i < process.argv.length - 1; i += 2) args.set(process.argv[i], process.argv[i + 1]);

const port = Number(args.get("--port") ?? 8787);
const mode = args.get("--mode") ?? "hang";
const MODES = ["hang", "truncate", "unauthorized", "ok"];
if (!MODES.includes(mode)) {
  console.error(`--mode 只能是 ${MODES.join(" / ")}，给的是 ${mode}`);
  process.exit(2);
}

const chat = (extra = {}) =>
  JSON.stringify({
    id: "fake-1",
    model: "fake-model-2026",
    choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
    usage: { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 12, completion_tokens: 2 },
    ...extra,
  });

/** 按 Content-Length 发完再关：故意用长度头而不是直接 end，这样"截断"才有意义。 */
function send(socket, status, body, { declaredLength = null, truncateAt = null } = {}) {
  const bytes = Buffer.from(body, "utf8");
  const length = declaredLength ?? bytes.length;
  socket.write(
    `HTTP/1.1 ${status}\r\n` +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${length}\r\n` +
      "Connection: close\r\n\r\n",
  );
  socket.write(truncateAt === null ? bytes : bytes.subarray(0, truncateAt));
  socket.end();
}

let seen = 0;
const server = net.createServer((socket) => {
  let raw = "";
  socket.on("data", (chunk) => {
    raw += chunk.toString("utf8");
    if (!raw.includes("\r\n\r\n")) return;
    // 请求头和体可能分两次到达；这里只等到头，够我们判断是不是一次 chat 请求了。
    const line = raw.split("\r\n")[0];
    seen += 1;
    console.log(`[fake-llm] #${seen} ${line}  (mode=${mode})`);

    if (mode === "hang") return; // 一个字都不回，连接就这么挂着
    if (mode === "truncate") {
      // 声明 200 字节、只给 20 字节就关 —— reqwest 会报 `error decoding response body`。
      send(socket, "200 OK", chat(), { declaredLength: 200, truncateAt: 20 });
      return;
    }
    if (mode === "unauthorized") {
      send(socket, "401 Unauthorized", JSON.stringify({ error: { message: "Authentication Fails" } }));
      return;
    }
    send(socket, "200 OK", chat());
  });
  socket.on("error", () => {}); // 客户端主动断开（点了停止）不算错
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[fake-llm] http://127.0.0.1:${port} mode=${mode} —— 等你把应用的 Base URL 指过来`);
});
