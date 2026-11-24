/**
 * AdBlock Playlist Interceptor (VAFT / ReYohoho Engine)
 * Strips SSAI stitched ads and Commercial Break slates from Twitch HLS media playlists
 */
import Hls from 'hls.js';

const AD_SIGNIFIERS = [
  'stitched-ad',
  'EXT-X-CUE-OUT',
  'twitch-stitched',
  'EXT-X-DATERANGE:CLASS="twitch-maf-ad"'
];

function sendAdCompletionBeacon(dateRangeLine, sentBeacons) {
  try {
    const idMatch = dateRangeLine.match(/ID="([^"]+)"/);
    const radMatch = dateRangeLine.match(/X-TV-TWITCH-AD-RADS-TOKEN="([^"]+)"/);
    if (!idMatch || !radMatch) return;

    const stitchedAdId = idMatch[1];
    if (sentBeacons) {
      if (sentBeacons.has(stitchedAdId)) return;
      if (sentBeacons.size > 100) sentBeacons.clear();
      sentBeacons.add(stitchedAdId);
    }

    const radToken = radMatch[1];

    const gqlBody = {
      query: `mutation MarkAdCompleted($input: MarkAdCompletedInput!) { markAdCompleted(input: $input) { error { code } } }`,
      variables: {
        input: {
          adId: stitchedAdId,
          radsToken: radToken
        }
      }
    };
    fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: {
        'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(gqlBody)
    }).catch(() => {});
  } catch (e) {}
}

export function filterAdMediaPlaylist(text, recoveryCache) {
  if (!text || typeof text !== 'string') return text;
  if (text.includes('#EXT-X-STREAM-INF:')) return text; // Pass master manifests unchanged

  let hasAdMarkers = false;
  for (let s = 0; s < AD_SIGNIFIERS.length; s++) {
    if (text.includes(AD_SIGNIFIERS[s])) {
      hasAdMarkers = true;
      break;
    }
  }

  const lines = text.split('\n');

  if (!hasAdMarkers) {
    let hasLive = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXTINF:') && i + 1 < lines.length && !lines[i + 1].startsWith('#')) {
        hasLive = true;
        break;
      }
    }
    if (hasLive && recoveryCache) {
      recoveryCache.lastCleanText = text;
      recoveryCache.lastCleanTime = Date.now();
    }
    return text;
  }

  // Ad detected: strip ad segments, ad init maps, orphaned program-date-time & ad tags
  const cleanLines = [];
  let inCueOut = false;
  let liveFound = 0;
  let skippedBeforeFirstLive = 0;
  let seenFirstLive = false;
  let origMediaSeq = -1;
  let mediaSeqLineIdx = -1;
  let pendingDateTime = null;
  let pendingMapLine = null;
  const sentBeacons = recoveryCache && recoveryCache.sentBeacons;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      origMediaSeq = parseInt(line.replace('#EXT-X-MEDIA-SEQUENCE:', '').trim(), 10);
      mediaSeqLineIdx = cleanLines.length;
      cleanLines.push(line);
      continue;
    }

    if (line.includes('EXT-X-CUE-OUT')) {
      inCueOut = true;
      pendingDateTime = null;
      pendingMapLine = null;
      continue;
    }
    if (line.includes('EXT-X-CUE-IN') || (line.startsWith('#EXT-X-DATERANGE:') && line.includes('twitch-stream-source'))) {
      inCueOut = false;
      continue;
    }

    // Skip ad DATERANGE & notify Twitch ad completed once per adId
    if (line.startsWith('#EXT-X-DATERANGE:') && (line.includes('stitched') || line.includes('twitch-maf') || line.includes('ad'))) {
      sendAdCompletionBeacon(line, sentBeacons);
      continue;
    }

    // Strip prefetch hints during ad breaks so player doesn't leak upcoming ad chunks
    if (line.startsWith('#EXT-X-TWITCH-PREFETCH:') || line.startsWith('#EXT-X-PRELOAD-HINT:')) {
      continue;
    }

    // Track per-segment program-date-time so skipped ads don't orphan timestamps
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      pendingDateTime = line;
      continue;
    }

    // Do not leak ad init segment map into live stream
    if (line.startsWith('#EXT-X-MAP:')) {
      if (inCueOut) continue;
      pendingMapLine = line;
      continue;
    }

    // Avoid leading/ad discontinuity tags when ad chunks were stripped
    if (line.startsWith('#EXT-X-DISCONTINUITY')) {
      if (inCueOut || liveFound === 0) continue;
      cleanLines.push(line);
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      const isLive = line.includes(',live');
      if (inCueOut || !isLive || line.includes('Amazon')) {
        // Skip ad segment and its URL
        pendingDateTime = null;
        if (!seenFirstLive) {
          skippedBeforeFirstLive++;
        }
        if (i + 1 < lines.length && !lines[i + 1].startsWith('#')) {
          i++;
        }
        continue;
      } else {
        seenFirstLive = true;
        liveFound++;
        if (pendingMapLine) {
          cleanLines.push(pendingMapLine);
          pendingMapLine = null;
        }
        if (pendingDateTime) {
          cleanLines.push(pendingDateTime);
          pendingDateTime = null;
        }
        cleanLines.push(line);
        if (i + 1 < lines.length && !lines[i + 1].startsWith('#')) {
          cleanLines.push(lines[i + 1]);
          i++;
        }
        continue;
      }
    }

    cleanLines.push(line);
  }

  if (liveFound > 0) {
    if (origMediaSeq >= 0 && mediaSeqLineIdx >= 0 && skippedBeforeFirstLive > 0) {
      cleanLines[mediaSeqLineIdx] = `#EXT-X-MEDIA-SEQUENCE:${origMediaSeq + skippedBeforeFirstLive}`;
    }
    const cleanText = cleanLines.join('\n');
    if (recoveryCache) {
      recoveryCache.lastCleanText = cleanText;
      recoveryCache.lastCleanTime = Date.now();
    }
    return cleanText;
  }

  // If ALL segments in this poll were ad segments:
  // Never return an empty playlist (cleanLines without segments causes fatal LEVEL_EMPTY_ERROR).
  // Allow bridging 1 poll cycle (< 3500ms) if recent, otherwise return text to keep player alive.
  if (recoveryCache && recoveryCache.lastCleanText && (Date.now() - recoveryCache.lastCleanTime < 3500)) {
    return recoveryCache.lastCleanText;
  }

  return text;
}

export function createAdBlockPlaylistLoader() {
  const recoveryCache = {
    lastCleanText: '',
    lastCleanTime: 0,
    sentBeacons: new Set()
  };

  return class AdBlockPlaylistLoader extends Hls.DefaultConfig.loader {
    constructor(config) {
      super(config);
      const origLoad = this.load.bind(this);
      this.load = (context, cfg, callbacks) => {
        const origSuccess = callbacks.onSuccess;
        callbacks.onSuccess = (response, stats, ctx, networkDetails) => {
          if (response && typeof response.data === 'string' && response.data.includes('#EXTM3U')) {
            response.data = filterAdMediaPlaylist(response.data, recoveryCache);
          }
          origSuccess(response, stats, ctx, networkDetails);
        };
        origLoad(context, cfg, callbacks);
      };
    }
  };
}
