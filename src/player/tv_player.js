/**
 * TV Video Player Engine
 * Powered by Hls.js with webOS-tuned memory bounds, hardware pipeline protection,
 * and TV OSD controls
 */

import Hls from 'hls.js';
import { fetchPlaybackAccessToken } from '../api/twitch_gql';
import { fetchLiveManifest } from '../api/reyohoho_proxy';
import { createManifestBlobUrl, patchMediaCodecs, isHevcCodec } from './codecs';

export const STORAGE_KEY_QUALITY = 'twitch_neo_preferred_quality';

export function getPreferredQuality() {
  try {
    return localStorage.getItem(STORAGE_KEY_QUALITY) || 'max'; // Default: 'max' (auto 1440p/Source)
  } catch (e) {
    return 'max';
  }
}

export function setPreferredQuality(val) {
  try {
    localStorage.setItem(STORAGE_KEY_QUALITY, val);
  } catch (e) {
    console.error('Failed to set preferred quality:', e);
  }
}

export class TvPlayer {
  constructor(options = {}) {
    this.options = options;
    this.hls = null;
    this.videoEl = document.getElementById('tv-video');
    this.containerEl = document.getElementById('player-container');
    this.osdEl = document.getElementById('player-osd');
    this.spinnerEl = document.getElementById('player-spinner');
    this.qualityModalEl = document.getElementById('quality-modal');
    this.qualityDialogEl = document.getElementById('quality-dialog');
    this.qualityOptionsEl = document.getElementById('quality-options-list');
    this.statsOverlayEl = document.getElementById('stats-overlay');

    // OSD UI Elements
    this.avatarEl = document.getElementById('osd-avatar');
    this.channelNameEl = document.getElementById('osd-channel-name');
    this.gameNameEl = document.getElementById('osd-game-name');
    this.streamTitleEl = document.getElementById('osd-stream-title');
    this.viewersEl = document.getElementById('osd-viewers');
    this.qualityLabelEl = document.getElementById('osd-quality-label');

    // Controls
    this.btnPlayPause = document.getElementById('btn-play-pause');
    this.iconPlay = document.getElementById('icon-play');
    this.iconPause = document.getElementById('icon-pause');
    this.btnQuality = document.getElementById('btn-quality');
    this.btnReload = document.getElementById('btn-reload');
    this.btnStats = document.getElementById('btn-stats');
    this.btnClose = document.getElementById('btn-close-player');

    // Stats elements
    this.statRes = document.getElementById('stat-res');
    this.statFps = document.getElementById('stat-fps');
    this.statBitrate = document.getElementById('stat-bitrate');
    this.statCodec = document.getElementById('stat-codec');
    this.statBuffer = document.getElementById('stat-buffer');
    this.statLatency = document.getElementById('stat-latency');
    this.statDropped = document.getElementById('stat-dropped');
    this.statProxy = document.getElementById('stat-proxy');

    // Quality Toast Notification in corner
    this.qualityToastEl = document.getElementById('quality-toast');
    this.qualityToastValueEl = document.getElementById('quality-toast-value');
    this.toastTimeout = null;
    this.waitingTimeout = null;
    this.lastPlayheadTime = -1;
    this.lastPlayheadAdvance = 0;

    this.currentChannel = null;
    this.currentStreamData = null;
    this.currentBlobUrl = null;
    this.currentRawManifest = null;
    this.currentSelectedLevel = -1; // -1 = Auto
    this.osdTimeout = null;
    this.statsInterval = null;
    this.watchdogInterval = null;
    this.isStatsVisible = false;
    this.isQualityDialogVisible = false;
    this.lastUsedProxy = '';

    // Apply global webOS MSE & codec patches immediately
    patchMediaCodecs();

    this._bindEvents();
    this._startWatchdog();
  }

