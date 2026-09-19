<template>
  <div class="kai-view">
    <KaiHeader :title="t('nav_calendar')" />

    <main class="kai-content">
      <!--
        The month bar: previous, the month, next — the feed's pager shape, so
        the D-pad reaches it from the grid and nothing else lives up here. The
        label between the arrows is inert; the arrows are the selectable cells.
      -->
      <div class="kai-cal__bar">
        <KaiListItem
          :icon="ChevronLeft"
          :aria-label="t('calendar_prev_month')"
          @select="shiftMonth(-1)"
        />
        <p class="kai-cal__month">{{ month }}</p>
        <KaiListItem
          :icon="ChevronRight"
          :aria-label="t('calendar_next_month')"
          @select="shiftMonth(1)"
        />
      </div>

      <div class="kai-cal__weekdays">
        <span v-for="key in WEEKDAYS" :key="key" class="kai-cal__weekday">{{ t(key) }}</span>
      </div>

      <!--
        One selectable owns the whole grid: forty-two day cells are not a list
        the highlight should walk one press at a time (see `onKeydown`). The
        D-pad moves the cursor a day or a week inside it; at the top and bottom
        rows it lets the press go, which is how the month bar above and the
        day's agenda below are reached the ordinary way.
      -->
      <div
        ref="grid"
        tabindex="-1"
        nav-selectable="true"
        :nav-selected="isSelected ? 'true' : 'false'"
        class="kai-cal__grid"
      >
        <div v-for="(week, index) in weeks" :key="index" class="kai-cal__week">
          <div
            v-for="day in week"
            :key="day.key"
            class="kai-cal__day"
            :class="{
              'kai-cal__day--outside': !day.inMonth,
              'kai-cal__day--today': day.key === today,
              'kai-cal__day--cursor': day.key === cursor,
            }"
            @click="setCursor(day.key)"
          >
            <span class="kai-cal__num">{{ day.num }}</span>
            <!-- A dot per kind of thing the day carries: an event in the
                 account's calendar, a notable day the network knows. -->
            <span class="kai-cal__marks">
              <span v-if="day.hasEvent" class="kai-cal__mark"></span>
              <span v-if="day.hasNotable" class="kai-cal__mark kai-cal__mark--notable"></span>
            </span>
          </div>
        </div>
      </div>

      <p class="kai-separator kai-cal__date">{{ cursorWeekday }} · {{ cursor }}</p>

      <KaiSpinner v-if="status === 'loading'" />

      <template v-else>
        <!--
          Today's check-in, nested in the day's content: the ritual shows on
          the cursor's day when that day is today, and nowhere else — the same
          day-scoped shape the agenda has, so it reads as part of the day
          rather than a screen of its own. It needs a session; signed out, the
          day is just the calendar.
        -->
        <template v-if="showCheckIn">
          <p class="kai-separator">{{ t('check_in_title') }}</p>

          <!-- Loading today's state -->
          <p v-if="checkInLoading" class="kai-text kai-text--secondary">{{ t('check_in_loading') }}</p>

          <!-- Couldn't read today's state: the section is useless without it. -->
          <template v-else-if="checkInErrorKey && !checkInResult">
            <p class="kai-text kai-text--error">{{ t(checkInErrorKey) }}</p>
            <KaiList class="kai-list--flat">
              <KaiListItem :primary="t('error_retry')" @select="loadCheckIn" />
            </KaiList>
          </template>

          <!-- Not checked in yet: the prompt and the single action. -->
          <template v-else-if="!checkInResult">
            <p class="kai-text">{{ t('check_in_check_in_today') }}</p>
            <p class="kai-text kai-text--secondary">{{ t('check_in_description') }}</p>
            <KaiList class="kai-list--flat">
              <KaiListItem :primary="t('check_in_check_in')" @select="doCheckIn" />
            </KaiList>
            <p v-if="checkInErrorKey" class="kai-text kai-text--error">{{ t(checkInErrorKey) }}</p>
          </template>

          <!-- Checked in: the rank, then the poem and the glanceable fortunes. -->
          <template v-else>
            <p class="kai-text kai-cal__level">{{ levelName }}</p>
            <p class="kai-text kai-text--secondary">
              {{ t('check_in_checked_in', { date: dateLabel }) }}
            </p>

            <template v-if="checkInResult.fortuneReport">
              <!-- The poem is the signature moment. -->
              <p v-if="checkInResult.fortuneReport.poem" class="kai-text">
                {{ checkInResult.fortuneReport.poem }}
              </p>
              <p v-if="checkInResult.fortuneReport.summary" class="kai-text kai-text--secondary">
                {{ checkInResult.fortuneReport.summary }}
              </p>

              <template v-if="fortuneItems.length">
                <p class="kai-separator">{{ t('check_in_fortunes') }}</p>
                <KaiList class="kai-list--flat">
                  <KaiListItem
                    v-for="item in fortuneItems"
                    :key="item.label"
                    :primary="item.label"
                    :secondary="item.value"
                  />
                </KaiList>
              </template>
            </template>
            <!-- The AI hasn't finished the report yet: a quiet note rather than
                 a fabricated poem, the same fallback the other clients show. -->
            <p v-else class="kai-text kai-text--secondary">{{ t('check_in_report_pending') }}</p>

            <!-- The daily fortune saying, advisory. -->
            <p v-if="fortune && fortune.content" class="kai-text kai-text--secondary">
              {{ fortune.content }}
            </p>

            <template v-if="checkInResult.tips.length">
              <p class="kai-separator">{{ t('check_in_tips') }}</p>
              <div v-for="tip in checkInResult.tips" :key="tip.title">
                <p class="kai-text">{{ tip.title }}</p>
                <p v-if="tip.content" class="kai-text kai-text--secondary">{{ tip.content }}</p>
              </div>
            </template>
          </template>
        </template>

        <p v-if="status === 'error'" class="kai-text kai-text--error">
          {{ t('error_load_failed') }}
        </p>

        <!-- The selected day's agenda. A row is the event's title and when it
             runs; the centre key adds what the description says, since a
             handset has no room for it in the row. -->
        <KaiList class="kai-list--flat">
          <KaiListItem
            v-for="event in dayEvents"
            :key="event.id"
            :primary="event.title"
            @select="toggleDetails(event.id)"
          >
            <template #secondary>
              <span class="kai-cal__when">{{ when(event) }}</span>
              <span v-if="event.description && expanded === event.id" class="kai-cal__desc">
                {{ event.description }}
              </span>
            </template>
          </KaiListItem>

          <KaiListItem v-if="status === 'error'" :primary="t('error_retry')" @select="load" />
        </KaiList>

        <!-- Notable days carry a name and nothing else, so they are not
             controls: plain rows, never focus targets. -->
        <KaiList v-if="dayNotable.length" class="kai-cal__notable-list">
          <li v-for="day in dayNotable" :key="day.name" class="kai-cal__notable">
            <span class="kai-cal__mark kai-cal__mark--notable"></span>{{ day.name }}
          </li>
        </KaiList>

        <p
          v-if="status === 'ready' && !dayEvents.length && !dayNotable.length && !showCheckIn"
          class="kai-text kai-text--secondary"
        >
          {{ t('calendar_no_events') }}
        </p>
      </template>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ChevronLeft, ChevronRight } from '@lucide/vue';

