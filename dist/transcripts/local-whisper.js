/**
 * Rung 3 of the transcript ladder: local Whisper — free and fully private.
 *
 * Nothing is bundled: this rung auto-detects a Whisper CLI the user already
 * has installed (whisper.cpp, openai-whisper, whisper-ctranslate2, or
 * mlx-whisper) and is skipped with an actionable message when none is found.
 * A custom command can be supplied via CASTRECALL_WHISPER_COMMAND with an
 * {input} placeholder; its stdout is treated as the transcript.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CastrecallSetupError } from "../config.js";
const TRANSCRIBE_TIMEOUT_MS = 60 * 60_000; // long episodes on CPU take a while
const KNOWN_BINARIES = [
    { name: "whisper-cli", flavor: "whisper.cpp" },
    { name: "whisper-cpp", flavor: "whisper.cpp" },
    { name: "mlx_whisper", flavor: "mlx-whisper" },
    { name: "whisper-ctranslate2", flavor: "whisper-ctranslate2" },
    { name: "whisper", flavor: "openai-whisper" },
];
export async function detectLocalWhisper(config, env = process.env) {
    if (config.localWhisper.disabled) {
        return { reason: "Local Whisper is disabled via CASTRECALL_DISABLE_LOCAL_WHISPER." };
    }
    if (config.localWhisper.command) {
        if (!config.localWhisper.command.includes("{input}")) {
            return {
                reason: "CASTRECALL_WHISPER_COMMAND is set but has no {input} placeholder for the audio file path.",
            };
        }
        return { detected: { flavor: "custom", command: config.localWhisper.command } };
    }
    for (const candidate of KNOWN_BINARIES) {
        const found = await findOnPath(candidate.name, env.PATH ?? "");
        if (found)
            return { detected: { flavor: candidate.flavor, command: found } };
    }
    return {
        reason: "No local Whisper CLI detected on PATH (looked for " +
            `${KNOWN_BINARIES.map((b) => b.name).join(", ")}). Install one — e.g. ` +
            "'brew install whisper-cpp' plus a ggml model, 'pip install mlx-whisper' on Apple Silicon, " +
            "or 'pip install openai-whisper' — or set CASTRECALL_WHISPER_COMMAND. " +
            "Free and fully private once installed.",
    };
}
export async function findOnPath(binary, pathVar) {
    for (const dir of pathVar.split(path.delimiter).filter(Boolean)) {
        const candidate = path.join(dir, binary);
        try {
            await fs.access(candidate, fs.constants.X_OK);
            const stat = await fs.stat(candidate);
            if (stat.isFile())
                return candidate;
        }
        catch {
            // not here; keep looking
        }
    }
    return undefined;
}
export async function transcribeWithLocalWhisper(config, audioUrl, deps = {}) {
    const detection = await detectLocalWhisper(config, deps.env ?? process.env);
    if (!detection.detected)
        throw new CastrecallSetupError(detection.reason);
    if (!audioUrl)
        throw new Error("Episode has no audio URL; cannot transcribe locally.");
    const fetchImpl = deps.fetchImpl ?? fetch;
    const execImpl = deps.execImpl ?? defaultExec;
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "castrecall-whisper-"));
    try {
        const audioPath = await downloadAudio(fetchImpl, audioUrl, workDir);
        const text = await runWhisper(detection.detected, config, audioPath, workDir, execImpl, deps.env);
        if (!text.trim()) {
            throw new Error(`${detection.detected.flavor} produced an empty transcript.`);
        }
        return { text: text.trim(), provider: providerLabel(detection.detected, config) };
    }
    finally {
        await fs.rm(workDir, { recursive: true, force: true });
    }
}
async function downloadAudio(fetchImpl, audioUrl, workDir) {
    const response = await fetchImpl(audioUrl);
    if (!response.ok) {
        throw new Error(`Audio download failed with HTTP ${response.status}.`);
    }
    const ext = audioUrl.split("?")[0].split(".").pop()?.toLowerCase();
    const safeExt = ext && /^[a-z0-9]{1,5}$/.test(ext) ? ext : "mp3";
    const audioPath = path.join(workDir, `episode.${safeExt}`);
    await fs.writeFile(audioPath, Buffer.from(await response.arrayBuffer()));
    return audioPath;
}
async function runWhisper(detected, config, audioPath, workDir, execImpl, env = process.env) {
    const model = config.localWhisper.model;
    switch (detected.flavor) {
        case "custom": {
            const command = detected.command
                .replaceAll("{input}", shellQuote(audioPath))
                .replaceAll("{model}", model ? shellQuote(model) : "");
            const result = await execImpl(["/bin/sh", "-c", command], {
                timeoutMs: TRANSCRIBE_TIMEOUT_MS,
            });
            assertExitOk(result, "custom whisper command");
            return result.stdout;
        }
        case "whisper.cpp": {
            if (!model) {
                throw new CastrecallSetupError("whisper.cpp needs a ggml model file. Set CASTRECALL_WHISPER_MODEL=/path/to/ggml-<size>.bin " +
                    "(download one with whisper.cpp's models script or from Hugging Face ggerganov/whisper.cpp).");
            }
            const input = await ensureWav(audioPath, workDir, execImpl, env);
            const result = await execImpl([detected.command, "-m", model, "-f", input, "-np", "-nt"], { timeoutMs: TRANSCRIBE_TIMEOUT_MS });
            assertExitOk(result, "whisper.cpp");
            return result.stdout;
        }
        case "openai-whisper":
        case "whisper-ctranslate2": {
            const argv = [
                detected.command,
                audioPath,
                "--output_format",
                "txt",
                "--output_dir",
                workDir,
                "--verbose",
                "False",
                ...(model ? ["--model", model] : []),
            ];
            const result = await execImpl(argv, { timeoutMs: TRANSCRIBE_TIMEOUT_MS });
            assertExitOk(result, detected.flavor);
            return readProducedTxt(workDir, audioPath);
        }
        case "mlx-whisper": {
            const argv = [
                detected.command,
                audioPath,
                "--output-dir",
                workDir,
                "--output-format",
                "txt",
                ...(model ? ["--model", model] : []),
            ];
            const result = await execImpl(argv, { timeoutMs: TRANSCRIBE_TIMEOUT_MS });
            assertExitOk(result, "mlx-whisper");
            return readProducedTxt(workDir, audioPath);
        }
    }
}
/** whisper.cpp wants 16 kHz mono WAV; convert with ffmpeg when the input isn't WAV. */
async function ensureWav(audioPath, workDir, execImpl, env) {
    if (audioPath.endsWith(".wav"))
        return audioPath;
    const ffmpeg = await findOnPath("ffmpeg", env.PATH ?? "");
    if (!ffmpeg) {
        throw new CastrecallSetupError("whisper.cpp needs 16 kHz WAV input and the episode audio is not WAV. " +
            "Install ffmpeg (e.g. 'brew install ffmpeg'), or use another Whisper CLI " +
            "(openai-whisper / mlx-whisper decode audio themselves).");
    }
    const wavPath = path.join(workDir, "episode.wav");
    const result = await execImpl([ffmpeg, "-y", "-i", audioPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath], { timeoutMs: 10 * 60_000 });
    assertExitOk(result, "ffmpeg conversion");
    return wavPath;
}
async function readProducedTxt(workDir, audioPath) {
    const base = path.basename(audioPath).replace(/\.[^.]+$/, "");
    const expected = path.join(workDir, `${base}.txt`);
    try {
        return await fs.readFile(expected, "utf8");
    }
    catch {
        // Some CLIs name outputs differently; take any .txt they produced.
        const entries = await fs.readdir(workDir);
        const txt = entries.find((name) => name.endsWith(".txt"));
        if (!txt)
            throw new Error("Whisper run finished but produced no .txt output.");
        return fs.readFile(path.join(workDir, txt), "utf8");
    }
}
function providerLabel(detected, config) {
    const model = config.localWhisper.model;
    const modelPart = model ? `:${path.basename(model)}` : "";
    return `local-whisper:${detected.flavor}${modelPart}`;
}
function assertExitOk(result, label) {
    if (result.code === 0)
        return;
    const stderrTail = result.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 500);
    throw new Error(`${label} exited with code ${result.code ?? "null (timeout/signal)"}${stderrTail ? `: ${stderrTail}` : ""}`);
}
function shellQuote(value) {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
function defaultExec(argv, options) {
    return new Promise((resolve, reject) => {
        const [command, ...args] = argv;
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
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
    });
}
