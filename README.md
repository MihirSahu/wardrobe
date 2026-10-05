# Wardrobe

A private, self-hosted wardrobe for your phone and desktop. Scan clothing, review transparent cutouts, create outfits, and generate modeled photos using your ChatGPT account through Codex app-server. No OpenAI API key or Codex desktop is required.

Originals, metadata, JSON records, generated images, and jobs live in `data/`. The backup scheduler snapshots **every file and directory beneath `data/`**, including unknown extensions and hidden files, to S3. Local data remains the source of truth.

## Docker Compose

```sh
git clone git@github.com:MihirSahu/wardrobe.git
cd wardrobe
cp .env.example .env
mkdir -p data
```

Set `WARDROBE_UID` and `WARDROBE_GID` in `.env` to the owner of `data/` (`id -u` and `id -g` on the target Linux host). The container runs as that non-root user; the bind mount must be writable by it. Existing files, IDs, and asset URLs are preserved. Back up an existing installation before upgrading it.

```sh
docker compose up --build -d
docker compose logs -f wardrobe
```

Open port 3000 on your existing private server connection. Compose creates one `wardrobe` container: the Node HTTP server, durable AI queue, managed Codex app-server subprocess, and backup scheduler. `./data` mounts at `/app/data`; `wardrobe_state` stores credentials and operational checkpoints outside backups. The image supports Linux ARM64 and AMD64; building on the target host selects its architecture.

In **Settings → Connect ChatGPT**, open OpenAI's device-code sign-in page and enter the displayed code. Complete sign-in using your YubiKey in the browser. The app never asks for your security-key PIN. Codex manages credentials across container restarts; reconnect if the session expires or is revoked. Select an available model in Settings. There is no automatic API-key or paid-provider fallback.

This follows the selected private, single-owner, noncommercial deployment assumption. Native headless image generation still requires the live smoke test below on the target runtime; a successful account connection alone does not establish image-generation support.

## Phone and browser workflow

- **Scan clothes** opens the native camera. Preview, retake, then upload. **Choose photos** opens your photo library; drag/drop and paste work on desktop.
- Multipart uploads show progress. JPEG, PNG, and WebP work. HEIC/HEIF support depends on the deployed decoder; unsupported photos get a JPEG conversion message. Photos are limited to 25 MB and 40 million decoded pixels and normalized for orientation.
- Photos are saved before analysis. Review detected garments, correct metadata and crop bounds, preview the crop, then approve generation. Review and approve the cutout. Modeled photos are optional and need a reference uploaded in Settings.
- If analysis detects no clothing, the saved photo stays in Imports with manual entry, analysis retry, source download and cancellation available. A retry requests a fresh analysis; manual entry uses the existing photo without uploading again.
- Upload while disconnected and choose manual entry, or leave analysis queued. Only one AI request runs at a time. Cancellation preserves sources. Uncertain interrupted requests require explicit retry; completed bytes are reused after persistence failures. Settings shows usage and queue pauses.
- Edit pieces on the server so changes appear on other devices. Older browser-local edits have a preview and explicit migration action in Settings; local values are cleared only after successful persistence.
- **Outfits** takes a count (1–12), occasion, season and direction. Suggestions use the real inventory and numbered garment contact sheets. Each outfit includes one top and one bottom, with optional supporting pieces; duplicate combinations and unknown IDs are rejected. Generate photos immediately or later, then review, regenerate, approve, replace, or delete them.
- Browsers update through server-sent events after changes, reconnect and phone sleep. Unsaved editor drafts are preserved. The gallery editor also generates modeled photos later and replaces accepted images.

## Verify native image generation

Codex is pinned to `0.149.1`. The integration consumes native `imageGeneration` events with bytes or a saved path. Its Code Mode host stays enabled because models such as GPT-5.6-Sol dispatch native image tools through it. Shell execution, plugins, browser/computer tools and external applications are disabled. Requests have restricted read access to disposable reference copies; the backend owns wardrobe writes.

