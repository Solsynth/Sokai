<template>
  <li
    ref="root"
    tabindex="-1"
    nav-selectable="true"
    :nav-selected="isSelected ? 'true' : 'false'"
    class="kai-list-item kai-compose-attachment"
    @click="emit('remove')"
  >
    <img
      v-if="attachment.preview"
      class="kai-compose-attachment__thumb"
      :src="attachment.preview"
      alt=""
    />
    <span class="kai-compose-attachment__text">
      <span class="kai-list-item__primary">
        <span class="kai-post__attach-kind">[{{ t(attachmentKindKey(attachment.kind)) }}]</span>
        {{ attachment.name }}
      </span>
      <span class="kai-list-item__secondary">
        <!-- A recorded take leads with its length: that is what a voice note
             is, and it is the only metadata the sender chose. -->
        <span v-if="attachment.durationMs">{{ formatClock(attachment.durationMs) }} · </span>
        {{ formatBytes(attachment.size) }} · {{ t('compose_tap_to_remove') }}
      </span>
    </span>
  </li>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { attachmentKindKey, formatBytes, formatClock, type AttachmentKind } from '~/src/api/models.js';
import { nav, registerSelectable, unregisterSelectable } from '~/src/kaios/nav.js';
import { t } from '~/src/kaios/l10n.js';

const props = defineProps<{
  /** The picked (possibly not yet uploaded) file. */
  attachment: {
    id: string;
    name: string;
    size: number;
    kind: AttachmentKind;
    preview: string;
    /** A recorded take's length; 0 or absent for every other pick. */
    durationMs?: number;
  };
}>();

const emit = defineEmits<{ remove: [] }>();

const root = ref<HTMLElement | null>(null);
const uid = ref(0);

const isSelected = computed(() => uid.value !== 0 && nav.current === uid.value);

onMounted(() => {
  uid.value = registerSelectable({
    el: root,
    // The whole row is the remove button, as the hint under the name says.
    onEnter: () => emit('remove'),
  });
});

onBeforeUnmount(() => {
  unregisterSelectable(uid.value);
});
</script>
