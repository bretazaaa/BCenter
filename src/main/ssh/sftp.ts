import { mkdir, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { SFTPWrapper, Stats } from 'ssh2'
import type { RemoteFile } from '@shared/types'

/** Transfert en cours : octets transférés sur le total (fichier par fichier). */
export type TransferProgress = (file: string, transferred: number, total: number) => void

/** Session de fichiers distante (SFTP) ouverte sur une machine. */
export interface FileSession {
  home(): Promise<string>
  list(path: string): Promise<RemoteFile[]>
  mkdir(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
  readText(path: string, maxBytes: number): Promise<string>
  writeText(path: string, content: string): Promise<void>
  /** Télécharge un fichier ou un dossier (récursivement) vers un chemin local. */
  download(remote: string, local: string, progress?: TransferProgress): Promise<void>
  /** Envoie un fichier ou un dossier local (récursivement) dans un dossier distant. */
  upload(local: string, remoteDir: string, progress?: TransferProgress): Promise<void>
  close(): void
}

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

export const remoteJoin = (dir: string, name: string) => (dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`)

const call = <T>(fn: (cb: (err: Error | null | undefined, value: T) => void) => void) =>
  new Promise<T>((resolve, reject) => fn((err, value) => (err ? reject(translate(err)) : resolve(value))))

function translate(error: Error & { code?: number }): Error {
  // Codes SFTP : 2 introuvable, 3 permission refusée, 4 échec générique (dossier non vide…).
  if (error.code === 2) return new Error('Fichier ou dossier introuvable.')
  if (error.code === 3) return new Error('Permission refusée.')
  return error
}

export class SftpSession implements FileSession {
  constructor(
    private readonly sftp: SFTPWrapper,
    private readonly onClose: () => void,
  ) {}

  home() {
    return call<string>((cb) => this.sftp.realpath('.', cb))
  }

  async list(path: string): Promise<RemoteFile[]> {
    const entries = await call<{ filename: string; longname: string; attrs: Stats }[]>((cb) => this.sftp.readdir(path, cb))
    const files = await Promise.all(
      entries
        .filter((e) => e.filename !== '.' && e.filename !== '..')
        .map(async (e): Promise<RemoteFile> => {
          const kind = e.attrs.mode & S_IFMT
          let type: RemoteFile['type'] = kind === S_IFDIR ? 'dir' : kind === S_IFLNK ? 'link' : 'file'
          // Lien symbolique : on suit la cible pour savoir s'il s'agit d'un dossier.
          if (type === 'link') {
            const target = await call<Stats>((cb) => this.sftp.stat(remoteJoin(path, e.filename), cb)).catch(() => null)
            if (target && (target.mode & S_IFMT) === S_IFDIR) type = 'dir'
          }
          return {
            name: e.filename,
            path: remoteJoin(path, e.filename),
            type,
            size: e.attrs.size,
            modified: e.attrs.mtime * 1000,
            mode: e.longname.split(/\s+/)[0] ?? '',
          }
        }),
    )
    return files.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name))
  }

  mkdir(path: string) {
    return call<void>((cb) => this.sftp.mkdir(path, (err) => cb(err, undefined)))
  }

  rename(from: string, to: string) {
    return call<void>((cb) => this.sftp.rename(from, to, (err) => cb(err, undefined)))
  }

  async remove(path: string): Promise<void> {
    const info = await call<Stats>((cb) => this.sftp.lstat(path, cb))
    if ((info.mode & S_IFMT) === S_IFDIR) {
      for (const child of await this.list(path)) await this.remove(child.path)
      await call<void>((cb) => this.sftp.rmdir(path, (err) => cb(err, undefined)))
    } else {
      await call<void>((cb) => this.sftp.unlink(path, (err) => cb(err, undefined)))
    }
  }

  async readText(path: string, maxBytes: number): Promise<string> {
    const info = await call<Stats>((cb) => this.sftp.stat(path, cb))
    if (info.size > maxBytes) throw new Error(`Fichier trop volumineux pour l’éditeur (${Math.round(info.size / 1024)} Kio) : téléchargez-le.`)
    const data = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      this.sftp.createReadStream(path).on('data', (c: Buffer) => chunks.push(c)).on('error', reject).on('end', () => resolve(Buffer.concat(chunks)))
    })
    if (data.includes(0)) throw new Error('Fichier binaire : téléchargez-le pour l’ouvrir.')
    return data.toString('utf8')
  }

  writeText(path: string, content: string) {
    return call<void>((cb) => this.sftp.writeFile(path, content, 'utf8', (err) => cb(err, undefined)))
  }

  async download(remote: string, local: string, progress?: TransferProgress): Promise<void> {
    const info = await call<Stats>((cb) => this.sftp.stat(remote, cb))
    if ((info.mode & S_IFMT) === S_IFDIR) {
      await mkdir(local, { recursive: true })
      for (const child of await this.list(remote)) await this.download(child.path, join(local, child.name), progress)
      return
    }
    await call<void>((cb) => this.sftp.fastGet(remote, local, { step: (done, _chunk, total) => progress?.(basename(remote), done, total) }, (err) => cb(err, undefined)))
  }

  async upload(local: string, remoteDir: string, progress?: TransferProgress): Promise<void> {
    const name = basename(local)
    const destination = remoteJoin(remoteDir, name)
    if ((await stat(local)).isDirectory()) {
      await this.mkdir(destination).catch(() => undefined) // Le dossier peut déjà exister.
      for (const child of await readdir(local)) await this.upload(join(local, child), destination, progress)
      return
    }
    await call<void>((cb) => this.sftp.fastPut(local, destination, { step: (done, _chunk, total) => progress?.(name, done, total) }, (err) => cb(err, undefined)))
  }

  close() {
    this.sftp.end()
    this.onClose()
  }
}
