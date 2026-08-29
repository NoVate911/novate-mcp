/**
 * Клиентская логика панели «NoVate MCP».
 * Компилируется в public/client.js при сборке образа: bun build --minify.
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

// Все уведомления показываются тостами и удаляются после анимации.
document.querySelectorAll<HTMLElement>("[data-toast]").forEach((el) => {
  let timer = 0;
  const close = (): void => {
    window.clearTimeout(timer);
    if (el.classList.contains("toast-leave")) return;
    el.classList.add("toast-leave");
    window.setTimeout(() => el.closest(".toast-stack")?.remove(), 240);
  };
  timer = window.setTimeout(close, 5000);
  el.querySelector<HTMLButtonElement>(".toast-close")?.addEventListener("click", close);
  el.addEventListener("mouseenter", () => window.clearTimeout(timer));
  el.addEventListener("mouseleave", () => { timer = window.setTimeout(close, 1800); });
});
