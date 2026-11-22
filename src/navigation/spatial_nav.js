/**
 * 2D Spatial Navigation Engine for LG webOS TV Remote & D-pad
 * Optimized for low-latency TV input and zero-jank frame rates
 */

export class SpatialNavigation {
  constructor() {
    this.currentFocused = null;
    this.backHandlers = [];
    this.isListening = false;
    this.lastMoveTime = 0;

    this._handleKeyDown = this._handleKeyDown.bind(this);
  }

  init() {
    if (!this.isListening) {
      window.addEventListener('keydown', this._handleKeyDown, true);
      this.isListening = true;
    }
  }

  destroy() {
    if (this.isListening) {
      window.removeEventListener('keydown', this._handleKeyDown, true);
      this.isListening = false;
    }
  }

  /**
   * Push a back key handler (LIFO stack)
   */
  pushBackHandler(handler) {
    this.backHandlers.push(handler);
  }

  /**
   * Remove a back key handler
   */
  removeBackHandler(handler) {
    this.backHandlers = this.backHandlers.filter(h => h !== handler);
  }

  /**
   * Get all currently visible and focusable DOM elements
   * Scoped to active UI layers to keep candidate pool small and fast
   */
  getFocusableElements() {
    // 1. If Quality Dialog is open, only navigate inside it
    const qualityDialog = document.getElementById('quality-dialog');
    if (qualityDialog && !qualityDialog.classList.contains('hidden')) {
      return Array.from(qualityDialog.querySelectorAll('.nav-focusable:not([disabled])'));
    }

    // 2. If Player OSD is open, navigate player controls
    const playerContainer = document.getElementById('player-container');
    if (playerContainer && !playerContainer.classList.contains('hidden')) {
      const osd = document.getElementById('player-osd');
      if (osd && !osd.classList.contains('hidden')) {
        return Array.from(osd.querySelectorAll('.nav-focusable:not([disabled])'));
      }
      return [];
    }

    // 3. Otherwise: Sidebar + Active View Section only (fastest & cleanest)
    const activeView = document.querySelector('.view-section.active');
    const sidebar = document.querySelector('.sidebar');

    const focusables = [];
    if (sidebar) {
      focusables.push(...sidebar.querySelectorAll('.nav-focusable:not([disabled])'));
    }
    if (activeView) {
      focusables.push(...activeView.querySelectorAll('.nav-focusable:not([disabled])'));
    }

    // Filter elements with non-zero dimensions
    return focusables.filter(el => {
      return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
    });
  }

  focusElement(el, scroll = true) {
    if (!el) return;

    if (this.currentFocused && this.currentFocused !== el) {
      this.currentFocused.classList.remove('nav-focused');
      this.currentFocused.blur();
    }

    this.currentFocused = el;
    el.classList.add('nav-focused');
    el.focus();

    if (scroll) {
      try {
        // 'auto' scrolling is hardware accelerated on webOS, 'smooth' lags severely
        el.scrollIntoView({
          behavior: 'auto',
          block: 'nearest',
          inline: 'nearest'
        });
      } catch (e) {
        // ignore scroll error
      }
    }
  }

  /**
   * Find nearest focusable in given direction using 2D geometric vector weighting
   */
  move(direction) {
    const focusables = this.getFocusableElements();
    if (focusables.length === 0) return;

    if (!this.currentFocused || !document.body.contains(this.currentFocused)) {
      this.focusElement(focusables[0]);
      return;
    }

    const currentRect = this.currentFocused.getBoundingClientRect();
    const cx = currentRect.left + currentRect.width / 2;
    const cy = currentRect.top + currentRect.height / 2;

    let bestCandidate = null;
    let minScore = Infinity;

    for (let i = 0; i < focusables.length; i++) {
      const target = focusables[i];
      if (target === this.currentFocused) continue;

      const r = target.getBoundingClientRect();
      const tx = r.left + r.width / 2;
      const ty = r.top + r.height / 2;

      let dPrimary = 0;
      let dSecondary = 0;
      let isValidDirection = false;

      switch (direction) {
        case 'up':
          if (ty < cy - 2) {
            dPrimary = cy - ty;
            dSecondary = Math.abs(tx - cx);
            isValidDirection = true;
          }
          break;
        case 'down':
          if (ty > cy + 2) {
            dPrimary = ty - cy;
            dSecondary = Math.abs(tx - cx);
            isValidDirection = true;
          }
          break;
        case 'left':
          if (tx < cx - 2) {
            dPrimary = cx - tx;
            dSecondary = Math.abs(ty - cy);
            isValidDirection = true;
          }
          break;
        case 'right':
          if (tx > cx + 2) {
            dPrimary = tx - cx;
            dSecondary = Math.abs(ty - cy);
            isValidDirection = true;
          }
          break;
      }

      if (isValidDirection) {
        // Weighted distance calculation
        const score = dPrimary + (dSecondary * 2.2);
        if (score < minScore) {
          minScore = score;
          bestCandidate = target;
        }
      }
    }

    if (bestCandidate) {
      this.focusElement(bestCandidate);
    }
  }

