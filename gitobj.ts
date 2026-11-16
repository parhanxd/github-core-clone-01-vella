// Pure git object model: hashing, trees, commits, tags, packfiles (read + write), deltas.
// Everything runs on node:zlib and node:crypto only.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObj { type: ObjType; data: Buffer }

export interface TreeEntry { mode: string; name: string; oid: string }

export const ZERO_OID = '0'.repeat(40);
const OID_RE = /^[0-9a-f]{40}$/;

export const isObjectId = (s: unknown): s is string => typeof s === 'string' && OID_RE.test(s);

export function hashObject(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`);
  h.update(data);
  return h.digest('hex');
}

export function makeObj(type: ObjType, data: Buffer): GitObj & { oid: string } {
  return { type, data, oid: hashObject(type, data) };
}

// ---------------------------------------------------------------- trees

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, space + 1);
    const mode = data.subarray(i, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): GitObj & { oid: string } {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return makeObj('tree', Buffer.concat(parts));
}

// ---------------------------------------------------------------- commits and tags

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  gpgsig?: string;
  raw: Buffer;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const lines = text.split('\n');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let message = '';
  let inBody = false;
  const bodyLines: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (inBody) { bodyLines.push(line); continue; }
    if (line === '') { inBody = true; continue; }
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (inBody) message = bodyLines.join('\n');
  return { tree, parents, author, committer, message, raw: data };
}

export interface BuildCommitInput {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}

export function buildCommit(input: BuildCommitInput): GitObj & { oid: string } {
  const lines: string[] = [`tree ${input.tree}`];
  for (const p of input.parents) lines.push(`parent ${p}`);
  lines.push(`author ${input.author}`);
  lines.push(`committer ${input.committer}`);
  lines.push('');
  lines.push(input.message);
  const data = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
  return makeObj('commit', data);
}

export function buildTag(input: { object: string; type: ObjType; tag: string; tagger: string; message: string }): GitObj & { oid: string } {
  const lines = [
    `object ${input.object}`,
    `type ${input.type}`,
    `tag ${input.tag}`,
    `tagger ${input.tagger}`,
    '',
    input.message,
  ];
  return makeObj('tag', Buffer.from(`${lines.join('\n')}\n`, 'utf8'));
}

// ---------------------------------------------------------------- packfiles

/** Read one header varint of a pack entry at offset i; returns {type, size, next}. */
function readPackHeader(buf: Buffer, i: number): { type: number; size: number; next: number } {
  const b0 = buf[i];
  const type = (b0 >> 4) & 0x7;
  let size = b0 & 0x0f;
  let shift = 4;
  let next = i + 1;
  let byte = b0;
  while (byte & 0x80) {
    byte = buf[next];
    size |= (byte & 0x7f) << shift;
    shift += 7;
    next += 1;
  }
  return { type, size, next };
}

const PACK_TYPE_OF: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVarint = (): number => {
    let result = 0;
    let shift = 0;
    let byte = 0;
    do {
      byte = delta[i];
      i += 1;
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error(`delta base size ${baseSize} != ${base.length}`);
  const resultSize = readVarint();
  const out = Buffer.alloc(resultSize);
  let o = 0;
  while (i < delta.length) {
    const op = delta[i];
    i += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset |= delta[i]; i += 1; }
      if (op & 0x02) { offset |= delta[i] << 8; i += 1; }
      if (op & 0x04) { offset |= delta[i] << 16; i += 1; }
      if (op & 0x08) { offset |= delta[i] << 24; i += 1; }
      if (op & 0x10) { size |= delta[i]; i += 1; }
      if (op & 0x20) { size |= delta[i] << 8; i += 1; }
      if (op & 0x40) { size |= delta[i] << 16; i += 1; }
      size &= 0xffff;
      if (size === 0) size = 0x10000;
      base.copy(out, o, offset, offset + size);
      o += size;
    } else if (op > 0) {
      delta.copy(out, o, i, i + op);
      i += op;
      o += op;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  if (o !== resultSize) throw new Error(`delta result size ${o} != ${resultSize}`);
  return out;
}

/** Inflate the zlib stream starting exactly at `start` (unknown length): window + binary search. */
function inflateExact(buf: Buffer, start: number, hint = 256): Buffer {
  const ok = (end: number): Buffer | null => {
    try { return inflateSync(buf.subarray(start, end)); } catch { return null; }
  };
  const limit = buf.length;
  // find an end that inflates cleanly
  let end = Math.min(start + hint, limit);
  let result = ok(end);
  while (result === null && end < limit) {
    hint *= 4;
    end = Math.min(start + hint, limit);
    result = ok(end);
  }
  if (result === null) throw new Error(`zlib stream at ${start} could not be inflated`);
  // binary search for the smallest clean end
  let lo = start + 1;
  let hi = end;
  let best = end;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (ok(mid) !== null) { hi = mid; best = mid; }
    else lo = mid + 1;
  }
  return ok(best)!;
}

function endOfStream(pack: Buffer, start: number, hint = 256): number {
  const ok = (end: number): boolean => {
    try { inflateSync(pack.subarray(start, end)); return true; } catch { return false; }
  };
  const limit = pack.length;
  let end = Math.min(start + hint, limit);
  while (!ok(end) && end < limit) {
    hint *= 4;
    end = Math.min(start + hint, limit);
  }
  if (!ok(end)) throw new Error(`zlib stream at ${start} has no end within the pack`);
  let lo = start + 1;
  let hi = end;
  let best = end;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (ok(mid)) { hi = mid; best = mid; }
    else lo = mid + 1;
  }
  return best;
}

// ---------------------------------------------------------------- pack write

const TYPE_OF_PACK: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function writePackObjectHeader(size: number, type: number): Buffer {
  const bytes: number[] = [];
  let b = (type << 4) | (size & 0x0f);
  let rest = size >> 4;
  while (rest > 0) {
    bytes.push(b | 0x80);
    b = rest & 0x7f;
    rest >>= 7;
  }
  bytes.push(b);
  return Buffer.from(bytes);
}

/** Write a (thin-less) pack holding `objects`, undeltified, with a correct trailer. */
export function writePack(objects: readonly GitObj[]): Buffer {
  const chunks: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const version = Buffer.alloc(4);
  version.writeUInt32BE(2, 0);
  const countBuf = Buffer.alloc(4);
  countBuf.writeUInt32BE(objects.length, 0);
  chunks.push(version, countBuf);
  for (const obj of objects) {
    chunks.push(writePackObjectHeader(obj.data.length, TYPE_OF_PACK[obj.type]));
    chunks.push(deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- pack read

/**
 * Parse a packfile (v2) into objects. `lookupBase` resolves REF_DELTA bases
 * from outside the pack (may return undefined). Returns the objects keyed by
 * their own SHA-1, with OFS/REF deltas applied.
 */
export function readPack(
  pack: Buffer,
  lookupBase: (oid: string) => GitObj | undefined,
): { objects: Map<string, GitObj> } {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('bad pack: missing PACK signature');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(pack.subarray(pack.length - 20))) throw new Error('bad pack: checksum mismatch');

  interface Entry { start: number; type: number; data: Buffer; ofsDelta?: number; refDelta?: string }
  const entries: Entry[] = [];

  let i = 12;
  for (let n = 0; n < count; n += 1) {
    const start = i;
    const { type, size, next } = readPackHeader(pack, i);
    let p = next;
    let ofsDelta: number | undefined;
    let refDelta: string | undefined;
    if (type === 6) {
      // OFS_DELTA: negative offset varint (git's odd encoding)
      let byte = pack[p];
      p += 1;
      let off = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[p];
        p += 1;
        off = ((off + 1) << 7) | (byte & 0x7f);
      }
      ofsDelta = start - off;
      if (ofsDelta < 12) throw new Error('OFS_DELTA base offset out of range');
    } else if (type === 7) {
      refDelta = pack.subarray(p, p + 20).toString('hex');
      p += 20;
    }
    const dataStart = p;
    const inflated = inflateExact(pack, dataStart, Math.max(64, size));
    entries.push({ start, type, data: inflated, ofsDelta, refDelta });
    i = endOfStream(pack, dataStart, Math.max(64, size));
  }

  const byOffset = new Map<number, number>();
  entries.forEach((e, n) => byOffset.set(e.start, n));
  const objects = new Map<string, GitObj>();

  // resolve non-delta entries first
  const raw = new Array<GitObj | null>(entries.length).fill(null);
  for (let n = 0; n < entries.length; n += 1) {
    const e = entries[n];
    if (e.type < 5) {
      const t = PACK_TYPE_OF[e.type];
      if (!t) throw new Error(`bad pack object type ${e.type}`);
      raw[n] = makeObj(t, e.data);
      objects.set(raw[n]!.oid, raw[n]!);
    }
  }

  // resolve deltas iteratively (chains can point forward via REF_DELTA or be deep)
  let pending = entries.map((e, n) => (e.type >= 5 ? n : -1)).filter((n) => n >= 0);
  while (pending.length) {
    const nextRound: number[] = [];
    for (const n of pending) {
      const e = entries[n];
      let base: GitObj | undefined;
      if (e.type === 6) {
        const bi = byOffset.get(e.ofsDelta!);
        base = bi === undefined ? undefined : raw[bi] ?? undefined;
      } else {
        base = objects.get(e.refDelta!) ?? lookupBase(e.refDelta!);
      }
      if (base === undefined) { nextRound.push(n); continue; }
      const obj = makeObj(base.type, applyDelta(base.data, e.data));
      raw[n] = obj;
      objects.set(obj.oid, obj);
    }
    if (nextRound.length === pending.length) {
      throw new Error(`pack: cannot resolve ${nextRound.length} delta(s) (thin pack with missing base?)`);
    }
    pending = nextRound;
  }
  return { objects };
}


export interface CommitMeta { tree: string; parents: string[] }

/** Parse the pieces of a commit needed for history walks. */
export function commitMetaOf(obj: GitObj): CommitMeta {
  const c = parseCommit(obj.data);
  return { tree: c.tree, parents: c.parents };
}
