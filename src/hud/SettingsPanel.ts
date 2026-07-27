import { AUDIO_RANGES, COMFORT_RANGES, type Settings } from '../app/settings.js';

/**
 * The comfort settings panel.
 *
 * Ships in production, unlike the tuning panel. That is the whole point: motion sickness
 * tolerance varies enormously between people, and a camera that makes someone ill is
 * unplayable for them no matter how good the game is. These four knobs cost very little now
 * and cannot be retrofitted after players have already bounced off.
 *
 * Deliberately reachable without a menu system. There is no title screen in M1, so the panel
 * is a single always-visible button plus a keyboard shortcut -- someone who starts feeling
 * queasy thirty seconds into their first run should not have to quit to find the fix.
 */
export class SettingsPanel {
  private readonly root: HTMLElement;
  private readonly button: HTMLButtonElement;
  private open = false;

  constructor(
    parent: HTMLElement,
    private readonly settings: Settings,
    private readonly onChange: () => void,
  ) {
    this.button = document.createElement('button');
    this.button.className = 'settings-button';
    this.button.type = 'button';
    this.button.textContent = 'SETTINGS';
    this.button.setAttribute('aria-label', 'Comfort and audio settings');
    this.button.addEventListener('click', () => this.toggle());
    parent.appendChild(this.button);

    this.root = document.createElement('div');
    this.root.className = 'settings-panel';
    this.root.innerHTML = `
      <div class="settings-head">
        <span>SETTINGS</span>
        <button type="button" class="settings-close" aria-label="Close">x</button>
      </div>
      <div class="settings-body"></div>
      <div class="settings-note">
        Motion sickness varies. If the camera is uncomfortable, turn the field of view
        widening off first, then reduce shake.
      </div>
    `;
    parent.appendChild(this.root);
    (this.root.querySelector('.settings-close') as HTMLElement).addEventListener('click', () =>
      this.toggle(false),
    );

    const body = this.root.querySelector('.settings-body') as HTMLElement;
    this.addToggle(
      body,
      'Field of view widens with speed',
      () => this.settings.comfort.fovWithSpeed,
      (v) => {
        this.settings.comfort.fovWithSpeed = v;
      },
    );
    this.addSlider(
      body,
      'Screen shake',
      COMFORT_RANGES.shakeScale,
      () => this.settings.comfort.shakeScale,
      (v) => {
        this.settings.comfort.shakeScale = v;
      },
    );
    this.addSlider(
      body,
      'Camera distance',
      COMFORT_RANGES.distanceScale,
      () => this.settings.comfort.distanceScale,
      (v) => {
        this.settings.comfort.distanceScale = v;
      },
    );
    this.addSlider(
      body,
      'Camera roll in turns',
      COMFORT_RANGES.rollDegrees,
      () => this.settings.comfort.rollDegrees,
      (v) => {
        this.settings.comfort.rollDegrees = v;
      },
    );

    const audio = document.createElement('div');
    audio.className = 'settings-group';
    audio.textContent = 'AUDIO';
    body.appendChild(audio);

    this.addToggle(
      body,
      'Sound',
      () => this.settings.audio.enabled,
      (v) => {
        this.settings.audio.enabled = v;
      },
    );
    this.addSlider(
      body,
      'Volume',
      AUDIO_RANGES.volume,
      () => this.settings.audio.volume,
      (v) => {
        this.settings.audio.volume = v;
      },
    );

    window.addEventListener('keydown', this.onKey);
  }

  private onKey = (e: KeyboardEvent): void => {
    // KeyC, not Escape: Escape is pause, and a settings panel that hijacks it would be worse
    // than one that is slightly harder to find.
    if (e.code === 'KeyC' && !e.repeat) this.toggle();
  };

  toggle(force?: boolean): void {
    this.open = force ?? !this.open;
    this.root.classList.toggle('visible', this.open);
    this.button.classList.toggle('active', this.open);
  }

  get isOpen(): boolean {
    return this.open;
  }

  private addToggle(
    parent: HTMLElement,
    label: string,
    get: () => boolean,
    set: (v: boolean) => void,
  ): void {
    const row = document.createElement('label');
    row.className = 'settings-row';
    const text = document.createElement('span');
    text.textContent = label;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = get();
    box.addEventListener('change', () => {
      set(box.checked);
      this.onChange();
    });
    row.append(text, box);
    parent.appendChild(row);
  }

  private addSlider(
    parent: HTMLElement,
    label: string,
    range: readonly [number, number],
    get: () => number,
    set: (v: number) => void,
  ): void {
    const row = document.createElement('label');
    row.className = 'settings-row';
    const text = document.createElement('span');
    text.textContent = label;

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(range[0]);
    slider.max = String(range[1]);
    slider.step = '0.05';
    slider.value = String(get());

    const readout = document.createElement('em');
    const show = (): void => {
      readout.textContent = Number(slider.value).toFixed(2);
    };
    show();

    slider.addEventListener('input', () => {
      set(Number(slider.value));
      show();
      this.onChange();
    });

    row.append(text, slider, readout);
    parent.appendChild(row);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    this.root.remove();
    this.button.remove();
  }
}
