import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * A static check, in the same spirit as routeMountParity.test.js.
 *
 * Generated client documents — invoices, quotes, statements — must go to the
 * non-public bucket. The per-generator suites all run with ISOPLUS_OFFLINE=1,
 * where uploads land in a local directory and the bucket argument is inert, so
 * a world-readable upload passes every one of them. This reads the source
 * instead, and covers call sites that do not exist yet.
 *
 * The only legitimate public upload is a business logo, which is meant to be
 * world-readable and is listed below.
 */
const SRC = fileURLToPath(new URL('../../../src', import.meta.url));

const PUBLIC_BY_DESIGN = ['businessProfileUpdate.js'];
const S3_CALLS = ['uploadFileToS3', 'getS3FileUrl'];

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.js') ? [path] : [];
  });
}

/**
 * The argument list of each S3 call, read by counting bracket depth rather
 * than by regex: the real call sites nest — `uploadFileToS3(Buffer.from(x),
 * key, true)` — and a `[^)]*` pattern stops at the inner bracket and misses
 * exactly the sites that matter.
 */
export function s3CallArguments(source) {
  const calls = [];
  for (const name of S3_CALLS) {
    let from = 0;
    for (;;) {
      const start = source.indexOf(`${name}(`, from);
      if (start === -1) break;
      let depth = 0;
      let end = start + name.length;
      for (; end < source.length; end += 1) {
        if (source[end] === '(') depth += 1;
        else if (source[end] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      calls.push({ name, args: source.slice(start + name.length + 1, end) });
      from = end + 1;
    }
  }
  return calls;
}

/** A call whose last argument is a bare `true` asks for the public bucket. */
const asksForPublicBucket = ({ args }) => /,\s*true\s*$/.test(args.trim());

describe('generated documents are not world-readable', () => {
  it('has no S3 call site asking for the public bucket, outside the logo path', () => {
    const offenders = [];
    for (const file of sourceFiles(SRC)) {
      if (PUBLIC_BY_DESIGN.some((name) => file.endsWith(name))) continue;
      for (const call of s3CallArguments(readFileSync(file, 'utf8')).filter(asksForPublicBucket)) {
        offenders.push(`${file.slice(SRC.length + 1)}: ${call.name}(${call.args.trim()})`);
      }
    }

    // These keys are built from sequential document numbers, so one guessed
    // number enumerates the rest, and each PDF carries a participant's name,
    // address and amounts.
    expect(offenders).toEqual([]);
  });

  it('is a check that can actually fail, including on a nested call', () => {
    // The first version of this guard used [^)]* and stopped at the bracket in
    // Buffer.from(...), so it silently skipped the uploads it existed to catch.
    const nested = 'uploadFileToS3(Buffer.from(pdfBytes), filename, true)';
    expect(s3CallArguments(nested).filter(asksForPublicBucket)).toHaveLength(1);
    expect(s3CallArguments('getS3FileUrl(key, 3600, true)').filter(asksForPublicBucket)).toHaveLength(1);
    expect(
      s3CallArguments('uploadFileToS3(buf, key, GENERATED_DOCUMENT_PUBLIC_READ)').filter(asksForPublicBucket),
    ).toHaveLength(0);
    expect(s3CallArguments('getS3File(key)').filter(asksForPublicBucket)).toHaveLength(0);
  });
});
