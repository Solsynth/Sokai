<template>
  <!-- No title bar: the lightbox is full-bleed, and the counter over the media
       says which attachment of the set is showing. -->
  <div class="kai-view">
    <!-- The media area is the view: LEFT/RIGHT move through the post's
         attachments (wrapping), UP/DOWN zoom an image, the centre key plays a
         video, and a zoomed image pans under LEFT/RIGHT and the 2/4/6/8 pad.
         Nothing else is drawn — no title bar, no key hint: the media takes the
         whole screen, and a set of more than one carries its count over it. -->
    <main ref="stage" class="kai-content kai-lightbox">
      <div
        tabindex="-1"
        nav-selectable="true"
        :nav-selected="isSelected ? 'true' : 'false'"
        class="kai-lightbox__stage"
      >
        <!-- An image shows the original bytes — the lightbox is the place for
             full resolution, and the D-pad zooms into it. -->
        <img
          v-if="current && current.kind === 'image'"
          ref="image"
          class="kai-lightbox__media"
          :class="{ 'kai-lightbox__media--zoomed': zoom > 1 }"
          :src="current ? originalUrl(current.id) : ''"
          :style="imageStyle"
          :alt="current ? describeAttachment(current) : ''"
          @load="layout"
        />

        <!-- A video plays in place: the original file for playback, the
             server's thumbnail as the poster until the first play. While
             paused the play badge sits on it; a progress bar tracks playback
             under it. The centre key (or a tap) toggles play. -->
        <span v-else-if="current && current.kind === 'video'" class="kai-lightbox__stage-box">
          <video
            ref="player"
            class="kai-lightbox__media"
            :src="mediaSrc(current)"
            :poster="current.src ? '' : thumbnailUrl(current.id)"
            @timeupdate="syncProgress"
            @loadedmetadata="syncProgress"
            @pause="playing = false"
            @ended="playing = false"
            @click="togglePlay"
          />
          <KaiPlayIcon v-if="!playing" class="kai-lightbox__play" size="lg" />
          <span class="kai-lightbox__progress">
            <span class="kai-lightbox__progress-fill" :style="{ width: progress + '%' }"></span>
          </span>
        </span>

        <!-- A voice note, or any audio attachment: the same player as a video
             over the attachment's own line, which is all an audio row has to
             show. Enter/centre (or a tap) plays and pauses it. -->
        <span v-else-if="current && current.kind === 'audio'" class="kai-lightbox__stage-box">
          <audio
            ref="player"
            class="kai-lightbox__audio"
            :src="mediaSrc(current)"
            @timeupdate="syncProgress"
            @loadedmetadata="syncProgress"
            @pause="playing = false"
            @ended="playing = false"
          ></audio>
          <p class="kai-lightbox__line">
            <span class="kai-post__attach-kind">[{{ t(attachmentKindKey(current.kind)) }}]</span>
            {{ describeAttachment(current) }}
          </p>
          <KaiPlayIcon v-if="!playing" class="kai-lightbox__play" size="lg" />
          <span class="kai-lightbox__progress">
            <span class="kai-lightbox__progress-fill" :style="{ width: progress + '%' }"></span>
          </span>
        </span>

        <!-- A document has no media to be; its line is the lightbox. -->
        <p v-else-if="current" class="kai-lightbox__line">
          <span class="kai-post__attach-kind">[{{ t(attachmentKindKey(current.kind)) }}]</span>
          {{ describeAttachment(current) }}
        </p>

        <!-- Where you are in the set, over the media rather than under it: the
             picture is the screen, and its counter is a fact about the picture.
             A lone attachment is not a set, so it carries no count. -->
        <p v-if="attachments.length > 1" class="kai-lightbox__counter">
          {{ t('lightbox_counter', { current: index + 1, total: attachments.length }) }}
        </p>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';

import { attachmentKindKey, describeAttachment, type Attachment } from '~/src/api/models.js';
import { originalUrl, thumbnailUrl } from '~/src/api/solian.js';
import KaiPlayIcon from '~/src/components/KaiPlayIcon.vue';
import { KEY } from '~/src/kaios/keys.js';
import { t } from '~/src/kaios/l10n.js';
import { nav, registerSelectable, setBaseSoftkeys, unregisterSelectable } from '~/src/kaios/nav.js';

/**
 * The post's attachments travel in the view params as JSON — the post is
 * already in memory when the lightbox opens, so there is no second fetch, and
 * the dev-browser URL keeps the lightbox restorable.
 */
const props = withDefaults(defineProps<{ params?: Record<string, string> }>(), {
  params: () => ({}),
});

const stage = ref<HTMLElement | null>(null);
const image = ref<HTMLImageElement | null>(null);
/**
 * The playing element — a `<video>` or an `<audio>`, whichever the current
 * attachment is. Only one of the two is ever rendered, so they share the ref
 * and, with it, one play/pause/progress path.
 */
