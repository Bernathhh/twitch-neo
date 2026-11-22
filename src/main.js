/**
 * Twitch TV Native - Main Application Entrypoint
 * Standalone webOS Client with 1440p60 Hardware Decode & Ad-Free Playback
 */

import './style/main.css';
import './style/sidebar.css';
import './style/grid.css';
import './style/player.css';
import './style/auth.css';

import {
  fetchTopStreams,
  fetchTopGames,
  fetchGameStreams,
  searchChannels,
  fetchFollowedStreams,
  fetchCurrentUser
} from './api/twitch_gql';

import {
  getStoredToken,
  getStoredUser,
  clearToken,
  startDeviceFlow,
  stopPolling
} from './api/twitch_auth';

import {
  REYOHOHO_SERVERS,
  getCurrentProxyServer,
  setCurrentProxyServer,
  testProxyPing
} from './api/reyohoho_proxy';

import { SpatialNavigation } from './navigation/spatial_nav';
import { TvPlayer } from './player/tv_player';

class TwitchNativeApp {
  constructor() {
    this.currentView = 'home';
    this.activeCategory = null;
    this.lastFocusedCard = null;

    this.nav = new SpatialNavigation();
    this.player = new TvPlayer({
      onClose: () => {
        if (this.lastFocusedCard && document.body.contains(this.lastFocusedCard)) {
          this.nav.focusElement(this.lastFocusedCard);
        } else {
          this.focusFirstInActiveView();
        }
      },
      onOpenDialog: (container) => {
        const firstBtn = container.querySelector('.nav-focusable');
        if (firstBtn) this.nav.focusElement(firstBtn);
      }
    });

    this._bindDomElements();
    this._initApp();
  }

  _bindDomElements() {
    // Views
    this.views = {
      home: document.getElementById('view-home'),
      following: document.getElementById('view-following'),
      browse: document.getElementById('view-browse'),
      categoryStreams: document.getElementById('view-category-streams'),
      search: document.getElementById('view-search'),
      settings: document.getElementById('view-settings'),
      auth: document.getElementById('view-auth')
    };

    // Sidebar items
    this.sidebarNavItems = document.querySelectorAll('.sidebar-nav .nav-item');
    this.authSidebarBtn = document.getElementById('auth-btn');

    // Home view containers
    this.heroContainer = document.getElementById('hero-stream-container');
    this.homeStreamGrid = document.getElementById('home-stream-grid');

    // Following view containers
    this.followingGrid = document.getElementById('following-stream-grid');
    this.followingEmpty = document.getElementById('following-empty-state');

    // Browse view containers
    this.browseGrid = document.getElementById('browse-grid');

    // Category streams containers
    this.categoryTitleEl = document.getElementById('category-title');
    this.categoryStreamGrid = document.getElementById('category-stream-grid');
    this.btnCategoryBack = document.getElementById('btn-category-back');

    // Search containers
    this.searchInput = document.getElementById('search-input');
    this.searchResultsGrid = document.getElementById('search-results-grid');

    // Settings containers
    this.proxySelectorContainer = document.getElementById('proxy-selector-container');
    this.proxyStatusIndicator = document.getElementById('proxy-status-indicator');

    // Auth containers
    this.authCodeBox = document.getElementById('auth-code-box');
    this.authUserCode = document.getElementById('auth-user-code');
    this.authLoggedInBox = document.getElementById('auth-logged-in-box');
    this.authUserAvatar = document.getElementById('auth-user-avatar');
    this.authUserName = document.getElementById('auth-user-name');
    this.btnLogout = document.getElementById('btn-logout');
  }

  async _initApp() {
    this.nav.init();
    this._setupBackNavigation();
    this._setupSidebar();
    this._setupSettings();
    this._setupSearch();
    this._setupAuth();

    // Check existing auth
    const token = getStoredToken();
    if (token) {
      this._updateAuthUi(getStoredUser());
    }

    // Load initial home view
    await this.loadHome();

    // Set initial focus
    const firstItem = document.querySelector('.sidebar-nav .nav-item[data-section="home"]');
    if (firstItem) {
      this.nav.focusElement(firstItem);
    }
  }

