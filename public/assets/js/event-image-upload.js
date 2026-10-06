(function (root) {
  const configUrl = new URL('event-image-formats.json', document.currentScript.src);
  const inputs = [...document.querySelectorAll('[data-event-image-upload]')];
  const fields = [...document.querySelectorAll('[data-event-image-error]')];
  const api = {
    ready: null,
    message: '',
    formats: [],
    validate() {
      return { valid: false, message: api.message };
    },
    needsPlaceholder() {
      return false;
    }
  };

  inputs.forEach(input => { input.disabled = true; });
  root.CPRIEventUpload = api;
  api.ready = fetch(configUrl)
    .then(response => {
      if (!response.ok) throw new Error(`Image format config request failed (${response.status}).`);
      return response.json();
    })
    .then(config => {
      api.formats = config.formats;
      const labels = config.formats.flatMap(format => format.labels);
      api.message = `Only ${labels.join(', ').replace(/, ([^,]*)$/, ', or $1')} images are allowed.`;
      const extensions = new Set(config.formats.flatMap(format => format.extensions.map(extension => extension.toLowerCase())));
      const mimes = new Set(config.formats.flatMap(format => format.mimes.map(mime => mime.toLowerCase())));
      const accept = [...extensions, ...mimes].join(',');
      inputs.forEach(input => {
        input.accept = accept;
        input.disabled = false;
      });
      fields.forEach(field => { field.textContent = ''; });
      api.validate = file => {
        const extension = file?.name?.match(/\.[^.]+$/)?.[0]?.toLowerCase();
        const mime = String(file?.type || '').toLowerCase();
        return extensions.has(extension) || mimes.has(mime)
          ? { valid: true, message: '' }
          : { valid: false, message: api.message };
      };
      api.needsPlaceholder = file => {
        const extension = file?.name?.match(/\.[^.]+$/)?.[0]?.toLowerCase();
        const mime = String(file?.type || '').toLowerCase();
        return ['.heic', '.heif'].includes(extension) ||
          config.formats
            .filter(format => ['heic', 'heif'].includes(format.id))
            .some(format => format.mimes.includes(mime));
      };
      return true;
    })
    .catch(error => {
      console.error('[event-image-upload] Could not load image formats:', error);
      fields.forEach(field => {
        field.textContent = 'Image upload options could not be loaded. Refresh this page before choosing a cover image.';
      });
      return false;
    });
})(globalThis);
