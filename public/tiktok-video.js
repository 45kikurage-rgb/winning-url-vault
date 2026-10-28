export const TIKTOK_VIDEO_CATEGORY = 'tiktok_lite_long_video';
export const TIKTOK_VIDEO_NAME = 'Tiktoklite長時間動画';

// This is the user's URL routing rule, not a claim about a video's duration.
export function isTikTokLongVideo(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'lite.tiktok.com'
      && !url.username && !url.password && !url.port
      && /^\/t\/[A-Za-z0-9]+\/?$/.test(url.pathname);
  } catch { return false; }
}

export const isTikTokVideoCard = item => item?.category === TIKTOK_VIDEO_CATEGORY;
