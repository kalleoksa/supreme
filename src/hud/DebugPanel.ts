import type { BoardTuning } from '../sim/boardTuning.js';
import { DEFAULT_TUNING } from '../sim/boardTuning.js';

/**
 * Live tuning panel. Dev builds only, loaded by dynamic import so it is tree-shaken
 * out of production entirely.
 *
 * This is the tool the feel pass runs on, and it earns its place through one feature:
 * **copy as JSON**. Forty-odd coupled scalars cannot be tuned by editing a file and
 * reloading -- you have to hear and feel each change immediately, which means dragging
 * sliders. But a good session is worthless if the numbers cannot get back into the
 * repository, so the export is the point and the sliders are the means.
 *
 * Hand-rolled rather than pulling in a GUI library. Generating a row per key from
 * `Object.keys` is about a hundred lines, which is not worth a dependency.
 */

/**
 * Slider bounds per key.
 *
 * Derived from the default rather than hardcoded, so adding a tunable does not mean
 * touching this file -- a new key gets a usable range automatically. The overrides
 * exist only where the default is 0 or 1 and a proportional range would be useless.
 */
const RANGE_OVERRIDES: Partial<Record<keyof BoardTuning, [number, number]>> = {
  LIP_WEIGHT: [0, 2],
  POP_NORMAL_BIAS: [0, 1],
  PUMP_MIN_ALIGN: [0, 1],
  BREAK_SCORE_KEEP: [0, 1],
  GRAVITY_SCALE: [0.2, 2],
  AIR_GRAVITY_SCALE: [0.2, 3],
};

function rangeFor(key: keyof BoardTuning, value: number): [number, number] {
  const override = RANGE_OVERRIDES[key];
  if (override) return override;
  if (value === 0) return [0, 1];
  return [0, Math.abs(value) * 3];
}

export class DebugPanel {
  private readonly root: HTMLElement;
  private readonly rows = new Map<keyof BoardTuning, HTMLElement>();
  private collapsed = true;

  constructor(
    parent: HTMLElement,
    private readonly tuning: BoardTuning,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'tuning-panel collapsed';
    // pointer-events must come back on: the parent HUD disables them so the game can
    // be clicked through, and a panel you cannot drag is not a panel.
    this.root.innerHTML = `
      <div class="tuning-head">
        <button class="tuning-toggle" type="button">tuning</button>
        <div class="tuning-actions">
          <button class="tuning-copy" type="button" title="Copy the whole tuning set as JSON">copy JSON</button>
          <button class="tuning-reset" type="button" title="Back to the committed defaults">reset</button>
        </div>
      </div>
      <div class="tuning-body"></div>
      <div class="tuning-status"></div>
    `;
    parent.appendChild(this.root);

    const body = this.root.querySelector('.tuning-body') as HTMLElement;
    const status = this.root.querySelector('.tuning-status') as HTMLElement;

    for (const key of Object.keys(tuning).toSorted() as (keyof BoardTuning)[]) {
      body.appendChild(this.buildRow(key));
    }

    (this.root.querySelector('.tuning-toggle') as HTMLElement).addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      this.root.classList.toggle('collapsed', this.collapsed);
    });

    (this.root.querySelector('.tuning-copy') as HTMLElement).addEventListener('click', () => {
      const json = JSON.stringify(this.tuning, null, 2);
      // Clipboard access can be denied or unavailable over plain http, so always log
      // the JSON too. Losing a good tuning session to a permission prompt would be
      // the single most annoying possible failure of this tool.
      console.log(json);
      void navigator.clipboard
        ?.writeText(json)
        .then(() => this.flash(status, 'copied to clipboard'))
        .catch(() => this.flash(status, 'clipboard blocked — JSON is in the console'));
    });

    (this.root.querySelector('.tuning-reset') as HTMLElement).addEventListener('click', () => {
      Object.assign(this.tuning, DEFAULT_TUNING);
      this.refresh();
      this.flash(status, 'reset to defaults');
    });
  }

  private buildRow(key: keyof BoardTuning): HTMLElement {
    const value = this.tuning[key];
    const [min, max] = rangeFor(key, DEFAULT_TUNING[key]);

    const row = document.createElement('label');
    row.className = 'tuning-row';
    row.innerHTML = `
      <span class="tuning-key">${key}</span>
      <input class="tuning-slider" type="range" min="${min}" max="${max}" step="${(max - min) / 500}" value="${value}" />
      <input class="tuning-number" type="number" step="any" value="${value}" />
    `;

    const slider = row.querySelector('.tuning-slider') as HTMLInputElement;
    const number = row.querySelector('.tuning-number') as HTMLInputElement;

    const apply = (raw: string, from: 'slider' | 'number'): void => {
      const next = Number(raw);
      if (!Number.isFinite(next)) return;
      (this.tuning as unknown as Record<string, number>)[key as string] = next;
      // Keep the two inputs in sync, but never write back into the one being dragged
      // or the caret jumps mid-edit.
      if (from === 'slider') number.value = String(round(next));
      else slider.value = raw;
    };

    slider.addEventListener('input', () => apply(slider.value, 'slider'));
    number.addEventListener('change', () => apply(number.value, 'number'));

    this.rows.set(key, row);
    return row;
  }

  /** Push the current tuning values back into the inputs, after a reset. */
  private refresh(): void {
    for (const [key, row] of this.rows) {
      const value = this.tuning[key];
      (row.querySelector('.tuning-slider') as HTMLInputElement).value = String(value);
      (row.querySelector('.tuning-number') as HTMLInputElement).value = String(round(value));
    }
  }

  private flash(el: HTMLElement, message: string): void {
    el.textContent = message;
    window.setTimeout(() => {
      if (el.textContent === message) el.textContent = '';
    }, 2200);
  }

  dispose(): void {
    this.root.remove();
    this.rows.clear();
  }
}

function round(v: number): number {
  return Math.abs(v) >= 1 ? Math.round(v * 1000) / 1000 : Math.round(v * 100000) / 100000;
}
