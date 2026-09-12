import { computed, ref } from 'vue';

import { writeStackHash } from '~/src/kaios/hash.js';

/**
 * Screen stack. Deliberately not vue-router: KaiOS has no address bar, the Back
 * key is the only "history", and a full router would cost more bundle than the
 * whole app. In the desktop browser the stack is also reflected in the URL —
 * `hash.ts` turns it into `#/view` segments for testing, no-op on a handset.
 *
 * Entries carry their parameters so a screen can be built from them: pushing
 * `{ name: 'post', params: { id } }` twice keeps two entries of the same view,
 * and Back returns to the one underneath.
 */
export interface ViewEntry {
  name: string;
  params: Record<string, string>;
}

export const stack = ref<ViewEntry[]>([{ name: 'dashboard', params: {} }]);

export const currentView = computed(() => stack.value[stack.value.length - 1]);

export const canGoBack = computed(() => stack.value.length > 1);

export function push(name: string, params: Record<string, string> = {}): void {
  stack.value.push({ name, params });
  writeStackHash(stack.value);
}

export function pop(): void {
  if (canGoBack.value) {
    stack.value.pop();
    writeStackHash(stack.value);
  }
}
