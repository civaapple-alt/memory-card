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
//   node scripts/fake-llm.mjs --port 8787 --mode definition  # 回一条像样的释义 JSON
//
// 再让应用指过来（跳过系统代理，否则请求会被 HTTP_PROXY 转走）：
//   $env:MEMORY_CARD_DB="...\tmp\fake.db"; $env:DEEPSEEK_BASE_URL="http://127.0.0.1:8787"
//   $env:DEEPSEEK_API_KEY="sk-fake"; $env:NO_PROXY="127.0.0.1,localhost"
//
// `definition` 模式还会把请求体里的 `term:` / `sentence:` 打进日志 ——
// 界面把两个输入框传成什么样，日志里就是什么样，不用猜。

import net from "node:net";

const args = new Map();
for (let i = 2; i < process.argv.length - 1; i += 2) args.set(process.argv[i], process.argv[i + 1]);

const port = Number(args.get("--port") ?? 8787);
const mode = args.get("--mode") ?? "hang";
const MODES = ["hang", "truncate", "unauthorized", "ok", "definition"];
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

/**
 * `definition` 模式的假释义。
 *
 * `in_context` 故意**总是**非空 —— 真模型就是这样：prompt 里它是必填字段，
 * 哪怕没给句子它也会拿领域知识把它填满。界面该不该显示这一块，是界面自己的事。
 */
const FAKE_DEFINITION = {
  lemma: "presentation",
  pos: "n.",
  domain_meaning: "（假模型）软件架构里指与界面和交互相关的那一层，即表示层。",
  general_meaning: "（假模型）演示、报告；呈现的行为。",
  why_translation_fails: "",
  in_context: "（假模型）在这句话里，presentation 指负责把数据渲染给用户的那一层。",
  examples: ["The presentation layer handles user input and displays data."],
  collocations: ["presentation layer", "presentation logic"],
  confidence: "high",
};

const definitionChat = () =>
  chat({
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify(FAKE_DEFINITION) },
        finish_reason: "stop",
      },
    ],
  });

/** 这次请求里 `term:` / `sentence:` 各是什么 —— 界面传了什么，日志就说什么。 */
function describeBody(body) {
  try {
    const req = JSON.parse(body);
    const user = [...(req.messages ?? [])].reverse().find((m) => m.role === "user");
    const prompt = typeof user?.content === "string" ? user.content : "";
    const grab = (name) => {
      const m = new RegExp(`(?:^|\\n)${name}: (.*)`).exec(prompt);
      return m ? m[1] : "(没找到)";
    };
    return `term=${JSON.stringify(grab("term"))} sentence=${JSON.stringify(grab("sentence"))}`;
  } catch {
    return "(请求体不是 JSON，跳过)";
  }
}

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
  let handled = false;
  socket.on("data", (chunk) => {
    raw += chunk.toString("utf8");
    if (handled) return;
    const split = raw.indexOf("\r\n\r\n");
    if (split < 0) return;
    const head = raw.slice(0, split);
    const body = raw.slice(split + 4);
    // 正文可能还在路上：声明了多长就等够多长，否则 describeBody 看到的是半截。
    // 比较用字节数 —— 请求体里有中文，按字符数比会永远等不到。
    const declared = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
    if (Buffer.byteLength(body) < declared) return;
    handled = true;

    const line = head.split("\r\n")[0];
    seen += 1;
    console.log(`[fake-llm] #${seen} ${line}  (mode=${mode})`);
    console.log(`[fake-llm]     ${describeBody(body)}`);

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
    if (mode === "definition") {
      send(socket, "200 OK", definitionChat());
      return;
    }
    send(socket, "200 OK", chat());
  });
  socket.on("error", () => {}); // 客户端主动断开（点了停止）不算错
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[fake-llm] http://127.0.0.1:${port} mode=${mode} —— 等你把应用的 Base URL 指过来`);
});
