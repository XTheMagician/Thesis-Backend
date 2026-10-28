import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';

// ------------------------------------------------------------------ //
//  Study-wide configuration constants                                 //
// ------------------------------------------------------------------ //

/** Schema version of the JSONL event log; bumped on breaking log changes. */
export const LOG_SCHEMA_VERSION = 1;

/**
 * Whether the participant's transcribed speech TEXT is written to the log.
 * Off by default — the study only needs when/how long the participant spoke
 * (see the user:utterance events), not what they said. Robot speech text is
 * always logged. Toggle with LOG_USER_TRANSCRIPT_TEXT=true in .env.
 */
export const LOG_USER_TRANSCRIPT_TEXT =
  (process.env.LOG_USER_TRANSCRIPT_TEXT ?? '').toLowerCase() === 'true';

/** Valid participant-code pattern. Only matching codes reach the aggregate
 *  "participants" export sheet; everything else is flagged under "hinweise". */
export const PARTICIPANT_ID_PATTERN = /^P\d{3}$/;

/**
 * App version recorded in session:started: the current git commit hash if the
 * backend runs from a checkout, otherwise the package.json version. Resolved
 * once at startup.
 */
export const APP_VERSION: string = resolveAppVersion();

function resolveAppVersion(): string {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
  try {
    return execSync('git rev-parse HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    // Not a git checkout (or git unavailable) — fall back to the package version
  }
  try {
    const pkgPath = join(root, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
      if (pkg.version) return `v${pkg.version}`;
    }
  } catch {
    // ignore
  }
  return 'unknown';
}
