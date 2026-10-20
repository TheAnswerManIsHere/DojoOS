// Derived media for one source (architecture.md §4, Ingest): where each derivative lives and
// how the thumbnail sprite is laid out. The worker writes them; the player and the logging
// viewer read them. Both sides compute the layout from the same function, so the sprite needs
// no manifest of its own.
import { prefixes } from "./storage";

export function derivedKeys(sourceId: string) {
  return {
    proxy: `${prefixes.proxies}${sourceId}.mp4`,
    sprite: `${prefixes.proxies}${sourceId}.sprite.jpg`,
    peaks: `${prefixes.proxies}${sourceId}.peaks.json`,
  };
}

/** The proxy fits inside a 1920×1920 box: 1080p for landscape and portrait alike, never upscaled. */
export const proxyMaxEdge = 1920;
/** At most this many sprite tiles, however long the source. */
export const spriteMaxTiles = 300;
export const spriteColumns = 10;
export const spriteTileWidth = 160;
/** Peaks per second of audio: one min/max pair every 50 ms. */
export const peaksPerSecond = 20;
export const peaksSampleRate = 8000;

export type SpriteLayout = {
  intervalSeconds: number; count: number; columns: number; rows: number; tileWidth: number; tileHeight: number;
};

/** One tile every intervalSeconds, starting at 0 s; tile i shows the frame at i × intervalSeconds. */
export function spriteLayout(durationMs: number, width: number, height: number): SpriteLayout {
  if (!(durationMs > 0) || !(width > 0) || !(height > 0)) throw new Error("Sprite layout needs a positive duration and frame size");
  const seconds = durationMs / 1000;
  const intervalSeconds = Math.max(2, Math.ceil(seconds / spriteMaxTiles));
  const count = Math.max(1, Math.ceil(seconds / intervalSeconds));
  const rows = Math.ceil(count / spriteColumns);
  // Even height, as the encoder scales with -2.
  const tileHeight = 2 * Math.round((spriteTileWidth * height) / width / 2);
  return { intervalSeconds, count, columns: spriteColumns, rows, tileWidth: spriteTileWidth, tileHeight };
}

/** The audiowaveform JSON shape (8-bit min/max pairs), which waveform players read directly. */
export type Peaks = { version: 2; channels: 1; sample_rate: number; samples_per_pixel: number; bits: 8; length: number; data: number[] };
