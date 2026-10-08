import type { FrameHandler } from './viewer';

export type PathTracerState = 'preparing' | 'preview' | 'converging' | 'denoising' | 'converged';

export interface PathTracerStatus { samples: number; max: number; state: PathTracerState }

/** Common surface of the WebGL and WebGPU path tracing backends (both lazy-loaded). */
export interface PathTracerBackend extends FrameHandler {
  readonly active: boolean;
  maxSamples: number;
  bounces: number;
  renderScale: number;
  denoise: boolean;
  /** WebGL smart-denoise strength (blur radius, sigma). Ignored by the WebGPU/OIDN backend. */
  denoiseStrength: number;
  enable(): Promise<void>;
  disable(): void;
  /** Restart accumulation (settings changed). */
  reset(): void;
  /** Re-display the current result without restarting (e.g. denoise toggled). */
  redisplay(): void;
  status(): PathTracerStatus;
}
