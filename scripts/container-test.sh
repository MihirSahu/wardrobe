#!/usr/bin/env bash
set -euo pipefail
umask 077

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
env_file="$repo_dir/.env"
test_root="$repo_dir/.state/container-test"
test_data="$test_root/data"
test_port="${WARDROBE_TEST_PORT:-3001}"
empty_data=false
copy_stage=""
copy_lock=""

usage() {
  cat <<'HELP'
Usage: scripts/container-test.sh [OPTIONS] COMMAND [COMPOSE_ARGS...]

Options (before COMMAND):
  --port PORT      Published port (default: 3001, or WARDROBE_TEST_PORT)
  --env-file FILE  Credentials/config file (default: repository .env)
  --empty          Initialize an empty test wardrobe instead of copying data/
  --help          Show this help

Commands:
  init     Prepare isolated data without starting Docker
  up       Prepare data, build, and start; wait up to 120s for health
  build    Build the test image without starting it
  logs     Follow application logs (Ctrl+C stops the log viewer)
  ps       Show test container status
  health   Request /api/health inside the running test container
  restart  Restart the test container, keeping data and credentials
  down     Stop/remove the test container; keep data and credentials
  exec     Run a command inside the running test container
  run      Run a one-off command (e.g. the native image smoke test)

Finish imports and stop the development app before the first data copy.
Existing test data is reused, never overwritten. Credentials are read by
Compose, not sourced as shell code. Back up now uses the bucket in .env.
HELP
}
die() { printf '%s\n' "$*" >&2; exit 1; }
cleanup() {
  if [[ -n "$copy_stage" ]]; then rm -rf -- "$copy_stage"; fi
  if [[ -n "$copy_lock" ]]; then rmdir -- "$copy_lock"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      [[ $# -ge 2 ]] || die "--port requires a number"
      test_port="$2"; shift 2 ;;
    --env-file)
      [[ $# -ge 2 ]] || die "--env-file requires a path"
      env_file="$2"; shift 2 ;;
    --empty) empty_data=true; shift ;;
    --help|-h) usage; exit 0 ;;
    --*) die "Unknown option: $1" ;;
    *) break ;;
  esac
done
[[ $# -gt 0 ]] || { usage; exit 1; }
action="$1"; shift
case "$action" in
  init|up|build|logs|ps|health|restart|down|exec|run) ;;
  *) die "Unknown command: $action" ;;
esac
[[ "$test_port" =~ ^[0-9]{1,5}$ ]] || die "Port must be an integer from 1 to 65535"
test_port=$((10#$test_port))
[[ "$test_port" -ge 1 && "$test_port" -le 65535 ]] || die "Port must be an integer from 1 to 65535"
if [[ "$empty_data" == true && "$action" != init && "$action" != up ]]; then
  die "--empty applies only to init or up"
fi
if [[ "$action" == init || "$action" == health ]]; then
  [[ $# -eq 0 ]] || die "$action does not accept extra arguments"
fi
[[ "$env_file" = /* ]] || env_file="$PWD/$env_file"
[[ -f "$env_file" ]] || die "Environment file not found. Create .env from .env.example and fill in your configuration."
if [[ "$action" != init ]]; then
  command -v docker >/dev/null || die "Docker is not installed. Install/start Docker Desktop first."
fi

prepare_data() {
  for dir in "$repo_dir/.state" "$test_root" "$test_data"; do
    [[ ! -L "$dir" ]] || die "Test data path must not contain symbolic links: $dir"
  done
  if [[ -d "$test_data" ]]; then
    printf 'Reusing isolated wardrobe at %s\n' "$test_data"
    return
  fi
  [[ ! -e "$test_data" ]] || die "Test data path exists but is not a directory"
  mkdir -p -- "$test_root"
  mkdir -- "$test_root/.copy-lock" || die "Another test data copy is in progress"
  copy_lock="$test_root/.copy-lock"
  copy_stage="$(mktemp -d "$test_root/.data-copy.XXXXXX")"
  if [[ "$empty_data" == false ]]; then
    [[ -d "$repo_dir/data" ]] || die "No data/ directory found. Use --empty to start a fresh test wardrobe."
    cp -R -- "$repo_dir/data/." "$copy_stage/"
  fi
  mv -- "$copy_stage" "$test_data"
  copy_stage=""
  rmdir -- "$copy_lock"; copy_lock=""
  printf 'Prepared isolated wardrobe at %s\n' "$test_data"
}

compose() {
  WARDROBE_TEST_PORT="$test_port" \
  WARDROBE_TEST_UID="$(id -u)" \
  WARDROBE_TEST_GID="$(id -g)" \
    docker compose --env-file "$env_file" \
    -p wardrobe-container-test -f "$repo_dir/compose.test.yaml" "$@"
}

case "$action" in
  init) prepare_data ;;
  up)
    prepare_data
    compose up --build --wait --wait-timeout 120 "$@"
    printf 'Open http://localhost:%s (ChatGPT sign-in uses a separate test volume).\n' "$test_port" ;;
  logs) compose logs --follow "$@" wardrobe ;;
  health)
    compose exec -T wardrobe node -e 'fetch("http://127.0.0.1:3000/api/health").then(async r => { console.log(await r.text()); process.exit(r.ok ? 0 : 1); }).catch(e => { console.error(e.message); process.exit(1); })' ;;
  exec) compose exec wardrobe "$@" ;;
  run) prepare_data; compose run --rm wardrobe "$@" ;;
  *) compose "$action" "$@" ;;
esac