import KaiHeader from '~/src/components/KaiHeader.vue';
import KaiList from '~/src/components/KaiList.vue';
import KaiListItem from '~/src/components/KaiListItem.vue';
import KaiSpinner from '~/src/components/KaiSpinner.vue';
import { checkIn, fetchCheckInResult, fetchDailyFortune, listCalendarMonth } from '~/src/api/solian.js';
import {
  dayKey,
  formatClockRange,
  monthKeys,
  monthStart,
  todayKey,
  weekdayIndex,
  type CalendarDay,
  type CalendarEvent,
  type CheckInResult,
  type FortuneSaying,
} from '~/src/api/models.js';
import { KEY } from '~/src/kaios/keys.js';
import { t } from '~/src/kaios/l10n.js';
import { move, nav, registerSelectable, setBaseSoftkeys, unregisterSelectable } from '~/src/kaios/nav.js';
import { useAccountStore } from '~/src/stores/account.js';

// Every screen is mounted with its stack entry's parameters; the calendar takes
// an optional `date` to open on (the dashboard's own tap target).
const props = withDefaults(defineProps<{ params?: Record<string, string> }>(), {
  params: () => ({}),
});

/** Monday first, the order `monthKeys` builds a week in. */
const WEEKDAYS = [
  'calendar_dow_mon',
  'calendar_dow_tue',
  'calendar_dow_wed',
  'calendar_dow_thu',
  'calendar_dow_fri',
  'calendar_dow_sat',
  'calendar_dow_sun',
];