  _bindEvents() {
    this.btnPlayPause.addEventListener('click', () => this.togglePlayPause());
    this.btnQuality.addEventListener('click', () => this.toggleQualityDialog());
    this.btnReload.addEventListener('click', () => this.reload());
    this.btnStats.addEventListener('click', () => this.toggleStats());
    this.btnClose.addEventListener('click', () => this.close());

    const hideSpinnerNow = () => {
      clearTimeout(this.waitingTimeout);
      this.hideSpinner();
    };

    // Video events: hide spinner immediately on any valid playback signal
    this.videoEl.addEventListener('playing', () => {
      hideSpinnerNow();
      this.lastPlayheadAdvance = Date.now();
      this.iconPlay.classList.add('hidden');
      this.iconPause.classList.remove('hidden');

      // Trigger corner quality notification on stream playback
      if (this.hls && this.hls.currentLevel >= 0 && this.hls.levels[this.hls.currentLevel]) {
        const lvl = this.hls.levels[this.hls.currentLevel];
        const res = lvl.height ? `${lvl.height}p${lvl.frameRate && lvl.frameRate >= 50 ? Math.round(lvl.frameRate) : ''}` : '';
        const isHevc = isHevcCodec(lvl.videoCodec) || (lvl.height && lvl.height >= 1440);
        if (res) {
          this.showQualityToast(`${res}${isHevc ? ' [HEVC]' : ''}`);
        }
      }
    });

    this.videoEl.addEventListener('timeupdate', () => {
      const cur = this.videoEl.currentTime;
      if (cur > 0 && Math.abs(cur - this.lastPlayheadTime) > 0.05) {
        this.lastPlayheadTime = cur;
        this.lastPlayheadAdvance = Date.now();
        if (!this.videoEl.paused) {
          hideSpinnerNow();
        }
      }
    });

    this.videoEl.addEventListener('canplay', hideSpinnerNow);
    this.videoEl.addEventListener('canplaythrough', hideSpinnerNow);
    this.videoEl.addEventListener('loadeddata', hideSpinnerNow);

    this.videoEl.addEventListener('pause', () => {
      clearTimeout(this.waitingTimeout);
      this.iconPlay.classList.remove('hidden');
      this.iconPause.classList.add('hidden');
    });

    // Only show spinner if playback is genuinely stalled (no progress for at least 1800ms)
    // Micro-buffer syncs and regular fragment transitions must never flicker the spinner
    this.videoEl.addEventListener('waiting', () => {
      clearTimeout(this.waitingTimeout);
      this.waitingTimeout = setTimeout(() => {
        const stalledTime = Date.now() - (this.lastPlayheadAdvance || 0);
        if (this.isOpen() && !this.videoEl.paused && stalledTime >= 1800) {
          this.showSpinner();
        }
      }, 1800);
    });

    // Reset OSD timer on user activity inside player
    this.containerEl.addEventListener('mousemove', () => this.showOsd());
    this.containerEl.addEventListener('click', (e) => {
      if (e.target === this.containerEl || e.target === this.videoEl) {
        this.toggleOsd();
      }
    });
  }

  showSpinner() {
    this.spinnerEl.classList.remove('hidden');
  }

  hideSpinner() {
    clearTimeout(this.waitingTimeout);
    this.spinnerEl.classList.add('hidden');
  }

  showOsd() {
    this.osdEl.classList.remove('hidden');
    this.osdEl.classList.add('visible');
    clearTimeout(this.osdTimeout);
    this.osdTimeout = setTimeout(() => {
      if (!this.isQualityDialogVisible) {
        this.hideOsd();
      }
    }, 4500);
  }

  hideOsd() {
    if (this.isQualityDialogVisible) return;
    this.osdEl.classList.remove('visible');
    this.osdEl.classList.add('hidden');
  }

