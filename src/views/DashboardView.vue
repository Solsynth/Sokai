<template>
  <div class="kai-view">
    <KaiHeader :title="t('app_title')" />

    <main class="kai-content">
      <!--
        The hero is the clock. It needs nothing from the network, so the screen
        has something alive on it before any request resolves — and it sits on
        the background, not on a card. The time and the date share one line and
        one baseline: the date is the clock's caption, set to its right and led
        by the weekday because that is the part of a date you actually look up.
      -->
      <div class="kai-hero">
        <div class="kai-hero__line">
          <p class="kai-hero__time">{{ time }}</p>
          <p class="kai-hero__date">{{ weekday }} · {{ date }}</p>
        </div>
      </div>

      <!--
        One tile per thing the app does. The first is the next event — or the
        absence of one — read the way the calendar screen's agenda rows read
        it: the countdown beside the name, the day and span under them. The
        tile is the way into that screen, so the glance itself is the way in.
        Adding a screen means adding a row here and a view to `App.vue`.

        The entries take the highlight on mount; the calendar tile is above
        them, so UP reaches it.
      -->
      <KaiList class="kai-list--flat">
        <KaiListItem class="kai-next-event" :secondary="nextWhen" @select="openCalendar">
          <template #primary>
            <span>{{ nextTitle }}</span>
            <span v-if="eta" class="kai-next-event__eta">{{ eta }}</span>
          </template>
        </KaiListItem>

        <KaiListItem
          v-for="(entry, index) in ENTRIES"
          :key="entry.view"
          :primary="t(entry.title)"
          :secondary="entry.view === 'account' ? accountDescription : t(entry.description)"
          :initial="index === 0"
          @select="push(entry.view)"
        />
      </KaiList>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import KaiHeader from '~/src/components/KaiHeader.vue';
import KaiList from '~/src/components/KaiList.vue';
import KaiListItem from '~/src/components/KaiListItem.vue';
import {
  countdownLabel,
  dayKey,
  formatClockRange,
  todayKey,
  weekdayIndex,
  type Countdown,
} from '~/src/api/models.js';
import { listCountdowns } from '~/src/api/solian.js';
import { t } from '~/src/kaios/l10n.js';
import { setBaseSoftkeys } from '~/src/kaios/nav.js';
import { push } from '~/src/kaios/views.js';
import { useAccountStore } from '~/src/stores/account.js';

// Every screen is mounted with its stack entry's parameters; the dashboard takes none.
withDefaults(defineProps<{ params?: Record<string, string> }>(), { params: () => ({}) });

interface DashboardEntry {
  view: string;
  title: string;
  description: string;
}

const ENTRIES: DashboardEntry[] = [
  { view: 'explore', title: 'nav_explore', description: 'nav_explore_desc' },
  { view: 'chat', title: 'nav_chat', description: 'nav_chat_desc' },
  { view: 'notifications', title: 'nav_notifications', description: 'nav_notifications_desc' },
  { view: 'account', title: 'nav_account', description: 'nav_account_desc' },
  { view: 'settings', title: 'nav_settings', description: 'nav_settings_desc' },
  { view: 'about', title: 'nav_about', description: 'nav_about_desc' },
];

const accountStore = useAccountStore();

/**
 * The account row reports the session: the signed-in identity when there is
 * one, the plain description when there is not.
 */
const accountDescription = computed(() => {
  if (accountStore.phase === 'signed-in' && accountStore.account) {
    return t('account_signed_in_as', { name: accountStore.account.display });
  }
  return t('nav_account_desc');
});

const SECOND_MS = 1000;
const MINUTE_MS = 60000;

/** Monday first, the order the calendar screen's own week runs in. */
const WEEKDAYS = [
  'calendar_dow_mon',
  'calendar_dow_tue',
  'calendar_dow_wed',
  'calendar_dow_thu',
  'calendar_dow_fri',
  'calendar_dow_sat',
  'calendar_dow_sun',
];

const time = ref('');
const date = ref('');
/** The countdown label is derived from this, so it advances on the same minute tick. */
const nowMs = ref(Date.now());
/** The soonest event, normalised; `null` until it loads or when the load fails. */
const countdown = ref<Countdown | null>(null);
let timer: ReturnType<typeof setTimeout> | null = null;

const weekday = computed(() => {
  if (!date.value) return '';
  return t(WEEKDAYS[weekdayIndex(date.value)]);
});

const eta = computed(() => {
  if (!countdown.value) return '';
  const label = countdownLabel(countdown.value, nowMs.value);
  return label ? t(label.key, label.args) : '';
});

const nextTitle = computed(() =>
  countdown.value ? countdown.value.title : t('calendar_no_upcoming'),
);

/** The day the next event falls on, with its span — the same reading the
 *  calendar screen's agenda rows use. */
const nextWhen = computed(() => {
  const event = countdown.value;
  if (!event) return '';

  const day = dayKey(event.startTime);
  if (!day) return '';
  if (event.isAllDay) return day + ' · ' + t('calendar_all_day');

  const span = formatClockRange(event.startTime, event.endTime);
  return span ? day + ' · ' + span : day;
});

function pad(value: number): string {
  return value < 10 ? '0' + value : '' + value;
}

/** No `Intl` on Gecko 48: the date is written the way the API writes its own. */
function tick(): void {
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
function schedule(): void {
  if (timer) clearTimeout(timer);
  tick();

  const now = new Date();
  const intoMinute = now.getSeconds() * SECOND_MS + now.getMilliseconds();
  timer = setTimeout(schedule, MINUTE_MS - intoMinute);
}

function onVisibilityChange(): void {
  if (document.hidden) {
    if (timer) clearTimeout(timer);
  } else {
    schedule();
  }
}

/** The countdown is decoration, so a failure hides the line rather than erroring. */
async function loadCountdown(): Promise<void> {
  try {
    const items = await listCountdowns();
    countdown.value = items[0] || null;
  } catch (error) {
    countdown.value = null;
  }
}

/**
 * Opens the full calendar on the day the row is describing — the event it
 * names, or today when there is nothing ahead — so the tap lands where the
 * glance was pointing.
 */
function openCalendar(): void {
  const event = countdown.value;
  push('calendar', { date: (event && dayKey(event.startTime)) || todayKey() });
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
  if (timer) clearTimeout(timer);
  document.removeEventListener('visibilitychange', onVisibilityChange);
});
</script>