  _setupBackNavigation() {
    this.nav.pushBackHandler(() => {
      // 1. If player is open
      if (this.player.isOpen()) {
        if (this.player.isQualityDialogVisible) {
          this.player.closeQualityDialog();
          return true;
        }
        if (this.player.isStatsVisible) {
          this.player.toggleStats();
          return true;
        }
        if (this.player.osdEl && this.player.osdEl.classList.contains('visible')) {
          this.player.hideOsd();
          return true;
        }
        this.player.close();
        return true;
      }

      // 2. If in category streams view
      if (this.currentView === 'categoryStreams') {
        this.switchView('browse');
        return true;
      }

      // 3. If in another view, return to home
      if (this.currentView !== 'home') {
        this.switchView('home');
        const homeBtn = document.querySelector('.sidebar-nav .nav-item[data-section="home"]');
        if (homeBtn) this.nav.focusElement(homeBtn);
        return true;
      }

      // 4. If in home view but focus is in stream cards, move focus to sidebar
      const current = this.nav.currentFocused;
      if (current && !current.closest('#sidebar')) {
        const homeBtn = document.querySelector('.sidebar-nav .nav-item[data-section="home"]');
        if (homeBtn) {
          this.nav.focusElement(homeBtn);
          return true;
        }
      }

      // 5. If already on sidebar, exit app or let webOS handle
      if (window.webOS && window.webOS.platformBack) {
        window.webOS.platformBack();
        return true;
      }

      return false;
    });
  }

  _setupSidebar() {
    this.sidebarNavItems.forEach(item => {
      item.addEventListener('click', () => {
        const section = item.dataset.section;
        this.switchView(section);
      });
    });

    this.authSidebarBtn.addEventListener('click', () => {
      this.switchView('auth');
    });

    if (this.btnCategoryBack) {
      this.btnCategoryBack.addEventListener('click', () => {
        this.switchView('browse');
      });
    }
  }

  switchView(viewName) {
    if (this.currentView === viewName && viewName !== 'categoryStreams') return;

    // Stop auth polling if leaving auth view
    if (this.currentView === 'auth') {
      stopPolling();
    }

    this.currentView = viewName;

    // Update active view classes
    Object.keys(this.views).forEach(key => {
      if (key === viewName) {
        this.views[key].classList.add('active');
      } else {
        this.views[key].classList.remove('active');
      }
    });

    // Update sidebar active button
    this.sidebarNavItems.forEach(item => {
      if (item.dataset.section === viewName) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });

    if (this.authSidebarBtn) {
      if (viewName === 'auth') {
        this.authSidebarBtn.classList.add('active');
      } else {
        this.authSidebarBtn.classList.remove('active');
      }
    }

    // Load view data
    switch (viewName) {
      case 'home':
        if (this.homeStreamGrid.children.length === 0) {
          this.loadHome();
        }
        break;
      case 'following':
        this.loadFollowing();
        break;
      case 'browse':
        if (this.browseGrid.children.length === 0) {
          this.loadBrowse();
        }
        break;
      case 'settings':
        this.loadSettings();
        break;
      case 'auth':
        this.loadAuth();
        break;
    }
  }

  focusFirstInActiveView() {
    const activeViewEl = this.views[this.currentView];
    if (activeViewEl) {
      const focusable = this.nav.getFocusableElements(activeViewEl)[0];
      if (focusable) {
        this.nav.focusElement(focusable);
        return;
      }
    }
    const sidebarItem = document.querySelector(`.sidebar-nav .nav-item[data-section="${this.currentView}"]`);
    if (sidebarItem) {
      this.nav.focusElement(sidebarItem);
    }
  }

  /**
   * Home View
   */
  async loadHome() {
    this.homeStreamGrid.innerHTML = '<div class="empty-desc">Загрузка популярных стримов...</div>';
    try {
      const streams = await fetchTopStreams(28);
      if (streams.length === 0) {
        this.homeStreamGrid.innerHTML = '<div class="empty-desc">Стримы не найдены</div>';
        return;
      }

      // Hero banner (Top #1 stream)
      const hero = streams[0];
      this._renderHero(hero);

      // Stream grid (Streams #2 and onwards)
      const rest = streams.slice(1);
      this._renderStreamGrid(rest, this.homeStreamGrid);
    } catch (err) {
      console.error('[App] Failed to load top streams:', err);
      this.homeStreamGrid.innerHTML = `<div class="empty-desc">Ошибка загрузки: ${err.message}</div>`;
    }
  }