  showQualityToast(label) {
    if (!this.qualityToastEl || !this.qualityToastValueEl) return;
    if (!label || label === '-' || label === 'Auto') return;

    let formatted = label;
    if (formatted.includes('[HEVC]')) {
      formatted = formatted.replace('[HEVC]', '<span class="hevc-badge">HEVC</span>');
    }

    this.qualityToastValueEl.innerHTML = formatted;
    this.qualityToastEl.classList.remove('hidden');
    this.qualityToastEl.classList.remove('toast-hide');

    clearTimeout(this.toastTimeout);
    this.toastTimeout = setTimeout(() => {
      if (this.qualityToastEl) {
        this.qualityToastEl.classList.add('toast-hide');
        setTimeout(() => {
          if (this.qualityToastEl && this.qualityToastEl.classList.contains('toast-hide')) {
            this.qualityToastEl.classList.add('hidden');
          }
        }, 400);
      }
    }, 3800);
  }

  toggleOsd() {
    if (this.osdEl.classList.contains('visible')) {
      this.hideOsd();
    } else {
      this.showOsd();
    }
  }

  togglePlayPause() {
    if (this.videoEl.paused) {
      this.videoEl.play().catch(() => {});
    } else {
      this.videoEl.pause();
    }
    this.showOsd();
  }

  toggleStats() {
    this.isStatsVisible = !this.isStatsVisible;
    if (this.isStatsVisible) {
      this.statsOverlayEl.classList.remove('hidden');
      this._startStatsLoop();
    } else {
      this.statsOverlayEl.classList.add('hidden');
      this._stopStatsLoop();
    }
    this.showOsd();
  }

  _startStatsLoop() {
    this._stopStatsLoop();
    this.statsInterval = setInterval(() => {
      this._updateStats();
    }, 1000);
    this._updateStats();
  }

  _stopStatsLoop() {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }

  _updateStats() {
    if (!this.isStatsVisible) return;

    if (this.videoEl.videoWidth) {
      this.statRes.textContent = `${this.videoEl.videoWidth}x${this.videoEl.videoHeight}`;
    }

    if (this.hls && this.hls.currentLevel >= 0 && this.hls.levels[this.hls.currentLevel]) {
      const level = this.hls.levels[this.hls.currentLevel];
      this.statFps.textContent = level.frameRate ? `${Math.round(level.frameRate)} fps` : '60 fps';
      this.statBitrate.textContent = level.bitrate ? `${(level.bitrate / 1000000).toFixed(1)} Mbps` : '-';
      this.statCodec.textContent = level.videoCodec || level.codecs || 'HEVC (hvc1)';
    }

    // Buffer length
    let bufferSec = 0;
    try {
      const ct = this.videoEl.currentTime;
      for (let i = 0; i < this.videoEl.buffered.length; i++) {
        if (this.videoEl.buffered.start(i) <= ct && ct <= this.videoEl.buffered.end(i)) {
          bufferSec = this.videoEl.buffered.end(i) - ct;
          break;
        }
      }
    } catch (e) {
      // ignore
    }
    this.statBuffer.textContent = bufferSec.toFixed(1);

    if (this.statLatency) {
      if (this.hls && typeof this.hls.latency === 'number' && !isNaN(this.hls.latency)) {
        this.statLatency.textContent = this.hls.latency.toFixed(1);
      } else {
        this.statLatency.textContent = '-';
      }
    }

    // Dropped frames
    if (this.videoEl.getVideoPlaybackQuality) {
      const q = this.videoEl.getVideoPlaybackQuality();
      this.statDropped.textContent = `${q.droppedVideoFrames} / ${q.totalVideoFrames}`;
    }

    this.statProxy.textContent = this.lastUsedProxy ? this.lastUsedProxy.replace('https://', '').replace('/', '') : 'ReYohoho';
  }