  _handleKeyDown(e) {
    const keyCode = e.keyCode || e.which;

    // Check if video player is currently active
    const playerContainer = document.getElementById('player-container');
    const isPlayerOpen = playerContainer && !playerContainer.classList.contains('hidden');
    const osd = document.getElementById('player-osd');
    const isOsdVisible = osd && osd.classList.contains('visible');
    const qualityDialog = document.getElementById('quality-dialog');
    const isQualityOpen = qualityDialog && !qualityDialog.classList.contains('hidden');

    // TV Media & Color Keys
    // Red=403, Green=404, Yellow=405, Blue=406, Play=415, Pause=19, Stop=413, PlayPause
    if (isPlayerOpen && window.app && window.app.player) {
      if (keyCode === 404) { // Green button -> toggle Quality dialog
        e.preventDefault();
        window.app.player.toggleQualityDialog();
        return;
      }
      if (keyCode === 405) { // Yellow button -> toggle Stats
        e.preventDefault();
        window.app.player.toggleStats();
        return;
      }
      if (keyCode === 415 || keyCode === 19 || keyCode === 406) { // Play/Pause/Blue
        e.preventDefault();
        window.app.player.togglePlayPause();
        return;
      }
      if (keyCode === 403) { // Red button -> reload
        e.preventDefault();
        window.app.player.reload();
        return;
      }
    }

    // If player is open but OSD is hidden (watching full-screen video),
    // ANY arrow key or Enter must immediately wake up the OSD and focus controls!
    if (isPlayerOpen && !isOsdVisible && !isQualityOpen) {
      const isBack = keyCode === 461 || e.key === 'Escape' || keyCode === 27 || keyCode === 8;
      if (!isBack) {
        e.preventDefault();
        if (window.app && window.app.player) {
          window.app.player.showOsd();
          const target = document.getElementById('btn-quality') || document.getElementById('btn-play-pause');
          if (target) {
            this.focusElement(target);
          }
        }
        return;
      }
    }

    // Remote D-pad arrow keys (throttled to ~50ms to prevent event backlog)
    const now = Date.now();
    const isArrow = e.key === 'ArrowUp' || keyCode === 38 ||
                    e.key === 'ArrowDown' || keyCode === 40 ||
                    e.key === 'ArrowLeft' || keyCode === 37 ||
                    e.key === 'ArrowRight' || keyCode === 39;

    if (isArrow) {
      e.preventDefault();
      if (now - this.lastMoveTime < 45) {
        return; // debounce rapid key repetitions
      }
      this.lastMoveTime = now;

      if (e.key === 'ArrowUp' || keyCode === 38) this.move('up');
      else if (e.key === 'ArrowDown' || keyCode === 40) this.move('down');
      else if (e.key === 'ArrowLeft' || keyCode === 37) this.move('left');
      else if (e.key === 'ArrowRight' || keyCode === 39) this.move('right');
      return;
    }

    // Enter / Click
    if (e.key === 'Enter' || keyCode === 13) {
      if (this.currentFocused && document.body.contains(this.currentFocused)) {
        e.preventDefault();
        this.currentFocused.click();
      } else if (isPlayerOpen && window.app && window.app.player) {
        e.preventDefault();
        window.app.player.showOsd();
        const target = document.getElementById('btn-quality') || document.getElementById('btn-play-pause');
        if (target) this.focusElement(target);
      }
      return;
    }

    // Back key (webOS 461, Escape 27, Backspace 8)
    if (keyCode === 461 || e.key === 'Escape' || keyCode === 27 || keyCode === 8) {
      e.preventDefault();
      if (this.backHandlers.length > 0) {
        const handler = this.backHandlers[this.backHandlers.length - 1];
        const handled = handler();
        if (handled) return;
      }
      return;
    }
  }
}
