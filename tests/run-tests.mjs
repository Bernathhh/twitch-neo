import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import babel from '@babel/core';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function loadModule(relPath, mocks = {}, globals = {}) {
  const absPath = path.resolve(rootDir, relPath);
  const src = fs.readFileSync(absPath, 'utf8');
  const { code } = babel.transformSync(src, {
    filename: absPath,
    presets: [['@babel/preset-env', { modules: 'commonjs', targets: { node: 'current' } }]]
  });

  const module = { exports: {} };
  const baseDir = path.dirname(absPath);

  function customRequire(spec) {
    if (mocks[spec]) return mocks[spec];
    if (spec.endsWith('.css')) return {};
    if (spec.startsWith('.')) {
      const targetRel = path.relative(rootDir, path.resolve(baseDir, spec.endsWith('.js') ? spec : `${spec}.js`));
      if (mocks[targetRel]) return mocks[targetRel];
      return loadModule(targetRel, mocks, globals);
    }
    throw new Error(`Unmocked import ${spec} from ${relPath}`);
  }

  const sandbox = {
    module,
    exports: module.exports,
    require: customRequire,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    URLSearchParams,
    URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} },
    Blob: class MockBlob {
      constructor(parts, opts) { this.parts = parts; this.opts = opts; }
    },
    ...globals
  };

  vm.runInNewContext(code, sandbox, { filename: absPath });
  return module.exports;
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS: ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.error(`FAIL: ${name}\n`, err);
  }
}

// 1. codecs.js tests
await test('codecs: patchMasterManifest strips AV1, normalizes HEVC, preserves AVC profile, keeps direct URLs', () => {
  const codecs = loadModule('src/player/codecs.js');
  const manifest = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=9800000,RESOLUTION=2560x1440,CODECS="hev1.1.6.L150.90.0.0.0.0.0,mp4a.40.2",FRAME-RATE=60.000',
    'https://euc11.playlist.ttvnw.net/v1/playlist/1440.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="avc1.4D4033,mp4a.40.2",FRAME-RATE=60.000',
    'https://euc11.playlist.ttvnw.net/v1/playlist/1080.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="av01.0.08M.08,mp4a.40.2"',
    'https://euc11.playlist.ttvnw.net/v1/playlist/av1.m3u8'
  ].join('\n');

  const out = codecs.patchMasterManifest(manifest);
  assert(!out.includes('av01'), 'AV1 stream should be stripped');
  assert(!out.includes('av1.m3u8'), 'AV1 URL should be stripped');
  assert(out.includes('CODECS="hvc1.1.6.L150.B0,mp4a.40.2"'), 'HEVC codec should normalize cleanly');
  assert(out.includes('CODECS="avc1.4D402a,mp4a.40.2"'), 'AVC level > 4.2 should clamp while preserving 4D40 Main Profile');
  assert(out.includes('\nhttps://euc11.playlist.ttvnw.net/v1/playlist/1440.m3u8'), 'Variant URLs must stay direct (unproxied)');
});

await test('codecs: patchMediaCodecs patches MediaSource and ManagedMediaSource once cleanly', () => {
  class FakeMS {
    static isTypeSupported(t) { return t === 'video/mp4; codecs="hvc1.1.6.L93.B0"'; }
    addSourceBuffer(t) { return { type: t }; }
  }
  class FakeMMS {
    static isTypeSupported(t) { return t === 'video/mp4; codecs="avc1.4d402a"'; }
    addSourceBuffer(t) { return { type: t }; }
  }
  const win = { MediaSource: FakeMS, ManagedMediaSource: FakeMMS };
  const codecs = loadModule('src/player/codecs.js', {}, { window: win });

  codecs.patchMediaCodecs();
  codecs.patchMediaCodecs(); // idempotent call must not double-wrap

  assert.equal(FakeMS.isTypeSupported('video/mp4; codecs="av01.0.08M.08"'), false);
  assert.equal(FakeMS.isTypeSupported('video/mp4; codecs="hev1.1.6.L150.90.0.0.0.0.0"'), true);
  assert.equal(FakeMMS.isTypeSupported('video/mp4; codecs="avc1.4d4033"'), true);
});

