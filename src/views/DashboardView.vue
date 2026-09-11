<template>
  <div class="kai-view">
    <KaiHeader :title="t('app_title')" />

    <main class="kai-content">
      <!--
        The reference dashboard leads with a clock. It needs nothing from the
        network, so the screen has something alive on it before any request
        resolves — and it sits on the background, not on a card. The line under
        the clock counts down to the next event; it is the reference clock
        card's second half, fetched separately so the clock never waits on it.
      -->
      <div class="kai-hero">
        <div class="kai-hero__line">
          <img class="kai-hero__mark" src="/img/icons/icon-mark-dark.png" alt="" />
          <p class="kai-hero__time">{{ time }}</p>
          <p class="kai-hero__date">{{ date }}</p>
        </div>
        <p v-if="countdown" class="kai-hero__countdown">{{ countdown.title }} · {{ countdownText }}</p>
      </div>

      <!-- Everything the app can do that is not the post list. Adding a screen
           means adding a row here and a view to `App.vue`. -->
      <KaiList class="kai-list--flat">
        <KaiListItem
          v-for="entry in ENTRIES"
          :key="entry.view"
          :primary="t(entry.title)"
          :secondary="t(entry.description)"
          @select="push(entry.view)"
        />
      </KaiList>
    </main>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import KaiHeader from '../components/KaiHeader.vue';
import KaiList from '../components/KaiList.vue';
import KaiListItem from '../components/KaiListItem.vue';
import { countdownLabel } from '../api/models.js';
import { listCountdowns } from '../api/solian.js';
import { t } from '../kaios/l10n.js';
import { setBaseSoftkeys } from '../kaios/nav.js';
import { push } from '../kaios/views.js';

// Every screen is mounted with its stack entry's parameters; the dashboard takes none.
defineProps({
  params: { type: Object, default: () => ({}) },
});

const ENTRIES = [
  { view: 'explore', title: 'nav_explore', description: 'nav_explore_desc' },
  { view: 'about', title: 'nav_about', description: 'nav_about_desc' },
];

const SECOND_MS = 1000;
const MINUTE_MS = 60000;

const time = ref('');
const date = ref('');
/** The countdown label is derived from this, so it advances on the same minute tick. */
const nowMs = ref(Date.now());
/** The soonest event, normalised; `null` until it loads or when the load fails. */
const countdown = ref(null);
let timer = null;

const countdownText = computed(() => {
  if (!countdown.value) return '';
  const label = countdownLabel(countdown.value, nowMs.value);
  return label ? t(label.key, label.args) : '';
});

function pad(value) {
  return value < 10 ? '0' + value : '' + value;
}

/** No `Intl` on Gecko 48: the date is written the way the API writes its own. */
function tick() {
  const now = new Date();
  nowMs.value = now.getTime();
  time.value = pad(now.getHours()) + ':' + pad(now.getMinutes());
  date.value = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
}

/**
 * One wake-up per minute, armed on the minute, instead of one per second: the
 * displayed time only changes when the minute does, so the sixty ticks in
 * between would spend battery to repaint the same two digits. This is why the
 * clock shows `HH:MM` and not seconds.
 *
 * Nothing is armed while the app is not visible: the timer is dropped on the way
 * out and re-armed, with a fresh reading, on the way back in.
 */
function schedule() {
  clearTimeout(timer);
  tick();

  const now = new Date();
  const intoMinute = now.getSeconds() * SECOND_MS + now.getMilliseconds();
  timer = setTimeout(schedule, MINUTE_MS - intoMinute);
}

function onVisibilityChange() {
  if (document.hidden) clearTimeout(timer);
  else schedule();
}

/** The countdown is decoration, so a failure hides the line rather than erroring. */
async function loadCountdown() {
  try {
    const items = await listCountdowns();
    countdown.value = items[0] || null;
  } catch (error) {
    countdown.value = null;
  }
}

onMounted(() => {
  schedule();
  document.addEventListener('visibilitychange', onVisibilityChange);
  loadCountdown();

  // The dashboard is the top level: Back is the platform's to take, which is
  // what leaves the app (design-guide/key).
  setBaseSoftkeys(() => ({
    center: { label: t('action_open') },
  }));
});

onBeforeUnmount(() => {
  clearTimeout(timer);
  document.removeEventListener('visibilitychange', onVisibilityChange);
});
</script>