const player = ref<HTMLMediaElement | null>(null);
const uid = ref(0);

const attachments = ref<Attachment[]>([]);
const index = ref(0);

/** Image zoom: 1 fits the screen, 2 and 4 step in. */
const zoom = ref(1);
/** Clockwise quarter-turns (0/90/180/270), driven by 1 and 3. */
const rotation = ref(0);
/** The pan offset of a zoomed image, in device px. */
const pan = reactive({ x: 0, y: 0 });
/** The rendered image box while zoomed; 0 until the bytes arrive. */
const view = reactive({ w: 0, h: 0 });

const playing = ref(false);
/** Playback position as a percentage of the duration, for the progress bar. */
const progress = ref(0);

const current = computed(() => attachments.value[index.value] ?? null);

/**
 * The bytes to play or show. An attachment that carries its own URL (a voice
 * note) is loaded from it; everything else is addressed by drive file id, and
 * the lightbox is the one place that wants the original rather than a preset.
 */
function mediaSrc(attachment: Attachment): string {
  return attachment.src || originalUrl(attachment.id);
}
const isSelected = computed(() => uid.value !== 0 && nav.current === uid.value);

/** How far one D-pad press pans a zoomed image — one design-guide row. */
const PAN_STEP_PX = 40;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * The image's rendered box at the current zoom and the room to pan it. `null`
 * while the image has not loaded (or is not an image).
 */
function bounds(): { w: number; h: number; maxX: number; maxY: number } | null {
  const img = image.value;
  const area = stage.value;
  if (!img || !area || !img.naturalWidth) return null;

  const areaW = area.clientWidth;
  const areaH = area.clientHeight;
  const fit = Math.min(areaW / img.naturalWidth, areaH / img.naturalHeight);
  const w = img.naturalWidth * fit * zoom.value;
  const h = img.naturalHeight * fit * zoom.value;
  // A quarter-turn swaps the rendered box's axes, so the room to pan follows.
  const turned = rotation.value % 180 !== 0;
  const shownW = turned ? h : w;
  const shownH = turned ? w : h;
  return {
    w: shownW,
    h: shownH,
    maxX: Math.max(0, (shownW - areaW) / 2),
    maxY: Math.max(0, (shownH - areaH) / 2),
  };
}

/** Re-measures the stage and clamps the pan to the zoomed image's extent. */
function layout(): void {
  const b = bounds();
  view.w = b ? b.w : 0;
  view.h = b ? b.h : 0;
  if (!b) return;
  pan.x = clamp(pan.x, -b.maxX, b.maxX);
  pan.y = clamp(pan.y, -b.maxY, b.maxY);
}

const imageStyle = computed(() => {
  const transform = 'translate(' + pan.x + 'px,' + pan.y + 'px) rotate(' + rotation.value + 'deg)';
  if (zoom.value === 1 || !view.w) {
    // Fit: only the turn applies; the media stays contained by CSS.
    return rotation.value ? { transform } : null;
  }
  return {
    width: view.w + 'px',
    height: view.h + 'px',
    transform,
  };
});

/** Stops any playback and returns the view to fit; called on every switch. */
function resetView(): void {
  if (player.value && typeof player.value.pause === 'function') player.value.pause();
  playing.value = false;
  progress.value = 0;
  zoom.value = 1;
  rotation.value = 0;
  pan.x = 0;
  pan.y = 0;
  view.w = 0;
  view.h = 0;
  void nextTick(layout);
}

/** Turns the picture by a quarter-turn; 1 goes counterclockwise, 3 clockwise. */
function rotate(delta: number): void {
  rotation.value += delta;
  pan.x = 0;
  pan.y = 0;
  layout();
}

/** Reads the player's position into the progress bar. */
function syncProgress(): void {
  const el = player.value;
  if (!el) return;
  const duration = el.duration;
  if (!duration || !isFinite(duration) || duration <= 0) {
    progress.value = 0;
    return;
  }
  progress.value = Math.min(100, (el.currentTime / duration) * 100);
}

/** UP steps in, DOWN steps out: 1 fits, 2 and 4 zoom in. */
function zoomIn(): void {
  if (zoom.value < 4) {
    zoom.value = zoom.value === 1 ? 2 : 4;
    layout();
  }
}

function zoomOut(): void {
  if (zoom.value > 1) {
    zoom.value = zoom.value === 4 ? 2 : 1;
    if (zoom.value === 1) {
      pan.x = 0;
      pan.y = 0;
    }
    layout();
  }
}

/** The centre action: play or pause the media. Images have the D-pad. */
function toggle(): void {
  const item = current.value;
  if (!item || (item.kind !== 'video' && item.kind !== 'audio')) return;
  togglePlay();
}

