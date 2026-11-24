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
    this._handleKeyUp = this._handleKeyUp.bind(this);
    this._handleFocusIn = this._handleFocusIn.bind(this);
  }

  _isTextInput(el) {
    return Boolean(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'));
  }

  _handleFocusIn(e) {
    const target = e.target && e.target.closest ? e.target.closest('.nav-focusable') : null;
    if (target && target !== this.currentFocused) {
      if (this.currentFocused) {
        this.currentFocused.classList.remove('nav-focused');
      }
      this.currentFocused = target;
      target.classList.add('nav-focused');
    }
  }

  _handleKeyUp(e) {
    const keyCode = e.keyCode || e.which;
    if (keyCode === 8 && this._isTextInput(document.activeElement)) {
      return;
    }
    if (keyCode === 461 || e.key === 'Escape' || keyCode === 27 || keyCode === 8) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }
  }

  init() {
    if (!this.isListening) {
      window.addEventListener('keydown', this._handleKeyDown, true);
      window.addEventListener('keyup', this._handleKeyUp, true);
      window.addEventListener('focusin', this._handleFocusIn, true);
      window.addEventListener('popstate', (e) => {
        e.preventDefault();
      }, true);
      this.isListening = true;
    }
  }

  destroy() {
    if (this.isListening) {
      window.removeEventListener('keydown', this._handleKeyDown, true);
      window.removeEventListener('keyup', this._handleKeyUp, true);
      window.removeEventListener('focusin', this._handleFocusIn, true);
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
  getFocusableElements(root = null) {
    if (root) {
      return Array.from(root.querySelectorAll('.nav-focusable:not([disabled])')).filter(el => el.offsetParent !== null);
    }

    // 1. If Quality Modal is open, only navigate inside it
    const qualityModal = document.getElementById('quality-modal');
    if (qualityModal && !qualityModal.classList.contains('hidden')) {
      return Array.from(qualityModal.querySelectorAll('.nav-focusable:not([disabled])'));
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

    // Filter visible elements without forced layout thrashing
    return focusables.filter(el => {
      return el.offsetParent !== null;
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
      const scrollContainer = el.closest('.main-content') || el.closest('.dialog-options');
      if (scrollContainer) {
        const cRect = scrollContainer.getBoundingClientRect();
        const eRect = el.getBoundingClientRect();

        // Comfortable TV viewing margins (unclipped outline inside scroll containers)
        const isDialog = scrollContainer.classList.contains('dialog-options');
        const topPadding = isDialog ? 16 : 90;
        const bottomPadding = isDialog ? 16 : 110;

        if (eRect.bottom > cRect.bottom - bottomPadding) {
          const delta = eRect.bottom - (cRect.bottom - bottomPadding);
          scrollContainer.scrollTop += delta;
        } else if (eRect.top < cRect.top + topPadding) {
          const delta = (cRect.top + topPadding) - eRect.top;
          scrollContainer.scrollTop = Math.max(0, scrollContainer.scrollTop - delta);
        }
      } else {
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
  }

  /**
   * Find nearest focusable in given direction using fast grid indexing + 2D geometric fallback
   */
  move(direction) {
    if (!this.currentFocused || !document.body.contains(this.currentFocused)) {
      const focusables = this.getFocusableElements();
      if (focusables.length > 0) this.focusElement(focusables[0]);
      return;
    }

    // Fast-path: 2D Grid navigation (zero DOM reflows, instant O(1))
    const currentGrid = this.currentFocused.closest('.cards-grid');
    if (currentGrid) {
      const cards = Array.from(currentGrid.querySelectorAll('.nav-focusable:not([disabled])'));
      const index = cards.indexOf(this.currentFocused);

      if (index !== -1) {
        // .stream-grid = 3 columns, .game-grid = 5 columns
        const cols = currentGrid.classList.contains('game-grid') ? 5 : 3;

        if (direction === 'down') {
          const nextIndex = index + cols;
          if (nextIndex < cards.length) {
            this.focusElement(cards[nextIndex]);
            return;
          }
          if (index < cards.length - 1 && Math.floor(index / cols) < Math.floor((cards.length - 1) / cols)) {
            this.focusElement(cards[cards.length - 1]);
            return;
          }
          return;
        }

        if (direction === 'up') {
          const prevIndex = index - cols;
          if (prevIndex >= 0) {
            this.focusElement(cards[prevIndex]);
            return;
          }
          // Top row: fall through to geometric search within main-content to reach controls above grid
        }

        if (direction === 'right') {
          if ((index + 1) % cols !== 0 && index + 1 < cards.length) {
            this.focusElement(cards[index + 1]);
            return;
          }
          return;
        }

        if (direction === 'left') {
          if (index % cols !== 0) {
            this.focusElement(cards[index - 1]);
            return;
          }
          // Leftmost column: fall through to geometric search to cleanly jump to sidebar
        }
      }
    }

    const focusables = this.getFocusableElements();
    if (focusables.length === 0) return;

    const currentInSidebar = Boolean(this.currentFocused.closest('#sidebar'));
    const currentInMain = Boolean(this.currentFocused.closest('#main-content'));

    const currentRect = this.currentFocused.getBoundingClientRect();
    const cx = currentRect.left + currentRect.width / 2;
    const cy = currentRect.top + currentRect.height / 2;

    let bestCandidate = null;
    let minScore = Infinity;

    for (let i = 0; i < focusables.length; i++) {
      const target = focusables[i];
      if (target === this.currentFocused) continue;

      // Vertical navigation stays within the active column region (no diagonal sidebar<->grid jumps on Up/Down)
      if (direction === 'up' || direction === 'down') {
        if (currentInSidebar && !target.closest('#sidebar')) continue;
        if (currentInMain && target.closest('#sidebar')) continue;
      }

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
    const activeEl = document.activeElement;
    const inTextInput = this._isTextInput(activeEl);

    // Check if video player is currently active
    const playerContainer = document.getElementById('player-container');
    const isPlayerOpen = playerContainer && !playerContainer.classList.contains('hidden');
    const osd = document.getElementById('player-osd');
    const isOsdVisible = osd && osd.classList.contains('visible');
    const qualityModal = document.getElementById('quality-modal');
    const isQualityOpen = qualityModal && !qualityModal.classList.contains('hidden');

    // TV Media & Color Keys
    // Red=403, Green=404, Yellow=405, Blue=406, Play=415, Pause=19, Stop=413, PlayPause=10252/179
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
      if (keyCode === 415 || keyCode === 19 || keyCode === 406 || keyCode === 10252 || keyCode === 179 || (!inTextInput && (e.key === ' ' || keyCode === 32))) {
        e.preventDefault();
        window.app.player.togglePlayPause();
        return;
      }
      if (keyCode === 403) { // Red button -> reload
        e.preventDefault();
        window.app.player.reload();
        return;
      }
      if (keyCode === 413) { // Stop -> close player
        e.preventDefault();
        window.app.player.close();
        return;
      }
    }

    const isArrow = e.key === 'ArrowUp' || keyCode === 38 ||
                    e.key === 'ArrowDown' || keyCode === 40 ||
                    e.key === 'ArrowLeft' || keyCode === 37 ||
                    e.key === 'ArrowRight' || keyCode === 39;
    const isEnter = e.key === 'Enter' || keyCode === 13;

    // If player is open but OSD is hidden (watching full-screen video),
    // navigation or OK keys wake up the OSD and focus controls (ignore system/volume keys)
    if (isPlayerOpen && !isOsdVisible && !isQualityOpen && (isArrow || isEnter)) {
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

    // Preserve Backspace inside text inputs (e.g. search bar)
    if (inTextInput && (keyCode === 8 || e.key === 'Backspace')) {
      return;
    }

    // Remote D-pad arrow keys (throttled to ~65ms to prevent event backlog)
    if (isArrow) {
      if (inTextInput) {
        const isLeft = e.key === 'ArrowLeft' || keyCode === 37;
        const isRight = e.key === 'ArrowRight' || keyCode === 39;
        try {
          if (isLeft && typeof activeEl.selectionStart === 'number' && activeEl.selectionStart > 0) {
            return; // allow caret movement inside text
          }
          if (isRight && typeof activeEl.selectionStart === 'number' && activeEl.selectionStart < (activeEl.value || '').length) {
            return; // allow caret movement inside text
          }
        } catch (err) {}
      }

      const now = Date.now();
      e.preventDefault();
      if (now - this.lastMoveTime < 65) {
        return; // debounce rapid key repetitions for smooth TV frame pacing
      }
      this.lastMoveTime = now;

      if (e.key === 'ArrowUp' || keyCode === 38) this.move('up');
      else if (e.key === 'ArrowDown' || keyCode === 40) this.move('down');
      else if (e.key === 'ArrowLeft' || keyCode === 37) this.move('left');
      else if (e.key === 'ArrowRight' || keyCode === 39) this.move('right');
      return;
    }

    // Enter / Click
    if (isEnter) {
      if (inTextInput) {
        return; // let input handle Enter natively (e.g. search submit & webOS IME done)
      }
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

    // Back key (webOS 461, Escape 27, Backspace 8 outside text input)
    if (keyCode === 461 || e.key === 'Escape' || keyCode === 27 || keyCode === 8) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (this.backHandlers.length > 0) {
        const handler = this.backHandlers[this.backHandlers.length - 1];
        const handled = handler();
        if (handled) return;
      }
      return;
    }
  }
}
