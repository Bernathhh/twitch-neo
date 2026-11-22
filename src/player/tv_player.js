/**
 * TV Video Player Engine
 * Powered by Hls.js with webOS-tuned memory bounds and TV OSD controls
 */

import Hls from 'hls.js';
import { fetchPlaybackAccessToken } from '../api/twitch_gql';
import { fetchLiveManifest } from '../api/reyohoho_proxy';
import { createManifestBlobUrl } from './codecs';
import { getStoredToken } from '../api/twitch_auth';

export class TvPlayer {
  constructor(options = {}) {
    this.options = options;
    this.hls = null;
    this.videoEl = document.getElementById('tv-video');
    this.containerEl = document.getElementById('player-container');
    this.osdEl = document.getElementById('player-osd');
    this.spinnerEl = document.getElementById('player-spinner');
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
    this.statDropped = document.getElementById('stat-dropped');
    this.statProxy = document.getElementById('stat-proxy');

    this.currentChannel = null;
    this.currentStreamData = null;
    this.currentBlobUrl = null;
    this.osdTimeout = null;
    this.statsInterval = null;
    this.isStatsVisible = false;
    this.isQualityDialogVisible = false;
    this.lastUsedProxy = '';

    this._bindEvents();
  }

  _bindEvents() {
    this.btnPlayPause.addEventListener('click', () => this.togglePlayPause());
    this.btnQuality.addEventListener('click', () => this.toggleQualityDialog());
    this.btnReload.addEventListener('click', () => this.reload());
    this.btnStats.addEventListener('click', () => this.toggleStats());
    this.btnClose.addEventListener('click', () => this.close());

    // Video events
    this.videoEl.addEventListener('playing', () => {
      this.hideSpinner();
      this.iconPlay.classList.add('hidden');
      this.iconPause.classList.remove('hidden');
    });

    this.videoEl.addEventListener('pause', () => {
      this.iconPlay.classList.remove('hidden');
      this.iconPause.classList.add('hidden');
    });

    this.videoEl.addEventListener('waiting', () => {
      this.showSpinner();
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

    // Dropped frames
    if (this.videoEl.getVideoPlaybackQuality) {
      const q = this.videoEl.getVideoPlaybackQuality();
      this.statDropped.textContent = `${q.droppedVideoFrames} / ${q.totalVideoFrames}`;
    }

    this.statProxy.textContent = this.lastUsedProxy ? this.lastUsedProxy.replace('https://', '').replace('/', '') : 'ReYohoho';
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
    this.qualityDialogEl.classList.remove('hidden');
    this.qualityOptionsEl.innerHTML = '';

    // Auto option
    const autoBtn = document.createElement('button');
    autoBtn.className = `dialog-option nav-focusable ${this.hls.autoLevelEnabled ? 'active' : ''}`;
    autoBtn.textContent = 'Авто (Рекомендуется)';
    autoBtn.addEventListener('click', () => {
      this.hls.currentLevel = -1;
      this.qualityLabelEl.textContent = 'Auto';
      this.closeQualityDialog();
    });
    this.qualityOptionsEl.appendChild(autoBtn);

    // Specific levels
    this.hls.levels.forEach((lvl, idx) => {
      const optBtn = document.createElement('button');
      const isSelected = !this.hls.autoLevelEnabled && this.hls.currentLevel === idx;
      optBtn.className = `dialog-option nav-focusable ${isSelected ? 'active' : ''}`;
      
      const resLabel = lvl.height ? `${lvl.height}p${lvl.frameRate && lvl.frameRate >= 50 ? Math.round(lvl.frameRate) : ''}` : lvl.name || `Уровень ${idx}`;
      const bitrateLabel = lvl.bitrate ? ` (${(lvl.bitrate / 1000000).toFixed(1)} Mbps)` : '';
      optBtn.textContent = `${resLabel}${bitrateLabel}`;

      optBtn.addEventListener('click', () => {
        this.hls.currentLevel = idx;
        this.qualityLabelEl.textContent = resLabel;
        this.closeQualityDialog();
      });

      this.qualityOptionsEl.appendChild(optBtn);
    });

    // Auto-focus first option
    if (this.options.onOpenDialog) {
      this.options.onOpenDialog(this.qualityOptionsEl);
    }
  }

  closeQualityDialog() {
    this.isQualityDialogVisible = false;
    this.qualityDialogEl.classList.add('hidden');
    this.btnQuality.focus();
    this.showOsd();
  }

  /**
   * Launch a stream
   */
  async playStream(streamData) {
    this.currentStreamData = streamData;
    this.currentChannel = streamData.userLogin;

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
      // 1. Fetch playback access token
      const authToken = getStoredToken();
      const { sig, token } = await fetchPlaybackAccessToken(this.currentChannel, authToken);

      // 2. Fetch live master playlist via ReYohoho proxy
      const { manifest, serverUrl } = await fetchLiveManifest(this.currentChannel, sig, token);
      this.lastUsedProxy = serverUrl;

      // 3. Patch codecs and create blob URL
      if (this.currentBlobUrl) {
        URL.revokeObjectURL(this.currentBlobUrl);
      }
      this.currentBlobUrl = createManifestBlobUrl(manifest);

      // 4. Initialize Hls.js with webOS-safe limits
      this._initHls(this.currentBlobUrl);
    } catch (err) {
      console.error('[TvPlayer] Playback start failed:', err);
      this.hideSpinner();
      this.streamTitleEl.textContent = `Ошибка загрузки стрима: ${err.message}. Нажмите кнопку перезагрузки для повтора.`;
      this.showOsd();
    }
  }

  _initHls(srcUrl) {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }

    if (Hls.isSupported()) {
      this.hls = new Hls({
        // webOS TV hardware bounds to prevent memory bloat and decoder stalling
        maxBufferLength: 8,
        maxMaxBufferLength: 12,
        maxBufferSize: 20 * 1024 * 1024, // 20 MB RAM buffer
        backBufferLength: 3,             // Aggressively flush passed frames for GPU memory
        liveBackBufferLength: 3,
        frontBufferFlushThreshold: 20,
        lowLatencyMode: false,
        highBufferWatchdogPeriod: 2,
        nudgeOffset: 0.1,
        nudgeMaxRetry: 5,
        enableWorker: true
      });

      this.hls.loadSource(srcUrl);
      this.hls.attachMedia(this.videoEl);

      this.hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        console.log('[TvPlayer] Manifest parsed with levels:', data.levels.length);
        this.videoEl.play().catch(e => {
          console.warn('[TvPlayer] Autoplay prevented, requires user action:', e);
        });

        // Set default label if top level is 1440p
        if (data.levels && data.levels.length > 0) {
          const top = data.levels[0];
          if (top.height >= 1440) {
            this.qualityLabelEl.textContent = '1440p60';
          }
        }
      });

      this.hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        const lvl = this.hls.levels[data.level];
        if (lvl) {
          const res = lvl.height ? `${lvl.height}p${lvl.frameRate && lvl.frameRate >= 50 ? Math.round(lvl.frameRate) : ''}` : 'Auto';
          this.qualityLabelEl.textContent = this.hls.autoLevelEnabled ? `Auto (${res})` : res;
        }
      });

      this.hls.on(Hls.Events.ERROR, (_event, data) => {
        console.warn('[TvPlayer] Hls error:', data.type, data.details, data.fatal);
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.log('[TvPlayer] Fatal network error, recovering...');
              this.hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.log('[TvPlayer] Fatal media error, recovering...');
              this.hls.recoverMediaError();
              break;
            default:
              console.error('[TvPlayer] Unrecoverable error, reloading stream...');
              this.reload();
              break;
          }
        }
      });
    } else if (this.videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      // Native Safari/HLS fallback
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
