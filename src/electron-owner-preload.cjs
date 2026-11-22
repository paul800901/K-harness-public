const {contextBridge, ipcRenderer} = require('electron');
// Only the trusted workbench gets this preload. Web pages never do.
let lastWindowFocus;
const windowFocusListeners = new Set();
const requestWindowFocus = () => ipcRenderer.send('k-native-window-focus-request');
// Resample the real native window after activation or a click, rather than
// trusting a cached false value forever. No polling and no focus control.
window.addEventListener('focus', requestWindowFocus);
window.addEventListener('pointerdown', requestWindowFocus, {capture: true});
ipcRenderer.on('k-native-window-focus', (_event, data) => {
  if (typeof data?.focused !== 'boolean') return;
  lastWindowFocus = Object.freeze({focused: data.focused});
  for (const callback of [...windowFocusListeners]) callback(lastWindowFocus);
});
contextBridge.exposeInMainWorld(
  'kBrowser',
  Object.freeze({
    onPageChanged: callback => {
      if (typeof callback !== 'function') throw new TypeError('Callback required.');
      const listener = (_event, data) => callback(data);
      ipcRenderer.on('k-native-browser-page', listener);
      return () => ipcRenderer.removeListener('k-native-browser-page', listener);
    },
    onWindowHidden: callback => {
      if (typeof callback !== 'function') throw new TypeError('Callback required.');
      const listener = () => callback();
      ipcRenderer.on('k-native-window-hidden', listener);
      return () => ipcRenderer.removeListener('k-native-window-hidden', listener);
    },
    // The main process revalidates the room, frame and file before revealing it.
    revealMessageFile: linkURL => ipcRenderer.invoke('k-native-reveal-message-file', String(linkURL)),
    onWindowFocusChanged: callback => {
      if (typeof callback !== 'function') throw new TypeError('Callback required.');
      windowFocusListeners.add(callback);
      if (lastWindowFocus !== undefined) callback(lastWindowFocus);
      requestWindowFocus();
      return () => windowFocusListeners.delete(callback);
    }
  })
);
