<template>
  <div class="kai-view">
    <KaiHeader :title="pack ? pack.name : t('chat_stickers')" />

    <main class="kai-content">
      <KaiSpinner v-if="chat.stickerStatus === 'loading'" />

      <template v-else>
        <p v-if="chat.stickerStatus === 'error'" class="kai-text kai-text--error">
          {{ t('chat_stickers_failed') }}
        </p>

        <p v-else-if="!chat.stickerPacks.length" class="kai-text kai-text--secondary">
          {{ t('chat_stickers_empty') }}
        </p>

        <!-- Two levels, one screen: the packs, then the stickers in the chosen
             one. Enter sends the sticker as its own message and returns to the
             composer — the watch's quick-sticker behaviour, and the only shape
             that works on a D-pad. -->
        <KaiList v-else class="kai-list--flat">
          <KaiListItem
            v-for="row in rows"
            :key="row.id"
            :thumb="row.thumb"
            :thumb-label="row.label"
            :primary="row.label"
            :secondary="row.detail"
            @select="onSelect(row.id)"
          />
        </KaiList>
      </template>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import type { StickerPack } from '~/src/api/models.js';
import KaiHeader from '~/src/components/KaiHeader.vue';
import KaiList from '~/src/components/KaiList.vue';
import KaiListItem from '~/src/components/KaiListItem.vue';
import KaiSpinner from '~/src/components/KaiSpinner.vue';
import { t } from '~/src/kaios/l10n.js';
import { setBaseSoftkeys } from '~/src/kaios/nav.js';
import { popTo, push } from '~/src/kaios/views.js';
import { useChatStore } from '~/src/stores/chat.js';

/**
 * Picking a sticker to send. `params.pack` selects the level: without it the
 * screen lists the packs, with it the stickers inside one. Choosing a sticker
 * sends it as the whole message (`:prefix+slug:`) and closes the picker *and*
 * the composer under it, landing on the thread the message went to — the send
 * is the end of the detour, not a return to the field.
 *
 * Stickers resolve to their image's drive id, which the row shows through the
 * same thumb preset every other picture in the app uses — a sticker is a
 * 1080px PNG, and the picker shows a screenful at once.
 */

const props = withDefaults(defineProps<{ params?: Record<string, string> }>(), {
  params: () => ({}),
});

const chat = useChatStore();

/** The room the sticker is going to; `''` when the picker is opened cold. */
const roomId = computed(() => props.params.room || '');
const packId = computed(() => props.params.pack || '');

const pack = computed<StickerPack | null>(
  () => chat.stickerPacks.find((item) => item.id === packId.value) || null,
);

/** One row: a pack to open, or a sticker to send. */
interface Row {
  /** The pack id, or the sticker id — what `onSelect` acts on. */
  id: string;
  label: string;
  detail: string;
  thumb: string;
}

/**
 * The pack list, or the stickers of the chosen pack. A sticker's label is its
 * slug — the name is empty on most of them — and the slug is half of the
 * placeholder, so the row names what it sends.
 */
const rows = computed<Row[]>(() => {
  if (!pack.value) {
    return chat.stickerPacks.map((item) => ({
      id: item.id,
      label: item.name || item.prefix,
      detail: t('chat_sticker_count', { n: item.stickers.length }),
      thumb: item.icon || item.stickers[0].image || '',
    }));
  }
  return pack.value.stickers.map((sticker) => ({
    id: sticker.id,
    label: sticker.slug,
    detail: ':' + pack.value!.prefix + '+' + sticker.slug + ':',
    thumb: sticker.image || '',
  }));
});

const sending = ref(false);

/** Enter on a pack opens it; Enter on a sticker sends it and closes. */
async function onSelect(id: string): Promise<void> {
  if (!pack.value) {
    push('chat-stickers', { pack: id, room: roomId.value });
    return;
  }
  const sticker = pack.value.stickers.find((item) => item.id === id);
  if (!sticker || !roomId.value || sending.value) return;
  sending.value = true;
  const sent = await chat.sendSticker(roomId.value, pack.value, sticker);
  sending.value = false;
  // A failure keeps the picker up: the composer behind it shows the error line.
  // A send closes the whole detour — the picker and the composer under it —
  // and lands on the thread, where the sticker now is: a sticker is the whole
  // message, so there is nothing left to write in the composer it came from.
  if (sent) popTo('chat-room');
}

onMounted(() => {
  setBaseSoftkeys(() => ({
    center: { label: t('action_open') },
    right: { label: '' },
  }));
  void chat.loadStickerPacks();
});
</script>
