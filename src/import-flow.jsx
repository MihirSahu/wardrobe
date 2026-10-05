import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowCounterClockwise, Check, Plus, SpinnerGap, Trash, UploadSimple, WarningCircle, X } from "@phosphor-icons/react";
import "./import-flow.css";
import { request, uploadPhoto, useWardrobeEvents } from "./api.js";
import { acknowledgeDraft, defaultDraft, importDraftPatch, refreshDrafts } from "./import-drafts.mjs";
import { failedImageStage, canCleanGarment } from "./import-recovery.mjs";
import { uploadPhotoBatch } from "./upload-batch.mjs";

const API = "/api/import/jobs";
const CONFIG_API = "/api/import/config";
const PARTS = [
  ["upperbody", "Tops"],
  ["wholebody_up", "Jackets"],
  ["lowerbody", "Bottoms"],
  ["accessories_up", "Accessories"],
  ["shoes", "Shoes"],
];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function deriveStatus(job) {
  const crop = job.stages?.crop;
  const garment = job.stages?.garment;
  const modeled = job.stages?.modeled;
  if (job.status === "complete") return { tone: "complete", text: "Piece added" };
  if (job.stages?.analysis?.status === "failed") return { tone: "error", text: "Analysis needs attention", detail: job.stages.analysis.error };
  if (job.error || crop?.status === "failed" || garment?.status === "failed" || modeled?.status === "failed") return { tone: "error", text: "Import needs attention", detail: crop?.error || garment?.error || modeled?.error || job.error };
  if (modeled?.status === "review") return { tone: "ready", text: "Modeled image ready for review" };
  if (modeled?.status === "processing") return { tone: "processing", text: "Styling modeled image" };
  if (garment?.status === "review") return { tone: "ready", text: "Ready for review" };
  if (job.progress && !reviewStageFor(job)) return { tone: "processing", text: job.progress };
  if (garment?.status === "approved") return { tone: "processing", text: "Creating modeled image" };
  if (crop?.status === "review") return { tone: "ready", text: "Crop ready for review" };
  if (crop?.status === "approved") return { tone: "processing", text: "Creating garment image" };
  if (crop?.status === "rejected" || garment?.status === "rejected" || modeled?.status === "rejected") return { tone: "complete", text: "Import declined" };
  return { tone: "processing", text: "Extracting clothing from image" };
}

function reviewStageFor(job) {
  if (job.stages?.modeled?.status === "review") return "modeled";
  if (job.stages?.garment?.status === "review") return "garment";
  if (job.stages?.crop?.status === "review") return "crop";
  return null;
}

