import './styles/kaios.css';

import { createApp } from 'vue';

import App from './App.vue';
import { installKeyHandler } from './kaios/keys.js';
import { initL10n } from './kaios/l10n.js';
import { applyStatusBarInset } from './kaios/screen.js';

installKeyHandler();
// Before mount: the header's padding has to be right on the first paint.
applyStatusBarInset();

// Mounting after strings land avoids a first paint full of message ids.
// `initL10n` is time-boxed, so a missing l10n library cannot hold up startup.
initL10n().then(() => {
  createApp(App).mount('#app');
});
