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
import { spawn } from "node:child_process";
import { findOnPath } from "../transcripts/local-whisper.js";
const SECRET_TIMEOUT_MS = 10_000;
export async function detectSecretBackend(config, deps = {}) {
    if (config.secrets.keychainDisabled) {
        return { reason: "Keychain storage is disabled via CASTRECALL_DISABLE_KEYCHAIN." };
    }
    const env = deps.env ?? process.env;
    const platform = deps.platform ?? process.platform;
    if (platform === "darwin") {
        const bin = await findOnPath("security", env.PATH ?? "");
        if (bin)
            return { backend: { kind: "macos-keychain", bin } };
        return { reason: "macOS Keychain CLI ('security') not found on PATH." };
    }
    if (platform === "linux") {
        const bin = await findOnPath("secret-tool", env.PATH ?? "");
        if (bin)
            return { backend: { kind: "libsecret", bin } };
        return {
            reason: "libsecret's 'secret-tool' not found on PATH. Install it (e.g. 'apt install " +
                "libsecret-tools' or 'dnf install libsecret') to store credentials in the OS keychain.",
        };
    }
    return {
        reason: `No supported OS keychain backend for platform '${platform}' (macOS Keychain and libsecret/Linux only).`,
    };
}
/** Reads never throw: any failure (missing entry, exec error) degrades to "absent". */
export async function readSecret(backend, service, account, deps = {}) {
    const execImpl = deps.execImpl ?? defaultExec;
    const argv = backend.kind === "macos-keychain"
        ? [backend.bin, "find-generic-password", "-s", service, "-a", account, "-w"]
        : [backend.bin, "lookup", "service", service, "account", account];
    try {
        const result = await execImpl(argv, { timeoutMs: SECRET_TIMEOUT_MS });
        if (result.code !== 0)
            return undefined;
        // macOS `-w` appends a trailing newline; trim so callers get the raw value.
        return result.stdout.trim();
    }
    catch {
        return undefined;
    }
}
export async function writeSecret(backend, service, account, value, deps = {}) {
    const execImpl = deps.execImpl ?? defaultExec;
    if (backend.kind === "macos-keychain") {
        // -U (update-in-place) makes writes idempotent; -w carries the value in
        // argv, which is briefly visible in the process list on macOS (accepted
        // for the short-lived token — see docs/ARCHITECTURE.md).
        const result = await execImpl([backend.bin, "add-generic-password", "-U", "-s", service, "-a", account, "-w", value], { timeoutMs: SECRET_TIMEOUT_MS });
        assertExitOk(result, "security add-generic-password");
        return;
    }
    // secret-tool store is idempotent (overwrites by attribute set) and takes
    // the value on stdin, so it never appears in argv or the process list.
    const result = await execImpl([backend.bin, "store", "--label", `CastRecall ${account}`, "service", service, "account", account], { timeoutMs: SECRET_TIMEOUT_MS, stdin: value });
    assertExitOk(result, "secret-tool store");
}
export async function deleteSecret(backend, service, account, deps = {}) {
    const execImpl = deps.execImpl ?? defaultExec;
    const argv = backend.kind === "macos-keychain"
        ? [backend.bin, "delete-generic-password", "-s", service, "-a", account]
        : [backend.bin, "clear", "service", service, "account", account];
    const result = await execImpl(argv, { timeoutMs: SECRET_TIMEOUT_MS });
    assertExitOk(result, `${backend.kind} delete`);
}
function assertExitOk(result, label) {
    if (result.code === 0)
        return;
    const stderrTail = result.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 500);
    throw new Error(`${label} exited with code ${result.code ?? "null (timeout/signal)"}${stderrTail ? `: ${stderrTail}` : ""}`);
}
function defaultExec(argv, options) {
    return new Promise((resolve, reject) => {
        const [command, ...args] = argv;
        const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
        child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
        child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
        if (options.stdin !== undefined) {
            child.stdin.end(options.stdin, "utf8");
        }
        else {
            child.stdin.end();
        }
    });
}
