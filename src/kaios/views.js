import { computed, ref } from 'vue';

/**
 * Screen stack. Deliberately not vue-router: KaiOS has no address bar, the Back
 * key is the only "history", and a full router would cost more bundle than the
 * whole app.
 *
 * Entries carry their parameters so a screen can be built from them: pushing
 * `{ name: 'post', params: { id } }` twice keeps two entries of the same view,
 * and Back returns to the one underneath.
 */
export const stack = ref([{ name: 'explore', params: {} }]);

export const currentView = computed(() => stack.value[stack.value.length - 1]);

export const canGoBack = computed(() => stack.value.length > 1);

export function push(name, params = {}) {
  stack.value.push({ name, params });
}

export function pop() {
  if (canGoBack.value) stack.value.pop();
}