function togglePlay(): void {
  const el = player.value;
  if (playing.value) {
    if (el && typeof el.pause === 'function') el.pause();
    playing.value = false;
  } else {
    playing.value = true;
    // The promise rejects on hosts with no media pipeline (jsdom); playback
    // state is tracked by us, and a rejection is not an error the user sees.
    if (el && typeof el.play === 'function') {
      try {
        const result = el.play();
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch (error) {
        // No media pipeline at all (a stub element): stay on our state.
      }
    }
  }
}

function switchAttachment(delta: number): void {
  if (!attachments.value.length) return;
  index.value = (index.value + delta + attachments.value.length) % attachments.value.length;
  resetView();
}

/** Pans the zoomed image by `dx`/`dy`, clamped to its overflow. */
function panBy(dx: number, dy: number): void {
  const b = bounds();
  if (!b) return;
  pan.x = clamp(pan.x + dx, -b.maxX, b.maxX);
  pan.y = clamp(pan.y + dy, -b.maxY, b.maxY);
}

/**
 * The phone pad moves inside a zoomed picture. 4/6 nudge the picture left and
 * right; 2/8 move the view up and down through it (so the picture itself
 * shifts the other way, the way a page scrolls).
 */
const NUM_PAD: Record<string, { dx: number; dy: number }> = {
  [KEY.PAD_UP]: { dx: 0, dy: PAN_STEP_PX },
  [KEY.PAD_LEFT]: { dx: -PAN_STEP_PX, dy: 0 },
  [KEY.PAD_RIGHT]: { dx: PAN_STEP_PX, dy: 0 },
  [KEY.PAD_DOWN]: { dx: 0, dy: -PAN_STEP_PX },
};

/**
 * The D-pad and phone pad belong to the lightbox. LEFT/RIGHT switch
 * attachments, UP/DOWN zoom an image, and a zoomed image pans — under
 * LEFT/RIGHT and under the 2/4/6/8 pad. 1 and 3 turn the picture. Registered
 * in the capture phase so it runs before the app-wide handler.
 */
function onKeydown(event: KeyboardEvent): void {
  const item = current.value;
  if (!item) return;

  if (item.kind === 'image') {
    if (event.key === KEY.ROTATE_CCW) {
      rotate(-90);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === KEY.ROTATE_CW) {
      rotate(90);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // The pad is a pan control only once the picture is zoomed; at fit it is
    // inert (LEFT/RIGHT are the switch keys).
    const step = NUM_PAD[event.key];
    if (step) {
      if (zoom.value > 1) panBy(step.dx, step.dy);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.key === KEY.UP) {
      zoomIn();
    } else if (event.key === KEY.DOWN) {
      zoomOut();
    } else if (event.key === KEY.LEFT || event.key === KEY.RIGHT) {
      if (zoom.value > 1) {
        // A zoomed picture pans under LEFT/RIGHT instead of switching; the
        // image is unzoomed before the set is moved through again.
        panBy(event.key === KEY.LEFT ? -PAN_STEP_PX : PAN_STEP_PX, 0);
      } else {
        switchAttachment(event.key === KEY.LEFT ? -1 : 1);
      }
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  if (event.key === KEY.LEFT || event.key === KEY.RIGHT) {
    switchAttachment(event.key === KEY.LEFT ? -1 : 1);
    event.preventDefault();
    event.stopPropagation();
  }
}

const centerLabel = computed(() => {
  const item = current.value;
  if (!item || (item.kind !== 'video' && item.kind !== 'audio')) return '';
  return playing.value ? t('lightbox_pause') : t('lightbox_play');
});

function parseParams(): void {
  let list: Attachment[] = [];
  const raw = props.params.attachments;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed as Attachment[];
    } catch (error) {
      list = [];
    }
  }
  attachments.value = list;

  const wanted = parseInt(props.params.index || '0', 10);
  index.value = Number.isNaN(wanted)
    ? 0
    : Math.max(0, Math.min(wanted, Math.max(0, list.length - 1)));
  resetView();
}

onMounted(() => {
  uid.value = registerSelectable({ el: stage, onEnter: toggle, initial: true });
  document.addEventListener('keydown', onKeydown, true);
  window.addEventListener('resize', layout);

  setBaseSoftkeys(() => ({
    // The hardware Back key closes the viewer (the design guide's Back/Clear
    // rule); no softkey duplicates it.
    center: { label: centerLabel.value },
    right: { label: '' },
  }));

  parseParams();
  void nextTick(layout);
});

onBeforeUnmount(() => {
  if (player.value && typeof player.value.pause === 'function') player.value.pause();
  document.removeEventListener('keydown', onKeydown, true);
  window.removeEventListener('resize', layout);
  unregisterSelectable(uid.value);
});
</script>
