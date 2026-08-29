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
  const duration = Number(el.dataset.toastDuration || "5000");
  timer = window.setTimeout(close, Number.isFinite(duration) ? duration : 5000);
  el.querySelector<HTMLButtonElement>(".toast-close")?.addEventListener("click", close);
  el.addEventListener("mouseenter", () => window.clearTimeout(timer));
  el.addEventListener("mouseleave", () => { timer = window.setTimeout(close, 1800); });
});


// Одноразовое копирование только что сгенерированного секрета.
document.querySelectorAll<HTMLButtonElement>("[data-copy-secret]").forEach((button) => {
  button.addEventListener("click", async () => {
    const value = button.closest("[data-toast]")
      ?.querySelector<HTMLElement>("[data-generated-secret]")?.textContent || "";
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      button.textContent = "Скопировано";
    } catch {
      button.textContent = "Не удалось скопировать";
    }
  });
});

// Поиск, фильтрация и сортировка проектов/файлов без перезагрузки страницы.
document.querySelectorAll<HTMLElement>("[data-filter-root]").forEach((root) => {
  const controls = root.querySelector<HTMLElement>("[data-filter-controls]");
  const list = root.querySelector<HTMLElement>("[data-filter-list]");
  if (!controls || !list) return;

  const items = Array.from(list.querySelectorAll<HTMLElement>("[data-filter-item]"));
  const search = controls.querySelector<HTMLInputElement>("[data-filter-search]");
  const kind = controls.querySelector<HTMLSelectElement>("[data-filter-kind]");
  const period = controls.querySelector<HTMLSelectElement>("[data-filter-period]");
  const sort = controls.querySelector<HTMLSelectElement>("[data-filter-sort]");
  const order = controls.querySelector<HTMLSelectElement>("[data-filter-order]");
  const empty = root.querySelector<HTMLElement>("[data-filter-empty]");
  const collator = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });

  const apply = (): void => {
    const query = (search?.value || "").trim().toLocaleLowerCase("ru");
    const selectedKind = kind?.value || "all";
    const selectedPeriod = period?.value || "all";
    const sortKey = sort?.value || "name";
    const direction = order?.value === "desc" ? -1 : 1;
    const cutoff = selectedPeriod === "all"
      ? 0
      : Date.now() - Number(selectedPeriod) * 24 * 3600_000;

    const sorted = [...items].sort((a, b) => {
      if (sortKey === "name" || sortKey === "kind") {
        return collator.compare(a.dataset[sortKey] || "", b.dataset[sortKey] || "") * direction;
      }
      return (Number(a.dataset[sortKey] || 0) - Number(b.dataset[sortKey] || 0)) * direction;
    });

    let visible = 0;
    for (const item of sorted) {
      const matchesSearch = !query || (item.dataset.name || "").includes(query);
      const matchesKind = selectedKind === "all" || item.dataset.kind === selectedKind;
      const matchesPeriod = !cutoff || Number(item.dataset.modified || 0) >= cutoff;
      item.hidden = !(matchesSearch && matchesKind && matchesPeriod);
      if (!item.hidden) visible++;
      list.append(item);
    }
    if (empty) empty.hidden = visible > 0;
  };

  search?.addEventListener("input", apply);
  controls.querySelectorAll<HTMLSelectElement>("select").forEach((select) => {
    select.addEventListener("change", apply);
  });
  apply();
});


// Единственная кнопка выбирает бэкап и сразу отправляет форму.
document.querySelectorAll<HTMLInputElement>("[data-auto-submit-file]").forEach((input) => {
  input.addEventListener("change", () => {
    if (!input.files?.length || !input.form) return;
    const text = input.closest("label")?.querySelector<HTMLElement>("[data-upload-text]");
    if (text) text.textContent = "Загрузка…";
    input.form.requestSubmit();
  });
});


// Вкладки настроек без перезагрузки с сохранением выбранного раздела в URL.
document.querySelectorAll<HTMLElement>(".settings-tabs").forEach((tabList) => {
  const tabs = Array.from(tabList.querySelectorAll<HTMLButtonElement>("[data-settings-tab]"));
  const panels = Array.from(document.querySelectorAll<HTMLElement>("[data-settings-panel]"));
  const activate = (id: string, updateUrl = true): void => {
    if (!tabs.some((tab) => tab.dataset.settingsTab === id)) return;
    tabs.forEach((tab) => tab.setAttribute(
      "aria-selected", String(tab.dataset.settingsTab === id),
    ));
    panels.forEach((panel) => { panel.hidden = panel.dataset.settingsPanel !== id; });
    if (updateUrl) {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", id);
      history.replaceState(null, "", url);
    }
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activate(tab.dataset.settingsTab || ""));
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const step = event.key === "ArrowRight" ? 1 : -1;
      const next = tabs[(index + step + tabs.length) % tabs.length];
      next.focus();
      activate(next.dataset.settingsTab || "");
    });
  });
});


// Живой прогресс фоновой startup-синхронизации S3.
const storageProgress = document.querySelector<HTMLElement>("[data-storage-progress]");
if (storageProgress) {
  const phase = storageProgress.querySelector<HTMLElement>("[data-storage-phase]");
  const count = storageProgress.querySelector<HTMLElement>("[data-storage-count]");
  const bar = storageProgress.querySelector<HTMLElement>("[data-storage-bar]");
  const labels: Record<string, string> = {
    outbox: "Обработка очереди", merge: "Сверка локальных и S3-файлов",
    reconcile: "Финальная проверка", complete: "Синхронизация завершена",
    error: "Ошибка синхронизации",
  };
  const refresh = async (): Promise<void> => {
    try {
      const response = await fetch("/api/storage-status", { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json() as { startup?: Record<string, unknown> };
      const startup = data.startup || {};
      const current = Math.max(0, Number(startup.current || 0));
      const total = Math.max(1, Number(startup.total || 1));
      const percent = Math.min(100, Math.round(current / total * 100));
      if (phase) phase.textContent = labels[String(startup.phase || "")] || "Ожидание запуска";
      if (count) count.textContent = `${current}/${total} · ${percent}%`;
      if (bar) bar.style.width = `${percent}%`;
      storageProgress.dataset.state = String(startup.state || "idle");
    } catch { /* следующий poll повторит запрос */ }
  };
  void refresh();
  window.setInterval(() => void refresh(), 2000);
}


// Мониторинг обновляется без необходимости вручную перезагружать страницу.
if (document.querySelector(".monitor-grid")) {
  window.setTimeout(() => window.location.reload(), 30_000);
}
