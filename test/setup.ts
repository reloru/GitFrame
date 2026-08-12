/**
 * jsdom gap-filling.
 *
 * jsdom's Blob predates `Blob.prototype.arrayBuffer`, which every browser the
 * app targets has shipped for years (Chrome 76+, Safari 14+, Firefox 69+).
 * Polyfilling it here keeps the production code free of workarounds for a
 * limitation that only exists in the test environment.
 */
if (typeof Blob !== 'undefined' && typeof Blob.prototype.arrayBuffer !== 'function') {
  Blob.prototype.arrayBuffer = function arrayBuffer(this: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error ?? new Error('Could not read blob'));
      reader.readAsArrayBuffer(this);
    });
  };
}

export {};
