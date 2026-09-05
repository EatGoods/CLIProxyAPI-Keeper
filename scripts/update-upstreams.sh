#!/usr/bin/env bash
set -euo pipefail

readonly CPA_REMOTE="cpa-upstream"
readonly CPA_URL="https://github.com/router-for-me/CLIProxyAPI.git"
readonly KEEPER_REMOTE="usage-upstream"
readonly KEEPER_URL="https://github.com/Willxup/cpa-usage-keeper.git"

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "更新中止：工作区存在未提交改动。"
  exit 1
fi

if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "更新中止：请切换到 main 分支后重试。"
  exit 1
fi

ensure_remote() {
  local name="$1"
  local url="$2"
  local expected="$3"
  local current

  if current="$(git remote get-url "$name" 2>/dev/null)"; then
    if [[ "$current" != *"$expected"* ]]; then
      echo "更新中止：远端 $name 指向 $current，而不是 $expected。"
      exit 1
    fi
    return
  fi

  git remote add "$name" "$url"
}

ensure_remote "$CPA_REMOTE" "$CPA_URL" "router-for-me/CLIProxyAPI"
ensure_remote "$KEEPER_REMOTE" "$KEEPER_URL" "Willxup/cpa-usage-keeper"

git fetch origin main
git merge --ff-only origin/main

sync_branch="codex/sync-upstreams-$(date +%Y%m%d%H%M%S)"
git switch -c "$sync_branch"

git fetch "$CPA_REMOTE" main
git fetch --no-tags "$KEEPER_REMOTE" main
git merge --no-edit "$CPA_REMOTE/main"
git merge --no-edit -Xsubtree=keeper "$KEEPER_REMOTE/main"

npm --prefix keeper/web ci
npm --prefix keeper/web run lint
npm --prefix keeper/web run test
npm --prefix keeper/web run typecheck
npm --prefix keeper/web run build
printf '\n' > keeper/web/dist/.gitkeep
go test ./...
(cd keeper && go test ./...)
docker compose build cli-proxy-api

if [[ -n "$(git status --porcelain)" ]]; then
  echo "更新中止：验证过程产生了未提交改动。"
  exit 1
fi

git switch main
git merge --ff-only "$sync_branch"
git push origin main
git branch -d "$sync_branch"

echo "CLIProxyAPI 与 CPA Usage Keeper 已更新并推送。"
