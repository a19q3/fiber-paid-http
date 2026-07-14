#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GIT_COMMON_DIR="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [[ -n "$GIT_COMMON_DIR" && "$(basename "$GIT_COMMON_DIR")" == ".git" ]]; then
  PROJECT_ROOT="$(dirname "$GIT_COMMON_DIR")"
else
  PROJECT_ROOT="$REPO_ROOT"
fi
BATTLECODE_REPO="${BATTLECODE_REPO:-$(cd "$PROJECT_ROOT/.." && pwd)/battlecode25-scaffold}"
BATTLECODE_REPO_URL="${BATTLECODE_REPO_URL:-https://github.com/battlecode/battlecode25-scaffold.git}"

if [[ ! -d "$BATTLECODE_REPO/.git" ]]; then
  git clone "$BATTLECODE_REPO_URL" "$BATTLECODE_REPO"
fi

if [[ -n "${BATTLECODE_JDK_HOME:-}" ]]; then
  JAVA_BIN="$BATTLECODE_JDK_HOME/bin/java"
else
  JAVA_BIN="$(command -v java || true)"
fi
if [[ -z "$JAVA_BIN" || ! -x "$JAVA_BIN" ]]; then
  echo "Battlecode requires JDK 21 or newer. Set BATTLECODE_JDK_HOME or put java on PATH." >&2
  exit 1
fi

JAVA_VERSION="$($JAVA_BIN -version 2>&1 | sed -n '1s/.*version "\([^"]*\)".*/\1/p')"
JAVA_MAJOR="${JAVA_VERSION%%.*}"
if [[ "$JAVA_MAJOR" == "1" ]]; then
  JAVA_MAJOR="$(printf '%s' "$JAVA_VERSION" | cut -d. -f2)"
fi
if [[ ! "$JAVA_MAJOR" =~ ^[0-9]+$ || "$JAVA_MAJOR" -lt 21 ]]; then
  echo "Battlecode requires JDK 21 or newer; detected ${JAVA_VERSION:-unknown}." >&2
  exit 1
fi

if [[ -n "${BATTLECODE_JDK_HOME:-}" ]]; then
  export JAVA_HOME="$BATTLECODE_JDK_HOME"
elif [[ -x /usr/libexec/java_home ]]; then
  export JAVA_HOME="$(/usr/libexec/java_home -v '21+' 2>/dev/null || true)"
else
  export JAVA_HOME="$($JAVA_BIN -XshowSettings:properties -version 2>&1 | sed -n 's/^[[:space:]]*java\.home = //p' | head -n 1)"
fi
if [[ -z "$JAVA_HOME" || ! -x "$JAVA_HOME/bin/javac" ]]; then
  echo "Could not resolve a JDK home with java and javac. Set BATTLECODE_JDK_HOME." >&2
  exit 1
fi

(
  cd "$BATTLECODE_REPO/java"
  ./gradlew version --no-daemon
  ./gradlew build --no-daemon
)

echo "Battlecode scaffold ready: $BATTLECODE_REPO"
echo "JDK ready: $JAVA_HOME ($JAVA_VERSION)"
echo "Next: BATTLECODE_DIR=$BATTLECODE_REPO/java pnpm battlecode:engine-smoke"
