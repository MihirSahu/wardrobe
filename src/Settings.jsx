import { useCallback, useEffect, useState } from "react";
import { request, uploadPhoto, useWardrobeEvents, useRefreshGate } from "./api.js";

export function Settings({ onMigrated }) {
  const [settings, setSettings] = useState(null); const [connection, setConnection] = useState(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [uploadProgress, setUploadProgress] = useState(null);
  const [snapshots, setSnapshots] = useState(null); const [migration, setMigration] = useState(null);
  const refreshGate = useRefreshGate();
  const refresh = useCallback(async () => {
    const current = refreshGate.begin();
    try { const [s, c] = await Promise.all([request("/api/settings"), request("/api/connection")]); if (!current()) return; setSettings(s); setConnection(c); }
    catch (e) { if (current()) setError(e.message); }
  }, [refreshGate]);
  useEffect(() => { refresh(); }, [refresh]); useWardrobeEvents(refresh);
  useEffect(() => {
    if (!connection?.login) return;
    const timer = setInterval(refresh, 4000); return () => clearInterval(timer);
  }, [connection?.login, refresh]);
  useEffect(() => {
    try { const edits = JSON.parse(localStorage.getItem("open-wardrobe-edits-v1") || "{}"); const deleted = JSON.parse(localStorage.getItem("open-wardrobe-deleted-v1") || "[]"); if (Object.keys(edits).length || deleted.length) setMigration({ edits, deleted }); } catch { /* Leave malformed legacy data untouched. */ }
  }, []);
  const perform = async (fn) => { setBusy(true); setError(""); try { await fn(); await refresh(); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  const buckets = connection?.rateLimits?.rateLimitsByLimitId ? Object.entries(connection.rateLimits.rateLimitsByLimitId) : connection?.rateLimits?.rateLimits ? [["Codex", connection.rateLimits.rateLimits]] : [];
  return <section className="workspace-page settings-page" aria-label="Settings">
    <div className="page-heading"><p className="eyebrow">Your private wardrobe</p><h1>Settings</h1><p>Connect ChatGPT, add your reference photo, and keep your wardrobe backed up.</p></div>
    {error && <p className="status error" role="alert">{error}</p>}
    <div className="settings-grid">
      <article className="settings-card"><h2>ChatGPT connection</h2><p className="connection-state"><span className={`state-dot ${connection?.connected ? "is-connected" : ""}`} />{connection?.connected ? `Connected${connection.planType ? ` · ${connection.planType}` : ""}` : "Not connected"}</p>
        <p>Sign in on OpenAI’s page using your YubiKey. Requests use your included Codex usage.</p>
        {connection?.error && <p className="inline-error">{connection.error}</p>}
        {connection?.login ? <div className="device-login"><p>Open the sign-in page and enter this code:</p><strong className="device-code">{connection.login.userCode}</strong><div className="button-row"><a className="primary-button" href={connection.login.verificationUrl} target="_blank" rel="noreferrer">Open OpenAI sign-in</a><button className="secondary-button" disabled={busy} onClick={() => perform(() => request("/api/connection/cancel", { method: "POST" }))}>Cancel</button></div><p role="status">Waiting for sign-in…</p></div> : <div className="button-row"><button className="primary-button" disabled={busy} onClick={() => perform(() => request(connection?.connected ? "/api/connection/logout" : "/api/connection/login", { method: "POST" }))}>{connection?.connected ? "Disconnect" : "Connect ChatGPT"}</button><button className="secondary-button" disabled={busy} onClick={() => perform(() => request("/api/connection?refresh=1"))}>Refresh connection</button></div>}
        {!!connection?.models?.length && <label className="form-field">Generation model<select value={settings?.model || connection.models.find((m) => m.isDefault)?.model || ""} onChange={(e) => perform(() => request("/api/settings", { method: "PATCH", body: { model: e.target.value } }))}>{connection.models.map((m) => <option key={m.model} value={m.model}>{m.displayName || m.model}</option>)}</select></label>}
        {buckets.map(([id, bucket]) => <div className="usage-block" key={id}><strong>{bucket.limitName || id}</strong>{[bucket.primary, bucket.secondary].filter(Boolean).map((w, i) => <p key={i}>{w.usedPercent == null ? "Usage unavailable" : `${Math.max(0, Math.round(100 - w.usedPercent))}% remaining`}{w.resetsAt ? ` · resets ${new Date(w.resetsAt * 1000).toLocaleString()}` : ""}</p>)}</div>)}
        {settings?.queue?.paused && <div className="queue-notice"><p>{settings.queue.detail || "Queue paused"}</p><button className="secondary-button" disabled={busy} onClick={() => perform(() => request("/api/queue/resume", { method: "POST" }))}>Resume queue</button></div>}
      </article>
      <article className="settings-card"><h2>Your modeled-photo reference</h2><p>Use a clear photo of yourself for modeled garments and outfits. Clothing imports work without it.</p>
        {settings?.hasModelReference && <img className="identity-preview" src={`/api/reference?w=320&v=${settings.identityReference || "original"}`} alt="Your identity reference" />}
        <label className="secondary-button file-button">{settings?.hasModelReference ? "Replace reference" : "Upload reference"}<input type="file" accept="image/*,.heic,.heif" disabled={busy} onChange={(e) => { const file = e.target.files[0]; e.target.value = ""; if (file) perform(async () => { setUploadProgress(0); try { await uploadPhoto("/api/reference", file, { onProgress: setUploadProgress }); } finally { setUploadProgress(null); } }); }} /></label>
        {uploadProgress !== null && <p role="status">Uploading {uploadProgress}%</p>}
      </article>
      <article className="settings-card"><h2>Complete S3 backups</h2><p>Every file under data/ is included. Backups run hourly when changed and at least daily, with 30-day retention.</p>
        <dl className="backup-details"><dt>Last successful backup</dt><dd>{settings?.backup?.lastSuccess ? new Date(settings.backup.lastSuccess).toLocaleString() : "No backup yet"}</dd><dt>Changes</dt><dd>{settings?.backup?.pendingChanges ? "Awaiting backup" : "Backed up"}</dd></dl>
        {!settings?.backup?.configured && <p>Backups are not configured on this server yet.</p>}
        {settings?.backup?.error && <p className="inline-error">{settings.backup.error}</p>}
        {settings?.backup?.running && <p role="status">{settings.backup.progress}</p>}
        <div className="button-row"><button className="primary-button" disabled={busy || !settings?.backup?.configured || settings?.backup?.running} onClick={() => perform(() => request("/api/backup", { method: "POST" }))}>Back up now</button><button className="secondary-button" disabled={busy || !settings?.backup?.configured} onClick={() => perform(async () => setSnapshots(await request("/api/backup/snapshots")))}>View snapshots</button></div>
        {snapshots && <ul className="snapshot-list">{snapshots.slice(0, 30).map((s) => <li key={s.id}>{new Date(s.completedAt).toLocaleString()}<small>{s.id}</small></li>)}{!snapshots.length && <li>No completed snapshots</li>}</ul>}
      </article>
      {migration && <article className="settings-card"><h2>Move this browser’s edits to the server</h2><p>Review these older local changes before sharing them across devices.</p><details><summary>{Object.keys(migration.edits).length} edited pieces · {migration.deleted.length} deletion markers</summary><pre className="migration-preview">{JSON.stringify(migration, null, 2)}</pre></details><button className="primary-button" disabled={busy} onClick={() => perform(async () => { await request("/api/import/migrate", { method: "POST", body: migration }); localStorage.removeItem("open-wardrobe-edits-v1"); localStorage.removeItem("open-wardrobe-deleted-v1"); setMigration(null); onMigrated?.(); })}>Apply reviewed changes</button></article>}
    </div>
  </section>;
}
