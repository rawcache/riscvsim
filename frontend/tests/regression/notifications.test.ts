// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { showNotification } from "../../src/notifications";

describe("notifications.ts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    document.head.querySelector("#notification-style-tag")?.remove();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
    document.head.querySelector("#notification-style-tag")?.remove();
  });

  it("showNotification renders a toast element", () => {
    showNotification({
      id: "n1",
      type: "xp",
      title: "+10 XP",
      message: "Completed a step",
      icon: "⚡",
      duration: 4000,
      accentColor: "var(--accent)",
    });

    expect(document.querySelectorAll(".notification-toast")).toHaveLength(1);
  });

  it("toast auto-dismisses after duration", () => {
    showNotification({
      id: "n2",
      type: "xp",
      title: "+10 XP",
      message: "Completed a step",
      icon: "⚡",
      duration: 1000,
      accentColor: "var(--accent)",
    });

    vi.advanceTimersByTime(1300);
    expect(document.querySelectorAll(".notification-toast")).toHaveLength(0);
  });

  it("max 3 toasts enforced", () => {
    for (let index = 0; index < 4; index += 1) {
      showNotification({
        id: `n-${index}`,
        type: "xp",
        title: `Toast ${index}`,
        message: "Stacking",
        icon: "⚡",
        duration: 4000,
        accentColor: "var(--accent)",
      });
    }

    expect(document.querySelectorAll(".notification-toast")).toHaveLength(3);
  });

  it("dismiss button removes toast", () => {
    showNotification({
      id: "n3",
      type: "badge",
      title: "Badge",
      message: "Unlocked",
      icon: "🏅",
      duration: 4000,
      accentColor: "#f59e0b",
    });

    (document.querySelector(".notification-toast button") as HTMLButtonElement).click();
    vi.advanceTimersByTime(250);
    expect(document.querySelectorAll(".notification-toast")).toHaveLength(0);
  });
});