  /**
   * Watchdog to prevent decoder lockups and safely recover stalls on Smart TV
   */
  _startWatchdog() {
    let lastTime = -1;
    let stallSeconds = 0;

    this.watchdogInterval = setInterval(() => {
      if (!this.isOpen() || this.videoEl.paused || this.videoEl.ended) {
        lastTime = -1;
        stallSeconds = 0;
        return;
      }

      // If network is loading actively and buffer is empty, let it buffer naturally
      if (this.videoEl.readyState < 3 && this.videoEl.networkState === 2) {
        return;
      }

      const cur = this.videoEl.currentTime;
      if (cur > 0 && Math.abs(cur - lastTime) < 0.04) {
        stallSeconds++;

        // At 4 seconds: attempt gentle play without mutating currentTime (never do currentTime += 0.1 on webOS!)
        if (stallSeconds === 4) {
          console.warn('[TvPlayer] Watchdog detected stall, gentle play kick...');
          this.videoEl.play().catch(() => {});
        }

        // At 8 seconds on 1440p60: decoder lock detected, auto-fallback to stable 1080p60
        if (stallSeconds >= 8) {
          console.warn('[TvPlayer] Unrecoverable stall on current level. Resetting to stable 1080p60...');
          stallSeconds = 0;
          lastTime = -1;
          this._fallbackToStableQuality();
        }
      } else {
        lastTime = cur;
        stallSeconds = 0;
      }
    }, 1000);
  }

  _fallbackToStableQuality() {
    if (!this.hls || !this.hls.levels || this.hls.levels.length === 0) return;

    // Find highest stable AVC level (preferably 1080p60, then 720p60) - never 160p
    let targetIdx = -1;
    let bestHeight = 0;
    for (let i = 0; i < this.hls.levels.length; i++) {
      const lvl = this.hls.levels[i];
      const h = lvl.height || 0;
      if (h <= 1080 && h > bestHeight) {
        bestHeight = h;
        targetIdx = i;
      }
    }

    if (targetIdx !== -1 && targetIdx !== this.currentSelectedLevel) {
      const label = `${bestHeight}p60 (Auto-Stable)`;
      this.qualityLabelEl.textContent = label;
      this._selectQualityLevel(targetIdx, label);
    } else {
      this.reload();
    }
  }

  toggleQualityDialog() {
    if (this.isQualityDialogVisible) {
      this.closeQualityDialog();
    } else {
      this.openQualityDialog();
    }
  }

  openQualityDialog() {
    if (!this.hls || !this.hls.levels || this.hls.levels.length === 0) return;
    this.isQualityDialogVisible = true;
    clearTimeout(this.osdTimeout);

    if (this.qualityModalEl) {
      this.qualityModalEl.classList.remove('hidden');
    }
    this.qualityDialogEl.classList.remove('hidden');
    this.qualityOptionsEl.innerHTML = '';

    let activeOptionBtn = null;

    // Specific levels: Highest resolution first (e.g. 1440p60 -> 1080p60 -> 720p60 -> 480p)
    const sortedIndices = [...Array(this.hls.levels.length).keys()].sort((a, b) => {
      const lvlA = this.hls.levels[a];
      const lvlB = this.hls.levels[b];
      const heightA = lvlA.height || 0;
      const heightB = lvlB.height || 0;
      if (heightB !== heightA) return heightB - heightA;
      return (lvlB.bitrate || 0) - (lvlA.bitrate || 0);
    });

    sortedIndices.forEach((idx) => {
      const lvl = this.hls.levels[idx];
      const optBtn = document.createElement('button');
      const isSelected = this.currentSelectedLevel === idx;
      optBtn.className = `dialog-option nav-focusable ${isSelected ? 'active' : ''}`;

      const resLabel = lvl.height ? `${lvl.height}p${lvl.frameRate && lvl.frameRate >= 50 ? Math.round(lvl.frameRate) : ''}` : lvl.name || `Уровень ${idx}`;
      const isHevc = isHevcCodec(lvl.videoCodec) || (lvl.height && lvl.height >= 1440);
      const tagLabel = isHevc ? ' [HEVC]' : '';
      const bitrateLabel = lvl.bitrate ? ` • ${(lvl.bitrate / 1000000).toFixed(1)} Mbps` : '';
      optBtn.innerHTML = `<span>${resLabel}${tagLabel}${bitrateLabel}</span>${isSelected ? '<span class="opt-check">✓</span>' : ''}`;

      optBtn.addEventListener('click', () => {
        this._selectQualityLevel(idx, resLabel);
      });

      if (isSelected) {
        activeOptionBtn = optBtn;
      }
      this.qualityOptionsEl.appendChild(optBtn);
    });

    // Auto option at the bottom
    const autoBtn = document.createElement('button');
    const isAutoActive = this.currentSelectedLevel === -1;
    autoBtn.className = `dialog-option nav-focusable ${isAutoActive ? 'active' : ''}`;
    autoBtn.innerHTML = `<span>Авто (Рекомендуется)</span>${isAutoActive ? '<span class="opt-check">✓</span>' : ''}`;
    autoBtn.addEventListener('click', () => {
      this._selectQualityLevel(-1, 'Auto');
    });
    if (isAutoActive) {
      activeOptionBtn = autoBtn;
    }
    this.qualityOptionsEl.appendChild(autoBtn);

    // Focus top element (highest resolution: 1440p) so remote users need 0 extra clicks to select maximum quality
    const topOption = this.qualityOptionsEl.firstElementChild;
    if (this.options.onOpenDialog) {
      this.options.onOpenDialog(topOption || activeOptionBtn);
    }
  }