// 2. adblock_loader.js tests
await test('adblock_loader: strips cue-out ads, ad maps, adjusts MEDIA-SEQUENCE, deduplicates beacons', () => {
  const beaconCalls = [];
  const fakeFetch = async (url, opts) => {
    beaconCalls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true };
  };
  class DummyLoader {}
  const adblock = loadModule(
    'src/player/adblock_loader.js',
    { 'hls.js': { DefaultConfig: { loader: DummyLoader } } },
    { fetch: fakeFetch }
  );

  const cache = { lastCleanText: '', lastCleanTime: 0, sentBeacons: new Set() };
  const playlist = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:2',
    '#EXT-X-MEDIA-SEQUENCE:100',
    '#EXT-X-DATERANGE:ID="ad-1",CLASS="twitch-stitched-ad",X-TV-TWITCH-AD-RADS-TOKEN="tok1"',
    '#EXT-X-CUE-OUT:30.000',
    '#EXT-X-DISCONTINUITY',
    '#EXT-X-MAP:URI="https://ad.example/init.mp4"',
    '#EXT-X-PROGRAM-DATE-TIME:2026-11-24T10:00:00Z',
    '#EXTINF:2.000,Amazon|stitched',
    'https://ad.example/1.mp4',
    '#EXT-X-PROGRAM-DATE-TIME:2026-11-24T10:00:02Z',
    '#EXTINF:2.000,Amazon|stitched',
    'https://ad.example/2.mp4',
    '#EXT-X-CUE-IN',
    '#EXT-X-DISCONTINUITY',
    '#EXT-X-MAP:URI="https://live.example/init.mp4"',
    '#EXT-X-PROGRAM-DATE-TIME:2026-11-24T10:00:04Z',
    '#EXTINF:2.000,live',
    'https://live.example/102.mp4'
  ].join('\n');

  const cleaned1 = adblock.filterAdMediaPlaylist(playlist, cache);
  assert(cleaned1.includes('#EXT-X-MEDIA-SEQUENCE:102'), 'MEDIA-SEQUENCE must advance by 2 skipped leading ad segments');
  assert(!cleaned1.includes('ad.example/init.mp4'), 'Ad EXT-X-MAP must not leak');
  assert(!cleaned1.includes('ad.example/1.mp4'), 'Ad segment must be stripped');
  assert(!cleaned1.includes('10:00:00Z'), 'Orphaned ad PDT must be dropped');
  assert(cleaned1.includes('10:00:04Z'), 'Live PDT must be kept');
  assert(cleaned1.includes('live.example/init.mp4'), 'Live map must be kept');
  assert(cleaned1.includes('live.example/102.mp4'), 'Live segment must be kept');
  assert.equal(beaconCalls.length, 1);

  adblock.filterAdMediaPlaylist(playlist, cache);
  assert.equal(beaconCalls.length, 1, 'Repeated polls for same adId must not re-fire beacon');
});

await test('adblock_loader: never returns empty playlist when liveFound === 0', () => {
  class DummyLoader {}
  const adblock = loadModule(
    'src/player/adblock_loader.js',
    { 'hls.js': { DefaultConfig: { loader: DummyLoader } } },
    { fetch: async () => ({ ok: true }) }
  );

  const cache = { lastCleanText: '', lastCleanTime: 0, sentBeacons: new Set() };
  const allAds = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:2',
    '#EXT-X-MEDIA-SEQUENCE:50',
    '#EXT-X-CUE-OUT:15.000',
    '#EXTINF:2.000,Amazon',
    'https://ad.example/50.mp4',
    '#EXTINF:2.000,Amazon',
    'https://ad.example/51.mp4'
  ].join('\n');

  const out = adblock.filterAdMediaPlaylist(allAds, cache);
  assert(out.includes('#EXTINF:'), 'Fallback output must still contain media segments to avoid LEVEL_EMPTY_ERROR');
});

