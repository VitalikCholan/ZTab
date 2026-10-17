#!/usr/bin/env bash
# Builds crypto/rust for wasm32-unknown-unknown and writes the wasm-bindgen output to crypto/pkg.
# Runs in Docker: Apple clang has no wasm32 target and the cohort pulls secp256k1-sys (C).
# Cargo registry and target dir live in named volumes so rebuilds take seconds, not minutes.
set -euo pipefail
cd "$(dirname "$0")"
WB=0.2.129
mkdir -p pkg
docker run --rm \
  -v "$PWD/rust":/w \
  -v "$PWD/pkg":/pkg \
  -v ztab-crypto-cargo-registry:/usr/local/cargo/registry \
  -v ztab-crypto-target:/w/target \
  -w /w \
  rust:1.98-bookworm sh -euc '
    apt-get update -qq && apt-get install -y -qq clang lld llvm curl >/dev/null
    rustup target add wasm32-unknown-unknown
    case "$(uname -m)" in
      aarch64) triple=aarch64-unknown-linux-gnu ;;
      x86_64)  triple=x86_64-unknown-linux-musl ;;
      *) echo "unsupported arch $(uname -m)"; exit 1 ;;
    esac
    curl -sSfL "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/'"$WB"'/wasm-bindgen-'"$WB"'-$triple.tar.gz" | tar -xz -C /tmp
    CC_wasm32_unknown_unknown=clang AR_wasm32_unknown_unknown=/usr/bin/llvm-ar \
      cargo build --release --target wasm32-unknown-unknown
    /tmp/wasm-bindgen-'"$WB"'-$triple/wasm-bindgen --target web --out-dir /pkg --out-name ztab_crypto \
      target/wasm32-unknown-unknown/release/ztab_crypto.wasm
  '
ls -la pkg