  closeQualityDialog() {
    this.isQualityDialogVisible = false;
    if (this.qualityModalEl) {
      this.qualityModalEl.classList.add('hidden');
    }
    this.qualityDialogEl.classList.add('hidden');
    if (this.btnQuality) {
      this.btnQuality.focus();
    }
    this.showOsd();
  }

  /**
   * Safe quality selection with pipeline reinitialization when crossing codec boundaries (AVC <-> HEVC)
   * or changing resolutions on LG webOS Starfish GStreamer
   */
  _selectQualityLevel(idx, resLabel) {
    this.closeQualityDialog();

    if (this.currentSelectedLevel === idx) {
      return;
    }

    this.currentSelectedLevel = idx;
    this.qualityLabelEl.textContent = resLabel;
    this.showQualityToast(resLabel);

    if (idx === -1) {
      // Auto
      if (this.hls) {
        this.hls.currentLevel = -1;
        this.hls.loadLevel = -1;
      }
      return;
    }

    // Clean pipeline restart for specific quality levels prevents decoder deadlocks
    if (this.currentBlobUrl) {
      console.log(`[TvPlayer] Clean hardware pipeline restart for quality level ${idx} (${resLabel})...`);
      this.showSpinner();
      this._cleanPipelineRestart(this.currentBlobUrl, idx);
    } else if (this.hls) {
      this.hls.currentLevel = idx;
      this.hls.loadLevel = idx;
    }
  }

  _cleanPipelineRestart(blobUrl, startLevelIdx) {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }

    // Clean video element state
    this.videoEl.pause();
    this.videoEl.removeAttribute('src');
    this.videoEl.load();

