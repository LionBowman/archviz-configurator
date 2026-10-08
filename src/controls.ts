import type { BindingApi, BindingParams, FolderApi } from '@tweakpane/core';

/**
 * Field registry: wraps Tweakpane bindings with a per-field reset button and lets presets
 * read/write every scene value through the normal change handlers (obj[key] = v; binding.refresh()).
 */
export interface Field {
  id: string;
  binding: BindingApi;
  obj: any;
  key: string;
  getDefault: () => unknown;
  /** Scene fields are captured by presets; material fields are captured by the material editor. */
  scope: 'scene' | 'material';
  /** Sliders snap to their step, so values within half a step count as unchanged. */
  tolerance: number;
  button?: HTMLButtonElement;
}

export const fields = new Map<string, Field>();

const ICON_RESET = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>';

export interface BindOptions {
  /** Stable id used in presets (defaults to "<folder>/<key>"). */
  id?: string;
  getDefault?: () => unknown;
  scope?: 'scene' | 'material';
  /** false = no reset button and not part of presets (navigation fields, read-only monitors). */
  track?: boolean;
}

const clone = <T>(v: T): T => (typeof v === 'object' && v !== null ? JSON.parse(JSON.stringify(v)) : v);

export function sameValue(a: unknown, b: unknown, tolerance = 1e-6) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= tolerance;
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  return JSON.stringify(a) === JSON.stringify(b);
}

export function bind<O extends object, K extends keyof O & string>(
  folder: FolderApi, obj: O, key: K, params: BindingParams = {}, opts: BindOptions = {},
): BindingApi<unknown, O[K]> {
  const binding = folder.addBinding(obj, key, params);
  if (opts.track === false || (params as any).readonly) return binding;

  const initial = clone(obj[key]);
  const field: Field = {
    id: opts.id ?? `${folder.title}/${key}`,
    binding, obj, key,
    getDefault: opts.getDefault ?? (() => initial),
    scope: opts.scope ?? 'scene',
    tolerance: ((params as any).step ?? 0) / 2 + 1e-6,
  };

  const btn = document.createElement('button');
  btn.className = 'field-reset';
  btn.type = 'button';
  btn.title = 'Reset to default';
  btn.setAttribute('aria-label', `Reset ${(params as any).label ?? key}`);
  btn.innerHTML = ICON_RESET;
  btn.addEventListener('click', (e) => { e.stopPropagation(); if (!binding.disabled) resetField(field); });
  binding.element.classList.add('has-reset');
  binding.element.appendChild(btn);
  field.button = btn;

  binding.on('change', () => updateIndicator(field));
  fields.set(field.id, field);
  updateIndicator(field);
  return binding;
}

export function isChanged(f: Field) {
  return !sameValue(f.obj[f.key], f.getDefault(), f.tolerance);
}

export function updateIndicator(f: Field) {
  f.button?.classList.toggle('changed', isChanged(f));
}

export function refreshIndicators() {
  fields.forEach(updateIndicator);
}

/** Write a value and fire the binding's change handlers (no-op if equal). */
export function setField(f: Field, value: unknown) {
  if (sameValue(f.obj[f.key], value)) return;
  f.obj[f.key] = clone(value);
  f.binding.refresh();
  updateIndicator(f);
}

export function resetField(f: Field) {
  setField(f, f.getDefault());
}
