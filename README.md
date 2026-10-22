# ZTab

![CI](https://github.com/VitalikCholan/ZTab/actions/workflows/ci.yml/badge.svg)

ZTab is a private bill splitter on shielded Zcash (testnet). An admin opens a tab, shares one link per participant, and each participant pays to their own shielded address; keys are derived and amounts encrypted in the browser, so the server only stores opaque blobs. The admin then withdraws the collected funds.

| Package | What it is |
|---|---|
| [`watcher/`](watcher/README.md) | Rust service that scans the chain and reports payments |
| [`crypto/`](crypto/README.md) | `@ztab/crypto`: key derivation, encryption and PCZT signing (Rust + wasm) |
| [`api/`](api/README.md) | NestJS API with PostgreSQL |
| [`pwa/`](pwa/README.md) | React progressive web app |
| [`deploy/`](deploy/README.md) | Docker Compose, Caddy, server scripts and runbook |
| [`docs/superpowers/specs/`](docs/superpowers/specs/) | Design specs (Ukrainian) |

Status: working on testnet, with images built by CI. A full submission README is coming.