const COLUMNS = 7;
/** Six weeks: every month fits, and the grid keeps one height as it pages. */
const ROWS = 6;

interface CalendarCell {
  key: string;
  num: number;
  inMonth: boolean;
  hasEvent: boolean;
  hasNotable: boolean;
}

const today = todayKey();

/**
 * The highlighted day, and the anchor for everything else: the grid is the
 * month it falls in, the agenda is what falls on it.
 */
const cursor = ref(dayKey(props.params.date) || today);
/** The month the payload on screen belongs to, so a late answer for a month
 *  the cursor has left cannot overwrite the one in front of the user. */
const loaded = ref(cursor.value.slice(0, 7));
const days = ref<CalendarDay[]>([]);
const status = ref<'loading' | 'ready' | 'error'>('loading');
/** The event whose description is open, by id; '' when none is. */
const expanded = ref('');

const accountStore = useAccountStore();

/** Today's check-in; null while unloaded or not yet checked in. */
const checkInResult = ref<CheckInResult | null>(null);
/** Today's fortune saying; advisory, so its absence never fails the section. */
const fortune = ref<FortuneSaying | null>(null);
const checkInLoading = ref(false);
const checkingIn = ref(false);
/** Whether today's state has been read at least once; false after a failure,
 *  so the retry row can try again. */
const checkInLoaded = ref(false);
/** l10n key for the last check-in failure; '' while healthy. */
const checkInErrorKey = ref('');

/** The check-in is the cursor day's ritual when that day is today — and it
 *  needs a session, so a signed-out calendar stays just a calendar. */
const showCheckIn = computed(() => accountStore.phase === 'signed-in' && cursor.value === today);

/** The day's rank, localised; an unknown level falls back to the key itself. */
const levelName = computed(() => t('check_in_level_' + (checkInResult.value?.level ?? 0)));

/** "M/D" of the check-in — locale-free, like the rest of this app's dates. */
const dateLabel = computed(() => {
  const at = checkInResult.value?.createdAt ?? 0;
  if (!at) return '';
  const d = new Date(at);
  return String(d.getMonth() + 1) + '/' + String(d.getDate());
});

/**
 * The four glanceable fortunes, empty values dropped — the same reduction the
 * watch card makes from the 16-field report.
 */
const fortuneItems = computed(() => {
  const report = checkInResult.value?.fortuneReport;
  if (!report) return [];
  const rows: Array<{ label: string; value: string }> = [
    { label: t('fortune_love'), value: report.love },
    { label: t('fortune_study'), value: report.study },
    { label: t('fortune_work'), value: report.career },
    { label: t('fortune_health'), value: report.health },
  ];
  return rows.filter((row) => row.value.length > 0);
});

/** Whether something selectable sits right under the grid: the check-in action
 *  when today still has one, else the day's first event row. Only while the
 *  day region is on screen — a late month load must not move the highlight. */
const hasGridNext = computed(
  () =>
    status.value !== 'loading' &&
    (dayEvents.value.length > 0 || (showCheckIn.value && !checkInLoading.value && !checkInResult.value)),
);

const grid = ref<HTMLElement | null>(null);
const uid = ref(0);
const isSelected = computed(() => uid.value !== 0 && nav.current === uid.value);

