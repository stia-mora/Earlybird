# EarlyBird bundled references

This repository bundles the following upstream reference repositories for deterministic,
offline rendering and copy editing:

- Local clones are kept under `vendor/skills/` for source inspection; tracked snapshots are under `vendor/references/`.
- `humanizer-zh` at `91f3d394db8419c20d67ebe22a96cf8fee0a404b` (MIT, op7418)
- `gzh-design-skill` at `ba1f4175519b481cb3566616c9e5178705067904` (AGPL-3.0, isjiamu)

The EarlyBird renderer reads the Graphite Minimal theme and common components from the
tracked snapshot. The service is intended for private self-hosted deployment; any
network deployment must comply with the AGPL-3.0 source-availability requirements.
