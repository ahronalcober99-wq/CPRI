(function (root) {
  const placeholderSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360">' +
    '<rect width="640" height="360" fill="#f0e6e4"/>' +
    '<text x="320" y="188" text-anchor="middle" font-family="sans-serif" font-size="28" fill="#75625f">No image</text>' +
    '</svg>';
  const placeholderDataUrl = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(placeholderSvg);

  function resolveImageUrl(event, apiBase) {
    const value = event && (event.imageUrl || event.photo || event.image);
    if (!value || typeof value !== 'string') return '';
    try {
      const base = apiBase || (root.location && root.location.origin) || 'https://cpri.onrender.com';
      const url = new URL(value.trim(), base);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      if (url.protocol === 'http:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(url.hostname)) {
        url.protocol = 'https:';
      }
      return url.href;
    } catch {
      return '';
    }
  }

  root.CPRIEventImages = { resolveImageUrl, placeholderDataUrl };
})(globalThis);
