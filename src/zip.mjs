// The entries of a zip file from its central directory: what an artifact holds, by name and size,
// without inflating anything. An artifact's zip is read only to say whether it is the one file
// another step already published; its contents are never opened.

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;

/**
 * The entries a zip's central directory lists, as { name, size } (size uncompressed), in the
 * directory's order; null when the buffer is not a zip whose directory can be read (truncated,
 * a zip64 directory, a comment longer than the search window). A directory entry keeps its
 * trailing slash, so a caller can tell a folder from a file.
 * @param {Buffer} buf
 * @returns {{ name: string, size: number }[] | null}
 */
export function zipEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) return null;
  // The end-of-central-directory record is the last 22 bytes, plus a comment of up to 65535.
  const floor = Math.max(0, buf.length - 22 - 65535);
  let at = -1;
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      at = i;
      break;
    }
  }
  if (at < 0) return null;
  const count = buf.readUInt16LE(at + 10);
  const size = buf.readUInt32LE(at + 12);
  const offset = buf.readUInt32LE(at + 16);
  // 0xFFFF / 0xFFFFFFFF say the real values are in a zip64 record, which is not read here.
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) return null;
  if (offset + size > at) return null;
  const entries = [];
  let p = offset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) return null;
    const uncompressed = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    if (p + 46 + nameLength > buf.length) return null;
    entries.push({ name: buf.toString('utf8', p + 46, p + 46 + nameLength), size: uncompressed });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