const month = computed(() => cursor.value.slice(0, 7));

/** The day heading: the cursor's own weekday, then the date. */
const cursorWeekday = computed(() => t(WEEKDAYS[weekdayIndex(cursor.value)]));

/** The answer's rows by day, so the grid does forty-two lookups, not scans. */
const byDate = computed(() => {
  const index: Record<string, CalendarDay> = {};
  for (let at = 0; at < days.value.length; at += 1) {
    index[days.value[at].date] = days.value[at];
  }
  return index;
});

const weeks = computed(() => {
  const keys = monthKeys(cursor.value);
  const inMonth = cursor.value.slice(0, 7);
  const rows: CalendarCell[][] = [];

  for (let row = 0; row < ROWS; row += 1) {
    const week: CalendarCell[] = [];
    for (let column = 0; column < COLUMNS; column += 1) {
      const key = keys[row * COLUMNS + column];
      const day = byDate.value[key];
      week.push({
        key,
        num: Number(key.slice(8, 10)),
        inMonth: key.slice(0, 7) === inMonth,
        hasEvent: Boolean(day && day.events.length),
        hasNotable: Boolean(day && day.notableDays.length),
      });
    }
    rows.push(week);
  }
  return rows;
});

const selectedDay = computed(() => byDate.value[cursor.value] || null);
const dayEvents = computed(() => (selectedDay.value ? selectedDay.value.events : []));
const dayNotable = computed(() => (selectedDay.value ? selectedDay.value.notableDays : []));

/** An event's line under its title: the span it runs. */
function when(event: CalendarEvent): string {
  if (event.isAllDay) return t('calendar_all_day');
  return formatClockRange(event.startTime, event.endTime);
}

/**
 * Loads the month the cursor is in. A day with nothing on it has no row in the
 * answer at all, so the grid keeps drawing its own cells and the agenda simply
 * finds nothing.
 */
async function load(): Promise<void> {
  const target = cursor.value.slice(0, 7);
  loaded.value = target;
  status.value = 'loading';

  try {
    const answer = await listCalendarMonth(Number(target.slice(0, 4)), Number(target.slice(5, 7)));
    if (loaded.value !== target) return;
    days.value = answer;
    status.value = 'ready';
  } catch (error) {
    if (loaded.value !== target) return;
    status.value = 'error';
  }
}

/** Moves the cursor. Crossing into a neighbouring month loads it. */
function setCursor(key: string): void {
  if (cursor.value === key) return;
  cursor.value = key;
  expanded.value = '';
  if (key.slice(0, 7) !== loaded.value) void load();
}

/** The month bar's two arrows: the cursor follows the flip to the 1st. */
function shiftMonth(delta: number): void {
  cursor.value = monthStart(cursor.value, delta);
  expanded.value = '';
  void load();
}

function toggleDetails(id: string): void {
  expanded.value = expanded.value === id ? '' : id;
}

/**
 * Loads today's check-in state, then the advisory fortune saying. Only fetched
 * when the section is actually on screen: a signed-out calendar or a cursor on
 * another day should not spend a request on it.
 */
async function loadCheckIn(): Promise<void> {
  if (!showCheckIn.value || checkInLoading.value || checkInLoaded.value) return;
  checkInLoading.value = true;
  checkInErrorKey.value = '';
  try {
    checkInResult.value = await fetchCheckInResult();
    checkInLoaded.value = true;
  } catch (error) {
    checkInErrorKey.value = 'error_load_failed';
  } finally {
    checkInLoading.value = false;
  }
  fortune.value = await fetchDailyFortune();
}

/** Performs today's check-in and shows the fresh result. */
async function doCheckIn(): Promise<void> {
  if (checkingIn.value) return;
  checkingIn.value = true;
  checkInErrorKey.value = '';
  try {
    const fresh = await checkIn();
    if (fresh) {
      checkInResult.value = fresh;
      checkInLoaded.value = true;
      // A check-in may surface today's saying; refresh it best-effort.
      fortune.value = await fetchDailyFortune();
    } else {
      checkInErrorKey.value = 'check_in_error';
    }
  } catch (error) {
    checkInErrorKey.value = 'check_in_error';
  } finally {
    checkingIn.value = false;
  }
}

