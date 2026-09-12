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
          v-if="status === 'ready' && !dayEvents.length && !dayNotable.length"
          class="kai-text kai-text--secondary"
        >
          {{ t('calendar_no_events') }}
        </p>
      </template>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ChevronLeft, ChevronRight } from '@lucide/vue';

import KaiHeader from '~/src/components/KaiHeader.vue';
import KaiList from '~/src/components/KaiList.vue';
import KaiListItem from '~/src/components/KaiListItem.vue';
import KaiSpinner from '~/src/components/KaiSpinner.vue';
import { listCalendarMonth } from '~/src/api/solian.js';
import {
  dayKey,
  formatClockRange,
  monthKeys,
  monthStart,
  todayKey,
  weekdayIndex,
  type CalendarDay,
  type CalendarEvent,
} from '~/src/api/models.js';
import { KEY } from '~/src/kaios/keys.js';
import { t } from '~/src/kaios/l10n.js';
import { move, nav, registerSelectable, setBaseSoftkeys, unregisterSelectable } from '~/src/kaios/nav.js';

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
 * The D-pad belongs to the grid while the grid is on screen. Registered in the
 * capture phase so it runs before the app-wide handler (the same arrangement
 * the lightbox and the reaction picker use), and only while the grid is the
 * highlight: on the agenda the arrows must keep walking the rows.
 *
 * Inside the grid the cursor clamps at the week's edges — a Sunday must not
 * wrap onto a Monday — and at the first and last rows the press is left to the
 * app-wide handler, which is how the month bar above and the agenda below are
 * reached the ordinary way.
 */
function onKeydown(event: KeyboardEvent): void {
  if (!isSelected.value) return;

  const keys = monthKeys(cursor.value);
  const index = keys.indexOf(cursor.value);
  const row = Math.floor(index / COLUMNS);
  const column = index % COLUMNS;

  let next = index;
  if (event.key === KEY.LEFT && column > 0) next = index - 1;
  else if (event.key === KEY.RIGHT && column < COLUMNS - 1) next = index + 1;
  else if (event.key === KEY.UP && row > 0) next = index - COLUMNS;
  else if (event.key === KEY.DOWN && row < ROWS - 1) next = index + COLUMNS;
  else return;

  event.preventDefault();
  event.stopPropagation();
  setCursor(keys[next]);
}

onMounted(() => {
  uid.value = registerSelectable({
    el: grid,
    // The centre key walks into the day's agenda; a day with nothing on it has
    // no agenda to move into, so the press stays on the grid.
    onEnter: () => {
      if (dayEvents.value.length) move(1);
    },
    initial: true,
  });
  document.addEventListener('keydown', onKeydown, true);
  void load();

  setBaseSoftkeys(() => ({
    // The hardware Back key goes up a level (the design guide's Back/Clear
    // rule); Today is the one action a calendar wants on a key of its own.
    left: { label: t('calendar_today'), onPress: () => setCursor(today) },
    center: { label: t('action_open') },
    right: { label: '' },
  }));
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true);
  unregisterSelectable(uid.value);
});
</script>
