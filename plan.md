# Wardrobe self-hosting plan

## Implementation status

Production server, serialized persistence, durable import/outfit jobs, managed device-code connection, native image adapter, full-directory S3 snapshots and restore, responsive camera/photo flows, and single-container Compose deployment are implemented. The native runtime is pinned to `0.149.1`.

Local automated, Docker and browser checks are recorded in [docs/verification.md](docs/verification.md). A local native-image request generated and saved a transparent cutout through headless app-server. Native modeled photos, Docker generation and deployed authentication remain live verification gates; the new S3 bucket still needs its name, region and credentials. [README.md](README.md) contains setup and smoke-test commands.

## Summary and agreed decisions

Turn Wardrobe into a self-hosted app for browsing, importing clothes, and creating outfits from desktop and mobile browsers.

- Keep local storage as the source of truth and back up the entire `data/` directory to a new S3 bucket, including all JSON/database files, images, and job state. A backup must restore the complete wardrobe, not just its image files.
- Target ChatGPT subscription usage for garment detection, outfit suggestions, cutouts, and modeled photos through the native ChatGPT-authenticated Codex runtime, without an OpenAI API key or Codex desktop.
- Generate images automatically from Wardrobe and present them for review and approval. Manual ChatGPT generation/upload is no longer the required workflow. Use headless native Codex app-server as the selected approach and validate real image generation in the target Docker environment as the first implementation milestone.
- Deploy one long-running `wardrobe` container through Docker Compose. It contains the Node server, a managed Codex app-server subprocess, and the manual backup service.
- Exclude selectable data folders, app authentication, and network-access setup, per the revised requirements. Existing server access remains an external deployment prerequisite.
- ChatGPT sign-in must support accounts using Advanced Account Security and YubiKey authentication. Authenticate on OpenAI's own browser page; do not implement security-key authentication inside Wardrobe.

## 1. Production server and persistent data

The current backend lives in Vite plugins, gallery edits live in browser storage, and outfit generation exists only as a Codex skill.

- Extract import, image-processing, and storage logic into reusable server modules. Add a production Node HTTP server that serves the built React frontend and APIs. Use Vite only for development and builds.
- Keep `data/library.json`, `data/imported/`, existing item IDs, and current asset routes compatible. Add persistent outfit records and image-serving routes.
- Preserve existing import endpoints and extend them for manual image uploads, generation-package downloads, and optional modeled images.
- Add server endpoints for editing wardrobe items, managing outfits, and uploading the identity reference. Save gallery edits on the server so desktop and phone share the same records.
- Offer a one-time migration of existing browser-local edits and deletion markers: preview changes, apply them explicitly, and clear local values only after successful persistence.
- Serialize mutations and use atomic JSON writes. Keep job states durable and recover interrupted jobs after restart without automatically repeating uncertain AI requests.
- Keep the Node backend as the single writer of authoritative JSON and data assets. Give Codex isolated scratch space outside `data/`; copy references into it and ingest generated images into `data/jobs/` under the shared write lock as soon as generation completes. This makes backup snapshots consistent without waiting for long image-generation requests. Scratch space is disposable; originals, prompts, metadata, and completed generated outputs belong in `data/`.
- Retain uploaded source images and accepted assets under `data/`. Use versioned asset filenames when replacing images so caches cannot show obsolete photos.
- Notify connected browsers of job, wardrobe, and outfit changes using server-sent events. Refetch authoritative state on initial connection, reconnect, and return to the foreground; preserve unsaved editor drafts. Worker output must appear automatically after backend ingestion, without a manual page refresh.

### Docker Compose

