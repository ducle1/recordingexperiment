/* Sổ Ghi Âm — cài đặt (localStorage) và kho bản ghi (IndexedDB), tất cả nằm trên máy người dùng. */
(function (SGA) {
  'use strict';

  const SKEY = 'so-ghi-am:settings';

  const settings = { deviceId: '', clean: true, agc: true };
  try { Object.assign(settings, JSON.parse(localStorage.getItem(SKEY) || '{}')); } catch (e) { /* bộ nhớ bị chặn */ }

  function saveSettings() {
    try { localStorage.setItem(SKEY, JSON.stringify(settings)); } catch (e) { /* bỏ qua */ }
  }

  let dbp = null;
  function open() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        try {
          const req = indexedDB.open('so-ghi-am', 1);
          req.onupgradeneeded = () => req.result.createObjectStore('takes', { keyPath: 'id' });
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        } catch (e) { reject(e); }
      });
    }
    return dbp;
  }

  async function run(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('takes', mode);
      const req = fn(tx.objectStore('takes'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  const DB = {
    all: () => run('readonly', s => s.getAll()),
    put: rec => run('readwrite', s => s.put(rec)),
    del: id => run('readwrite', s => s.delete(id)),
  };

  SGA.storage = { settings, saveSettings, DB };
})(window.SGA = window.SGA || {});
