# archon-core (Rust → WASM compute core)

CPU-bound kernels for the hot paths: file hashing, tree-sitter symbol parsing,
repo-map ranking, and vector top-k. **Pure compute — no I/O.** The TypeScript
host feeds it bytes (via the Capability Broker) and consumes the results.
See [ADR-0011](../../docs/adr/0011-rust-wasm-compute-core.md).

## Why Rust→WASM (not a native addon)

- Native-class speed on the genuinely hot path (parse / hash / rank / vector).
- One portable artifact (Node, edge, browser) — no per-platform binaries.
- The WASM sandbox **cannot** touch the OS, so the core has no ambient
  authority. All side effects stay in the TS host behind the broker. WASM
  reinforces the safety model; a native addon would weaken it.

## Build

Requires the Rust toolchain + `wasm-pack`:

```bash
cargo install wasm-pack            # once
npm run build:wasm                 # -> crates/archon-core/pkg/ (gitignored)
```

The TS loader in `src/core/compute.ts` instantiates `pkg/` and wraps the
`wasm-bindgen` exports behind the `ComputeCore` interface.
