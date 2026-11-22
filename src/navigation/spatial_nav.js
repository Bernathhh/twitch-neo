/**
 * 2D Spatial Navigation Engine for LG webOS TV Remote & D-pad
 */

export class SpatialNavigation {
  constructor() {
    this.currentFocused = null;
    this.backHandlers = [];
    this.isListening = false;

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
   */
  getFocusableElements(container = document) {
    const selector = '.nav-focusable:not([disabled])';
    const all = Array.from(container.querySelectorAll(selector));
    return all.filter(el => {
      // Must be visible in DOM
      if (el.offsetParent === null && el.offsetWidth === 0 && el.offsetHeight === 0) {
        return false;
      }
      // Check if inside a hidden ancestor
      let parent = el.parentElement;
      while (parent && parent !== document.body) {
        if (parent.classList.contains('hidden') || parent.style.display === 'none') {
          return false;
        }
        parent = parent.parentElement;
      }
      return true;
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
        el.scrollIntoView({
          behavior: 'smooth',
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

    for (const target of focusables) {
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
        // Weighted Manhattan distance with heavy penalty for secondary axis spread
        const score = dPrimary + (dSecondary * 2.5);
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

    // Remote D-pad arrow keys
    if (e.key === 'ArrowUp' || keyCode === 38) {
      e.preventDefault();
      this.move('up');
      return;
    }
    if (e.key === 'ArrowDown' || keyCode === 40) {
      e.preventDefault();
      this.move('down');
      return;
    }
    if (e.key === 'ArrowLeft' || keyCode === 37) {
      e.preventDefault();
      this.move('left');
      return;
    }
    if (e.key === 'ArrowRight' || keyCode === 39) {
      e.preventDefault();
      this.move('right');
      return;
    }

    // Enter / Click
    if (e.key === 'Enter' || keyCode === 13) {
      if (this.currentFocused) {
        e.preventDefault();
        this.currentFocused.click();
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
