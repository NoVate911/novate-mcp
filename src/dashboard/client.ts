/**
 * Клиентская логика панели «NoVate MCP».
 * Компилируется в public/client.js при сборке образа: bun build --minify.
 * Сознательно крошечная: вся анимация — в CSS, здесь только то,
 * что CSS не умеет.
 */

// Плавный счётчик для числовых статистик (ease-out cubic)
document.querySelectorAll<HTMLElement>("[data-count]").forEach((el) => {
  const target = Number(el.dataset.count || "0");
  if (!Number.isFinite(target) || target <= 0) return;
  const duration = 700;
  const start = performance.now();
  const tick = (now: number): void => {
    const k = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = String(Math.round(target * eased));
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

// Уведомления сами плавно исчезают через 2.6 секунды
const flash = document.querySelector<HTMLElement>(".note.ok");
if (flash) {
  flash.style.transition = "opacity .5s ease";
  setTimeout(() => { flash.style.opacity = "0"; }, 2600);
  setTimeout(() => { flash.remove(); }, 3200);
}
