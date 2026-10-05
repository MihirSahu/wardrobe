const sensitiveKey = /token|secret|password|authorization|cookie|credential|api[_-]?key|user[_-]?code|device[_-]?code|prompt|payload|base64|image|result/i;

export function redactLogMessage(value) {
  return String(value)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/Bearer\s+[^\s"',}]+/gi, "Bearer [redacted]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1[credentials redacted]@")
    .replace(/\b(?:sk-[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g, "[redacted]")
    .replace(/(["']?(?:[\w-]*(?:token|secret|password|api[_-]?key|authorization|cookie|credential)[\w-]*|user[_-]?code|device[_-]?code|prompt|payload|result)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, "$1[redacted]")
    .replace(/data:image\/[^;\s]+;base64,[A-Za-z0-9+/=]+/gi, "[image payload redacted]")
    .replace(/[A-Za-z0-9+/=_-]{120,}/g, "[payload redacted]")
    .slice(0, 4000);
}

function clean(value, depth = 0) {
  if (depth > 5) return "[omitted]";
  if (value instanceof Error) return redactLogMessage(value.message);
  if (Buffer.isBuffer(value)) return "[binary payload omitted]";
  if (typeof value === "string") return redactLogMessage(value);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => clean(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitiveKey.test(key) ? "[redacted]" : clean(item, depth + 1)]));
  return value;
}

export function createLogger({ enabled = process.env.WARDROBE_LOGS === "1", sink = (line) => process.stdout.write(line + "\n") } = {}) {
  return (source, event, details = {}) => {
    if (!enabled) return;
    // Logging must never interrupt an import, checkpoint or backup.
    try { sink(`${new Date().toISOString()} [${source}] ${event} ${JSON.stringify(clean(details))}`); } catch { /* unavailable output */ }
  };
}

export function streamDiagnostics(stream, log) {
  // Bound each native diagnostic line; discard oversized lines in their entirety.
  let pending = ""; let oversized = false;
  const flush = () => { if (oversized) log("codex", "stderr", { message: "Oversized diagnostic omitted" }); else if (pending.trim()) log("codex", "stderr", { message: pending }); pending = ""; oversized = false; };
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    const parts = chunk.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (!oversized) { if (pending.length + parts[i].length > 8000) { pending = ""; oversized = true; } else pending += parts[i]; }
      if (i < parts.length - 1) flush();
    }
  });
  stream.on("end", flush);
}
