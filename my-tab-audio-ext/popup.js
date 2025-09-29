document.getElementById('openBtn').addEventListener('click', async () => {
  const serverUrl = document.getElementById('serverUrl').value.trim();
  const url = 'capture.html' + (serverUrl ? ('#' + encodeURIComponent(serverUrl)) : '');
  const target = chrome.runtime.getURL('capture.html') + '*';
  const tabs = await chrome.tabs.query({ url: target });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
  } else {
    await chrome.tabs.create({ url });
  }
});
