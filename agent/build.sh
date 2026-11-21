#!/usr/bin/env bash
set -euo pipefail
# Static, portable binaries; no C toolchain needed to build or test.
export CGO_ENABLED=0
cd "$(dirname "$0")"
BUILDER="${BUILDER:-$PWD/_tools/builder}"
if [[ ! -x "$BUILDER" ]]; then
  GOBIN="$(dirname "$BUILDER")" go install go.opentelemetry.io/collector/cmd/builder@v0.165.0
fi
"$BUILDER" --config manifest.yaml --skip-compilation
cp main.go config.go logoperator.go custody.go custody_cli.go custody_cli_test.go config_test.go logoperator_test.go custody_test.go custody_component_test.go _build/
cd _build
# Build with a patched Go toolchain (standard-library security fixes); see docs/AUDIT.md.
go mod edit -toolchain=go1.26.11
go mod tidy
go test -p 2 -trimpath -tags grpcnotrace ./...
mkdir -p "${DESTDIR:-../dist}"
go build -p 2 -trimpath -tags grpcnotrace -ldflags="-s -w" -o "${DESTDIR:-../dist}/monitoring-agent" .
