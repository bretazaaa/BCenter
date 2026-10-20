// Lance `electron-vite dev` sans ELECTRON_RUN_AS_NODE : cette variable, héritée de certains terminaux
// (VS Code, outils basés sur Electron), ferait démarrer Electron comme un simple Node.js.
import { spawn } from 'node:child_process'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(['npx electron-vite dev', ...process.argv.slice(2)].join(' '), { stdio: 'inherit', env, shell: true })
child.on('exit', (code) => process.exit(code ?? 0))
