# BCenter (source)

Private source repository of **BCenter**, a Windows desktop app to monitor and maintain Proxmox VE infrastructure.
Official builds are published to the public repository [bretazaaa/BCenter](https://github.com/bretazaaa/BCenter).

## Development

Requirements: Node.js 24 and npm.

```bash
npm install
npm run dev        # start the app with hot reload (add -- -- --demo for a simulated cluster)
npm test           # unit tests
npm run typecheck  # TypeScript checks
npm run dist       # build the Windows installer into dist/
```

Stack: Electron, React, Vite, Zustand, TypeScript, Recharts, ssh2, SQLite (`node:sqlite`), electron-builder and electron-updater.

```
src/
├─ main/       Electron main process: engine, Proxmox client, SSH, storage, tray, updates
├─ preload/    Isolated bridge between the UI and the engine
├─ renderer/   React interface
└─ shared/     Types and API contract shared by both sides
```

Other virtualization platforms can be added by implementing `VirtualizationProvider` (`src/main/services/provider.ts`).

## Releasing

1. `npm version patch` (or `minor` / `major`) — creates a commit and a `vX.Y.Z` tag.
2. `git push --follow-tags`.

The [Release workflow](.github/workflows/release.yml) builds the installer and publishes it to the public repository's
Releases, where installed copies of BCenter pick it up automatically. It needs the `RELEASE_TOKEN` secret
(fine-grained token with *Contents: read and write* on `bretazaaa/BCenter`).

## License

Proprietary — see [LICENSE](LICENSE).
