import { computed, ref } from 'vue';

/**
 * Screen stack. Deliberately not vue-router: KaiOS has no address bar, the Back
 * key is the only "history", and a full router would cost more bundle than the
 * whole app.
 */
export const stack = ref(['home']);

export const currentView = computed(() => stack.value[stack.value.length - 1]);

export const canGoBack = computed(() => stack.value.length > 1);

export function push(view) {
  stack.value.push(view);
}

export function pop() {
  if (canGoBack.value) stack.value.pop();
}
