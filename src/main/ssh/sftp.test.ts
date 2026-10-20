import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { localChild, safeLocalName } from './sftp'

describe('téléchargement SFTP', () => {
  it('neutralise les noms distants dangereux sous Windows', () => {
    expect(safeLocalName('..\\..\\Startup\\evil.bat')).toBe('.._.._Startup_evil.bat')
    expect(safeLocalName('..')).toBe('_')
    expect(safeLocalName('C:\\Windows')).toBe('C__Windows')
    expect(safeLocalName('con')).toBe('_con')
    expect(safeLocalName('rapport.pdf.')).toBe('rapport.pdf')
    expect(safeLocalName('normal-file.txt')).toBe('normal-file.txt')
  })

  it('reste toujours dans le dossier de destination', () => {
    const dir = resolve('downloads')
    expect(localChild(dir, '../../evil')).toBe(join(dir, '.._.._evil'))
    expect(localChild(dir, 'a\\..\\..\\b')).toBe(join(dir, 'a_.._.._b'))
  })
})