// 3. twitch_gql.js & reyohoho_proxy.js tests
await test('twitch_gql: playback token prefers anonymous call first and propagates 401 on auth failure', async () => {
  const calls = [];
  const gql = loadModule('src/api/twitch_gql.js', {}, {
    fetch: async (url, opts) => {
      calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
      if (opts.headers.Authorization === 'OAuth expired_tok') {
        return { ok: false, status: 401, statusText: 'Unauthorized' };
      }
      return {
        ok: true,
        json: async () => ({
          data: {
            streamPlaybackAccessToken: { value: '{"v":1}', signature: 'sig123' }
          }
        })
      };
    }
  });

  const tok = await gql.fetchPlaybackAccessToken('pgl', 'user_secret_oauth');
  assert.equal(tok.sig, 'sig123');
  assert.equal(calls[0].headers.Authorization, undefined, 'Playback token must be requested anonymously first');

  await assert.rejects(
    () => gql.fetchCurrentUser('expired_tok'),
    (err) => err.status === 401
  );
});

await test('twitch_gql: searchChannels sorts live streams ahead of offline channels', async () => {
  const gql = loadModule('src/api/twitch_gql.js', {}, {
    fetch: async () => ({
      ok: true,
      json: async () => ({
        data: {
          searchFor: {
            channels: {
              edges: [
                { item: { __typename: 'User', id: '1', login: 'off', displayName: 'Off', profileImageURL: 'a', stream: null } },
                { item: { __typename: 'User', id: '2', login: 'livech', displayName: 'Live', profileImageURL: 'b', stream: { id: 's1', title: 'Hi', viewersCount: 100, previewImageURL: 'p', game: { name: 'CS2' } } } }
              ]
            }
          }
        }
      })
    })
  });

  const res = await gql.searchChannels('test');
  assert.equal(res.length, 2);
  assert.equal(res[0].login || res[0].userLogin, 'livech');
  assert.equal(res[0].isLive, true);
  assert.equal(res[1].isLive, false);
});

