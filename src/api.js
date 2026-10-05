import { useEffect, useRef } from "react";
import { createRefreshGate } from "./refresh-gate.mjs";

export function useRefreshGate() { return useRef(createRefreshGate()).current; }

export async function request(url, { body, ...options } = {}) {
  const response = await fetch(url, {
    ...options, cache: "no-store",
    ...(body === undefined ? {} : body instanceof FormData ? { body } : { headers: { "Content-Type": "application/json", ...options.headers }, body: JSON.stringify(body) }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "The request failed. Try again.");
  return result;
}

export function uploadPhoto(url, file, { manual = false, onProgress = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); const form = new FormData();
    form.append("image", file); form.append("manual", String(manual));
    xhr.open("POST", url);
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)); };
    xhr.onerror = () => reject(new Error("Upload interrupted. Check your connection and try again."));
    xhr.onload = () => { let result; try { result = JSON.parse(xhr.responseText); } catch { reject(new Error("Invalid upload response")); return; } if (xhr.status >= 200 && xhr.status < 300) resolve(result); else reject(new Error(result.error || "Upload failed")); };
    xhr.send(form);
  });
}

export function useWardrobeEvents(refresh) {
  useEffect(() => {
    const source = new EventSource("/api/events");
    source.addEventListener("change", refresh); source.addEventListener("open", refresh);
    const foreground = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", foreground);
    return () => { source.close(); document.removeEventListener("visibilitychange", foreground); };
  }, [refresh]);
}
