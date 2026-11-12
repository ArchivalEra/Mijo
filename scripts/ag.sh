#!/bin/sh
# ag-cli 隔离封装：token 只活在一个临时 XDG_CONFIG_HOME 里，命令结束即删。
# 不跑全局安装、不改 ~/.gitconfig、不把 token 落到用户主目录。
#
# 用法：AGCLI_TOKEN=<token> ./scripts/ag.sh api /repos/owner/repo --raw-output
set -eu
: "${AGCLI_TOKEN:?AGCLI_TOKEN is required}"
AGCLI_BIN="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)/node_modules/.bin/ag-cli"
XDG_DIR="$(mktemp -d)"
trap 'rm -rf "$XDG_DIR"' EXIT INT TERM
printf '%s' "$AGCLI_TOKEN" | XDG_CONFIG_HOME="$XDG_DIR" "$AGCLI_BIN" auth login --with-token >/dev/null
exec env XDG_CONFIG_HOME="$XDG_DIR" "$AGCLI_BIN" "$@"
