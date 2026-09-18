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

/**
 * The direction the top view last moved, for the view-swap animation in
 * App.vue: a push slides the new screen in from the right, a pop returns it
 * the other way. Set synchronously with the stack change so the swap renders
 * with the right transition. External stack swaps (a bookmarked hash, a manual
 * edit) keep the previous direction — a cosmetic non-issue, dev-only.
 */
export const viewDirection = ref<'push' | 'pop'>('push');

export function push(name: string, params: Record<string, string> = {}): void {
  stack.value.push({ name, params });
  viewDirection.value = 'push';
  writeStackHash(stack.value);
}

export function pop(): void {
  if (canGoBack.value) {
    stack.value.pop();
    viewDirection.value = 'pop';
    writeStackHash(stack.value);
  }
}

/**
 * Pops back to a screen several entries down, which `pop` repeated cannot do
 * honestly: a detour that pushes more than one entry (the sticker picker, a
 * pack inside it) would need its depth known to the caller. A name that is not
 * on the stack leaves it alone, so a caller cannot pop past the screen it
 * asked for and land somewhere unrelated.
 */
export function popTo(name: string): void {
  for (let index = stack.value.length - 1; index >= 0; index -= 1) {
    if (stack.value[index].name !== name) continue;
    if (index === stack.value.length - 1) return;
    stack.value = stack.value.slice(0, index + 1);
    viewDirection.value = 'pop';
    writeStackHash(stack.value);
    return;
  }
}
