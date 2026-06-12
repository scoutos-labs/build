import { gzipSync } from 'node:zlib'

export type TarEntry = { path: string; content: string }

const BLOCK = 512
const NAME_FIELD = 100
const PREFIX_FIELD = 155

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0') + '\0'
}

/**
 * USTAR stores paths over 100 bytes as prefix(155) + '/' + name(100). Returns
 * [prefix, name] or throws when no '/' split satisfies both limits.
 */
function splitPath(path: string): [string, string] {
  if (Buffer.byteLength(path) <= NAME_FIELD) return ['', path]
  for (let i = path.length - 1; i > 0; i--) {
    if (path[i] !== '/') continue
    const prefix = path.slice(0, i)
    const name = path.slice(i + 1)
    if (Buffer.byteLength(name) <= NAME_FIELD && Buffer.byteLength(prefix) <= PREFIX_FIELD) {
      return [prefix, name]
    }
  }
  throw new Error(`Path too long for USTAR archive: ${path}`)
}

function headerFor(path: string, size: number): Buffer {
  const [prefix, name] = splitPath(path)
  const header = Buffer.alloc(BLOCK)
  header.write(name, 0, NAME_FIELD, 'utf8')
  header.write('0000644\0', 100, 8) // mode
  header.write('0000000\0', 108, 8) // uid
  header.write('0000000\0', 116, 8) // gid
  header.write(octal(size, 12), 124, 12)
  header.write(octal(0, 12), 136, 12) // mtime 0: deterministic archives
  header.fill(' ', 148, 156) // checksum is computed with the field spaced out
  header.write('0', 156, 1) // typeflag: regular file
  header.write('ustar\0', 257, 6)
  header.write('00', 263, 2)
  if (prefix) header.write(prefix, 345, PREFIX_FIELD, 'utf8')

  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return header
}

function padToBlock(buffer: Buffer): Buffer {
  const remainder = buffer.length % BLOCK
  if (remainder === 0) return buffer
  return Buffer.concat([buffer, Buffer.alloc(BLOCK - remainder)])
}

/** Minimal USTAR + gzip writer; directories are implicit in entry paths. */
export function createTarGz(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = []
  for (const entry of entries) {
    const content = Buffer.from(entry.content, 'utf8')
    parts.push(headerFor(entry.path, content.length))
    parts.push(padToBlock(content))
  }
  parts.push(Buffer.alloc(BLOCK * 2)) // end-of-archive marker
  return gzipSync(Buffer.concat(parts))
}