Use a clothing photo and identity photo already under `data/`. **Stop the app first** so the test is the only process using its Codex credentials volume:

```sh
docker compose stop wardrobe
docker compose run --rm wardrobe node scripts/smoke-images.mjs \
  --source /app/data/YOUR_CLOTHING_PHOTO.png \
  --reference /app/data/model-reference.jpeg
docker compose up -d
```

If disconnected, the test prints OpenAI's verification URL and device code. It generates one cutout and one modeled photo, checks decoding and cutout transparency, and checks authentication after app-server restart. Outputs go to `/app/state/smoke-output`, outside wardrobe records. Inspect garment and identity fidelity before deployment:

```sh
docker compose cp wardrobe:/app/state/smoke-output ./smoke-output
```

If no native image result is returned, the job fails explicitly. There is no manual-image or API-key fallback. A separate `codex exec` transport would need its own validation before switching the runner. YubiKey sign-in, actual phone camera behavior, and real image fidelity are live checks, not covered by mocked tests.

## New S3 bucket

For a private server outside AWS, create a dedicated bucket and IAM user in the **same AWS account**, then give Wardrobe that user's access key. Use your existing AWS administrator sign-in for setup; keep its credentials separate from the app. If the server already has an IAM role available to the backend, attach the runtime policy to that role and leave the access-key variables empty instead.

### 1. Create the private bucket

