// Hands a downloaded Blob to the browser as a file save. The file is never opened or previewed
// in the portal (no iframe, no new tab, no URL shown): an <a download> saves it to disk.
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser time to start the save before the object URL goes away.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
