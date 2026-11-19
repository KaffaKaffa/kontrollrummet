import { useEffect, useState } from 'react';

/**
 * Light, dark, or whatever the Mac is set to. Remembered per browser, and in
 * Kontrollrummet.app, whose web view keeps its storage. index.html applies the
 * stored choice before React starts, so a dark board never flashes light.
 */
export type Theme = 'system' | 'light' | 'dark';

const KEY = 'kontrollrummet.theme';
const NEXT: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
const LABEL: Record<Theme, string> = { system: 'Auto', light: 'Ljust', dark: 'Mörkt' };
// Font Awesome Pro 7.1.0, regular: circle-half-stroke, sun-bright, moon (https://fontawesome.com/license, Commercial License).
const ICON: Record<Theme, string> = {
  system: 'M344 526.6L344 113.3C447.6 125.3 528 213.2 528 320C528 426.8 447.6 514.7 344 526.6zM296 526.6C192.4 514.7 112 426.8 112 320C112 213.2 192.4 125.3 296 113.4L296 526.7zM320 576C461.4 576 576 461.4 576 320C576 178.6 461.4 64 320 64C178.6 64 64 178.6 64 320C64 461.4 178.6 576 320 576z',
  light: 'M296 552L296 496C296 482.7 306.7 472 320 472C333.3 472 344 482.7 344 496L344 552C344 565.3 333.3 576 320 576C306.7 576 296 565.3 296 552zM296 144L296 88C296 74.7 306.7 64 320 64C333.3 64 344 74.7 344 88L344 144C344 157.3 333.3 168 320 168C306.7 168 296 157.3 296 144zM139 139C148.4 129.6 163.6 129.6 172.9 139L212.5 178.6C221.9 188 221.9 203.2 212.5 212.5C203.1 221.8 187.9 221.9 178.6 212.5L139 172.9C129.6 163.5 129.6 148.3 139 139zM427.5 427.5C436.9 418.1 452.1 418.1 461.4 427.5L501 467.1C510.4 476.5 510.4 491.7 501 501C491.6 510.3 476.4 510.4 467.1 501L427.5 461.4C418.1 452 418.1 436.8 427.5 427.5zM64 320C64 306.7 74.7 296 88 296L144 296C157.3 296 168 306.7 168 320C168 333.3 157.3 344 144 344L88 344C74.7 344 64 333.3 64 320zM472 320C472 306.7 482.7 296 496 296L552 296C565.3 296 576 306.7 576 320C576 333.3 565.3 344 552 344L496 344C482.7 344 472 333.3 472 320zM139 501C129.6 491.6 129.6 476.4 139 467.1L178.6 427.5C188 418.1 203.2 418.1 212.5 427.5C221.8 436.9 221.9 452.1 212.5 461.4L172.9 501C163.5 510.4 148.3 510.4 139 501zM427.5 212.5C418.1 203.1 418.1 187.9 427.5 178.6L467.1 139C476.5 129.6 491.7 129.6 501 139C510.3 148.4 510.4 163.6 501 172.9L461.4 212.5C452 221.9 436.8 221.9 427.5 212.5zM384 320C384 284.7 355.3 256 320 256C284.7 256 256 284.7 256 320C256 355.3 284.7 384 320 384C355.3 384 384 355.3 384 320zM208 320C208 258.1 258.1 208 320 208C381.9 208 432 258.1 432 320C432 381.9 381.9 432 320 432C258.1 432 208 381.9 208 320z',
  dark: 'M303.3 112.7C196.2 121.2 112 210.8 112 320C112 434.9 205.1 528 320 528C353.3 528 384.7 520.2 412.6 506.3C309.2 482.9 232 390.5 232 280C232 214.2 259.4 154.9 303.3 112.7zM64 320C64 178.6 178.6 64 320 64C339.4 64 358.4 66.2 376.7 70.3C386.6 72.5 394 80.8 395.2 90.8C396.4 100.8 391.2 110.6 382.1 115.2C321.5 145.4 280 207.9 280 280C280 381.6 362.4 464 464 464C469 464 473.9 463.8 478.8 463.4C488.9 462.6 498.4 468.2 502.6 477.5C506.8 486.8 504.6 497.6 497.3 504.6C451.3 548.8 388.8 576 320 576C178.6 576 64 461.4 64 320z',
};

function stored(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

function remember(theme: Theme) {
  try {
    if (theme === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // Private window or blocked storage: the choice lasts until the page reloads.
  }
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(stored);

  useEffect(() => {
    const system = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && system.matches);
      document.documentElement.classList.toggle('dark', dark);
      document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    };
    apply();
    system.addEventListener('change', apply);
    return () => system.removeEventListener('change', apply);
  }, [theme]);

  const next = NEXT[theme];
  return (
    <button
      type="button"
      className="icon-btn theme-toggle"
      aria-label={`Tema: ${LABEL[theme]}. Byt till ${LABEL[next]}.`}
      title={`Tema: ${LABEL[theme]}. Klicka för ${LABEL[next].toLowerCase()}.`}
      onClick={() => {
        setTheme(next);
        remember(next);
      }}
    >
      <svg viewBox="0 0 640 640" width="18" height="18" aria-hidden="true">
        <path fill="currentColor" d={ICON[theme]} />
      </svg>
    </button>
  );
}
