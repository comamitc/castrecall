/**
 * OS keychain backend for Pocket Casts credentials and the session token —
 * the safer alternative to plaintext env vars (see docs/ARCHITECTURE.md).
 *
 * Follows the same "detect a CLI, then drive it through an injected
 * `ExecImpl`" shape as ../transcripts/local-whisper.ts: detection is pure
 * (no subprocess) so it stays deterministic in tests, and every keychain
 * operation goes through an injectable exec so nothing here ever touches a
 * real keychain unless a test explicitly asks it to.
 *
 * Two backends, both accessed as argv-only subprocess calls (never
 * `sh -c`, so secret values never touch a shell line):
 *  - macOS: the built-in `security` CLI (Keychain Access).
 *  - Linux: `secret-tool` from libsecret (GNOME Keyring / KWallet backends).
 */
import type { ResolvedConfig } from "../config.js";
export type SecretBackend = {
    kind: "macos-keychain";
    bin: string;
} | {
    kind: "libsecret";
    bin: string;
};
export type SecretBackendDetection = {
    backend: SecretBackend;
    reason?: undefined;
} | {
    backend?: undefined;
    reason: string;
};
export type ExecResult = {
    code: number | null;
    stdout: string;
    stderr: string;
};
export type ExecImpl = (argv: string[], options: {
    timeoutMs: number;
    stdin?: string;
}) => Promise<ExecResult>;
export declare function detectSecretBackend(config: ResolvedConfig, deps?: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
}): Promise<SecretBackendDetection>;
/** Reads never throw: any failure (missing entry, exec error) degrades to "absent". */
export declare function readSecret(backend: SecretBackend, service: string, account: string, deps?: {
    execImpl?: ExecImpl;
}): Promise<string | undefined>;
export declare function writeSecret(backend: SecretBackend, service: string, account: string, value: string, deps?: {
    execImpl?: ExecImpl;
}): Promise<void>;
export declare function deleteSecret(backend: SecretBackend, service: string, account: string, deps?: {
    execImpl?: ExecImpl;
}): Promise<void>;
