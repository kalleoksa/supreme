import './styles.css';
import { Game } from './app/Game.js';
import { TITLE } from './app/config.js';
import { installHarness } from './dev/harness.js';

const harness = installHarness();

function fail(message: string): void {
  harness.error = message;
  const status = document.getElementById('boot-status');
  if (status) {
    status.textContent = message;
    status.classList.add('error');
  }
  console.error(message);
}

function boot(): void {
  document.title = TITLE;

  const canvas = document.getElementById('stage');
  const hud = document.getElementById('hud');
  if (!(canvas instanceof HTMLCanvasElement) || !hud) {
    fail('Missing #stage canvas or #hud element.');
    return;
  }

  // Fail loudly and specifically. "Black screen" is the worst possible error
  // message for a game, and WebGL2 being unavailable is a real outcome on old
  // hardware and locked-down browsers.
  const probe = canvas.getContext('webgl2');
  if (!probe) {
    fail('WebGL2 is not available in this browser, so the game cannot start.');
    return;
  }

  let game: Game;
  try {
    game = new Game({
      canvas,
      hud,
      debug: import.meta.env.DEV,
    });
  } catch (err) {
    fail(`Failed to initialise: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  harness.game = game;
  game.start();

  const bootEl = document.getElementById('boot');
  bootEl?.classList.add('hidden');
  harness.ready = true;

  if (import.meta.hot) {
    import.meta.hot.dispose(() => game.dispose());
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
