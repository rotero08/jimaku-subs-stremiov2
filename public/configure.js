// The setup page: collects the key and options, builds the install link, tests the key.
// Everything runs in the browser; the key is only ever sent to this server's /api/validate.

import { decode, encode, validKey } from './codec.js';

const $ = (id) => document.getElementById(id);
const key = $('key');
const status = $('status');
const settings = () => ({
  jimakuApiKey: key.value.trim(),
  assMode: document.querySelector('input[name="ass"]:checked').value,
  maxSubtitles: Number($('max').value),
});

let serverKeyMode = false;

function say(text, state = '') {
  status.textContent = text;
  status.dataset.state = state;
}

function setEnabled(element, enabled) {
  if (element.tagName === 'BUTTON') element.disabled = !enabled;
  else element.setAttribute('aria-disabled', String(!enabled));
}

function refresh() {
  const ready = serverKeyMode || validKey(key.value.trim());
  $('test').disabled = !validKey(key.value.trim());
  for (const element of [$('install'), $('web'), $('copy')]) setEnabled(element, ready);
  if (!ready) {
    $('url').value = '';
    $('install').href = '#';
    $('web').href = '#';
    return;
  }
  const origin = location.origin;
  const manifest = serverKeyMode ? `${origin}/manifest.json` : `${origin}/${encode(settings())}/manifest.json`;
  $('url').value = manifest;
  // stremio:// always means https, so a plain-http server (a local one) needs the manual route.
  const secure = location.protocol === 'https:';
  $('install').href = secure ? manifest.replace(/^https:/, 'stremio:') : '#';
  setEnabled($('install'), secure);
  $('note-local').hidden = secure;
  $('web').href = `https://web.stremio.com/#/addons?addon=${encodeURIComponent(manifest)}`;
  setEnabled($('web'), secure);
}

async function testKey() {
  const value = key.value.trim();
  $('test').disabled = true;
  say('Asking Jimaku…');
  try {
    const response = await fetch('/api/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jimakuApiKey: value }),
    });
    const { status: result } = await response.json();
    if (result === 'valid') say('✓ Jimaku accepted this key.', 'ok');
    else if (result === 'invalid') say('✗ Jimaku rejected this key. Copy it again from your account page.', 'bad');
    else if (result === 'rate_limited') say('Jimaku is busy right now, so the key could not be checked. It may still be fine.', 'warn');
    else say('Could not reach Jimaku right now. Try again in a moment.', 'warn');
  } catch {
    say('Could not reach this server. Check your connection.', 'warn');
  } finally {
    $('test').disabled = !validKey(key.value.trim());
  }
}

async function copyLink() {
  const url = $('url');
  try {
    await navigator.clipboard.writeText(url.value);
    $('copy').textContent = 'Copied ✓';
  } catch {
    url.select();
    $('copy').textContent = 'Press Ctrl+C to copy';
  }
  setTimeout(() => ($('copy').textContent = 'Copy the link'), 2500);
}

function toggleReveal() {
  const show = key.type === 'password';
  key.type = show ? 'text' : 'password';
  $('reveal').setAttribute('aria-pressed', String(show));
  $('reveal').setAttribute('aria-label', show ? 'Hide the key' : 'Show the key');
}

// A link opened from Stremio's "Configure" button is /<settings>/configure: fill the form from it.
const [first, second] = location.pathname.split('/').filter(Boolean);
if (second === 'configure') {
  const saved = decode(first);
  if (saved) {
    key.value = saved.jimakuApiKey;
    const mode = document.querySelector(`input[name="ass"][value="${saved.assMode}"]`);
    if (mode) mode.checked = true;
    if ([...$('max').options].some((o) => o.value === String(saved.maxSubtitles))) $('max').value = String(saved.maxSubtitles);
  }
}

key.addEventListener('input', () => {
  say('');
  refresh();
});
for (const element of document.querySelectorAll('input[name="ass"], #max')) element.addEventListener('change', refresh);
$('test').addEventListener('click', testKey);
$('copy').addEventListener('click', copyLink);
$('reveal').addEventListener('click', toggleReveal);
$('url').addEventListener('focus', () => $('url').select());
refresh();

// A server that has its own key needs nothing from the visitor: just install.
fetch('/manifest.json')
  .then((r) => r.json())
  .then((manifest) => {
    if (manifest?.behaviorHints?.configurationRequired === false) {
      serverKeyMode = true;
      $('step-key').hidden = true;
      $('step-options').hidden = true;
      refresh();
    }
  })
  .catch(() => {});