// The section appears when the cursor reaches today; that is when its state is
// read. `immediate` covers the plain open that lands on today by default.
watch(
  showCheckIn,
  (visible) => {
    if (visible) void loadCheckIn();
  },
  { immediate: true },
);

/**
 * The D-pad belongs to the grid while the grid is on screen. Registered in the
 * capture phase so it runs before the app-wide handler (the same arrangement
 * the lightbox and the reaction picker use), and only while the grid is the
 * highlight: on the agenda the arrows must keep walking the rows.
 *
 * The cursor moves a day or a week at a time, and it never leaves the month it
 * started in on the D-pad: the grid's outside days are reached by clicking,
 * and the month bar's arrows are the only keys that change the month. At the
 * grid's own edges the press is released instead — UP from the first row walks
 * the highlight to the month bar, DOWN from the last row into the day's
 * content below (the agenda), so the day's detail is always reachable from
 * the grid. LEFT/RIGHT at a week's edge clamp: a Sunday must not wrap onto a
 * Monday.
 */
function onKeydown(event: KeyboardEvent): void {
  if (!isSelected.value) return;

  const keys = monthKeys(cursor.value);
  const index = keys.indexOf(cursor.value);
  const row = Math.floor(index / COLUMNS);
  const column = index % COLUMNS;
  const month = cursor.value.slice(0, 7);

  let next = -1;
  if (event.key === KEY.LEFT && column > 0) next = index - 1;
  else if (event.key === KEY.RIGHT && column < COLUMNS - 1) next = index + 1;
  else if (event.key === KEY.UP && row > 0) next = index - COLUMNS;
  else if (event.key === KEY.DOWN && row < ROWS - 1) next = index + COLUMNS;

  // A move that stays inside the month is the grid's: the cursor takes it.
  if (next >= 0 && keys[next].slice(0, 7) === month) {
    event.preventDefault();
    event.stopPropagation();
    setCursor(keys[next]);
    return;
  }

  // Anything else is the grid's edge, and the cursor does not leave the month
  // on the D-pad — the month bar's arrows own that. A press into the
  // neighbouring month's row is released instead: UP from the first row walks
  // the highlight to the month bar above, DOWN from the last row into the
  // day's content below (the agenda) — so the day's detail stays reachable
  // from the grid. LEFT/RIGHT at a week's edge clamp: a Sunday must not wrap
  // onto a Monday, and the press must not spill into the month bar. Keys that
  // are not grid directions (Enter, the softkeys, the phone pad) fall through
  // to the app-wide handler.
  if (event.key === KEY.LEFT || event.key === KEY.RIGHT) {
    event.preventDefault();
    event.stopPropagation();
  }
}

onMounted(() => {
  uid.value = registerSelectable({
    el: grid,
    // The centre key walks into the day's first action: today's check-in row
    // when one is waiting, else the agenda. A day with neither keeps the press
    // on the grid.
    onEnter: () => {
      if (hasGridNext.value) move(1);
    },
    initial: true,
  });
  document.addEventListener('keydown', onKeydown, true);
  void load();

  setBaseSoftkeys(() => {
    // The hardware Back key goes up a level (the design guide's Back/Clear
    // rule); Today is the one action a calendar wants on a key of its own.
    // The right key offers today's check-in while one is still due — the same
    // press as the section's row — and goes inert once it is done, so a day
    // that is checked in (or another day, or signed out) keeps the blank key.
    const checkInDue = showCheckIn.value && !checkInLoading.value && !checkInResult.value;
    return {
      left: { label: t('calendar_today'), onPress: () => setCursor(today) },
      center: { label: t('action_open') },
      right: checkInDue ? { label: t('check_in_check_in'), onPress: doCheckIn } : { label: '' },
    };
  });
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true);
  unregisterSelectable(uid.value);
});
</script>
