import { useCallback, useEffect, useState } from "react";
import { request, uploadPhoto, useWardrobeEvents, useRefreshGate } from "./api.js";
import { OptimizedImage } from "./OptimizedImage.jsx";

export function Outfits({ items }) {
  const [outfits, setOutfits] = useState([]); const [jobs, setJobs] = useState([]); const [reference, setReference] = useState(false);
  const [form, setForm] = useState({ count: 3, occasion: "", season: "", direction: "", generateModeled: false });
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [directions, setDirections] = useState({});
  const refreshGate = useRefreshGate();
  const refresh = useCallback(async () => { const current = refreshGate.begin(); try { const [o, j, s] = await Promise.all([request("/api/outfits"), request("/api/jobs"), request("/api/settings")]); if (!current()) return; setOutfits(o); setJobs(j); setReference(s.hasModelReference); } catch (e) { if (current()) setError(e.message); } }, [refreshGate]);
  useEffect(() => { refresh(); }, [refresh]); useWardrobeEvents(refresh);
  const perform = async (fn) => { setBusy(true); setError(""); try { await fn(); await refresh(); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  const curation = jobs.filter((j) => j.kind === "curation");
  return <section className="workspace-page" aria-label="Outfits">
    <div className="page-heading"><p className="eyebrow">Made from your wardrobe</p><h1>Outfits</h1><p>Build complete looks using pieces you already own.</p></div>
    <form className="outfit-form" onSubmit={(e) => { e.preventDefault(); perform(() => request("/api/outfits", { method: "POST", body: form })); }}>
      <label className="form-field">Looks<input type="number" min="1" max="12" required value={form.count} onChange={(e) => setForm({ ...form, count: Number(e.target.value) })} /></label>
      <label className="form-field">Occasion<input value={form.occasion} placeholder="Everyday, office, dinner…" onChange={(e) => setForm({ ...form, occasion: e.target.value })} /></label>
      <label className="form-field">Season<input value={form.season} placeholder="Fall, warm weather…" onChange={(e) => setForm({ ...form, season: e.target.value })} /></label>
      <label className="form-field outfit-direction">Styling direction<textarea rows="2" value={form.direction} placeholder="Relaxed layers, tonal colors…" onChange={(e) => setForm({ ...form, direction: e.target.value })} /></label>
      <label className="check-field"><input type="checkbox" disabled={!reference} checked={form.generateModeled} onChange={(e) => setForm({ ...form, generateModeled: e.target.checked })} />Generate modeled photos{!reference && " (add your reference in Settings)"}</label>
      <button className="primary-button" disabled={busy || !items.length}>Create outfits</button>
    </form>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {curation.map((j) => <div className="queue-notice" key={j.id}><p>{j.stages.analysis.error || j.progress || `Queued: ${j.count} outfits`}</p><div className="button-row">{j.stages.analysis.status === "failed" && <button className="secondary-button" disabled={busy} onClick={() => perform(() => request(`/api/import/jobs/${j.id}/stages/analysis/retry`, { method: "POST" }))}>Retry</button>}<button className="secondary-button" disabled={busy} onClick={() => perform(() => request(`/api/import/jobs/${j.id}/cancel`, { method: "POST" }))}>Cancel</button></div></div>)}
    {!outfits.length && !curation.length && <p className="empty-outfits">Your next favorite combination starts here. Import a top and a bottom, then create a few looks.</p>}
    <div className="outfit-grid">{outfits.map((outfit) => {
      const active = jobs.filter((j) => j.outfitId === outfit.id).at(-1); const state = active?.stages.modeled;
      const processing = ["processing", "queued"].includes(state?.status);
      return <article className="outfit-card" key={outfit.id}>
        {outfit.reviewImage || outfit.image ? <OptimizedImage className="outfit-photo" src={outfit.reviewImage || outfit.image} alt={outfit.name} sizes="(max-width: 600px) 100vw, 33vw" /> : <div className="outfit-pieces">{outfit.garmentIds.map((id) => { const item = items.find((i) => i.id === id); return item ? <OptimizedImage key={id} src={item.image} alt={item.name} sizes="120px" /> : <span key={id}>Piece removed</span>; })}</div>}
        <div className="outfit-card-content"><p className="eyebrow">{outfit.status === "accepted" ? "Approved look" : processing ? active.progress || "Queued for generation" : "Suggested look"}</p><h2>{outfit.name}</h2><p>{outfit.reason}</p><p className="outfit-item-names">{outfit.garmentIds.map((id) => items.find((i) => i.id === id)?.name || "Removed piece").join(" · ")}</p>
          {state?.error && <p className="inline-error">{state.error}</p>}
          <label className="form-field">Photo direction <span>optional</span><input value={directions[outfit.id] || ""} onChange={(e) => setDirections({ ...directions, [outfit.id]: e.target.value })} placeholder="A quiet courtyard…" /></label>
          <div className="button-row">{outfit.reviewImage && <button className="primary-button" disabled={busy} onClick={() => perform(() => request(`/api/outfits/${outfit.id}/approve`, { method: "POST", body: { reviewedAssetUrl: outfit.reviewImage } }))}>Approve photo</button>}<button className="secondary-button" disabled={busy || !reference || processing} onClick={() => perform(() => request(`/api/outfits/${outfit.id}/generate`, { method: "POST", body: { prompt: directions[outfit.id] || "" } }))}>{outfit.image || outfit.reviewImage ? "Regenerate" : "Generate photo"}</button>{processing && <button className="secondary-button" disabled={busy} onClick={() => perform(() => request(`/api/import/jobs/${active.id}/cancel`, { method: "POST" }))}>Cancel generation</button>}{state?.status === "failed" && <button className="secondary-button" disabled={busy} onClick={() => perform(() => request(`/api/import/jobs/${active.id}/stages/modeled/retry`, { method: "POST" }))}>Retry saved result</button>}</div>
          <div className="button-row"><label className="text-button file-button">Upload replacement<input type="file" accept="image/*" disabled={busy || processing} onChange={(e) => { const file = e.target.files[0]; e.target.value = ""; if (file) perform(() => uploadPhoto(`/api/outfits/${outfit.id}/replacement`, file)); }} /></label><button className="text-button" disabled={busy} onClick={() => perform(() => request(`/api/outfits/${outfit.id}`, { method: "DELETE" }))}>Delete look</button></div>
        </div>
      </article>;
    })}</div>
  </section>;
}
