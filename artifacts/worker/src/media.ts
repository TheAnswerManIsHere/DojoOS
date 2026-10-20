// The ingest derivatives (architecture.md §4): a 1080p H.264/AAC proxy, a thumbnail sprite and
// a waveform peaks file, each made from local files with ffmpeg so they can be tested without
// storage. Every step reports its own cost from ffmpeg's -benchmark line, which is what step 1
// records as the first real proxy's wall time and peak memory.
import { spawn } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import { peaksPerSecond, peaksSampleRate, proxyMaxEdge, spriteLayout, type Peaks, type StepCost } from "@workspace/shared";

type Run = { stderr: string; wallMs: number; maxRssKiB: number | null };

function run(command: string, args: string[], signal: AbortSignal, onStdout?: (chunk: Buffer) => void): Promise<Run> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { signal, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => onStdout?.(chunk));
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-20_000); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`${command} exited ${code}: ${stderr.slice(-1500)}`));
      // ffmpeg 6 prints "maxrss=48196kB", 7 prints "KiB"; both are getrusage's kibibytes on Linux.
      const rss = /bench: maxrss=(\d+)\s*(?:KiB|kB)/i.exec(stderr);
      resolve({ stderr, wallMs: Math.round(performance.now() - started), maxRssKiB: rss ? Number(rss[1]) : null });
    });
  });
}

const ffmpeg = (args: string[], signal: AbortSignal, onStdout?: (chunk: Buffer) => void) =>
  run("ffmpeg", ["-hide_banner", "-nostdin", "-benchmark", "-y", ...args], signal, onStdout);

/** Fits the picture inside proxyMaxEdge × proxyMaxEdge (never upscaling), keyframe every second for seeking, moov first for
 * range playback. The audio keeps the source's channel layout: forcing stereo upmixes a mono lav track at -3 dB, and the
 * waveform made from the proxy would read quieter than the camera recorded. */
export async function makeProxy(input: string, output: string, signal: AbortSignal,
  streams: { hasVideo: boolean; hasAudio: boolean } = { hasVideo: true, hasAudio: true }): Promise<StepCost> {
  const fit = `scale=w='min(iw,${proxyMaxEdge})':h='min(ih,${proxyMaxEdge})':force_original_aspect_ratio=decrease:force_divisible_by=2`;
  const video = streams.hasVideo ? ["-map", "0:v:0", "-vf", fit, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-pix_fmt", "yuv420p", "-force_key_frames", "expr:gte(t,n_forced*1)"] : ["-vn"];
  const audio = streams.hasAudio ? ["-map", "0:a:0", "-c:a", "aac", "-b:a", "128k"] : ["-an"];
  const result = await ffmpeg(["-i", input, ...video, ...audio, "-movflags", "+faststart", "-f", "mp4", output], signal);
  return { wallMs: result.wallMs, maxRssKiB: result.maxRssKiB, bytes: (await stat(output)).size };
}

/** One JPEG grid of tiles laid out by spriteLayout, read from the proxy (already small, so cheap to decode). */
export async function makeSprite(proxy: string, output: string, durationMs: number, width: number, height: number, signal: AbortSignal): Promise<StepCost> {
  const layout = spriteLayout(durationMs, width, height);
  const filter = `fps=1/${layout.intervalSeconds},scale=${layout.tileWidth}:${layout.tileHeight},tile=${layout.columns}x${layout.rows}`;
  const result = await ffmpeg(["-i", proxy, "-an", "-vf", filter, "-frames:v", "1", "-q:v", "5", "-f", "image2", output], signal);
  return { wallMs: result.wallMs, maxRssKiB: result.maxRssKiB, bytes: (await stat(output)).size };
}

/** Mono 8 kHz decode reduced to 8-bit min/max pairs, peaksPerSecond of them per second, streamed so memory stays flat
 * whatever the length; a source with no audio gets an empty peaks file. */
export async function makePeaks(input: string, output: string, hasAudio: boolean, signal: AbortSignal): Promise<StepCost> {
  const samplesPerPixel = peaksSampleRate / peaksPerSecond;
  const data: number[] = [];
  let wallMs = 0, maxRssKiB: number | null = null;
  if (hasAudio) {
    let carry: Buffer = Buffer.alloc(0);
    let min = 0, max = 0, inPixel = 0;
    const result = await ffmpeg(["-i", input, "-vn", "-map", "0:a:0", "-ac", "1", "-ar", String(peaksSampleRate), "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"], signal, (chunk) => {
      const bytes = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const usable = bytes.length - (bytes.length % 2);
      for (let offset = 0; offset < usable; offset += 2) {
        const sample = bytes.readInt16LE(offset);
        if (sample < min) min = sample;
        if (sample > max) max = sample;
        if (++inPixel === samplesPerPixel) { data.push(min >> 8, max >> 8); min = 0; max = 0; inPixel = 0; }
      }
      carry = bytes.subarray(usable);
    });
    if (inPixel > 0) data.push(min >> 8, max >> 8);
    ({ wallMs, maxRssKiB } = result);
  }
  const peaks: Peaks = { version: 2, channels: 1, sample_rate: peaksSampleRate, samples_per_pixel: samplesPerPixel, bits: 8, length: data.length / 2, data };
  await writeFile(output, JSON.stringify(peaks));
  return { wallMs, maxRssKiB, bytes: (await stat(output)).size };
}
