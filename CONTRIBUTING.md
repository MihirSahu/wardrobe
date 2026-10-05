# Contributing

Fork the repo, create a focused branch, and open a pull request.

```bash
sfw pnpm install --frozen-lockfile
sfw pnpm check
docker compose build
```

Never commit `.env`, `data/`, `.state/`, personal photos, generated wardrobe assets, or credentials. Tests use disposable fixtures; do not run write tests against an existing wardrobe. Live account sign-in, S3 deployment, and phone-camera checks are separate from automated tests.

Keep `.aws/`, `.codex/`, exported authentication files, and private keys local. Git and Docker exclude these along with build output, test reports, logs, caches, and editor backups. `.env.example` contains empty configuration values; credential strings in logging/authentication tests are synthetic fixtures. Source code, the pnpm lockfile, reusable Codex skills, and setup/verification documentation belong in commits. Adding an ignore rule does not remove an already tracked file; check both `git status --short` and `git diff --cached` before committing.
