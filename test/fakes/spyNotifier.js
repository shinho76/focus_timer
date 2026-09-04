/**
 * Spy Notification-constructor-like fake for ports/notifier.js tests.
 * permission can be injected/mutated to simulate 'default' | 'granted' | 'denied',
 * and shown notifications are recorded for assertions.
 */
export function createSpyNotifier({ permission = 'default', throwOnConstruct = false } = {}) {
  const shown = [];

  function SpyNotification(title, opts) {
    if (SpyNotification.permission !== 'granted') {
      throw new Error('Notification permission not granted');
    }
    if (throwOnConstruct) {
      throw new TypeError('Illegal constructor');
    }
    shown.push({ title, opts });
    this.title = title;
    this.opts = opts;
    this.onclick = null;
  }

  SpyNotification.permission = permission;
  SpyNotification.requestPermission = async () => {
    return SpyNotification.permission;
  };
  SpyNotification._shown = shown;

  return SpyNotification;
}
