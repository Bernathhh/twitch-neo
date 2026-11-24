/**
 * Twitch GraphQL API Client
 * High-performance, lightweight GraphQL queries for Twitch data
 */

const GQL_ENDPOINT = 'https://gql.twitch.tv/gql';
const PUBLIC_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

export async function postGql(query, variables = {}, token = null) {
  const headers = {
    'Client-Id': PUBLIC_CLIENT_ID,
    'Content-Type': 'application/json'
  };

  if (token) {
    headers['Authorization'] = `OAuth ${token}`;
  }

  const response = await fetch(GQL_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query,
      variables
    })
  });

  if (!response.ok) {
    throw new Error(`Twitch GQL HTTP Error: ${response.status} ${response.statusText}`);
  }

  const result = await response.json();
  if (result.errors && result.errors.length > 0) {
    console.warn('[Twitch GQL] Query warnings/errors:', result.errors);
  }
  return result.data;
}

/**
 * Fetch top live streams
 */
export async function fetchTopStreams(limit = 30) {
  const query = `
    query GetTopStreams($limit: Int!) {
      streams(first: $limit) {
        edges {
          node {
            id
            title
            viewersCount
            previewImageURL(width: 440, height: 248)
            broadcaster {
              id
              login
              displayName
              profileImageURL(width: 70)
              broadcastSettings {
                title
                game {
                  id
                  name
                  displayName
                }
              }
            }
            game {
              id
              name
              boxArtURL(width: 285, height: 380)
            }
          }
        }
      }
    }
  `;

  const data = await postGql(query, { limit });
  if (!data?.streams?.edges) return [];

  return data.streams.edges.map(edge => ({
    id: edge.node.id,
    title: edge.node.title || edge.node.broadcaster?.broadcastSettings?.title || 'Без названия',
    viewers: edge.node.viewersCount || 0,
    previewUrl: edge.node.previewImageURL,
    userLogin: edge.node.broadcaster.login,
    userName: edge.node.broadcaster.displayName,
    userAvatar: edge.node.broadcaster.profileImageURL,
    gameName: edge.node.game?.name || edge.node.broadcaster?.broadcastSettings?.game?.name || 'Без категории',
    gameBoxArt: edge.node.game?.boxArtURL || ''
  }));
}

/**
 * Fetch top categories and games
 */
export async function fetchTopGames(limit = 30) {
  const query = `
    query GetTopGames($limit: Int!) {
      games(first: $limit) {
        edges {
          node {
            id
            name
            displayName
            boxArtURL(width: 285, height: 380)
            viewersCount
          }
        }
      }
    }
  `;

  const data = await postGql(query, { limit });
  if (!data?.games?.edges) return [];

  return data.games.edges.map(edge => ({
    id: edge.node.id,
    name: edge.node.name,
    displayName: edge.node.displayName,
    boxArtUrl: edge.node.boxArtURL,
    viewers: edge.node.viewersCount || 0
  }));
}

/**
 * Fetch live streams for a specific category
 */
export async function fetchGameStreams(gameName, limit = 30) {
  const query = `
    query GetGameStreams($gameName: String!, $limit: Int!) {
      game(name: $gameName) {
        id
        name
        displayName
        boxArtURL(width: 285, height: 380)
        streams(first: $limit) {
          edges {
            node {
              id
              title
              viewersCount
              previewImageURL(width: 440, height: 248)
              broadcaster {
                id
                login
                displayName
                profileImageURL(width: 70)
              }
            }
          }
        }
      }
    }
  `;

  const data = await postGql(query, { gameName, limit });
  if (!data?.game?.streams?.edges) return [];

  return data.game.streams.edges.map(edge => ({
    id: edge.node.id,
    title: edge.node.title || 'Без названия',
    viewers: edge.node.viewersCount || 0,
    previewUrl: edge.node.previewImageURL,
    userLogin: edge.node.broadcaster.login,
    userName: edge.node.broadcaster.displayName,
    userAvatar: edge.node.broadcaster.profileImageURL,
    gameName: data.game.displayName || data.game.name,
    gameBoxArt: data.game.boxArtURL
  }));
}

/**
 * Search channels and games
 */