    // Give webOS hardware decoder 150ms to release the hardware pipeline context
    setTimeout(() => {
      this._initHls(blobUrl, startLevelIdx);
    }, 150);
  }

  /**
   * Launch a stream
   */
  async playStream(streamData) {
    this.currentStreamData = streamData;
    this.currentChannel = streamData.userLogin;
    this.currentSelectedLevel = -1; // reset to auto

    // Show player
    this.containerEl.classList.remove('hidden');
    this.showSpinner();
    this.showOsd();

    // Populate OSD metadata
    this.avatarEl.src = streamData.userAvatar || '';
    this.channelNameEl.textContent = streamData.userName || streamData.userLogin;
    this.gameNameEl.textContent = streamData.gameName ? `• ${streamData.gameName}` : '';
    this.streamTitleEl.textContent = streamData.title || '';
    this.viewersEl.textContent = streamData.viewers ? `${streamData.viewers.toLocaleString('ru-RU')} зрителей` : '';
    this.qualityLabelEl.textContent = 'Auto';

    try {
      // 1. Fetch playback access token anonymously (without user OAuth token)
      // Passing user auth causes Twitch SSAI to identify non-Turbo accounts and inject commercial breaks
      const { sig, token } = await fetchPlaybackAccessToken(this.currentChannel, null);

      // 2. Fetch live master playlist via ReYohoho proxy
      const { manifest, serverUrl } = await fetchLiveManifest(this.currentChannel, sig, token);
      this.lastUsedProxy = serverUrl;
      this.currentRawManifest = manifest;

      // 3. Patch codecs and create blob URL
      if (this.currentBlobUrl) {
        URL.revokeObjectURL(this.currentBlobUrl);
      }
      this.currentBlobUrl = createManifestBlobUrl(manifest);

      // 4. Initialize Hls.js with TV-safe limits
      this._initHls(this.currentBlobUrl, -1);
    } catch (err) {
      console.error('[TvPlayer] Playback start failed:', err);
      this.hideSpinner();
      this.streamTitleEl.textContent = `Ошибка загрузки стрима: ${err.message}. Нажмите кнопку перезагрузки для повтора.`;
      this.showOsd();
    }
  }

  _initHls(srcUrl, startLevel = -1) {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }

    if (Hls.isSupported()) {
      this.hls = new Hls({
        // CRITICAL FOR WEBOS:
        // 1. enableWorker: false eliminates worker thread IPC overhead on ARM dual/quad-core TV CPUs
        enableWorker: false,

        // 2. Ultra Low-Latency tuning for Twitch Live streams
        lowLatencyMode: true,
        liveSyncDurationCount: 3,          // 3 segments (6s) behind live edge: eliminates micro-buffer underruns and waiting flicker
        liveMaxLatencyDurationCount: 6,    // 6 segments max latency before gentle catchup
        maxLiveSyncPlaybackRate: 1.05,
        liveDurationInfinity: true,

        // 3. Memory-safe buffer limits (prevents TV RAM exhaustion and dropped frames on 1440p)
        maxBufferLength: 8,
        maxMaxBufferLength: 12,
        maxBufferSize: 20 * 1024 * 1024,   // 20 MB buffer cap
        backBufferLength: 3,               // Aggressively flush passed frames for GPU memory
        liveBackBufferLength: 3,
        frontBufferFlushThreshold: 10,

        // 4. Disable Hls.js internal nudging (which triggers synchronous IPC SeekTo deadlocks on webOS)
        highBufferWatchdogPeriod: 0,
        nudgeMaxRetry: 0,

        // Network timeouts
        fragLoadingTimeOut: 12000,
        manifestLoadingTimeOut: 10000,
        levelLoadingTimeOut: 10000,

        startLevel: startLevel
      });

      this.hls.loadSource(srcUrl);
      this.hls.attachMedia(this.videoEl);

      // Hide spinner immediately when first media fragment is buffered in hardware pipeline
      this.hls.on(Hls.Events.FRAG_BUFFERED, () => {
        clearTimeout(this.waitingTimeout);
        this.hideSpinner();
      });

      this.hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        console.log('[TvPlayer] Manifest parsed with levels:', data.levels.length);

        let targetLevel = startLevel;
        if (targetLevel === -1) {
          const pref = getPreferredQuality();
          if (pref === 'max') {
            // Find highest resolution level (1440p60 if available, else 1080p60)
            let bestIdx = 0;
            let bestHeight = 0;
            let bestBitrate = 0;
            for (let i = 0; i < data.levels.length; i++) {
              const lvl = data.levels[i];
              const h = lvl.height || 0;
              const b = lvl.bitrate || 0;
              if (h > bestHeight || (h === bestHeight && b > bestBitrate)) {
                bestHeight = h;
                bestBitrate = b;
                bestIdx = i;
              }
            }
            targetLevel = bestIdx;
          } else if (pref === '1080p') {
            let bestIdx = -1;
            for (let i = 0; i < data.levels.length; i++) {
              if (data.levels[i].height === 1080) { bestIdx = i; break; }
            }
            if (bestIdx !== -1) targetLevel = bestIdx;
          } else if (pref === '720p') {
            let bestIdx = -1;
            for (let i = 0; i < data.levels.length; i++) {
              if (data.levels[i].height === 720) { bestIdx = i; break; }
            }
            if (bestIdx !== -1) targetLevel = bestIdx;
          }
        }

        if (targetLevel >= 0 && data.levels[targetLevel]) {
          this.hls.currentLevel = targetLevel;
          this.hls.loadLevel = targetLevel;
          this.currentSelectedLevel = targetLevel;

          const lvl = data.levels[targetLevel];
          const res = lvl.height ? `${lvl.height}p${lvl.frameRate && lvl.frameRate >= 50 ? Math.round(lvl.frameRate) : ''}` : 'Custom';
          const isHevc = isHevcCodec(lvl.videoCodec) || (lvl.height && lvl.height >= 1440);
          this.qualityLabelEl.textContent = res;
          this.showQualityToast(`${res}${isHevc ? ' [HEVC]' : ''}`);
        }

        this.videoEl.play().catch(e => {
          console.warn('[TvPlayer] Autoplay prevented, waiting for user action:', e);
        });
      });

      this.hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        const lvl = this.hls.levels[data.level];
        if (lvl) {
          const res = lvl.height ? `${lvl.height}p${lvl.frameRate && lvl.frameRate >= 50 ? Math.round(lvl.frameRate) : ''}` : 'Auto';
          const isHevc = isHevcCodec(lvl.videoCodec) || (lvl.height && lvl.height >= 1440);
          const fullLabel = `${res}${isHevc ? ' [HEVC]' : ''}`;
          if (this.currentSelectedLevel === -1) {
            this.qualityLabelEl.textContent = `Auto (${res})`;
          } else {
            this.qualityLabelEl.textContent = res;
          }
          this.showQualityToast(fullLabel);
        }
      });

      this.hls.on(Hls.Events.ERROR, (_event, data) => {
        console.warn('[TvPlayer] Hls error:', data.type, data.details, data.fatal);
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.log('[TvPlayer] Fatal network error, reloading...');
              this.hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.log('[TvPlayer] Fatal media error, recovering media...');
              this.hls.recoverMediaError();
              break;
            default:
              console.error('[TvPlayer] Unrecoverable error, falling back to stable quality...');
              this._fallbackToStableQuality();
              break;
          }
        }
      });
    } else if (this.videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      this.videoEl.src = srcUrl;
      this.videoEl.play().catch(() => {});
    }
  }

  reload() {
    if (this.currentStreamData) {
      this.playStream(this.currentStreamData);
    }
  }

  close() {
    this._stopStatsLoop();
    this.closeQualityDialog();

    clearTimeout(this.waitingTimeout);

    if (this.qualityToastEl) {
      clearTimeout(this.toastTimeout);
      this.qualityToastEl.classList.add('toast-hide');
      this.qualityToastEl.classList.add('hidden');
    }

    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }

    if (this.currentBlobUrl) {
      URL.revokeObjectURL(this.currentBlobUrl);
      this.currentBlobUrl = null;
    }

    this.videoEl.pause();
    this.videoEl.removeAttribute('src');
    this.videoEl.load();

    this.containerEl.classList.add('hidden');
    this.currentChannel = null;
    this.currentStreamData = null;

    if (this.options.onClose) {
      this.options.onClose();
    }
  }

  isOpen() {
    return !this.containerEl.classList.contains('hidden');
  }
}
