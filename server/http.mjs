import Busboy from "busboy";
import { fail } from "./store.mjs";

export function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(value));
}
export async function body(req, limit = 35 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw fail("Request is too large", 413); chunks.push(chunk); }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw fail("Expected JSON"); }
}
export async function upload(req) {
  if (!req.headers["content-type"]?.startsWith("multipart/form-data")) {
    const value = await body(req);
    const match = value.imageDataUrl?.match(/^data:(image\/[^;]+);base64,(.+)$/s);
    if (!match) throw fail("Upload a photo using multipart/form-data");
    return { bytes: Buffer.from(match[2], "base64"), mime: match[1], filename: value.filename || value.metadata?.name || "New piece", manual: Boolean(value.manual) };
  }
  return new Promise((resolve, reject) => {
    let parser; try { parser = Busboy({ headers: req.headers, limits: { files: 1, fileSize: 25 * 1024 * 1024, fields: 5, fieldSize: 1500, parts: 6 } }); } catch { reject(fail("Invalid upload")); return; }
    let file; let error; const fields = {};
    parser.on("file", (name, stream, info) => {
      const chunks = []; stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("limit", () => { error = fail("Choose an image smaller than 25 MB", 413); });
      stream.on("end", () => { file = { bytes: Buffer.concat(chunks), mime: info.mimeType, filename: info.filename }; });
      stream.on("error", reject);
    });
    parser.on("field", (name, value) => { fields[name] = value; });
    for (const event of ["filesLimit", "fieldsLimit", "partsLimit"]) parser.on(event, () => { error = fail("Upload one image at a time", 413); });
    parser.on("error", () => reject(fail("Invalid multipart upload")));
    req.on("aborted", () => reject(fail("Upload interrupted")));
    parser.on("close", () => error ? reject(error) : !file ? reject(fail("Choose an image")) : resolve({ ...file, manual: fields.manual === "true" }));
    req.pipe(parser);
  });
}
