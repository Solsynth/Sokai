// First import: the runtime polyfill must exist before any module that calls
// `Promise.withResolvers` runs (see kaios/polyfills.ts).
import './kaios/polyfills';
import './styles/kaios.css';

import { createApp } from 'vue';
import { createPinia } from 'pinia';

import App from './App.vue';
import { installKeyHandler } from './kaios/keys.js';
import { initL10n } from './kaios/l10n.js';
import { initSession } from './kaios/session.js';
import { applyStatusBarInset } from './kaios/screen.js';

installKeyHandler();
// Before mount: the header's padding has to be right on the first paint.
applyStatusBarInset();

// Pinia before anything reads a store, then the stored session restored into
// the account store — both before mount, so the first paint is the right one.
const app = createApp(App);
app.use(createPinia());
initSession();

// Mounting after strings land avoids a first paint full of message ids.
// `initL10n` is time-boxed, so a missing l10n library cannot hold up startup.
initL10n().then(() => {
  app.mount('#app');
});
