/** Minimal loading overlay. First load is opaque, later loads are a soft floating card. */
export class Loader {
  private label: HTMLElement;
  private bar: HTMLElement;
  private first = true;

  constructor(private el: HTMLElement) {
    this.label = el.querySelector('.loader-label')!;
    this.bar = el.querySelector('.loader-bar span')!;
  }

  show(text: string) {
    this.el.classList.toggle('soft', !this.first);
    this.el.classList.remove('hidden');
    this.label.textContent = text;
    this.progress(0);
  }

  progress(p: number) {
    this.bar.style.width = `${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`;
  }

  hide() {
    this.progress(1);
    this.first = false;
    this.el.classList.add('hidden');
  }
}