Open the [S3 console](https://console.aws.amazon.com/s3/), choose **General purpose buckets → Create bucket**, and configure:

| Setting | Value |
| --- | --- |
| Bucket type | General purpose |
| Bucket name | A globally unique name, such as `wardrobe-backups-REPLACE-WITH-UNIQUE-SUFFIX`, using lowercase letters, numbers and hyphens |
| AWS Region | Your chosen region; record its code, such as `us-east-1` |
| Object Ownership | **ACLs disabled / Bucket owner enforced** |
| Block Public Access | Keep **Block all public access** enabled (all four settings) |
| Bucket Versioning | **Enable** |
| Default encryption | **Server-side encryption with Amazon S3 managed keys (SSE-S3)** |

Choose **Create bucket**. Keep the bucket private; the app uses authenticated S3 requests. This setup uses SSE-S3, which matches the app's uploads and needs no KMS permissions. [AWS bucket creation guide](https://docs.aws.amazon.com/AmazonS3/latest/userguide/GetStartedWithS3.html#CreatingABucket).

### 2. Configure snapshot retention

In your bucket's **Management → Create lifecycle rule**, create these two enabled rules. For each, choose **Limit the scope to specific prefixes or tags** and enter the prefix `snapshots/`. Leave tag and object-size filters unset so small completion manifests are included.

| Rule name | Actions and values |
| --- | --- |
| `snapshot-retention` | **Expire current versions of objects:** 30 days after creation. **Permanently delete previous versions of objects:** 30 days after becoming noncurrent; leave **Number of newer versions to retain** blank. Under **Delete expired delete markers or incomplete multipart uploads**, select **Delete incomplete multipart uploads:** 1 day after initiation. |
| `expired-markers` | Under **Delete expired delete markers or incomplete multipart uploads**, select **Delete expired object delete markers** only. |

Save each rule with **Create rule**. Use a separate marker-cleanup rule because its expiration action cannot also specify an age. These settings match the provisioning script and the app's 30-day recovery window. [AWS lifecycle setup](https://docs.aws.amazon.com/AmazonS3/latest/userguide/how-to-set-lifecycle-configuration-intro.html), [expiration action constraints](https://docs.aws.amazon.com/AmazonS3/latest/API/API_LifecycleExpiration.html).

### 3. Create the IAM policy

Open the [IAM console](https://console.aws.amazon.com/iam/) and choose **Policies → Create policy → JSON**. Paste the policy below, replacing **both** occurrences of `YOUR_BUCKET` with the bucket's exact name (without `s3://` or a trailing slash). Choose **Next**, name it `WardrobeBackup`, then **Create policy**. [AWS policy creation guide](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_create-console.html).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListSnapshots",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::YOUR_BUCKET",
      "Condition": { "StringLike": { "s3:prefix": ["snapshots/*", "snapshots/"] } }
    },
    {
      "Sid": "ReadAndWriteSnapshots",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::YOUR_BUCKET/snapshots/*"
    }
  ]
}
```

This is the [runtime policy template](docs/runtime-backup-policy.json). It permits listing, writing and reading snapshots, including restore, and aborting incomplete multipart uploads. It grants no object-deletion or bucket-configuration permissions. Attach it as an **IAM permissions policy**; it is not a bucket policy. For this same-account setup, the IAM policy grants access without adding a bucket policy or enabling public access.

### 4. Create the IAM user and access key

1. In IAM, choose **Users → Create user**. Name it `wardrobe-backup` and leave **Provide user access to the AWS Management Console** unchecked.
2. On the permissions page, choose **Attach policies directly**, select only `WardrobeBackup`, then finish creating the user. Keep this user free of additional policies or group memberships that broaden its access. [AWS IAM user guide](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_users_create.html).
3. Open `wardrobe-backup` → **Security credentials → Access keys → Create access key**. Review the alternatives, choose **Other**, then **Next**. Add a description such as `Wardrobe private server` and choose **Create access key**.
4. Save the **Access key ID** and **Secret access key** securely. The secret is shown only during creation. Keep any downloaded credentials outside `data/` and Git. [AWS access-key creation guide](https://docs.aws.amazon.com/IAM/latest/UserGuide/access-keys-admin-managed.html#Using_CreateAccessKey).

### 5. Configure Wardrobe

From the repository directory, copy `.env.example` to `.env` if you have not already done so. Edit the existing `.env`, preserving your other settings:

```dotenv
S3_BACKUP_BUCKET=YOUR_BUCKET
AWS_REGION=YOUR_REGION_CODE
AWS_ACCESS_KEY_ID=YOUR_IAM_USER_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY=YOUR_IAM_USER_SECRET_ACCESS_KEY
AWS_SESSION_TOKEN=
```

`S3_BACKUP_BUCKET` is the bare bucket name, and `AWS_REGION` must match the bucket's region. An IAM user's access key has no session token; leave `AWS_SESSION_TOKEN` empty. `.env` is Git-ignored and stays outside `data/`, so the app's backups do not include it. Restrict its local permissions and recreate an existing Compose container to load the new environment:

```sh
chmod 600 .env
docker compose up -d --force-recreate wardrobe
```

For an initial deployment, use `docker compose up --build -d` as described above. For local development, restart with `sfw pnpm dev` after editing `.env`. Avoid exported AWS credentials in the launching shell that would override the values in `.env`.

### 6. Verify the first backup

1. Open **Settings → Back up now** and wait for **Last successful backup** to update.
2. Choose **View snapshots** and confirm a completed snapshot appears.
3. Using your administrator sign-in in S3, open `snapshots/<snapshot-id>/`. It should contain `archive.tar.gz` and `complete.json`. The archive includes everything under `data/`, including JSON/database files, source photos, generated images and pending jobs; files are packaged together rather than uploaded individually.
4. Use the [restore instructions](#restore) to verify a snapshot into a new directory before relying on it for recovery.

If backup fails, check the error in Settings or `docker compose logs -f wardrobe`. For `AccessDenied`, confirm both policy bucket names and the attached user policy; for credential or region errors, recheck `.env` and recreate the container. Retention is enforced by S3 lifecycle, so confirm both rules are enabled in the bucket's Management tab.

### Alternative: provision the bucket from the CLI

To create and configure the bucket with the included script, **skip steps 1–2** and run the following with separate AWS provisioning credentials and an explicit globally unique bucket name and region. The runtime IAM user from step 4 cannot provision buckets. Continue with steps 3–6 afterward.

```sh
sfw pnpm install --frozen-lockfile
sfw pnpm s3 provision --bucket YOUR_BUCKET --region YOUR_REGION
```

This creates a **new** bucket with all four public-access blocks, disabled ACLs, SSE-S3 encryption, versioning, and lifecycle cleanup. Existing buckets are not reused or modified. If configuration fails after bucket creation, the command reports the error; finish configuring that new bucket in AWS before enabling runtime backups. It never deletes a bucket.

### Backup behavior

Backups run hourly when changed, at least daily when unchanged, and through **Settings → Back up now**. Staging copies hold the same lock as all app writes; compression and upload release it. Large archives use multipart upload. Every regular file and empty directory is included. Unsupported entries, including symbolic links, fail the backup explicitly rather than being skipped or followed outside the root. Stop external scripts that write to `data/` during a snapshot.

Snapshots have an archive and completion manifest with per-file SHA-256 hashes and the archive digest. Completion is uploaded last; incomplete uploads do not appear in the snapshot list. S3 outages do not stop local wardrobe use. Staging and status stay outside `data/`.

Current snapshots expire after 30 days. Noncurrent versions expire 30 days after becoming noncurrent, so physical storage cleanup can happen later than the recovery window. Lifecycle also cleans expired delete markers and incomplete multipart uploads. Deleted local pieces remain in older snapshots during the recovery window; retained originals and replaced assets remain in `data/` until removed offline.

## Restore

Choose a completed snapshot ID in Settings. Restore into a **new directory**:

```sh
sfw pnpm s3 restore --bucket YOUR_BUCKET --region YOUR_REGION \
  --snapshot SNAPSHOT_ID --destination ./restored-data
```

Restore verifies the archive digest, entries, all file hashes, sizes and directories. It rejects traversal, links and unexpected entries and never overwrites an existing directory. After verification, stop the app, move the existing data directory aside, put the restored directory at `./data`, confirm ownership matches the container UID/GID, and restart. Keep the old directory until the wardrobe, outfits and pending jobs are verified.

Restoring `data/` restores records and completed outputs. Unknown interrupted requests stay failed until explicitly retried; saved results can finish without another generation. Reconnect ChatGPT if the separate state volume is unavailable.

Completed images and analysis results are checkpointed under `data/` even if writing operational receipts fails, provided the data volume is writable. They remain included in snapshots and can be reused after restoring without the old state volume.

## Development and checks

Use Node 22+ and pnpm through Socket Firewall:

```sh
sfw pnpm install --frozen-lockfile
sfw pnpm dev
sfw pnpm check
```

`sfw pnpm dev` manages both development servers: Vite serves assets on 5173 and proxies `/api` to Node on 3000. Press Ctrl+C once in that terminal to stop both servers and their child processes. Independent monitors also stop each service if the outer launcher exits abruptly or the terminal closes; Vite is launched directly without an additional sfw/pnpm wrapper. Production serves built assets and APIs directly from one Node server:

```sh
sfw pnpm build
sfw pnpm start
```

Development streams Vite output and timestamped backend logs into that same terminal: HTTP requests and errors, queue/job stages, Codex RPC/turn summaries and native stderr diagnostics, and S3 snapshot progress. Logs redact recognized credentials and encoded image payloads; request bodies, query strings and raw Codex protocol messages are not logged. Browser console messages remain in the browser's developer tools. Set `WARDROBE_LOGS=0 sfw pnpm dev` to disable the additional backend logs, or `WARDROBE_LOGS=1 sfw pnpm start` to enable them outside development.

Local operational state defaults to `.state/`; `WARDROBE_STATE_DIR` relocates **operational state only**. Wardrobe data stays at `data/` in the application root. No app login or network/VPN setup is included; use your existing private access.

Automated tests use disposable directories, simulated Codex, and in-memory S3. They verify recovery, validation, concurrent persistence, safe assets, SSE, full snapshots and safe restore. They do not sign in or bill real image requests. Bundled Codex skills remain available for offline workflows; stop the server before skills directly mutate `data/`.

## License

[MIT](LICENSE). Fork of [tandpfun/wardrobe](https://github.com/tandpfun/wardrobe).