await test('reyohoho_proxy: fetchLiveManifest omits user auth parameter and migrates outdated urls', async () => {
  let requestedUrl = '';
  const store = { twitch_native_proxy_server: 'https://usher.ttvnw.net/' };
  const proxy = loadModule('src/api/reyohoho_proxy.js', {}, {
    localStorage: {
      getItem: (k) => store[k] || null,
      setItem: (k, v) => { store[k] = v; }
    },
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    fetch: async (url) => {
      requestedUrl = url;
      return { ok: true, text: async () => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nhttps://edge.ttvnw.net/a.m3u8' };
    }
  });

  const res = await proxy.fetchLiveManifest('pgl', 'sig', 'tok');
  assert(!requestedUrl.includes('auth='), 'usher request must never include user auth parameter');
  assert(res.serverUrl.includes('proxy4.rte.net.ru'), 'Should auto-migrate outdated proxy URL to proxy4');
});

// 4. tv_player.js tests
await test('tv_player: selects optimal resolution (1440p max / 1080p60 > 1080p30 / Auto->Manual codec boundary)', async () => {
  const elMock = () => ({
    classList: {
      _s: new Set(['hidden']),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    addEventListener() {},
    removeAttribute() {},
    load() {},
    pause() {},
    play: async () => {},
    focus() {},
    buffered: { length: 0 },
    textContent: '',
    innerHTML: '',
    src: ''
  });
  const doc = {
    getElementById: () => elMock()
  };

  class FakeHls {
    constructor(cfg) { this.cfg = cfg; this.levels = []; this.currentLevel = -1; this.loadLevel = -1; }
    static isSupported() { return true; }
    on() {}
    loadSource() {}
    attachMedia() {}
    destroy() {}
    startLoad() {}
  }
  FakeHls.Events = { FRAG_BUFFERED: 'fb', MANIFEST_PARSED: 'mp', LEVEL_SWITCHED: 'ls', ERROR: 'err' };
  FakeHls.ErrorTypes = { NETWORK_ERROR: 'ne', MEDIA_ERROR: 'me' };
  FakeHls.DefaultConfig = { loader: class {} };

  const playerMod = loadModule('src/player/tv_player.js', {
    'hls.js': FakeHls,
    'src/api/twitch_gql.js': { fetchPlaybackAccessToken: async () => ({ sig: 's', token: 't' }) },
    'src/api/reyohoho_proxy.js': { fetchLiveManifest: async () => ({ manifest: '#EXTM3U', serverUrl: 'https://proxy4.rte.net.ru/' }) },
    'src/api/twitch_auth.js': { getStoredToken: () => null }
  }, {
    document: doc,
    window: {},
    localStorage: { getItem: () => 'max', setItem() {} }
  });

  const player = new playerMod.TvPlayer({});
  clearInterval(player.watchdogInterval); // keep node process clean to exit

  const levels = [
    { height: 0, bitrate: 160000, frameRate: 0, name: 'audio_only' },
    { height: 160, bitrate: 200000, frameRate: 30 },
    { height: 1080, bitrate: 4500000, frameRate: 30, videoCodec: 'avc1.4D401F' },
    { height: 1080, bitrate: 8000000, frameRate: 60, videoCodec: 'avc1.4D402A' },
    { height: 1440, bitrate: 9800000, frameRate: 60, videoCodec: 'hvc1.1.6.L150.B0' }
  ];

  assert.equal(player._pickBestLevelForHeight(levels, 9999, false), 4, 'max picks 1440p60');
  assert.equal(player._pickBestLevelForHeight(levels, 1080, true), 3, '1080p exact picks 1080p60 over 1080p30');
  assert.equal(player._pickBestLevelForHeight(levels, 720, false), 1, 'ignores audio_only height 0');

  // Test Auto (HEVC on idx 4) -> Manual 1080p AVC (idx 3) triggers cleanPipelineRestart
  let restarted = null;
  player.hls = new FakeHls({});
  player.hls.levels = levels;
  player.hls.currentLevel = 4; // playing HEVC in Auto mode
  player.currentSelectedLevel = -1;
  player.currentBlobUrl = 'blob:stream';
  player._cleanPipelineRestart = (url, idx) => { restarted = { url, idx }; };

  player._selectQualityLevel(3, '1080p60');
  assert.deepEqual(restarted, { url: 'blob:stream', idx: 3 }, 'Auto HEVC -> Manual AVC must trigger pipeline restart');

  // Same-codec AVC 1080p -> 1080p30 (idx 3 -> idx 2) must be instant (no pipeline restart)
  restarted = null;
  player._selectQualityLevel(2, '1080p30');
  assert.equal(restarted, null, 'Same-codec AVC -> AVC must switch immediately without pipeline restart');
});

await test('tv_player: playStream aborts offline channel and stale closed session', async () => {
  const containerClasses = new Set(['hidden']);
  const titleEl = { textContent: '' };
  const elById = (id) => ({
    classList: id === 'player-container'
      ? { add: (c) => containerClasses.add(c), remove: (c) => containerClasses.delete(c), contains: (c) => containerClasses.has(c) }
      : { add() {}, remove() {}, contains: () => true },
    addEventListener() {},
    removeAttribute() {},
    load() {},
    pause() {},
    play: async () => {},
    focus() {},
    buffered: { length: 0 },
    textContent: '',
    innerHTML: '',
    src: ''
  });
  const doc = { getElementById: (id) => (id === 'osd-stream-title' ? titleEl : elById(id)) };

  class FakeHls {
    static isSupported() { return true; }
    on() {}
    loadSource() {}
    attachMedia() {}
    destroy() {}
  }
  FakeHls.Events = { FRAG_BUFFERED: 'fb', MANIFEST_PARSED: 'mp', LEVEL_SWITCHED: 'ls', ERROR: 'err' };
  FakeHls.DefaultConfig = { loader: class {} };

  let initCalled = false;
  let resolveManifest;
  const manifestPromise = new Promise(r => { resolveManifest = r; });

  const playerMod = loadModule('src/player/tv_player.js', {
    'hls.js': FakeHls,
    'src/api/twitch_gql.js': { fetchPlaybackAccessToken: async () => ({ sig: 's', token: 't' }) },
    'src/api/reyohoho_proxy.js': { fetchLiveManifest: () => manifestPromise },
    'src/api/twitch_auth.js': { getStoredToken: () => null }
  }, {
    document: doc,
    window: {},
    localStorage: { getItem: () => 'max', setItem() {} }
  });

  const player = new playerMod.TvPlayer({});
  clearInterval(player.watchdogInterval);
  player._initHls = () => { initCalled = true; };

  // 1. Offline stream should fail immediately without calling _initHls
  await player.playStream({ userLogin: 'off', isLive: false });
  assert.equal(initCalled, false);
  assert(titleEl.textContent.includes('Offline'));

  // 2. Closing while async fetchLiveManifest is in-flight must abort _initHls
  const p = player.playStream({ userLogin: 'live1', isLive: true });
  await Promise.resolve();
  player.close();
  resolveManifest({ manifest: '#EXTM3U', serverUrl: 'https://proxy4.rte.net.ru/' });
  await p;
  assert.equal(initCalled, false, 'Stale manifest after close() must NOT start hidden playback');
});

// 5. spatial_nav.js tests
await test('spatial_nav: preserves Backspace in text input & prevents diagonal Up jump to sidebar', () => {
  const inputEl = {
    tagName: 'INPUT',
    value: 'abc',
    selectionStart: 2,
    classList: { add() {}, remove() {}, contains: () => false },
    closest: (s) => (s === '#main-content' ? {} : null),
    getBoundingClientRect: () => ({ left: 200, top: 100, width: 400, height: 50 }),
    focus() {},
    blur() {}
  };
  const sidebarEl = {
    tagName: 'BUTTON',
    classList: { add() {}, remove() {}, contains: () => false },
    closest: (s) => (s === '#sidebar' ? {} : null),
    offsetParent: {},
    getBoundingClientRect: () => ({ left: 20, top: 40, width: 100, height: 80 }),
    focus() {},
    blur() {}
  };
  const topCardEl = {
    tagName: 'BUTTON',
    classList: { add() {}, remove() {}, contains: () => false },
    closest: (s) => (s === '#main-content' ? {} : null),
    offsetParent: {},
    getBoundingClientRect: () => ({ left: 200, top: 150, width: 300, height: 200 }),
    focus() {},
    blur() {}
  };

  const doc = {
    activeElement: inputEl,
    body: { contains: () => true },
    getElementById: () => null,
    querySelector: (sel) => {
      if (sel === '.sidebar') return { querySelectorAll: () => [sidebarEl] };
      if (sel === '.view-section.active') return { querySelectorAll: () => [topCardEl] };
      return null;
    }
  };

  const navMod = loadModule('src/navigation/spatial_nav.js', {}, {
    window: { addEventListener() {}, removeEventListener() {} },
    document: doc
  });

  const nav = new navMod.SpatialNavigation();
  let backCalled = false;
  nav.pushBackHandler(() => { backCalled = true; return true; });

  let prevented = false;
  nav._handleKeyDown({
    keyCode: 8,
    key: 'Backspace',
    preventDefault() { prevented = true; },
    stopPropagation() {},
    stopImmediatePropagation() {}
  });
  assert.equal(backCalled, false, 'Backspace inside <input> must not trigger Back navigation');
  assert.equal(prevented, false, 'Backspace inside <input> must not be preventDefaulted');

  // ArrowLeft inside input with caret at pos 2 must stay inside input
  prevented = false;
  nav._handleKeyDown({
    keyCode: 37,
    key: 'ArrowLeft',
    preventDefault() { prevented = true; }
  });
  assert.equal(prevented, false, 'ArrowLeft inside input caret pos > 0 must move caret');

  // Vertical Up from top card in main-content must NOT jump diagonally to sidebar above it
  doc.activeElement = topCardEl;
  nav.currentFocused = topCardEl;
  nav.move('up');
  assert.equal(nav.currentFocused, topCardEl, 'Pressing Up at top of view-following/browse must not jump diagonally to sidebar');
});

// 6. escapeHtml test
await test('main: escapeHtml escapes HTML/XSS metacharacters safely', () => {
  const mainMod = loadModule('src/main.js', {
    './style/main.css': {},
    './style/sidebar.css': {},
    './style/grid.css': {},
    './style/player.css': {},
    './style/auth.css': {},
    'src/api/twitch_gql.js': {},
    'src/api/twitch_auth.js': {},
    'src/api/reyohoho_proxy.js': {},
    'src/navigation/spatial_nav.js': {},
    'src/player/tv_player.js': {}
  }, {
    window: { addEventListener() {} }
  });

  assert.equal(mainMod.escapeHtml('<script>alert("x")</script> & <3'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &lt;3');
});

const failed = results.filter(r => !r.ok);
console.log(`\nSummary: ${results.length - failed.length}/${results.length} tests passed.`);
if (failed.length > 0) process.exit(1);
