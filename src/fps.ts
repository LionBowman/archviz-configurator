import type { Viewer } from './viewer';

/**
 * FPS meter over the canvas. Counts frames the viewer actually renders (it renders on demand),
 * so when nothing is moving it shows the last active reading (greyed, marked idle) instead of a meaningless 0.
 */
export class FpsMeter {
  readonly el = document.createElement('div');
  private frames = 0;
  private last = performance.now();
  private worst = 0;
  private prevFrame = 0;
  private timer = 0;
  private lastActive: { fps: number; worst: number } | null = null;
  /** Recent fully-busy windows (≈2 s), averaged for the idle display so one hiccup doesn't define it. */
  private recent: { fps: number; worst: number }[] = [];
  private firstFrame = 0;

  constructor(viewer: Viewer, container: HTMLElement) {
    this.el.className = 'fps-meter';
    this.el.setAttribute('aria-live', 'off');
    container.appendChild(this.el);
    viewer.listeners.frame.add(() => this.tick());
    this.timer = window.setInterval(() => this.report(), 500);
    this.report();
  }

  set visible(v: boolean) { this.el.hidden = !v; }
  get visible() { return !this.el.hidden; }

  private tick() {
    const now = performance.now();
    if (this.prevFrame) this.worst = Math.max(this.worst, now - this.prevFrame);
    if (!this.frames) this.firstFrame = now;
    this.prevFrame = now;
    this.frames++;
  }

  private report() {
    const now = performance.now();
    const dt = (now - this.last) / 1000;
    if (this.frames < 2) {
      // Nothing is being drawn (on-demand rendering): keep the last active reading, greyed out.
      const last = this.lastActive;
      this.el.innerHTML = last
        ? `<b>${Math.round(last.fps)}</b> fps<span>idle · last ${(1000 / last.fps).toFixed(1)} ms avg · worst ${last.worst.toFixed(0)} ms</span>`
        : '<b>–</b> fps<span>idle · move to measure</span>';
      this.el.dataset.level = 'idle';
      this.prevFrame = 0;
      this.recent = []; // next burst of activity starts a fresh average
    } else {
      const fps = this.frames / dt;
      // Only remember windows that were busy throughout; a window where motion stopped part-way under-reports.
      const busy = (this.prevFrame - this.firstFrame) / 1000 >= dt * 0.8;
      if (busy) {
        this.recent = [...this.recent, { fps, worst: this.worst }].slice(-4);
        this.lastActive = {
          fps: this.recent.reduce((a, r) => a + r.fps, 0) / this.recent.length,
          worst: Math.max(...this.recent.map((r) => r.worst)),
        };
      }
      this.el.innerHTML = `<b>${Math.round(fps)}</b> fps<span>${(1000 / fps).toFixed(1)} ms · worst ${this.worst.toFixed(0)} ms</span>`;
      this.el.dataset.level = fps >= 50 ? 'good' : fps >= 28 ? 'ok' : 'bad';
    }
    this.frames = 0;
    this.worst = 0;
    this.last = now;
  }

  dispose() {
    clearInterval(this.timer);
    this.el.remove();
  }
}