function ReviewEditor({ job, stage, draft, setDraft, regenPrompt, setRegenPrompt, busy, onAction, hasReference }) {
  const asset = job.stages[stage]?.assetUrl;
  const isCrop = stage === "crop";
  const isGarment = stage === "garment";
  const primaryValid = HEX_COLOR.test(draft.color);
  const secondaryValid = !draft.secondaryColor || HEX_COLOR.test(draft.secondaryColor);
  return (
    <div className="import-editor">
      <img className="import-editor__preview" src={asset} alt={isCrop ? "Detected item crop" : isGarment ? "Extracted garment" : "Generated modeled look"} />
      <div className="import-fields">
        <p className="import-editor__stage">{isCrop ? "Detected item" : isGarment ? "Garment image" : "Modeled image"}</p>
        {isCrop && <p className="import-card__detail">Check the intended item. Adjust its details and crop before starting generation.</p>}
        {(isCrop || isGarment) ? (
          <>
            <div className="import-field"><label htmlFor={`name-${job.id}`}>Name</label><input id={`name-${job.id}`} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></div>
            <div className="import-field"><label htmlFor={`part-${job.id}`}>Category</label><select id={`part-${job.id}`} value={draft.part} onChange={(event) => setDraft({ ...draft, part: event.target.value })}>{PARTS.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></div>
            <div className="import-field"><label htmlFor={`primary-${job.id}`}>Primary color</label><div className="import-color-row"><input id={`primary-${job.id}`} type="color" value={primaryValid ? draft.color : "#000000"} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /><input aria-label="Primary color hex" aria-invalid={!primaryValid} value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /></div>{!primaryValid && <small className="import-field-error">Use a six-digit hex color, such as #d8d0c2.</small>}</div>
            <div className="import-field"><label htmlFor={`secondary-${job.id}`}>Secondary color <span>optional</span></label><input id={`secondary-${job.id}`} type="text" aria-invalid={!secondaryValid} placeholder="#hex or leave blank" value={draft.secondaryColor} onChange={(event) => setDraft({ ...draft, secondaryColor: event.target.value })} />{!secondaryValid && <small className="import-field-error">Use a six-digit hex color or leave this empty.</small>}</div>
            <div className="import-field"><label htmlFor={`tags-${job.id}`}>Details</label><input id={`tags-${job.id}`} value={draft.tags} placeholder="casual, cotton, striped" onChange={(event) => setDraft({ ...draft, tags: event.target.value })} /></div>
          </>
        ) : <p className="import-card__detail">Approve this editorial image to attach it to the new wardrobe piece, or regenerate it with a more specific direction.</p>}
        {isCrop && <fieldset className="crop-fields"><legend>Crop bounds (0–1000)</legend>{["x", "y", "width", "height"].map((key) => <label key={key}>{key}<input type="number" min={key === "width" || key === "height" ? 1 : 0} max="1000" value={draft.boundingBox[key]} onChange={(e) => setDraft({ ...draft, boundingBox: { ...draft.boundingBox, [key]: Number(e.target.value) } })} /></label>)}</fieldset>}
        {isGarment && <label className="check-field"><input type="checkbox" disabled={!hasReference} checked={draft.generateModeled} onChange={(e) => setDraft({ ...draft, generateModeled: e.target.checked })} />Also generate a modeled photo{!hasReference && " (add a reference in Settings)"}</label>}
        {!isCrop && <label className="text-button file-button">Upload replacement<input type="file" accept="image/*" disabled={busy} onChange={(e) => { const file = e.target.files[0]; e.target.value = ""; if (file) onAction("upload", file); }} /></label>}
        {!isCrop && <div className="import-field import-regenerate-field">
          <label htmlFor={`regenerate-${job.id}-${stage}`}>Regeneration direction <span>optional</span></label>
          <textarea id={`regenerate-${job.id}-${stage}`} rows="3" value={regenPrompt} onChange={(event) => setRegenPrompt(event.target.value)} placeholder={isGarment ? "Example: preserve the original zipper and remove the retail tag" : "Example: use a quiet evening street and show the full garment"} />
        </div>}
        <div className="import-actions">
          <button className="import-button" disabled={busy} onClick={() => onAction("reject")}><Trash size={14} /> Reject</button>
          {!isCrop && <button className="import-button" disabled={busy} onClick={() => onAction("regenerate", regenPrompt)}><ArrowCounterClockwise size={14} /> Regenerate</button>}
          {isCrop && <button className="import-button" disabled={busy} onClick={() => onAction("preview")}>Preview crop</button>}
          <button className="import-button import-button--primary" disabled={busy || ((isGarment || isCrop) && (!draft.name.trim() || !primaryValid || !secondaryValid))} onClick={() => onAction("approve")}><Check size={14} weight="bold" /> {isCrop ? "Use crop" : "Approve"}</button>
        </div>
      </div>
    </div>
  );
}

function RecoveryEditor({ job, stage: name, tolerance, setTolerance, busy, onPreview, onAccept, regenPrompt, setRegenPrompt, onAction }) {
  const stage = job.stages[name];
  const cleanupAvailable = name === "garment" && canCleanGarment(job);
  const contaminated = stage.cleanupDiagnostics?.contaminatedPixels;
  const previewTimer = useRef(null);
  useEffect(() => () => clearTimeout(previewTimer.current), []);
  useEffect(() => { clearTimeout(previewTimer.current); }, [busy, stage.rawAsset]);
  const updateTolerance = (next) => {
    setTolerance(next);
    clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => onPreview(next), 300);
  };
  return (
    <div className="import-cleanup-editor">
      <p className="import-editor__stage">{cleanupAvailable ? "Background cleanup" : name === "garment" ? "Garment image needs attention" : "Modeled photo needs attention"}</p>
      {stage.error && <p className="inline-error" role="alert">{stage.error}</p>}
      {cleanupAvailable ? <>
      <p className="import-card__detail">The generated garment is preserved below. Adjust the cleanup locally—this does not call the image model again.</p>
      <div className="import-cleanup-comparison">
        <figure><img src={stage.failedAssetUrl} alt="Generated garment on its chroma background" /><figcaption>Generated source</figcaption></figure>
        <figure><img src={stage.cleanupPreviewUrl || stage.failedAssetUrl} alt="Transparent garment cleanup preview" /><figcaption>{stage.cleanupPreviewUrl ? "Cleanup preview" : "Preview appears here"}</figcaption></figure>
      </div>
      <div className="import-field import-cleanup-strength">
        <label htmlFor={`cleanup-${job.id}`}>Cleanup strength <strong>{tolerance}</strong></label>
        <input id={`cleanup-${job.id}`} type="range" min="18" max="110" step="2" disabled={busy} value={tolerance} onChange={(event) => updateTolerance(Number(event.target.value))} />
        <div className="import-cleanup-scale"><span>Preserve more edge detail</span><span>Remove more background</span></div>
      </div>
      {Number.isFinite(contaminated) && <p className="import-card__detail">The automated check sees {contaminated.toLocaleString()} tinted edge {contaminated === 1 ? "pixel" : "pixels"}. If the preview looks clean, you can still use it.</p>}
      <div className="import-actions">
        <button className="import-button" disabled={busy} onClick={() => onPreview(tolerance)}><ArrowCounterClockwise size={14} /> Preview cleanup</button>
        <button className="import-button import-button--primary" disabled={busy} onClick={onAccept}><Check size={14} weight="bold" /> Use this cleanup</button>
      </div>
      </> : <>
        {(stage.failedAssetUrl || stage.assetUrl) && <img className="import-editor__preview" src={stage.failedAssetUrl || stage.assetUrl} alt="Saved image from the failed generation" />}
        <p className="import-card__detail">Generate a new image or upload a replacement to continue. Retry uses any saved output again.</p>
      </>}
      <div className="import-field import-regenerate-field">
        <label htmlFor={`recovery-${job.id}-${name}`}>Regeneration direction <span>optional</span></label>
        <textarea id={`recovery-${job.id}-${name}`} rows="3" value={regenPrompt} onChange={(e) => setRegenPrompt(e.target.value)} placeholder="Describe what the next image should fix" />
      </div>
      <div className="button-row">
        <button className="import-button" disabled={busy} onClick={() => onAction("regenerate", regenPrompt)}><ArrowCounterClockwise size={14} /> Regenerate</button>
        <label className="text-button file-button">Upload replacement<input type="file" accept="image/*,.heic,.heif" disabled={busy} onChange={(e) => { const file = e.target.files[0]; e.target.value = ""; if (file) onAction("upload", file); }} /></label>
      </div>
    </div>
  );
}

export function WardrobeImportFlow({ onGarmentApproved, onModeledApproved }) {
  const inputRef = useRef(null); const cameraRef = useRef(null);
  const [jobs, setJobs] = useState([]); const [draftState, setDraftState] = useState({ drafts: {}, baselines: {} }); const [prompts, setPrompts] = useState({});
  const drafts = draftState.drafts;
  const [tolerances, setTolerances] = useState({}); const [open, setOpen] = useState(false); const [selected, setSelected] = useState(null);
  const [busyId, setBusyId] = useState(null); const [error, setError] = useState(""); const [setup, setSetup] = useState(null);
  const [photos, setPhotos] = useState([]); const [progress, setProgress] = useState(null); const [manual, setManual] = useState(false);
  const photoPreviews = useRef(new Set());
  const [dragging, setDragging] = useState(false);
  const refreshSequence = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    try {
      const [stored, config] = await Promise.all([request(API), request(CONFIG_API)]);
      if (sequence !== refreshSequence.current) return;
      setJobs(stored); setSetup(config);
      setDraftState((current) => refreshDrafts(stored, current));
    } catch (e) { if (sequence === refreshSequence.current) setError(e.message); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]); useWardrobeEvents(refresh);
  useEffect(() => {
    const scan = () => cameraRef.current?.click();
    const imports = () => setOpen(true);
    window.addEventListener("wardrobe:scan", scan); window.addEventListener("wardrobe:imports", imports);
    return () => { window.removeEventListener("wardrobe:scan", scan); window.removeEventListener("wardrobe:imports", imports); };
  }, []);
  useEffect(() => {
    const next = new Set(photos.map((p) => p.preview));
    for (const url of photoPreviews.current) if (!next.has(url)) URL.revokeObjectURL(url);
    photoPreviews.current = next;
  }, [photos]);
  useEffect(() => () => { for (const url of photoPreviews.current) URL.revokeObjectURL(url); photoPreviews.current.clear(); }, []);
  const previewFiles = useCallback((files) => {
    setError(""); const images = [...files].filter((file) => file.type.startsWith("image/") || /\.(heic|heif|jpe?g|png|webp)$/i.test(file.name));
    if (images.some((f) => f.size > 25 * 1024 * 1024)) { setError("Choose photos smaller than 25 MB."); setOpen(true); return; }
    setPhotos(images.map((file) => ({ file, preview: URL.createObjectURL(file) }))); setOpen(true);
  }, []);
  useEffect(() => {
    let depth = 0;
    const enter = (e) => { if (![...e.dataTransfer.types].includes("Files")) return; e.preventDefault(); depth++; setDragging(true); };
    const over = (e) => { if ([...e.dataTransfer.types].includes("Files")) e.preventDefault(); };
    const leave = () => { depth = Math.max(0, depth - 1); if (!depth) setDragging(false); };
    const drop = (e) => { e.preventDefault(); depth = 0; setDragging(false); previewFiles(e.dataTransfer.files); };
    const paste = (e) => { if (e.clipboardData.files.length) { e.preventDefault(); previewFiles(e.clipboardData.files); } };
    window.addEventListener("dragenter", enter); window.addEventListener("dragover", over); window.addEventListener("dragleave", leave); window.addEventListener("drop", drop); window.addEventListener("paste", paste);
    return () => { window.removeEventListener("dragenter", enter); window.removeEventListener("dragover", over); window.removeEventListener("dragleave", leave); window.removeEventListener("drop", drop); window.removeEventListener("paste", paste); };
  }, [previewFiles]);
  const upload = async () => {
    setBusyId("upload"); setError("");
    try {
      await uploadPhotoBatch(photos, (file) => { setProgress(0); return uploadPhoto(API, file, { manual, onProgress: setProgress }); }, (photo, result) => {
        setPhotos((current) => current.filter((pending) => pending !== photo));
        if (result.jobs?.[0]) setSelected(result.jobs[0].id);
      });
    } catch (e) { setError(e.message); } finally { await refresh(); setBusyId(null); setProgress(null); }
  };
  const perform = async (job, stage, action, value) => {
    setBusyId(job.id); setError("");
    try {
      let result; let reviewedAssetUrl = job.stages[stage]?.assetUrl;
      if (action === "upload") result = await uploadPhoto(`${API}/${job.id}/stages/${stage}/upload`, value);
      else {
        const draft = drafts[job.id] || defaultDraft(job);
        if (["approve", "preview"].includes(action) && ["crop", "garment"].includes(stage)) {
          const metadata = importDraftPatch(draft, draftState.baselines[job.id] || defaultDraft(job));
          const saved = await request(`${API}/${job.id}/metadata`, { method: "PATCH", body: { metadata, ...(action === "approve" ? { reviewedStage: stage, reviewedAssetUrl } : {}) } });
          setDraftState((current) => acknowledgeDraft(saved, draft, current));
          // Crop edits create a new asset; only advance after validating the prior review.
          if (stage === "crop") reviewedAssetUrl = saved.stages.crop.assetUrl;
        }
        if (action === "preview") { await refresh(); return; }
        result = await request(`${API}/${job.id}/stages/${stage}/${action}`, { method: "POST", body: { prompt: value || "", generateModeled: draft.generateModeled, ...(action === "approve" ? { reviewedAssetUrl } : {}) } });
      }
      if (result.record) { onGarmentApproved?.(result.record); if (stage === "modeled") onModeledApproved?.(job.id, result.record.modeledImage); }
      setPrompts((current) => ({ ...current, [`${job.id}:${stage}`]: "" })); await refresh();
    } catch (e) { setError(e.message); await refresh(); } finally { setBusyId(null); }
  };
  const cleanup = async (job, action, tolerance) => {
    setBusyId(job.id); setError("");
    try { await request(`${API}/${job.id}/stages/garment/cleanup-${action}`, { method: "POST", body: { tolerance: tolerance ?? tolerances[job.id] ?? 46, reviewedRawAsset: job.stages.garment.rawAsset } }); await refresh(); }
    catch (e) { setError(e.message); } finally { setBusyId(null); }
  };
  const jobAction = async (job, action) => {
    setBusyId(job.id); setError("");
    try { await request(`${API}/${job.id}/${action}`, { method: "POST" }); await refresh(); }
    catch (e) { setError(e.message); } finally { setBusyId(null); }
  };
  const ready = jobs.filter((j) => reviewStageFor(j)).length;
  const reviewJob = jobs.find((j) => j.id === selected) || jobs.find((j) => reviewStageFor(j) || failedImageStage(j)) || jobs.at(-1);
  const reviewStage = reviewJob && reviewStageFor(reviewJob);
  const failedStage = reviewJob && failedImageStage(reviewJob);
  return <>
    <input ref={inputRef} type="file" accept="image/*,.heic,.heif" multiple hidden onChange={(e) => { previewFiles(e.target.files); e.target.value = ""; }} />
    <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { previewFiles(e.target.files); e.target.value = ""; }} />
    <div className="import-drop-overlay" data-active={dragging} aria-hidden={!dragging}><div className="import-drop-target"><UploadSimple size={34} /><h2>Drop clothing photos</h2></div></div>
    <aside className={`import-tray${jobs.length ? " is-expanded" : ""}`} aria-label="Wardrobe imports"><button className="import-tray__button" onClick={() => setOpen(true)} aria-label="Open imports">{ready ? ready : <Plus size={20} />}</button><div className="import-tray__actions"><span className="import-tray__label">{ready ? `${ready} ready to review` : jobs.length ? `${jobs.length} imports` : "Add clothes"}</span><button className="import-icon-button" onClick={() => inputRef.current?.click()} aria-label="Choose photos"><UploadSimple size={18} /></button></div></aside>
    {open && <div className="import-popover-backdrop" data-open="true" onMouseDown={(e) => e.target === e.currentTarget && !busyId && setOpen(false)}><section className="import-popover" role="dialog" aria-modal="true" aria-labelledby="import-title">
      <header className="import-popover__header"><div><p className="import-popover__eyebrow">Wardrobe import</p><h2 id="import-title" className="import-popover__title">{photos.length ? "Review your photo" : ready ? `${ready} ready for review` : "Add to your wardrobe"}</h2></div><button className="import-icon-button" disabled={Boolean(busyId)} onClick={() => setOpen(false)} aria-label="Close imports"><X size={20} /></button></header>
      {setup?.queue?.paused && <p className="queue-notice">{setup.queue.detail || "Queue paused"}. Photos and drafts remain saved. Connect ChatGPT or resume the queue in Settings.</p>}
      {!!photos.length && <div className="capture-preview"><div className="capture-photos">{photos.map((p, i) => <img src={p.preview} key={i} alt={`Photo ${i + 1} to import`} />)}</div><p>Keep the garment fully visible and use a clear, well-lit photo.</p><label className="check-field"><input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} />Enter garment details manually</label><div className="button-row"><button className="secondary-button" disabled={Boolean(busyId)} onClick={() => cameraRef.current?.click()}>Retake</button><button className="secondary-button" disabled={Boolean(busyId)} onClick={() => setPhotos([])}>Discard photo</button><button className="primary-button" disabled={Boolean(busyId)} onClick={upload}>{progress === null ? "Upload and import" : `Uploading ${progress}%`}</button></div></div>}
      {!photos.length && <>
        {!jobs.length ? <div className="import-drop-target"><h2>Start with a photo</h2><p>Scan a garment or upload an outfit photo. Review every piece before adding it.</p><div className="button-row"><button className="primary-button" onClick={() => cameraRef.current?.click()}>Use camera</button><button className="secondary-button" onClick={() => inputRef.current?.click()}>Choose photos</button></div></div> : <>
          {reviewJob && reviewStage ? <ReviewEditor job={reviewJob} stage={reviewStage} draft={drafts[reviewJob.id] || defaultDraft(reviewJob)} setDraft={(draft) => setDraftState((current) => ({ ...current, drafts: { ...current.drafts, [reviewJob.id]: draft } }))} regenPrompt={prompts[`${reviewJob.id}:${reviewStage}`] || ""} setRegenPrompt={(p) => setPrompts((current) => ({ ...current, [`${reviewJob.id}:${reviewStage}`]: p }))} busy={Boolean(busyId)} hasReference={setup?.hasModelReference} onAction={(action, value) => perform(reviewJob, reviewStage, action, value)} /> : failedStage ? <RecoveryEditor key={`${reviewJob.id}:${failedStage}`} job={reviewJob} stage={failedStage} tolerance={tolerances[reviewJob.id] ?? 46} setTolerance={(t) => setTolerances((c) => ({ ...c, [reviewJob.id]: t }))} busy={Boolean(busyId)} onPreview={(t) => cleanup(reviewJob, "preview", t)} onAccept={() => cleanup(reviewJob, "accept")} regenPrompt={prompts[`${reviewJob.id}:${failedStage}`] || ""} setRegenPrompt={(p) => setPrompts((current) => ({ ...current, [`${reviewJob.id}:${failedStage}`]: p }))} onAction={(action, value) => perform(reviewJob, failedStage, action, value)} /> : null}
          <div className="import-card-list">{jobs.map((job) => { const state = deriveStatus(job); const name = drafts[job.id]?.name || "New piece"; const failed = Object.entries(job.stages).find(([, s]) => s.status === "failed")?.[0]; return <article className={`import-card is-${state.tone}`} key={job.id}><img className="import-card__image" src={job.stages.garment.assetUrl || job.stages.crop.assetUrl || job.originalAssetUrl} alt="" /><div className="import-card__body"><h3 className="import-card__title">{name}</h3><p className="import-card__detail">{state.detail || state.text}</p><div className="button-row">{["queued", "failed"].includes(job.stages.analysis?.status) && <button className="text-button" disabled={Boolean(busyId)} onClick={() => jobAction(job, "manual")}>Enter manually</button>}{failed && <button className="text-button" disabled={Boolean(busyId)} onClick={() => perform(job, failed, "retry")}>Retry</button>}<a className="text-button" href={`${API}/${job.id}/package`}>Download sources</a></div></div><div className="import-card__actions">{(reviewStageFor(job) || failedImageStage(job)) && <button className="import-icon-button" onClick={() => setSelected(job.id)} aria-label={`Review ${name}`}><Check size={17} /></button>}<button className="import-icon-button" disabled={Boolean(busyId)} onClick={() => jobAction(job, "cancel")} aria-label={`Cancel ${name}`}><Trash size={17} /></button></div></article>; })}</div>
          <div className="button-row"><button className="secondary-button" onClick={() => cameraRef.current?.click()}>Scan another</button><button className="secondary-button" onClick={() => inputRef.current?.click()}>Choose photos</button></div>
        </>}
      </>}
      {error && <p className="import-status is-error" role="alert">{error}</p>}
    </section></div>}
  </>;
}