  _renderHero(stream) {
    this.heroContainer.innerHTML = '';
    const heroCard = document.createElement('div');
    heroCard.className = 'hero-card';

    heroCard.innerHTML = `
      <img class="hero-backdrop" src="${stream.previewUrl.replace('440x248', '1920x1080')}" alt="">
      <div class="hero-gradient-overlay"></div>
      <div class="hero-info">
        <div class="hero-badge-row">
          <span class="live-pill">В ЭФИРЕ</span>
          <span class="hero-viewers">${stream.viewers.toLocaleString('ru-RU')} зрителей</span>
        </div>
        <h1 class="hero-title">${stream.title}</h1>
        <div class="hero-streamer-row">
          <img class="hero-avatar" src="${stream.userAvatar}" alt="${stream.userName}">
          <div>
            <div class="hero-streamer-name">${stream.userName}</div>
            <div class="hero-game-name">${stream.gameName}</div>
          </div>
        </div>
        <button id="hero-watch-btn" class="hero-play-btn nav-focusable">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          Смотреть
        </button>
      </div>
    `;

    const playBtn = heroCard.querySelector('#hero-watch-btn');
    playBtn.addEventListener('click', () => {
      this.lastFocusedCard = playBtn;
      this.player.playStream(stream);
    });

    this.heroContainer.appendChild(heroCard);
  }

  _renderStreamGrid(streams, container) {
    container.innerHTML = '';
    streams.forEach(stream => {
      const card = document.createElement('button');
      card.className = 'stream-card nav-focusable';
      card.innerHTML = `
        <div class="card-thumb-container">
          <img class="card-thumb" src="${stream.previewUrl}" alt="">
          <span class="live-pill badge-top-left">LIVE</span>
          <span class="badge-bottom-left">${stream.viewers.toLocaleString('ru-RU')} зрит.</span>
        </div>
        <div class="card-meta">
          <img class="card-avatar" src="${stream.userAvatar}" alt="">
          <div class="card-details">
            <h3 class="card-title">${stream.title}</h3>
            <span class="card-author">${stream.userName}</span>
            <span class="card-game">${stream.gameName}</span>
          </div>
        </div>
      `;

      card.addEventListener('click', () => {
        this.lastFocusedCard = card;
        this.player.playStream(stream);
      });

      container.appendChild(card);
    });
  }

  /**
   * Following View
   */
  async loadFollowing() {
    const token = getStoredToken();
    if (!token) {
      this.followingGrid.innerHTML = '';
      this.followingEmpty.classList.remove('hidden');
      return;
    }

    this.followingEmpty.classList.add('hidden');
    this.followingGrid.innerHTML = '<div class="empty-desc">Загрузка отслеживаемых стримов...</div>';

    try {
      const streams = await fetchFollowedStreams(token, 30);
      if (streams.length === 0) {
        this.followingGrid.innerHTML = '';
        this.followingEmpty.classList.remove('hidden');
        return;
      }
      this._renderStreamGrid(streams, this.followingGrid);
    } catch (err) {
      console.error('[App] Failed to load followed streams:', err);
      this.followingGrid.innerHTML = `<div class="empty-desc">Ошибка загрузки: ${err.message}</div>`;
    }
  }

  /**
   * Browse View
   */
  async loadBrowse() {
    this.browseGrid.innerHTML = '<div class="empty-desc">Загрузка категорий...</div>';
    try {
      const games = await fetchTopGames(30);
      this.browseGrid.innerHTML = '';
      games.forEach(game => {
        const card = document.createElement('button');
        card.className = 'game-card nav-focusable';
        card.innerHTML = `
          <div class="game-thumb-container">
            <img class="game-thumb" src="${game.boxArtUrl}" alt="${game.name}">
          </div>
          <div class="game-name">${game.displayName || game.name}</div>
          <div class="game-viewers">${game.viewers ? game.viewers.toLocaleString('ru-RU') + ' зрителей' : ''}</div>
        `;

        card.addEventListener('click', () => {
          this.openCategory(game);
        });

        this.browseGrid.appendChild(card);
      });
    } catch (err) {
      console.error('[App] Failed to load games:', err);
      this.browseGrid.innerHTML = `<div class="empty-desc">Ошибка: ${err.message}</div>`;
    }
  }

  async openCategory(game) {
    this.activeCategory = game;
    this.categoryTitleEl.textContent = game.displayName || game.name;
    this.switchView('categoryStreams');
    this.categoryStreamGrid.innerHTML = '<div class="empty-desc">Загрузка стримов категории...</div>';

    try {
      const streams = await fetchGameStreams(game.name, 30);
      if (streams.length === 0) {
        this.categoryStreamGrid.innerHTML = '<div class="empty-desc">Нет активных прямых эфиров в этой категории</div>';
        return;
      }
      this._renderStreamGrid(streams, this.categoryStreamGrid);
    } catch (err) {
      console.error('[App] Failed to load category streams:', err);
      this.categoryStreamGrid.innerHTML = `<div class="empty-desc">Ошибка: ${err.message}</div>`;
    }
  }