- Use a multi-stage Docker build, Node 22, a non-root runtime, and pinned dependency/runtime versions.
- Mount `./data` at `/app/data`; store Codex credentials and operational state in a separate persistent volume outside the backup directory.
- Make the runtime UID/GID configurable for bind-mount ownership. Build for Linux amd64 and arm64 with matching Codex and Sharp dependencies, and verify the deployed server architecture before rollout.
- Add health checks, graceful shutdown, restart policy, and `.dockerignore` exclusions for data, credentials, and development artifacts.
- Standardize scripts, documentation, and CI on pnpm. Use `sfw pnpm ...` for repository commands and provide `sfw` in the build environment.
- Preserve the existing untracked pnpm configuration while consolidating package-manager setup.
- Bucket provisioning and restore are separate commands, not long-running services. S3 remains an external AWS service.

## 2. ChatGPT connection and browser workflows

Use Codex app-server, managed by Wardrobe over stdio. It exposes authentication and streamed events suited to a custom UI. The TypeScript Codex SDK provides convenient thread execution, but the app-server interfaces directly support the web-facing account lifecycle required here. See the [SDK guidance](https://learn.chatgpt.com/docs/codex-sdk) and [app-server documentation](https://learn.chatgpt.com/docs/app-server).

### Component responsibilities

- Wardrobe's Node server serves the UI, owns persistence, and runs the background job queue. "Worker" means this job-running application code, not a separately authenticated Codex service or container.
- A single managed Codex app-server subprocess handles the account connection and executes queued analysis/generation requests over its stdio protocol. The primary design does not use the Codex SDK.
- Both the Settings connection panel and job runner call that same app-server instance. After browser/YubiKey sign-in completes, jobs reuse its managed ChatGPT session; there is no second worker login.
- Headless image generation is an implementation smoke test, separate from authentication. The conditional `codex exec` fallback below is an alternate execution transport to investigate only if the selected app-server approach fails, not another required component.

### Connection and YubiKey sign-in

- Add a Settings connection panel with connect, cancel, disconnect, connection status, and available usage-limit information.
- Use app-server-managed device-code login: show the verification URL and code, let the user complete OpenAI's browser sign-in using the YubiKey, then wait for confirmed login completion.
- Verify Wardrobe's device-code integration with Advanced Account Security and security-key authentication in the deployed environment.
- Target a private, single-owner, noncommercial server deployment using native managed Codex authentication. Record this as the deployment assumption, rather than an independently verified OpenAI eligibility determination. Public/commercial hosting is outside this plan.
- The YubiKey stays with the user's browser/device. Do not mount it into Docker, collect its PIN, or attempt authentication automation.
- Let Codex manage stored credentials and refresh. Keep credentials server-side, outside `data/`, Git, logs, downloads, and S3 backups. Show a reconnect state if credentials expire or are revoked; do not promise indefinite unattended access.
- Test complete sign-in with Advanced Account Security and the actual YubiKey, plus reconnect, cancellation, logout, and container restart.

References: [Codex authentication and headless-login fallbacks](https://learn.chatgpt.com/docs/auth) and [Advanced Account Security](https://help.openai.com/en/articles/20001221-advanced-account-security). Advanced Account Security requires passkeys/security keys and shortens active sessions; its session behavior should not be assumed to map to a particular Codex token lifetime.

### Inference

- Send bounded text/image requests for garment analysis and outfit curation. Require structured results, validate them on the server, and let only Wardrobe's application code modify its records.
- Restrict Codex to analysis and native image generation: disable shell execution, arbitrary file changes, and external application tools. Permit generated files only in isolated scratch space; Wardrobe validates and ingests completed outputs before committing approval changes to its records.
- Persist request progress and results. Show actionable states for authentication failures, unavailable models, exhausted usage, malformed output, and interrupted requests.
- Run one AI job at a time initially. Queue additional jobs durably, prevent duplicate submissions, and allow cancellation. Pausing for authentication or usage limits preserves the queue; uncertain completion requires explicit retry. Keep the HTTP server responsive during generation, image processing, and backup compression by offloading expensive work from its event loop.
- Select from available models and verify access with a completed request. Require no OpenAI API key and perform no automatic fallback to paid API usage.

### Native image-generation validation

The earlier manual-image requirement conflated two routes. The separate Sign in with ChatGPT integration through `api.openai.com/v1` excludes the hosted image-generation tool, including when app-server is configured to use that provider. Native Codex image generation is documented as using included Codex usage and is available in interactive CLI workflows. The inspected local CLI is version 0.149.1 and reports `image_generation` as stable and enabled. This establishes a candidate route, not proof of headless Linux/Docker support. See [native image generation](https://learn.chatgpt.com/docs/image-generation), [usage accounting](https://learn.chatgpt.com/docs/pricing#how-does-image-generation-count-toward-usage-limits), and the [separate SIWC route's limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

- Use the native Codex provider with managed ChatGPT sign-in; do not configure the restricted SIWC Responses provider for image generation.
- As the first implementation milestone, run a bounded end-to-end smoke test through app-server in Linux/Docker: generate a transparent garment cutout from a clothing photo, then a modeled photo using both the accepted garment and identity references. This tests the selected architecture rather than requiring another product decision before starting implementation.
- Require returned image bytes/files, successful decoding, transparent alpha for the cutout, recognizable garment/identity fidelity, and successful operation without Codex desktop, browser interaction during generation, or an API key. Verify credentials survive restart and reconnection works with the YubiKey.
- If app-server cannot expose the native tool, test `codex exec` as the internal worker transport. Keep app-server for account connection and status; use the same ChatGPT credentials. Do not infer SDK/non-interactive support from interactive CLI availability alone.
- Pin a proven runtime and record which transport, inputs, completion events, and output paths worked. If neither transport works, report automated subscription-backed images as unverified/unavailable and obtain a new provider decision; do not silently restore manual generation or paid API fallback.
- Persist generated bytes before cleanup or record updates. Retry storage/cleanup with those same bytes; do not repeat successful generation because persistence failed. Require explicit retry when completion is uncertain, and surface subscription limits rather than switching billing modes.

### Clothes import

1. Capture or upload a photo and save it before analysis.
2. Detect garments and suggest metadata and bounding boxes; let the user correct crops and details.
3. Queue native Codex generation for each garment using its crop and reconstruction prompt; display progress in Wardrobe.
4. Persist the generated cutout, run existing transparency/chroma cleanup where applicable, then let the user review and approve it.
5. Generate a modeled photo using the accepted garment and uploaded identity reference, then review and approve it. Select this option by default when a reference is available; users can uncheck it, and imports without a reference remain cutout-only.
6. Allow regeneration with user directions and optional replacement uploads. Importing a garment must not require an identity reference or modeled image.

Allow manual metadata and crop entry when ChatGPT is disconnected. Keep source photos and durable job state while waiting for reconnection. The current API-key Images API must not run automatically.

### Outfits

- Add an Outfits screen with requested count, occasion, season, and styling direction.
- Curate combinations from existing wardrobe items and their visual references, following the repository's outfit guidance.
- Validate garment IDs, required pieces, and combination uniqueness; report when inventory cannot support the requested count.
- Persist each proposed outfit with selected garments, explanation, prompt, and image status.
- Queue automatic modeled-photo generation using the exact selected garments and identity reference. Provide progress, regeneration, optional replacement upload, review, approval, and deletion.
- Support browsing suggested outfits before modeled images are available.

## 3. S3 backup and recovery

Provide a separate provisioning command that creates a new bucket using explicit AWS region and bucket-name inputs. Configure Block Public Access, disabled ACLs, SSE-S3 encryption, and versioning. Keep provisioning permissions separate from runtime backup permissions. See [AWS bucket configuration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/GettingStartedS3CLI.html).

- Use the AWS SDK credential chain; keep AWS credentials outside `data/` and the frontend.
- Back up every file and directory beneath `data/`, including `library.json`, outfit manifests, job JSON, any database files, metadata, identity references, uploaded originals, crops, garment cutouts, modeled photos, outfit images, thumbnails, and additional files. Do not use an image-only allowlist or silently omit unexpected entries; report unsupported filesystem entries rather than following links outside the data root.
- Keep all authoritative wardrobe records and assets under `data/` so a complete snapshot is sufficient to restore the wardrobe. The current JSON store remains in use; if replaced with a database later, use its supported consistent-backup mechanism rather than copying an active database file unsafely.
- Trigger backups only through the "Back up now" action or an explicit backup API request. Startup, data changes, and elapsed time must not trigger backups; each manual request creates a complete snapshot even when unchanged.
- Create a consistent staging copy while holding the application's data-write lock. Compress and upload after releasing the lock. All application writes must use the same lock; external writers must be stopped during snapshots.
- Store each snapshot under a unique ID, with an archive and manifest containing file paths, sizes, and SHA-256 checksums. Upload the completion manifest last; list only completed snapshots as recoverable.
- Keep staging files and backup status outside `data/`. Prevent overlapping backups and retry transient failures with bounded backoff.
- Keep local operation available during S3 outages. Display last successful backup, pending changes, current progress, and failures.
- Retain snapshots for 30 days by default. Configure lifecycle cleanup for current objects, noncurrent versions, expired delete markers, and abandoned multipart uploads. See [AWS lifecycle behavior](https://docs.aws.amazon.com/AmazonS3/latest/userguide/intro-lifecycle-rules.html).
- Provide a restore command that verifies checksums and safely extracts into a new empty directory. Document stopping the app and replacing its data directory after verification.

The runtime may upload and read backups but must not delete historical snapshots. Local deletion must remain recoverable within the retention window. Restoring wardrobe data requires reconnecting ChatGPT if the separate credentials volume is unavailable.

## 4. Mobile experience

Preserve the existing visual style while making Gallery, Imports, Outfits, and Settings usable on narrow screens.

- Add a prominent "Scan clothes" action using native camera capture and a separate photo-library picker. Preview, retake, and upload before starting analysis.
- Use native file capture for v1; avoid a custom live-camera implementation.
- Handle orientation, enforce upload and decoded-image limits, and normalize supported images. Convert HEIC/HEIF when supported by the deployed decoder; otherwise explain how to provide JPEG.
- Use multipart uploads, upload progress, durable jobs, and resumable review after refresh or phone sleep.
- Provide touch-sized controls, safe-area spacing, full-screen mobile review, keyboard-safe forms, and no horizontal overflow.
- Generate responsive thumbnails for imported garments and outfits; current `/api/` images bypass the existing optimizer.

## 5. Verification and implementation order

- Existing wardrobe data loads without changing IDs or losing images; edits appear on a second device.
- Concurrent edits, approvals, replacements, and deletions do not corrupt JSON or lose unrelated changes.
- Import works without an API key or identity reference; manual entry works while disconnected.
- Wardrobe's device-code connection is verified with Advanced Account Security and YubiKey authentication in the target deployment.
- Connection survives container restart, handles cancellation and usage limits, and never exposes credentials.
- The native-generation smoke test passes on the target Linux/Docker runtime. Complete camera/photo import → automatic cutout → optional automatic modeled photo → approval, plus outfit curation → automatic modeled outfit → approval, entirely through Wardrobe without an API key or Codex desktop.
- Successful image generation is not repeated after a storage/cleanup failure; uncertain completion, cancellation, rate limits, and worker restart produce recoverable job states.
- Backup and restore reproduce the complete data tree and checksums, including every JSON/database file and image. Restore to a fresh data directory and verify that the app loads the same wardrobe metadata, outfits, assets, and pending jobs. Interrupted uploads never appear complete; S3 outages leave the app usable.
- Compose rebuilds preserve data and connection state; production serves APIs and assets without Vite.
- Worker output refreshes desktop and phone views automatically, including after event-stream reconnect, without discarding unsaved drafts. Snapshotting during an active generation produces consistent data and never captures a partially ingested output.
- Browser tests cover 360–430 px phones, tablet, and desktop. Validate actual camera capture, orientation, uploads, and review on iOS Safari and Android Chrome.

Implement in this order: native image-generation smoke test → production server and persistence → device-code connection integration → automated garment import → automated outfits → backups and restore → mobile refinement and deployment verification.