export async function searchChannels(userQuery) {
  const query = `
    query SearchForChannels($userQuery: String!) {
      searchFor(userQuery: $userQuery, platform: "web") {
        channels {
          edges {
            item {
              __typename
              ... on User {
                id
                login
                displayName
                profileImageURL(width: 70)
                stream {
                  id
                  title
                  viewersCount
                  previewImageURL(width: 440, height: 248)
                  game {
                    name
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await postGql(query, { userQuery });
  if (!data?.searchFor?.channels?.edges) return [];

  return data.searchFor.channels.edges
    .filter(edge => edge.item && edge.item.__typename === 'User')
    .map(edge => {
      const user = edge.item;
      const isLive = Boolean(user.stream);
      return {
        id: user.stream?.id || user.id,
        userLogin: user.login,
        userName: user.displayName,
        userAvatar: user.profileImageURL,
        isLive,
        title: user.stream?.title || (isLive ? 'Прямой эфир' : 'Не в сети'),
        viewers: user.stream?.viewersCount || 0,
        previewUrl: user.stream?.previewImageURL || user.profileImageURL,
        gameName: user.stream?.game?.name || ''
      };
    });
}

/**
 * Fetch playback access token for stream playback
 * Uses ad-free player types (thunderdome / frontpage) to bypass mid-roll ads and commercial breaks
 */
export async function fetchPlaybackAccessToken(channelLogin, token = null) {
  const query = `
    query GetPlaybackToken($login: String!, $playerType: String!) {
      streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) {
        value
        signature
        __typename
      }
    }
  `;

  // 'popout' has full unthrottled 1440p60 HEVC/AVC and avoids Twitch SSAI preroll ads
  // 'embed' and 'site' as fallbacks
  const playerTypes = ['popout', 'embed', 'site'];

  // 1. Request playback token anonymously to prevent Twitch SSAI ad targeting on user accounts
  for (const pt of playerTypes) {
    try {
      const data = await postGql(query, { login: channelLogin, playerType: pt }, null);
      const tokenData = data?.streamPlaybackAccessToken;
      if (tokenData && tokenData.signature && tokenData.value) {
        return {
          sig: tokenData.signature,
          token: tokenData.value
        };
      }
    } catch (e) {
      // try next playerType
    }
  }

  // 2. Fallback with user auth token (e.g. for subscriber-only streams)
  if (token) {
    for (const pt of playerTypes) {
      try {
        const data = await postGql(query, { login: channelLogin, playerType: pt }, token);
        const tokenData = data?.streamPlaybackAccessToken;
        if (tokenData && tokenData.signature && tokenData.value) {
          return {
            sig: tokenData.signature,
            token: tokenData.value
          };
        }
      } catch (e) {}
    }
  }

  throw new Error('Не удалось получить токен воспроизведения Twitch');
}

/**
 * Fetch current user profile info
 */
export async function fetchCurrentUser(token) {
  if (!token) return null;
  const query = `
    query GetCurrentUser {
      currentUser {
        id
        login
        displayName
        profileImageURL(width: 150)
      }
    }
  `;

  const data = await postGql(query, {}, token);
  return data?.currentUser || null;
}

/**
 * Fetch followed live channels
 */
export async function fetchFollowedStreams(token, limit = 30) {
  if (!token) return [];
  const query = `
    query GetFollowedLiveUsers($limit: Int!) {
      currentUser {
        followedLiveUsers(first: $limit) {
          edges {
            node {
              id
              login
              displayName
              profileImageURL(width: 70)
              stream {
                id
                title
                viewersCount
                previewImageURL(width: 440, height: 248)
                game {
                  id
                  name
                  displayName
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await postGql(query, { limit }, token);
  if (!data?.currentUser?.followedLiveUsers?.edges) return [];

  return data.currentUser.followedLiveUsers.edges
    .filter(edge => edge.node?.stream)
    .map(edge => {
      const u = edge.node;
      return {
        id: u.stream.id,
        title: u.stream.title || 'Прямой эфир',
        viewers: u.stream.viewersCount || 0,
        previewUrl: u.stream.previewImageURL,
        userLogin: u.login,
        userName: u.displayName,
        userAvatar: u.profileImageURL,
        gameName: u.stream.game?.name || u.stream.game?.displayName || 'Без категории'
      };
    });
}