  /**
   * Search View
   */
  _setupSearch() {
    let debounceTimer = null;
    this.searchInput.addEventListener('input', (e) => {
      clearTimeout(debounceTimer);
      const q = e.target.value.trim();
      if (!q) {
        this.searchResultsGrid.innerHTML = '';
        return;
      }
      debounceTimer = setTimeout(() => {
        this.executeSearch(q);
      }, 500);
    });

    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(debounceTimer);
        const q = this.searchInput.value.trim();
        if (q) this.executeSearch(q);
      }
    });
  }

  async executeSearch(query) {
    this.searchResultsGrid.innerHTML = '<div class="empty-desc">Поиск...</div>';
    try {
      const results = await searchChannels(query);
      if (results.length === 0) {
        this.searchResultsGrid.innerHTML = '<div class="empty-desc">Ничего не найдено</div>';
        return;
      }
      this._renderStreamGrid(results, this.searchResultsGrid);
    } catch (err) {
      console.error('[App] Search error:', err);
      this.searchResultsGrid.innerHTML = `<div class="empty-desc">Ошибка поиска: ${err.message}</div>`;
    }
  }

  /**
   * Settings View
   */
  _setupSettings() {
    const currentProxy = getCurrentProxyServer();
    this.proxySelectorContainer.innerHTML = '';

    REYOHOHO_SERVERS.forEach(srv => {
      const btn = document.createElement('button');
      btn.className = `selector-btn nav-focusable ${srv.url === currentProxy ? 'active' : ''}`;
      btn.textContent = srv.id.toUpperCase();
      btn.addEventListener('click', () => {
        setCurrentProxyServer(srv.url);
        this._setupSettings();
        this._testProxyStatus(srv.url);
      });
      this.proxySelectorContainer.appendChild(btn);
    });
  }

  loadSettings() {
    this._testProxyStatus(getCurrentProxyServer());
  }

  async _testProxyStatus(serverUrl) {
    this.proxyStatusIndicator.textContent = 'Проверка соединения...';
    this.proxyStatusIndicator.style.color = 'var(--text-secondary)';

    const res = await testProxyPing(serverUrl);
    if (res.ok) {
      this.proxyStatusIndicator.textContent = `В сети (${res.ms} мс)`;
      this.proxyStatusIndicator.style.color = '#00f59b';
    } else {
      this.proxyStatusIndicator.textContent = `Ошибка (${res.error || res.status})`;
      this.proxyStatusIndicator.style.color = 'var(--live-red)';
    }
  }

  /**
   * Auth View
   */
  _setupAuth() {
    this.btnLogout.addEventListener('click', () => {
      clearToken();
      this._updateAuthUi(null);
      this.loadAuth();
    });
  }

  _updateAuthUi(user) {
    if (user) {
      const authLabel = this.authSidebarBtn.querySelector('.auth-label');
      if (authLabel) authLabel.textContent = user.displayName || user.login;

      const placeholder = this.authSidebarBtn.querySelector('.auth-avatar-placeholder');
      if (placeholder) {
        placeholder.innerHTML = `<img class="auth-user-avatar-mini" src="${user.profileImageURL}" alt="">`;
      }
    } else {
      const authLabel = this.authSidebarBtn.querySelector('.auth-label');
      if (authLabel) authLabel.textContent = 'Войти';

      const placeholder = this.authSidebarBtn.querySelector('.auth-avatar-placeholder');
      if (placeholder) {
        placeholder.innerHTML = `
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
          </svg>
        `;
      }
    }
  }

  loadAuth() {
    const token = getStoredToken();
    const user = getStoredUser();

    if (token && user) {
      this.authCodeBox.classList.add('hidden');
      this.authLoggedInBox.classList.remove('hidden');
      this.authUserAvatar.src = user.profileImageURL || '';
      this.authUserName.textContent = user.displayName || user.login;
    } else {
      this.authLoggedInBox.classList.add('hidden');
      this.authCodeBox.classList.remove('hidden');
      this.authUserCode.textContent = 'Получение...';

      startDeviceFlow(
        (codeData) => {
          this.authUserCode.textContent = codeData.userCode;
        },
        (userData) => {
          this._updateAuthUi(userData);
          this.loadAuth();
        },
        (err) => {
          this.authUserCode.textContent = 'Ошибка';
          console.error('[Auth] Flow error:', err);
        }
      );
    }
  }
}

// Bootstrap once DOM is ready
window.addEventListener('DOMContentLoaded', () => {
  window.app = new TwitchNativeApp();
});
